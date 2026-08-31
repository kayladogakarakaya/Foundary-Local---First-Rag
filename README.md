[![JavaScript](https://img.shields.io/badge/JavaScript-ES2022-F7DF1E?logo=javascript&logoColor=000)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A5%2020-339933?logo=node.js&logoColor=fff)](https://nodejs.org/)
[![Foundry Local](https://img.shields.io/badge/Foundry%20Local-On--Device%20AI-0078D4?logo=microsoft&logoColor=fff)](https://foundrylocal.ai)
[![Phi-3.5 Mini](https://img.shields.io/badge/Model-Phi--3.5%20Mini%20Instruct-6B21A8)](https://huggingface.co/microsoft/Phi-3.5-mini-instruct)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Offline](https://img.shields.io/badge/Connectivity-100%25%20Offline-brightgreen)]()

*Three philosophers. One dilemma. Zero internet connection.*

AGORA is a local, offline RAG (Retrieval-Augmented Generation) assistant that answers ethical dilemmas from the actual writing of three philosophers, Immanuel Kant, John Stuart Mill, and Friedrich Nietzsche, instead of from an AI model's vague memory of "what philosophers generally think."

Ask it a question, and it gives you three separate, citation-backed answers side by side: one grounded in Kant's *Fundamental Principles of the Metaphysic of Morals*, one in Mill's *Utilitarianism*, one in Nietzsche's *On the Genealogy of Morality*. Every claim is traceable back to the exact passage that produced it.

## Why I built this

I'm a high school student who got into philosophy, and I kept running into the same problem: I wanted to know how Kant, Mill, and Nietzsche would actually respond to a real dilemma, not a textbook summary of their views, but their own reasoning applied to a specific case. Reading three dense 18th–19th century texts every time I had a question wasn't realistic. And asking a general chatbot doesn't really solve it either; it answers from training memory and can quietly invent quotes or blend positions that were never actually held.

So I built a small system that keeps all three books on my own machine, retrieves the actual relevant passages for a question, and forces the model to answer *from those passages*; with the sources shown, every time.

## What it does

- Takes any ethical case or dilemma as a prompt
- Retrieves the most relevant excerpts from **each philosopher separately**, so one author's larger text can't crowd out the others
- Generates three independent, streamed answers; one per philosopher, each in first person, grounded only in his own retrieved text
- Shows inline citations plus a citations panel with the exact excerpt and match score behind every answer
- Says so honestly when a topic simply isn't addressed in the source text, instead of inventing a position
- Runs **entirely offline** after the model is downloaded once; no API keys, no cloud calls, nothing leaves the machine

## How it works

```
PDF  →  clean Markdown  →  ~200-word chunks  →  term-frequency vectors  →  per-author retrieval  →  3 cited stances
```

1. **Source cleanup** — the original PDFs are extracted and cleaned (stripping OCR noise, running headers, footnote clutter, and non-content sections like indexes), then saved as Markdown with front matter (`author`, `title`, `category`).
2. **Chunking** — each document is split into overlapping ~200-word pieces, small enough to retrieve precisely.
3. **Vectorizing** — every chunk becomes a term-frequency vector (a word-count fingerprint), stored in SQLite alongside an inverted index for fast lookup. This isn't a cloud embedding model; it's simple, transparent, and fully local: you can point at the exact shared vocabulary that pulled a passage in.
4. **Retrieval** — a query is vectorized the same way and compared with cosine similarity, but *filtered per author*, so Kant, Mill, and Nietzsche are each matched only against their own writing.
5. **Generation** — [Foundry Local](https://foundrylocal.ai) runs **Phi-3.5 Mini** on-device, once per philosopher, with a system prompt that instructs it to answer strictly from the retrieved excerpts, in that philosopher's voice, and to admit honestly when the excerpts don't cover the case.
6. **UI** — the three answers stream into the browser independently over Server-Sent Events, each in its own card with its own citations.

## The library

| Philosopher | Text | Chunks | Category |
|---|---|---|---|
| Immanuel Kant | *Fundamental Principles of the Metaphysic of Morals* (trans. T. K. Abbott) | 176 | Deontological Ethics |
| John Stuart Mill | *Utilitarianism* | 156 | Consequentialist Ethics |
| Friedrich Nietzsche | *On the Genealogy of Morality* + supplementary excerpts (trans. Carol Diethe) | 444 | Genealogical Critique |

**776 chunks · 135,000+ words** of primary source text, fully searchable offline.

## Tech stack

- **[Foundry Local](https://foundrylocal.ai)** + **Phi-3.5 Mini Instruct** — on-device model runtime
- **Node.js / Express** — local server, SSE streaming
- **SQLite** (`better-sqlite3`) — local vector store (term-frequency + cosine similarity, no external vector DB)
- Plain HTML/CSS/JS front end — no framework

## Running it locally

```bash
cd local-rag
npm install
npm run ingest   # chunks and indexes the three source texts
npm start        # starts the server at http://127.0.0.1:3000
```

Requires [Foundry Local](https://foundrylocal.ai) installed and running.

## What I learned

**Clean data mattered more than clever prompts.** The raw PDFs were full of running headers, footnote markers, and a 15-page index. Retrieval only became trustworthy once that noise was stripped out and every book got real front matter — the prompt engineering barely mattered until the underlying text was actually clean.

**A shared pool of chunks isn't fair to every author.** Nietzsche's material alone produced 444 chunks against Kant's 176 and Mill's 156. Early on, with one shared top-K search, Nietzsche's chunks quietly dominated every answer regardless of the question. Fixing it meant retrieving separately per philosopher; a small change with a big effect on retrieval quality.

**Local AI has real limits, not infinite offline power.** Running three generations back-to-back on a laptop with limited free memory occasionally caused the model runtime to cancel mid-answer. That wasn't a prompt bug; it was a genuine resource constraint, and it meant the app needed to handle failure gracefully (retry, then a clear message) instead of assuming every generation succeeds.

**Vectorizing text isn't magic.** Before this project I assumed "vectorization" meant deep semantic understanding by default. Building this with plain term-frequency vectors made it clear that a simple word-count comparison, done well, is often enough; and it's a lot easier to explain *why* a passage was retrieved when the method is transparent.

## Credits & references

- Immanuel Kant, *Fundamental Principles of the Metaphysic of Morals*, trans. T. K. Abbott, Project Gutenberg #5682
- John Stuart Mill, *Utilitarianism*, Global Grey ebooks edition
- Friedrich Nietzsche, *On the Genealogy of Morality*, trans. Carol Diethe, Cambridge University Press
- Microsoft Tech Community, ["Building your first local RAG application with Foundry Local"](https://techcommunity.microsoft.com/blog/azuredevcommunityblog/building-your-first-local-rag-application-with-foundry-local/4501968) the starting point for this project's architecture

---

*A personal project exploring what local, offline RAG can do outside of the usual technical-support demo, applied to something I actually care about.*


## License

MIT – This solution is a scenario sample for learning and experimentation.
