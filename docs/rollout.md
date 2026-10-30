# Rollout switchboard

Every flag added after the baseline (`baseline-ollama-v1`, `docs/baselines/ollama-v1.json`). **Every default is the
baseline**: unset or the value below gives today's behaviour. Turn one on only after it passes the gate (below) and
turn it off again by setting it back to its default and restarting the backend (`docs/rollback.md`, layer 1). None
of these needs a migration; turning one off loses no data (new fields are optional and the app ignores them).

## Flags

| Flag (backend/.env) | Default | What it changes when on | Revert | Added in | Gate |
|---|---|---|---|---|---|
| `CLOUD_FALLBACK` | `off` | Allows any non-Ollama provider. Required for every hosted chain: off = every model call takes the baseline path, whatever `LLM_PROVIDERS_*` say. **Privacy trade-off below.** | `off` | feat/chat-model-upgrade | not passed (see PR) |
| `LLM_PROVIDERS_CHAT` | empty | With `CLOUD_FALLBACK=on`: providers allowed in the chat chain, in the order of `config/provider-order.json` (decided: ollama → deploy GLM, few-shot → groq gpt-oss-20b → rules). | empty | #24 | – |
| `LLM_PROVIDERS_DOCS` | empty | Same for documents (decided: ollama → groq gpt-oss-120b). | empty | #24 | – |
| `LLM_PROVIDERS_VISION` | empty | Same for document images. The vision chain is empty by decision (no hosted vision; tier B never gets images). There is no separate `DOC_VISION` flag. | empty | #24 | – |
| `LLM_TIER_B_LEAD_APPROVED` | empty | Tier B providers allowed to lead a chain. | empty | #24 | – |
| `LLM_MASK_NAMES` | `cues` | `capitalised`: hosted providers also get every capitalised word masked (harder to read documents). | `cues` | #24 | – |
| `BEDROCK_ENABLED`, `BEDROCK_MODEL`, `BEDROCK_DAILY_BUDGET_USD` | `false`, empty, `0` | Bedrock first in each chain (no AWS access yet; `scripts/test-bedrock.ts`). | `false` | #24 | not run |
| Few-shot per provider (`fewShot` in `config/provider-order.json`, not env) | on for deploy GLM only | Providers marked `fewShot` get the router prompt with the 5 nearest English bank rows. Only used inside the cloud chain. | set `fewShot: false` | feat/chat-model-upgrade | re-measure on the classmates' set |
| `DOC_CHUNKING` | `false` | Document AI pass in 600-character chunks, every chunk the time budget allows, longer replies. | `false` | #26 | **failed** (p95 +10.8 s) |
| `DOC_AI_SPLIT` | `off` | A dense chunk (more than 8 dated lines) is read in pieces; a failed piece is halved once. | `off` | fix/doc-ai-truncation | see PR |
| `DOC_DATESHEET` | `off` | Dates written "4-Nov" / "04-Nov-2026" / "4-November-2026" parse (in documents and chat; the AI date check accepts them too); dated rows under a "Date Sheet" / "Exam(ination) Schedule" / "Midterm Schedule" heading are exams without "exam" on each row; OCR table borders ("_") and cells glued to a date are split; a leading weekday is dropped from such titles; a sheet with no heading (two or more rows with a full date and a time range, "course_class_teacher 03-Jun-2026 13:00-16:00") gives exams titled by course, **reviewed, never auto-created**; one row's OCR year far from the sheet's is corrected; a screenshot's dark border is cut before OCR. | `off` | fix/date-sheet | see PR |
| `DOC_FALLBACK_UI` | `off` | Responses carry the extracted text: "See what was read", the no-dates screen, "Pick lines" (review items). | `off` | feat/document-routing | see PR |
| `DOC_ROUTING` | `off` | Document type decides what is created automatically; "Wrong type?" re-reads. | `off` | feat/document-routing | see PR |
| `DOC_PRIORITY_V2` | `off` | Document task priority from item type, days left and weightage. | `off` | feat/document-routing | see PR |
| `DOC_EVIDENCE` | `off` | AI items must quote a document line that gives their date; otherwise review only. | `off` | feat/document-routing | see PR |
| `DOC_LAYOUT` | `off` | OCR'd tables rebuilt into rows and columns. | `off` | feat/document-routing | see PR |
| `DOC_AGREE`, `DOC_AGREE_MODEL` | `off`, `qwen2.5:14b` | Second local model for type "other" or OCR < 70; agreement shown, never auto-created. | `off` | feat/document-routing | see PR |
| `OOS_CONFIRM` | `off` | A bare imperative the app can't carry out ("book me a taxi", "call my mother": a verb, no task cue, no date, time, duration or repeat) gets "I can't do that myself. Add it as a task?" with an **Add as a task** button, instead of becoming a task. On the AI-written held-out set: 4 of the 6 out-of-scope actions become the question; 4 real tasks also ask first (one extra tap). | `off` | feat/chat-model-upgrade | proposal; your call |
| `MEANING_ROUTER` | `off` | Bank neighbours guide the router (stays off unless held-out data shows it beats the rules). | `off` | before the baseline | – |

## Demo setting (FYP evaluation only)

To show the fallback chain working (for example with Ollama stopped), set in `backend/.env` for the demo and revert
afterwards (default stays off):

```dotenv
CLOUD_FALLBACK=on
LLM_PROVIDERS_CHAT=ollama,deploy,groq
# leave LLM_PROVIDERS_DOCS and LLM_PROVIDERS_VISION empty: documents stay local
```

Use a demo account with made-up tasks only: what the router sends to Deploy and Groq is masked, not anonymised (below).
`GET /health/ai` shows each provider's state during the demo. Revert: `CLOUD_FALLBACK=off` and restart.

## Cloud fallback: the privacy trade-off

With `CLOUD_FALLBACK=on`, a message the rules are unsure about (and, with `LLM_PROVIDERS_DOCS`, document text) may
go to Deploy (tier B: its terms say nothing about training on API prompts) or Groq (tier A: no training) whenever
Ollama is down or fails. **Masking is not anonymisation**: it replaces phone and CNIC numbers, other long digit
runs, e-mails, links and names after a cue word ("call", "with", "Dr", "bhai"), but the rest of the message is sent
as written. What the message is about (an illness, a family matter, a place, a course, a name without a cue word)
still reaches the provider. Off by default for that reason; the gate decides whether it is ever turned on.

## Gate (every PR)

A flag may be turned on only if **all** hold versus the saved baseline, with AI on and with AI off:

- chat eval (`npm run eval:assistant`), pending matrix and query eval (`npm run eval:queries`) not lower, and zero
  new wrong actions;
- document recall and precision (`npm run eval:documents`) not lower, and wrong items reaching auto-create = 0;
- the private-document eval and the held-out chat sets (when they have rows) not lower;
- p95 latency not worse than the baseline by more than 2 s.

If any number is lower, the flag stays off and the PR says so. Thresholds are never tuned to pass.
