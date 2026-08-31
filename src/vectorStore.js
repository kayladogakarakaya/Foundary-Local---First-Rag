/**
 * Local vector store backed by SQLite.
 * Stores document chunks and their term-frequency vectors for offline RAG retrieval.
 *
 * Performance optimisations:
 * - Inverted index: maps terms → chunk IDs for fast candidate filtering
 * - Row cache: parsed TF maps kept in memory to avoid JSON.parse on every query
 * - Prepared statements: reused across calls
 */
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { termFrequency, cosineSimilarity } from "./chunker.js";

export class VectorStore {
  constructor(dbPath) {
    // Ensure data directory exists
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this._init();

    // In-memory caches for fast retrieval
    this._rowCache = null;    // Array of { id, doc_id, title, category, content, tf }
    this._invertedIndex = null; // Map<term, Set<rowIndex>>
  }

  _init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        doc_id TEXT NOT NULL,
        title TEXT,
        category TEXT,
        author TEXT,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        tf_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_doc_id ON chunks(doc_id);
    `);

    // Migrate older databases created before the `author` column existed.
    const existingCols = this.db.prepare("PRAGMA table_info(chunks)").all().map((c) => c.name);
    if (!existingCols.includes("author")) {
      this.db.exec("ALTER TABLE chunks ADD COLUMN author TEXT");
    }

    // Prepare reusable statements
    this._stmtInsert = this.db.prepare(
      "INSERT INTO chunks (doc_id, title, category, author, chunk_index, content, tf_json) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    this._stmtAll = this.db.prepare("SELECT * FROM chunks");
    this._stmtCount = this.db.prepare("SELECT COUNT(*) as cnt FROM chunks");
    this._stmtListDocs = this.db.prepare(
      "SELECT doc_id, title, category, author, COUNT(*) as chunks FROM chunks GROUP BY doc_id ORDER BY title"
    );
    this._stmtListAuthors = this.db.prepare(
      "SELECT DISTINCT author FROM chunks WHERE author IS NOT NULL AND author != '' ORDER BY author"
    );
    this._stmtDeleteDoc = this.db.prepare("DELETE FROM chunks WHERE doc_id = ?");
  }

  /** Invalidate in-memory caches (called after any mutation). */
  _invalidateCache() {
    this._rowCache = null;
    this._invertedIndex = null;
  }

  /** Build or return the in-memory row cache and inverted index. */
  _ensureCache() {
    if (this._rowCache) return;

    const rows = this._stmtAll.all();
    this._rowCache = rows.map((row) => {
      const tf = new Map(JSON.parse(row.tf_json));
      return { id: row.id, doc_id: row.doc_id, title: row.title, category: row.category, author: row.author, content: row.content, tf };
    });

    // Build inverted index: term → set of row indices
    this._invertedIndex = new Map();
    for (let i = 0; i < this._rowCache.length; i++) {
      for (const term of this._rowCache[i].tf.keys()) {
        if (!this._invertedIndex.has(term)) {
          this._invertedIndex.set(term, new Set());
        }
        this._invertedIndex.get(term).add(i);
      }
    }
  }

  /** Remove all existing chunks (for fresh re-ingestion). */
  clear() {
    this.db.exec("DELETE FROM chunks");
    this._invalidateCache();
  }

  /** Insert a single chunk. */
  insert(docId, title, category, chunkIndex, content, author = null) {
    const tf = termFrequency(content);
    const tfJson = JSON.stringify([...tf]);
    this._stmtInsert.run(docId, title, category, author, chunkIndex, content, tfJson);
    this._invalidateCache();
  }

  /**
   * The core retrieval function: finds the top-K chunks most relevant to a
   * query, using term-frequency vectors and cosine similarity (see chunker.js).
   *
   * Two-phase search, so a query never has to score the whole corpus:
   *   1. Candidate filtering — walk the inverted index to collect only the
   *      chunks that share at least one word with the query. For a small
   *      local corpus this already narrows things down a lot.
   *   2. Scoring & ranking — compute cosine similarity for each candidate
   *      only, then sort and keep the top K.
   *
   * If `author` is given, non-matching chunks are skipped during scoring.
   * This is what powers per-philosopher retrieval in the stance-comparison
   * mode: without it, a larger document (more chunks) would dominate a
   * shared top-K list regardless of which author is actually most relevant.
   */
  search(query, topK = 5, author = null) {
    const queryTf = termFrequency(query);
    this._ensureCache();

    // Phase 1: candidate filtering via the inverted index.
    const candidateIndices = new Set();
    for (const term of queryTf.keys()) {
      const indices = this._invertedIndex.get(term);
      if (indices) {
        for (const idx of indices) candidateIndices.add(idx);
      }
    }

    // Phase 2: score only the candidates, optionally restricted to one author.
    const scored = [];
    for (const idx of candidateIndices) {
      const row = this._rowCache[idx];
      if (author && row.author !== author) continue;
      const score = cosineSimilarity(queryTf, row.tf);
      if (score > 0) {
        scored.push({ ...row, score, tf_json: undefined });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  /** List distinct authors present in the store (for per-perspective retrieval). */
  listAuthors() {
    return this._stmtListAuthors.all().map((r) => r.author);
  }

  /** Remove all chunks for a specific document. */
  removeByDocId(docId) {
    this._stmtDeleteDoc.run(docId);
    this._invalidateCache();
  }

  /** Get total chunk count. */
  count() {
    return this._stmtCount.get().cnt;
  }

  /** List distinct documents in the store. */
  listDocs() {
    return this._stmtListDocs.all();
  }

  close() {
    this.db.close();
  }
}
