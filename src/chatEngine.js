/**
 * Foundry Local chat engine.
 * Uses the Foundry Local SDK to discover, load, and run inference
 * on a local model. Performs RAG retrieval and generates responses.
 * Selects the hardware-optimised model variant automatically and
 * reports download/load progress via a status callback.
 */
import { FoundryLocalManager } from "foundry-local-sdk";
import { VectorStore } from "./vectorStore.js";
import { config } from "./config.js";
import {
  SYSTEM_PROMPT,
  SYSTEM_PROMPT_COMPACT,
  buildStanceSystemPrompt,
  buildStanceSystemPromptCompact,
} from "./prompts.js";

export class ChatEngine {
  constructor() {
    this.chatClient = null;
    this.model = null;
    this.store = null;
    this.compactMode = false;
    this.modelAlias = null;
    /** @type {string[]} Authors present in the knowledge base (for per-perspective stance mode). */
    this.authors = [];
    /** @type {(status: {phase: string, message: string, progress?: number}) => void} */
    this._statusCallback = null;
  }

  /** Register a callback that receives init status updates for the UI. */
  onStatus(callback) {
    this._statusCallback = callback;
  }

  _emitStatus(phase, message, progress) {
    const status = { phase, message, ...(progress !== undefined && { progress }) };
    console.log(`[ChatEngine] ${message}`);
    if (this._statusCallback) this._statusCallback(status);
  }

  /**
   * Initialize the engine: create Foundry Local manager, discover and load
   * the best model variant for this hardware, and open the vector store.
   */
  async init() {
    this._emitStatus("init", "Initializing Foundry Local SDK...");

    // Create the manager (requires appName)
    const manager = FoundryLocalManager.create({ appName: "gas-field-local-rag" });
    const catalog = manager.catalog;

    this._emitStatus("catalog", "Discovering available models...");
    this.model = await catalog.getModel(config.model);
    this.modelAlias = this.model.alias;

    // On macOS the SDK's auto-selected GPU variant requests the DirectML execution
    // provider, which doesn't exist outside Windows and fails to load. Force the CPU
    // variant there instead.
    if (process.platform === "darwin") {
      const cpuVariant = this.model.variants.find((v) => v.modelInfo.runtime.deviceType === "CPU");
      if (cpuVariant) this.model.selectVariant(cpuVariant.id);
    }

    this._emitStatus("variant", `Selected model: ${this.modelAlias} (${this.model.id})`);

    // Download the model if not already cached, with progress reporting
    if (!this.model.isCached) {
      this._emitStatus("download", `Downloading ${this.modelAlias}... This may take a few minutes on first run.`, 0);
      await this.model.download((progress) => {
        const pct = Math.round(progress * 100);
        this._emitStatus("download", `Downloading ${this.modelAlias}... ${pct}%`, progress);
      });
      this._emitStatus("download", `Download complete.`, 1);
    } else {
      this._emitStatus("cached", `Model ${this.modelAlias} is already cached.`);
    }

    // Load the model into memory
    this._emitStatus("loading", `Loading ${this.modelAlias} into memory...`);
    await this.model.load();

    // Create the native chat client with performance settings pre-configured
    this.chatClient = this.model.createChatClient();
    this.chatClient.settings.temperature = 0.1; // Low for deterministic, safety-critical responses
    this._emitStatus("ready", `Model ready: ${this.modelAlias}`);

    // Open the local vector store
    this.store = new VectorStore(config.dbPath);
    const count = this.store.count();
    this.authors = this.store.listAuthors();
    this._emitStatus("ready", `Vector store ready: ${count} chunks indexed.`);

    if (count === 0) {
      console.warn("[ChatEngine] WARNING: No documents ingested. Run 'npm run ingest' first.");
    }
  }

  /** Expose the vector store for direct operations (e.g. upload ingestion). */
  getStore() {
    return this.store;
  }

  /** Authors present in the knowledge base, for the stance-comparison UI. */
  getAuthors() {
    return this.authors;
  }

  /**
   * Set compact mode for extreme latency / edge devices.
   */
  setCompactMode(enabled) {
    this.compactMode = enabled;
    console.log(`[ChatEngine] Compact mode: ${enabled ? "ON" : "OFF"}`);
  }

  /**
   * Reduce a generation error to a short, UI-safe message. The SDK surfaces
   * native failures as multi-KB .NET stack traces; log the full detail
   * server-side but only ever show the first line to the client.
   */
  _friendlyError(err) {
    console.error("[ChatEngine] Generation error:", err);
    const firstLine = String(err?.message || err || "Generation failed").split("\n")[0];
    if (/OperationCanceledException/i.test(firstLine)) {
      return "Generation was interrupted by the local model runtime (often a low-memory condition). Try again.";
    }
    return firstLine.length > 200 ? firstLine.slice(0, 200) + "…" : firstLine;
  }

  /**
   * Retrieve the chunks most relevant to a query across the whole knowledge
   * base (used by the plain, non-comparative chat endpoints). Delegates the
   * actual ranking to VectorStore.search() — see vectorStore.js for how
   * candidates are found and scored. Compact mode retrieves fewer chunks to
   * keep the prompt short for lower latency.
   */
  retrieve(query) {
    const topK = this.compactMode ? Math.min(config.topK, 3) : config.topK;
    return this.store.search(query, topK);
  }

  /**
   * Turn retrieved chunks into the context block injected into the prompt.
   * Each chunk is labelled with its source document and category so the
   * model can cite "which document" a claim came from, and so it's obvious
   * downstream (in logs, or to a developer) exactly what the model saw.
   */
  _buildContext(chunks) {
    if (chunks.length === 0) {
      return "No relevant documents found in local knowledge base.";
    }

    return chunks
      .map(
        (c, i) =>
          `--- Document ${i + 1}: ${c.title} [${c.category}] ---\n${c.content}`
      )
      .join("\n\n");
  }

