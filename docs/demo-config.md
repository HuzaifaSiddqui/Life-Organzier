# Demo configuration (FYP evaluation, 10 Nov 2026)

These are the settings for the evaluation demo only. **The defaults in `backend/.env.example` stay off.** Put the values
below in `backend/.env` before the demo, and set them back afterwards ([Revert](#revert-each-flag)). Each flag is
described in [rollout.md](rollout.md), and the rollback layers in [rollback.md](rollback.md).

## Flags for the demo

```dotenv
# Chat
CHAT_FIXES_V2=on        # rule fixes (#31) and the model guards (#35)
OOS_NOTE=on             # "I can't call / send / book that myself, so I'll keep it as a task for you."
OOS_CONFIRM=off         # the stricter alternative to OOS_NOTE; keep off

# Cloud fallback: the chat chain is Ollama first, cloud only when Ollama fails
CLOUD_FALLBACK=on
LLM_PROVIDERS_CHAT=ollama,deploy,groq
LLM_PROVIDERS_DOCS=      # empty: documents stay on this machine
LLM_PROVIDERS_VISION=    # empty: images never leave this machine
# Keys (values only in backend/.env, never in this file): DEPLOY_API_KEY_1, GROQ_API_KEY

# Documents
DOC_ROUTING=on          # passed its gate: 3 clean runs, recall 153–154/154, 0 wrong items, p95 25.8–33.4 s
DOC_AI_SPLIT=on         # dense chunks (date sheets) read in pieces so the AI reply isn't cut off
DOC_EVIDENCE=off        # stays off: crashed the eval with "OCR is busy" in 4 of 5 runs (known-limitations.md)
DOC_DATESHEET=off       # stays off: #34 is not merged; see below

# Everything else stays at its default (off / empty)
```

**What the flags depend on:**

- `CHAT_FIXES_V2=on` turns on the rule fixes (#31) and the model guards (#35, merged): no routine without a repeat cue;
  a model's choice stays in the family a rule fix withdrew from, never completes after a negation and never undoes; a
  state-changing choice by the model is shown as a "Did you mean this?" button instead of running; "mute
  notifications" with no task named is Do Not Disturb.
- `DOC_DATESHEET` (dash dates such as "4-Nov-2026", date sheets without a heading, screenshot borders) is in #34, which
  is not merged. It stays out of the demo until the rules-only document eval is rerun on a quiet machine and the
  private documents are scored. The `DOC_EVIDENCE_V2` work (`feat/doc-evidence-v2`) is not on main and is not used.

**Privacy (CLOUD_FALLBACK=on):** if Ollama fails, the chat message goes to Deploy (tier B) or Groq (tier A). The message
is masked but not anonymised ([rollout.md → privacy trade-off](rollout.md#cloud-fallback-the-privacy-trade-off)). Use
only the demo account, with made-up data. Documents and images never go to the cloud with the values above.

## Start everything

```bash
# 1. Ollama (leave it running), then load the chat model once so the first message isn't slow
ollama serve                                   # skip if the Ollama app is already running
ollama pull qwen2.5:7b && ollama pull nomic-embed-text   # first time only
curl -s http://127.0.0.1:11434/api/generate -d '{"model":"qwen2.5:7b","prompt":"hi","stream":false,"options":{"num_predict":1}}' > /dev/null

# 2. Backend (from the main checkout, with the demo values in backend/.env)
cd backend && npx prisma migrate deploy && npm run dev     # http://localhost:5050

# 3. Phone over USB
adb reverse tcp:5050 tcp:5050

# 4. App
cd mobile && npx expo start --dev-client      # add -c after installing native packages
```

On start, the backend log shows `AI model qwen2.5:7b loaded`. The model then stays in memory for 30 minutes after its
last use (`keep_alive`).

## Revert each flag

Set the value back, save `backend/.env`, and restart the backend (Ctrl+C, then `npm run dev`). None of these needs a
migration or loses data.

| Flag | Demo | Revert to | What changes back |
|---|---|---|---|
| `CHAT_FIXES_V2` | `on` | `off` | Rule decisions as before #31; the model's choices run without the guards |
| `OOS_NOTE` | `on` | `off` | Out-of-scope requests become tasks with no note |
| `CLOUD_FALLBACK` | `on` | `off` | Every model call is local only; the `LLM_PROVIDERS_*` values are ignored |
| `LLM_PROVIDERS_CHAT` | `ollama,deploy,groq` | empty | No hosted chain (also implied by `CLOUD_FALLBACK=off`) |
| `DOC_ROUTING` | `on` | `off` | No document type; the rules decide what is created, as before |
| `DOC_AI_SPLIT` | `on` | `off` | Dense chunks go to the model in one piece (the reply may be cut off and dropped) |

To return everything at once, copy the flag lines from `backend/.env.example` (all off) over the demo values.

## Pre-demo checklist

Do this 15 minutes before the demo, on the laptop you will use, plugged in, with the lid open.

- [ ] **Ollama model loaded:** `ollama ps` lists `qwen2.5:7b`. If not, run the warm-up `curl` above (the first load
      takes up to about 2 minutes).
- [ ] **Memory:** the 7B model needs about 5 GB of free RAM. Close heavy apps: a second editor, browser tabs with
      video, the Antigravity app. Check Activity Monitor → Memory: memory pressure should be green. In the
      evaluation runs, another app using a full CPU core made document timings much worse and twice made OCR give up
      ("OCR is busy").
- [ ] **Backend up:** `curl -s localhost:5050/health` returns `"ok":true`, and `ai.available` is `true`.
- [ ] **AI health route:** `curl -s localhost:5050/health/ai` shows `aiEnabled: true`; the `chat` job is `configured: true`
      with chain `ollama, deploy, groq`; the `docs` and `vision` jobs are `configured: false`; each provider is `up` (none
      `billing_blocked`).
- [ ] **Phone connected:** `adb reverse tcp:5050 tcp:5050` was run after plugging in, and the app opens on the dashboard.
- [ ] **Demo account:** signed in as the demo account, with made-up tasks, routines and documents only. No real names,
      phone numbers or private documents.
- [ ] **Flags:** `backend/.env` has the values above. Nothing else is switched on.
- [ ] **Sleep:** the laptop will not sleep during the demo (plugged in; or run `caffeinate -ims` in a terminal).

## Document timings to expect

These are measured on this laptop with the local model (qwen2.5:7b). The time runs from upload to the result
screen, per document.

| Situation | Expected time |
|---|---|
| Text, PDF or DOCX, rules only (AI off) | under 1 s |
| Any document with AI on, quiet machine (DOC_ROUTING gate, 3 runs) | p95 25.8–33.4 s |
| Same, with other heavy apps open (30–31 Oct runs) | p95 38–56 s, slowest about 73 s |
| A dense date sheet with `DOC_AI_SPLIT=on` | can use the whole 2-minute AI budget; the rules' items appear even if the AI pass is cut short |
| Photo or screenshot (OCR) | add a few seconds for OCR; under heavy load OCR can refuse with "busy" |

In the runs, the slow AI calls were the long replies (about 180–270 output tokens at roughly 150 ms per token), not
time-outs. Upload short, clear documents for the live demo, and keep a pre-processed one ready to show.
