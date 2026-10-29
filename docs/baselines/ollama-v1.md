# Baseline: Ollama (v1)

Tag **`baseline-ollama-v1`** → commit **2988159** (main after PRs #11–#22), measured **28 Oct 2026**. The gate for every
new feature compares against these numbers (`docs/rollout.md`); how to come back here: `docs/rollback.md`.
Machine-readable copy: [`ollama-v1.json`](ollama-v1.json).

## Setup

| | |
|---|---|
| Machine | Apple M1, 16 GB, macOS 26.5.2 |
| Runtime | Node v24.21.0, PostgreSQL 16.13, Ollama 0.34.3 |
| Chat / documents model | `qwen2.5:7b` (845dbda0ea48), local Ollama |
| Embeddings | `nomic-embed-text` (0a109f422b47), hashed bag-of-words fallback |
| Check-in first-step copy | `gemini-3.8-flash`, then Ollama, then the built-in library |
| Env | `AI_PROVIDER=ollama`, `OLLAMA_MODEL=qwen2.5:7b`, `GEMINI_MODEL=gemini-3.8-flash`, `GEMINI_API_KEY` set, `GEMINI_FALLBACK` unset, `MEANING_ROUTER` off, `UNKNOWN_LOG` on |
| Libraries | Prisma 6.19.3, Express 4.22.1, tesseract.js 7.0.0, sharp 0.34.4, pdfjs-dist 5.4.296, TypeScript 5.9.3 |

## Numbers

| Check | AI off | AI on (Ollama) |
|---|---|---|
| Backend typecheck / tests | 0 errors, 358/358 | – |
| Mobile typecheck / tests | clean, 41/41 | – |
| Chat eval (`npm run eval:assistant`, rules) | 211/215 (en 145/147, Roman Urdu 48/50, Urdu 18/18) | – (rules-only script) |
| Pending-answer matrix | 230/230 | – |
| Query eval (`npm run eval:queries`) | precision 100%, recall 94.3% (44/46 exact), negatives 10/10 | – |
| Router gate (`npm run eval:router`), 259 bank rows | en 98.0%, Roman Urdu 96.6% (rules = combined) | en 98.5%, Roman Urdu 98.3% (LLM router without examples = combined); asked on 0/253 |
| Document eval (`npm run eval:documents`), 69 synthetic | recall 153/154, precision 153/153 | recall 153/154, precision 153/154 |
| Private documents | not scored: 1 image, no manifest | – |
| Held-out chat (`chat-holdout.json`) | no rows yet | – |

The one document miss (both modes) is the noisy photo of `multiline-exam` ("Midterm", 15 Nov 10 AM); with AI on the
model also adds a misread "Midter Ex" item there (the only precision loss).

## Time per message (`npx tsx scripts/bench-latency.ts`)

| Sample | AI off: median / p95 | AI on: median / p95 | over 1 s (AI on) |
|---|---|---|---|
| Even sample of 40 bank messages | 8 ms / 29 ms | 10 ms / 42 ms | 0 of 40 |
| Messages the rules are unsure about (`--unsure`, 7) | 10 ms / 38 ms | **5959 ms / 8573 ms** | 7 of 7 |

Most messages never reach the model; the unsure ones are the AI path, so their p95 (**8573 ms**) is the latency
baseline for the gate (no more than 2 s worse). Router model calls in `eval:router -- --model`: median 6.1 s, p95 13.4 s.

## Reproduce

```bash
git checkout baseline-ollama-v1 && cd backend
REQUIRE_DB=true npm test && npm run eval:assistant && npm run eval:queries
npm run eval:router && npm run eval:router -- --model
npm run eval:documents -- --ai
npx tsx scripts/bench-latency.ts && npx tsx scripts/bench-latency.ts --ai
npx tsx scripts/bench-latency.ts --unsure && npx tsx scripts/bench-latency.ts --ai --unsure
cd ../mobile && npx tsc --noEmit && npm test
```

`scripts/bench-latency.ts` was added with this record (it is not in the tagged commit); copy it into a checkout of the
tag to rerun the latency rows.