  /**
   * Generate a response for a user query (non-streaming).
   */
  async query(userMessage, history = []) {
    // 1. Retrieve relevant chunks
    const chunks = this.retrieve(userMessage);
    const context = this._buildContext(chunks);

    // 2. Build messages array
    const systemPrompt = this.compactMode ? SYSTEM_PROMPT_COMPACT : SYSTEM_PROMPT;
    const messages = [
      { role: "system", content: systemPrompt },
      {
        role: "system",
        content: `Retrieved context from local knowledge base:\n\n${context}`,
      },
      ...history,
      { role: "user", content: userMessage },
    ];

    // 3. Call the local model via the native chat client
    this.chatClient.settings.maxTokens = this.compactMode ? 512 : 1024;
    const response = await this.chatClient.completeChat(messages);

    return {
      text: response.choices[0].message.content,
      sources: chunks.map((c) => ({
        title: c.title,
        category: c.category,
        docId: c.doc_id,
        score: Math.round(c.score * 100) / 100,
      })),
    };
  }

  /**
   * Generate a streaming response for a user query.
   * Returns an async iterable of text chunks.
   */
  async *queryStream(userMessage, history = []) {
    // 1. Retrieve relevant chunks
    const chunks = this.retrieve(userMessage);
    const context = this._buildContext(chunks);

    // 2. Build messages array
    const systemPrompt = this.compactMode ? SYSTEM_PROMPT_COMPACT : SYSTEM_PROMPT;
    const messages = [
      { role: "system", content: systemPrompt },
      {
        role: "system",
        content: `Retrieved context from local knowledge base:\n\n${context}`,
      },
      ...history,
      { role: "user", content: userMessage },
    ];

    // 3. Stream from the local model via the SDK's callback-based streaming
    this.chatClient.settings.maxTokens = this.compactMode ? 512 : 1024;

    // Yield sources metadata first
    yield {
      type: "sources",
      data: chunks.map((c) => ({
        title: c.title,
        category: c.category,
        docId: c.doc_id,
        score: Math.round(c.score * 100) / 100,
      })),
    };

    try {
      for await (const text of this._streamChatText(messages)) {
        yield { type: "text", data: text };
      }
    } catch (err) {
      yield { type: "error", data: this._friendlyError(err) };
    }
  }

  /**
   * Drive the SDK's callback-based streaming chat call and yield text deltas
   * as they arrive. A `.catch()` is attached synchronously so a mid-stream
   * failure (model error, native cancellation) surfaces as a normal thrown
   * error here instead of an unhandled promise rejection — which would
   * otherwise crash the whole process (Node exits by default on those).
   */
  async *_streamChatText(messages) {
    const textChunks = [];
    let resolve;
    let done = false;
    let error = null;

    this.chatClient
      .completeStreamingChat(messages, (chunk) => {
        textChunks.push(chunk);
        if (resolve) { resolve(); resolve = null; }
      })
      .then(() => {
        done = true;
        if (resolve) { resolve(); resolve = null; }
      })
      .catch((err) => {
        error = err;
        done = true;
        if (resolve) { resolve(); resolve = null; }
      });

    while (!done || textChunks.length > 0) {
      if (textChunks.length === 0 && !done) {
        await new Promise((r) => { resolve = r; });
      }
      while (textChunks.length > 0) {
        const chunk = textChunks.shift();
        const content = chunk.choices?.[0]?.delta?.content;
        if (content) yield content;
      }
    }

    if (error) throw error;
  }

  /**
   * Generate one stance per author on a case, each grounded only in that
   * author's own retrieved excerpts. Streams events tagged with the author
   * so the UI can render them into separate cards as they arrive:
   *   { type: 'stance-start', author }
   *   { type: 'sources', author, data }
   *   { type: 'text', author, data }
   *   { type: 'stance-end', author }
   * Authors are processed sequentially (the model runs one inference at a time).
   */
  async *queryStancesStream(userMessage) {
    const topK = this.compactMode ? Math.min(config.topK, 2) : config.topK;
    this.chatClient.settings.maxTokens = this.compactMode ? 220 : 400;

    for (const author of this.authors) {
      yield { type: "stance-start", author };

      const chunks = this.store.search(userMessage, topK, author);
      const context = this._buildContext(chunks);
      const systemPrompt = this.compactMode
        ? buildStanceSystemPromptCompact(author)
        : buildStanceSystemPrompt(author);

      const messages = [
        { role: "system", content: systemPrompt },
        { role: "system", content: `Retrieved excerpts from ${author}'s writing:\n\n${context}` },
        { role: "user", content: userMessage },
      ];

      yield {
        type: "sources",
        author,
        data: chunks.map((c) => ({
          title: c.title,
          category: c.category,
          docId: c.doc_id,
          score: Math.round(c.score * 100) / 100,
        })),
      };

      // The local model runtime occasionally cancels a generation under memory
      // pressure (native OperationCanceledException); one retry clears most of
      // these transient failures without bothering the user.
      try {
        for await (const text of this._streamChatText(messages)) {
          yield { type: "text", author, data: text };
        }
      } catch (err) {
        console.warn(`[ChatEngine] ${author} generation failed, retrying once.`);
        yield { type: "stance-retry", author };
        try {
          for await (const text of this._streamChatText(messages)) {
            yield { type: "text", author, data: text };
          }
        } catch (err2) {
          yield { type: "error", author, data: this._friendlyError(err2) };
        }
      }

      yield { type: "stance-end", author };
    }
  }

  close() {
    if (this.model) {
      this.model.unload().catch(() => {});
    }
    if (this.store) this.store.close();
  }
}
