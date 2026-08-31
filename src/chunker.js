/**
 * Document chunking utility.
 * Splits markdown documents into overlapping chunks suitable for RAG retrieval.
 */

/**
 * Parse front-matter (YAML-like) from a markdown document.
 */
export function parseFrontMatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: text };

  const meta = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return { meta, body: match[2] };
}

/**
 * Split text into chunks of approximately `maxTokens` tokens with
 * `overlapTokens` overlap between consecutive chunks. Uses whitespace-based
 * token approximation (good enough for local RAG). The overlap exists so an
 * idea that spans a chunk boundary in the source text still appears whole
 * in at least one chunk, instead of being split with no chunk containing
 * the full argument.
 */
export function chunkText(text, maxTokens = 400, overlapTokens = 50) {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= maxTokens) return [text];

  const chunks = [];
  let start = 0;
  while (start < words.length) {
    const end = Math.min(start + maxTokens, words.length);
    chunks.push(words.slice(start, end).join(" "));
    if (end >= words.length) break;
    start = end - overlapTokens;
  }
  return chunks;
}

/**
 * "Vectorize" a piece of text as a term-frequency vector: a word → count
 * map, lowercased and stripped of punctuation. This is a much simpler
 * stand-in for the embedding models a cloud RAG pipeline would normally
 * call out to — no semantic understanding of synonyms, but it's fast,
 * fully local, and every match is explainable by the words it shares
 * with the query. Returns a Map<term, frequency>.
 */
export function termFrequency(text) {
  const tf = new Map();
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9₂\-']/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
  for (const t of tokens) {
    tf.set(t, (tf.get(t) || 0) + 1);
  }
  return tf;
}

/**
 * Compute cosine similarity between two term-frequency vectors: the cosine
 * of the angle between them, in [0, 1]. It scores how much vocabulary two
 * texts share in proportion to their own length, so a short query can still
 * match strongly against a long chunk that uses the same terms repeatedly.
 */
export function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [term, freq] of a) {
    normA += freq * freq;
    if (b.has(term)) dot += freq * b.get(term);
  }
  for (const [, freq] of b) normB += freq * freq;
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
