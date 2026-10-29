# Life Organizer — AI Assistant Architecture

## Running it

```bash
# one-time
ollama pull qwen2.5:7b
ollama pull nomic-embed-text
cd backend && npx prisma migrate deploy && npx prisma generate

# every time
cd backend && npm run dev          # API on :5050
cd mobile  && npx expo run:android # rebuild after native dependency changes

# checks
cd backend && npm test             # unit tests (NLU, clarity, scheduling, reminders, extraction, crisis, sync)
cd backend && npm run smoke        # 60 HTTP checks against a temporary DB-only user
cd backend && npm run e2e          # multi-turn conversation against the real local LLM
```

## Design principle

A small local model (Qwen 2.5 7B) is good at language but bad at arithmetic and consistency. So the LLM does
**narrow, schema-constrained jobs** (intent when rules are unsure, titles, empathetic replies,
memory extraction, sub-task names, topics), while **dates, clarity scoring, scheduling,
reminders, patterns and safety are deterministic code**. If Ollama is down, a circuit breaker
skips it and the assistant keeps working on rules.

**Cloud fallback (off by default; `docs/rollout.md`).** With `CLOUD_FALLBACK=on` and `LLM_PROVIDERS_CHAT` set, the
router's model calls go through a hosted chain (`backend/src/ai/chains.ts`, order in `config/provider-order.json`):
Ollama → Deploy GLM-5.3-flash (tier B, masked text, few-shot: the 5 nearest English bank rows) → Groq gpt-oss-20b
(tier A, masked) → rules. 8 s per hosted call, 15 s per chain, failover on timeout, 429, 5xx, invalid JSON or schema
failure, breaker 3 failures → 60 s, $0 spend guard. Off: every model call takes the path above, unchanged
(`tests/baselineRegression.test.ts` pins chat to `docs/baselines/ollama-v1.json`). Status: built and tested with fake
providers (`tests/chatFailover.test.ts`); not turned on (gate in the PR).

## Check-in copy (FR-RN-004)

Check-in message text always comes from reviewed templates (`backend/src/modules/checkins/templates.ts`,
English + Urdu, Funny/Serious/Gentle). Only the **first step** ("Read question 1") is model-written, in the
background when a task's scheduled start is set or changed — never at notification time:

1. **Gemini** (`GEMINI_MODEL`, a Flash model) when `GEMINI_API_KEY` is set — English and Urdu. Called with a
   per-call provider preference (`providers: ["gemini"]`), so chat's provider chain is unchanged.
2. **Ollama** (`qwen2.5:7b`) — English only (its Urdu was unreliable in testing).
3. **Keyword library** in `templates.ts` (reviewed, English + Urdu).
4. **None** → templates without a first step.

Every model result passes a strict validator (2–8 words, allowlisted imperative verb, no digits unless in the
title, no commas/semicolons/emoji, not the title repeated, Urdu script for Urdu). The source used is stored
on the copy and in `CheckinLog.copySource` (`GEMINI | OLLAMA | LIBRARY | NONE`, or `WITHHELD` when research mode deliberately omits an existing step) for the evaluation.

**Privacy (push):** an "Added from WhatsApp" push carries the task title through Expo and Google FCM (Apple on iOS); nothing else about the task is sent.

**Privacy:** the first-step prompt contains only the task title and planned duration. No description, notes,
mood, memories or user details are sent — to Gemini or to Ollama.

### Check-in flow, estimate accuracy and evaluation

- **Planning** is pure (`checkins/checkinPlanner.ts`): eligibility, timing, caps, per-slot history; `checkinService.planCheckins` persists rows with stable ids (`CheckinLog`, with `slotStart`, `researchMode`) and cancels the old slot's rows on reschedule. **Answers** (`POST /api/checkins/:id/respond`) are claimed atomically, use the phone's tap time, and are recorded as `stale` when the check-in was already cancelled. Tasks completed by an answer get `completedVia = CHECKIN`.
- **Phone**: every notification action opens the app; answers made offline are queued with the tap time and sent before the next sync, with a retry policy that drops a poison answer after 10 attempts or 48 h (`mobile/src/utils/answerQueue.ts`).
- **Estimate accuracy** (`patterns/estimateRatio.ts`, learned in `patternService`): `estimate_ratio:<category>` = median actual ÷ estimated duration (same-day work only; no partial-progress or rescheduled-after-start tasks; ratios 0.2–4; ≥ 5 samples). It is shown in Insights and drives one-tap duration suggestions on the task form and the chat draft card (≥ 15 min difference, rounded to 15 min, never automatic).
- **Evaluation**: `backend/scripts/checkin-report.ts` → `docs/checkin-evaluation-results.md`; method and threats to validity in [checkins-evaluation-method.md](checkins-evaluation-method.md).

### FR-RN-004 acceptance criteria → tests

Full wording and exact test names per criterion are in `docs/FRs/FUNCTIONAL REQUIREMENTS.md` §5.4. "Device" = also needs the manual device test (mobile code is typechecked, not unit-tested).

| Area | Automated tests | Manual |
|---|---|---|
| Eligibility (type, duration, fixed/routine/done, off switch, overdue) | `checkins.test.ts` "eligibility rules" | — |
| Timing rules (start +5, one follow-up, completion after duration + buffer, quiet hours/DND skip, short tasks, after-deadline drop, per-slot history, rescheduled after start) | `checkins.test.ts` (timing, follow-up, quiet hours, short tasks, deadline, slot history, rescheduled-after-start) | — |
| Caps: 3 per task, 5 per day, follow-ups dropped first | `checkins.test.ts` "per-task cap…", "daily cap…", "over the daily cap…" | — |
| Extra check-ins (+15/+30/+60): exempt from caps, max 2 per slot, past-deadline warning, concurrent taps create one | `checkins.test.ts` "user-requested extra time…", "+30 min past the deadline…"; `checkinService.test.ts` "two concurrent +30 answers…" | — |
| Tone: Funny default, saved style, Gentle after a hard mood without changing the setting, style requests in chat | `checkins.test.ts` "tone is the saved style…"; `checkinService.test.ts` "style: …", "plan: a hard mood…", "chat: style requests…", "choosing a style while check-ins are off…" | — |
| Copy generation: templates fit 120 chars, validator, Gemini → Ollama → library → none, breaker, AI unavailable, stale copy, privacy of the prompt | `checkinCopy.test.ts` (all), `checkinService.test.ts` "AI breaker…", "AI pacing…", "retry: Gemini…" | — |
| Research mode: stable 50/50, WITHHELD logged, only research rows compared | `checkinCopy.test.ts` "research mode can omit the first step"; `checkinService.test.ts` "plan: research mode records WITHHELD…"; `checkinEvaluation.test.ts` "research comparison…" | — |
| Response handling, every path: Started, Done, partial, +30, more time, Didn't, stale, cancelled, late tap, Urdu, atomic claim | `checkinService.test.ts` "respond: …" (allowed answers, Started, Done/partly/+30/refused, tap time clamp, old check-in, cancelled, DONE on cancelled, concurrent, late STARTED, Urdu), "maintenance: unanswered…", "plan: rows are persisted…" | device: Update… sheet |
| Offline queue and poison answers | `answerQueue.test.ts` (4xx, timeouts/5xx, offline, 10 attempts, 48 h, age from first try) | device: airplane mode, backend stopped |
| Notification scheduling (local notifications, actions, cold start, stale taps, cancel on re-plan) | server side: `checkinService.test.ts` "plan: rows are persisted with stable ids…" | device: all four device cases |
| Estimate ratio and suggestions (median, outliers, partial, rescheduled, <5 samples, same-day, by completion, 15-min rounding) | `estimateRatio.test.ts` | device: task form and chat card |
| Evaluation report (response rates, start rate + Wilson, per-user averages, acceptance dedupe, accuracy grouping, salted ids, CSV has no free text) | `checkinEvaluation.test.ts` | — |
| Logs survive task deletion; `startedAt` only on first IN_PROGRESS | `checkins.test.ts` (DB-backed) | — |

## Context handling (four memory layers)

| Layer | What | Where |
|---|---|---|
| Working memory | Dialogue state: the open question (pending slots), the tasks in focus ("it", "this"), undo targets | `Conversation.state` |
| Episodic memory | Every user message embedded (`nomic-embed-text`, 768-d) and recalled across conversations; rolling conversation summaries | `ConversationMessage.embedding`, `Conversation.summary` |
| Semantic memory | Durable facts, preferences, coping strategies, goals, course knowledge — de-duplicated (cosine ≥ 0.9 reinforces instead of duplicating), grounded (an LLM memory must be supported by the user's own words) | `MemoryItem` (`double precision[]` vectors) |
| Behavioural memory | Patterns learned from data: peak hours, category success, procrastination, routine adherence, mood cycles, late-night activity, preferred times — each with sample-size confidence; used only at ≥ 50 % | `UserPattern` |

Retrieval score = `0.55·similarity + 0.25·importance + 0.20·recency` (Generative-Agents style).
Context is assembled per turn into a budgeted block (≈1.1–2.2k chars) so it fits the small model.
pgvector is not available on Windows PG17, so similarity runs in-process per user; swapping in
pgvector only changes `candidateMemories()` in `memoryService.ts`.

Background learning (embeddings, extraction, summaries) runs after the reply and yields to live
requests, so it never adds latency.

## Turn pipeline (`backend/src/modules/assistant`)

`crisis check → chat command rules (registry) → working-memory resolution (answer to the open question, or
topic switch) → NLU (rules → LLM if unsure) → handler → reply with cards + one-tap actions → background learning`.

The same engine serves the app chat, voice, and WhatsApp, so memory is shared across channels.

### Chat commands (`assistant/commands/`)

What chat can do, per feature: [chat-coverage.md](chat-coverage.md). Each command in `registry.ts` has a name,
rule patterns (English, Urdu script, Roman Urdu; pure, no I/O), a zod argument schema, a reference resolver,
`execute` (reusing the services the REST routes use), a confirmation policy and an undo step. The intents that
existed before are wrapped (`wrapped.ts`), not rewritten: the main pipeline still runs them through `nlu.ts`.

- **Rules first, AI off works.** A new command is matched by its own rules right after the crisis check; dates and
  times come only from `entities.ts` (`extractTimeRange` and `extractWeekdays` were added for commands).
- **References** ("my gym routine", "the essay") resolve by fuzzy match; several matches ask "which one?" with
  numbered options (`command_choice`), none says so.
- **Confirmation**: deletes, bulk changes and skipping a mandatory routine ask once (`confirm_command`); the
  resolved arguments are stored, so "yes" runs exactly what was shown. A confirmation expires after 10 minutes: a later
  "yes" runs nothing and offers "Show it again" (the original words, re-run for a fresh preview).
- **Open questions come first** (`pendingAnswer.ts`): while a question is open, a plausible answer to it (yes / no in
  English, Urdu or Roman Urdu, a number, "done", "cancel", a date or time for a draft, a name from the list) goes to
  that question and never starts a command; if the question can't use it, it is asked again. Only a reply that is
  not an answer (e.g. "mark all done" to a time question) can replace the question. The reply's `answered` field
  says which question took it. Eval group: `pending` in `assistant-eval.json`.
- **Offers in chat replies** (`dialogue.ts` `acceptOffer`): when a model chat reply suggests "Say: …", that text is
  kept as the open question and shown as a button. "yes" / "sure" / "haan" runs it; "yes, for 6 pm" or "yes,
  tomorrow" runs it with that time or day; anything else drops it. English and Roman Urdu yes words only.
- **A time alone means today** (`draft.ts`): "call Mooz at 6 pm" is due today; if 6 PM has passed, the usual
  "tomorrow, or a later time today?" question asks. A reply that opens with "yes", "I mean" or "actually" never
  puts those words in the title, and the LLM (which sees the conversation) titles it ("Call Mooz").
- **Undo**: each change stores one undo step in the conversation state (`UndoRecord`: settings, routine,
  deleted routine, routine occurrence, task batch). "Undo" or the Undo button reverts the newest change, a
  command's or a task edit's, whichever came last. Window: 15 minutes, deletes 24 hours.
- **Bulk** (`bulk.ts`): move all of today to another day, complete all with a tag, delete all completed, delete all open tasks, postpone
  non-urgent. One preview with the titles (at most 25 tasks per confirmation; WhatsApp shows 8 and "…and N
  more"), one "yes", undone as one batch from per-task snapshots.
- **Several requests in one message** (`multi.ts`): split only at clause boundaries (and / aur / then / also /
  phir / اور / پھر) and only when every part parses on its own (a new task needs an explicit "add / remind me",
  so "buy bread and eggs" stays one task). Parts run in order with one summary reply; a part that has to ask
  (which one? confirm?) is asked, and at most one question per reply.
- **Fallback router** (`router.ts`, AI on and rules unsure, i.e. rule confidence below 0.75): two small
  schema-constrained calls, area then command, over the registry. The model returns a command name and argument
  words only; dates, times, durations and weekdays are re-extracted by `entities.ts`, the arguments are
  validated with the command's zod schema, and references resolve in code. If the rules accept the text after
  all, they win. Help is built from the registry.
- **Meaning-based router** (`meaning.ts`, `neighbours.ts`), **off by default** (`MEANING_ROUTER=on` turns it on). The
  gate below found no gain: with AI on it scores exactly what the LLM router without examples scores (English
  98.5% = 98.5%, Roman Urdu 98.3% = 98.3%), and with AI off it never beats the rules (98.0% / 96.6%), while it adds
  an embedding call per message (median 14 ms). Off, the chat routes as before: the rules, and the plain LLM
  router when the rules are unsure (below 0.75); no bank, no arbitration. When on: the 5 nearest rows of `tests/eval/utterance-bank.json`
  (embedded once per embedding model, cached in `backend/.cache`; hashed vectors with AI off) are given to the
  fallback router as examples and are a second opinion. Rules confidence below 0.75 (unchanged): the model picks,
  guided by the examples; if it disagrees with both the rules and a strong neighbour vote, the neighbours win.
  0.75–0.85: the rules. 0.85 and up (or a registry match): the rules, unless the neighbours strongly disagree and
  the model agrees with them; then one question with two buttons (arbitration). A command chosen by the neighbours
  alone that changes data is only offered as a button. Crisis detection runs first and is never routed. Neighbours
  never decide alone (AI off): see the gate below.
- **Unknown messages** (always on): no command fits → "I can't do that yet" and 3 things I can do (`unknownReply`);
  the message is appended to `backend/logs/unknown-utterances.jsonl` (masked text, language, time; no user id). `npm run unknown:review` makes review rows (in `backend/logs`, git-ignored), `npm run bank:approve`
  adds approved ones to the bank.
  **Privacy (unknown-message log):** `UNKNOWN_LOG=off` turns it off. Before writing, `maskForLog` replaces CNIC
  and phone numbers, any other run of 5+ digits, e-mails and links, and likely names: a capitalised word that is not
  the first one (short acronyms such as KFC are kept), a word after a cue ("call", "meet", "with", "sir", "Dr"),
  and a word before an Urdu honorific ("bhai", "baji", "sahab"). Names are guessed: a lower-case name with no cue
  ("mooz is my friend") stays. No user id, conversation id or device is written. The file is capped
  (`UNKNOWN_LOG_MAX_KB`, default 512 KB) and rotated once to `.1`, so at most about 1 MB is kept; it never leaves
  the server and is git-ignored. Review rows (`npm run unknown:review`) stay in `backend/logs` too.
- **Action contract**: every button, chip and suggestion carries a payload (`command` + args, or `answer` for one
  open question, or one of the older payloads), never a sentence for the engine to read again; `text` is what a
  WhatsApp user can type. A `command` payload with only a sentence is read by that command's own parser.
  `tests/actionContract.test.ts` taps every button from 20 conversations. Guards: `npm run typecheck` fails if
  `QuickAction.payload` becomes optional (`ACTION_PAYLOAD_REQUIRED` in `actions.ts`), and `tests/actionLint.test.ts`
  fails on any `{ label, text }` object in `backend/src` without a payload. See `docs/chat-failures.md`.
- **WhatsApp**: command replies are plain text; options become a numbered list (`formatReply`), "1" answers them,
  app-only buttons (open a screen) are dropped (and the numbers count only the listed ones), lists cap at 8.
- **Eval**: `npm run eval:assistant` (rules only, AI off) scores `tests/eval/assistant-eval.json` per command;
  `tests/eval/chat-holdout.json` is for a teammate and never tuned on.
- **Router gate** (`npm run eval:router`, `-- --model` with the models from `.env`): leave-one-out over the 259
  English and Roman Urdu bank rows, command accuracy. 25 Oct 2026, after #18 and #22 were merged:

  | | n | rules alone | neighbours alone | rules + model (before) | rules + neighbours + model |
  |---|---|---|---|---|---|
  | English, AI off (hashed vectors) | 201 | 98.0% | 42.8% | – | 98.0% |
  | Roman Urdu, AI off | 58 | 96.6% | 29.3% | – | 96.6% |
  | English, AI on (nomic-embed-text, qwen2.5:7b) | 201 | 98.0% | 53.7% | 98.5% | 98.5% |
  | Roman Urdu, AI on | 58 | 96.6% | 32.8% | 98.3% | 98.3% |

  The rules were written against most of these rows, so "rules alone" is optimistic. The combined path beats
  rules alone only with the model on, and only as much as the model router did before: the bank examples and the
  neighbour vote changed no answer on this bank (3–5 rows per command). Arbitration asked on 0 of the 253 rows the
  rules get right. Neighbours alone are off. Added time per message: median 14 ms, p95 20–29 ms with the embedding
  model (0.1 ms hashed); messages that call the model (7 of 259): median 4.2 s, as before. Held-out:
  `chat-holdout.json` has no scored rows yet, so there is no unbiased number.

## FR coverage

| Area | Status |
|---|---|
| FR-TM-001..008 tasks (Clarity Index, mandatory clarifications, type classification, chat edits, soft delete 24h, undo, scheduling, overload, splitting, progress, missed/overdue handling) | Implemented. From chat also: notes/description, per-task reminder mode, start, reopen, add/remove tags, category, add/list/complete subtasks (each undoable) |
| FR-RM-001..004 routines (frequency, priority, mandatory confirm, time-locked vs flexible, contexts) | Implemented. From chat: list, change time/days/title/priority/duration, pause/resume, delete (confirmed, undo 24 h), done/skip today, move one occurrence. Every N days (`intervalDays` 2..30 from `anchorDate`): created by chat ("every other day", "alternate days", "every 3 days", Roman Urdu "har doosre din") or in the routine form; "I already took it today" marks today done. The server's `routineMatchesDay` decides which days count; documents with these phrases make no routine and say so; changing an interval is done on the routine screen |
| FR-RN-001..003 reminders (escalating, peak-hour critical reminder, quiet hours, DND, adaptive on ignored reminders, per-task overrides, OS notifications with Done/Snooze) | Implemented. Routines (phase 1): every routine gets a time (given, part of day, or peak start hour; "no reminder" only on request); per pending occurrence a nudge 10 min before, the alarm at the time, a "Still to do" follow-up at +20 (mandatory: also +60) within 36 h; buttons Done / Snooze 15 min / Skip today; routines keep 24 of the 60 slots when both overflow. Not yet: routine reminder log, WhatsApp routine reminders, per-routine mode |
| FR-DP-001..004 documents (PDF/DOCX/OCR, cleaning, deadlines/schedules/timetables with confidence thresholds, course info, prerequisite question, grid timetables from PDFs and from photos/screenshots (positional: day rows, slot columns, coloured class blocks; image classes go to review), AI action items for other documents with date grounding, re-upload dedupe, CNIC/phone masking) | Implemented — scanned PDFs are rendered on the server and OCR'd (first 10 pages); images are preprocessed with sharp (EXIF rotate, deskew, denoise, contrast, upscale) and read in several page-segmentation modes, keeping the most confident; only English OCR works offline. Deadline rules (`documents/dateRules.ts`, dates still read by `entities.ts`): multi-line records joined, table columns mapped from the header row, week numbers from the semester start in the document (else undated, "needs the semester start"), ranges keep the end date, 2-digit years, OCR slips repaired inside date tokens only, day-first numbers, the year inferred from the term or the document's other dates; tickets, bills and notices found by event words and always reviewed; header rows are never items; deadlines OCR'd at below 90 % confidence are always reviewed. With AI on, every document also gets a model pass (masked text, chunks of 2,500 characters with overlap, at most 6 chunks / 2 minutes; `DOC_AI_SPLIT=on`, off by default, reads a dense chunk in pieces of at most 8 dated lines and halves a failed piece once): items it agrees with gain confidence (reviewed kinds stay ≤ 90), model-only items are review-only (≤ 80), and its dates must appear in the document. Each document gets at most 150 s (OCR + AI, `DOCUMENT_TIME_LIMIT_MS`); past that the rules' result comes back with a warning. The OCR queue refuses work (503 "try again in a minute") when 3 jobs are already waiting. Accuracy is measured by `npm run eval:documents` on synthetic fixtures: [document-eval-results.md](document-eval-results.md) |
| FR-MH-001..004 mood (detection + confirmation, check-in, mood→task mapping, stress chunking/postpone, coping memories, crisis safety, Pro conversation) | Implemented |
| FR-PL-001..002 patterns & recommendations with visible confidence | Implemented |
| FR-RN-004 start & completion check-ins (planner, templates + first step, respond endpoint, mobile notifications and sheet, estimate-ratio suggestions, evaluation report) | **COMPLETE** (device test pending) |
| FR-WA-001..002 WhatsApp (webhook, multi-turn, numbered replies, image OCR, reminders, 24h rule, bulk guard) | Implemented, **Pro-only** for everything (chat, tasks, images/PDFs, queries, reminders). **Verified linking**: the app shows an 8-character code, the user sends `LINK <code>` from WhatsApp (code hashed, 10-min expiry, 5 failures/hour per number); numbers can't be typed in. Webhook dedupes by MessageSid, answers with empty TwiML and replies through the REST API, one message at a time per number. Reminders re-plan on the server, are claimed atomically and re-checked against quiet hours/DND before sending, and are stored in the WhatsApp chat so "done"/"1" completes that task. Needs Twilio credentials in `.env`; manual test: `docs/whatsapp-e2e-checklist.md` |
| P2 Expo push: tasks/routines created on WhatsApp reach the phone | Implemented: `push/pushService.ts` behind a `PushProvider` interface (Expo; batches of 100, tickets and receipts, tokens deleted on DeviceNotRegistered, never logged; sign-out removal is queued on the phone and retried offline). A WhatsApp-created task or routine (chat or a document sent there) sends a visible "Added from WhatsApp" push with `{type: "sync"}`; the app syncs and re-plans local alarms. Needs EAS setup: `docs/push-setup.md` |
| P3 Urgent WhatsApp alerts (Pro, message only, no calls) | Implemented: `isUrgent` = pending, HIGH/URGENT priority, due within 3 h. One message per task (ReminderLog level URGENT), only inside the 24 h window (else `WHATSAPP_SKIPPED_WINDOW`), held back by quiet hours, DND and the daily cap. "Reply done / snooze 1h" works: snoozes are SNOOZE rows that survive re-plans (max 3 per task, 15 min–4 h, never past the due time; a time in quiet hours/DND moves to when they end, and the reply says so) |
| WhatsApp Agent (user's own agent, **Pro**, on by default; `WHATSAPP_AGENT=off` switches it off) | Implemented; **API facts unverified** until the probe runs (`docs/whatsapp-agent.md`, `docs/whatsapp-agent-findings.md`). A Pro user pastes their agent's API key in the app; the server does the rest (no server setup: the key-encryption secret is generated on first start). Keys AES-256-GCM at rest, never returned or logged. One long-poll loop per key (Postgres advisory lock, backoff with jitter, 401/400-100 → reconnect + push, 409 wait, 429 budget; Free users are not polled), updates claimed before handling and the offset saved after, no history replay. Text, voice notes (local whisper.cpp, on by default; "I heard: …"; "please type" when it isn't running) and photos/PDF/DOCX go through the same engine (channel `WHATSAPP_AGENT`, crisis check first, numbered replies). Documents never auto-create: "1 Add all / 2 Review in app / 3 Ignore" as a 10-minute confirm. Context window: 8 turns / 30 min / ~600 tokens, masked. Reminders on WhatsApp and the phone by default (Both), push fallback in WhatsApp-only mode. The Twilio path is unchanged |
| Deadline and class questions ("what's due today", "when is X due", overdue, most urgent, today's/next class, where is my class; en/ur/Roman Urdu) | Implemented, rule-based (`assistant/queries.ts`, answers in `assistant/queryAnswers.ts`); classes come from routines (`Routine.location` holds the room, only when it appears in the timetable), never from raw document text. Short plain-text replies; WhatsApp lists cap at 8 with "…and N more" |
| FR-VF-001..002 voice in/out (confidence < 80 % re-ask, 2 s silence, 2 min cap, TTS with rate/language) | Implemented with on-device STT (not Whisper). The recogniser gets up to 100 hints from the user's data (places, course codes, tags; never task titles; `contextualStrings`: Android 13+ and iOS), and the transcript's spelled letters (runs of 3+) are joined ("k f c" → "kfc") before sending |
| Find tasks and routines by topic ("is there any task related to KFC", "KFC wala kaam") | Implemented: command `find_items` (`commands/find.ts`, rules in English and Roman Urdu; Urdu-script questions planned after the deadline; replies also in Urdu; filter {terms, status, dateRange, priority, tag, place}; AI router may fill it, dates from entities.ts). `search/searchService.ts` searches title, notes, tags, category, subtasks, place name and address, routine title and location; exact word > substring > fuzzy (≥ 0.75) > Soundex; at most 8 with "matched in"; nothing found → says so and offers the 2 closest. Never falls back to today's list for a question that names a term. Eval: `npm run eval:queries` (seeded, in CI) |
| FR-MS-001..004 sync (offline queue, idempotent creates, field-level merge, versions/history 90 days, backoff) | Implemented for tasks only — local store is AsyncStorage, not SQLite; conflicts resolve last-write-wins without UI (see known-limitations.md) |
| FR-AN-001..002 analytics (ranges, comparison, categories, heatmap, routines, insights, CSV export) | Implemented — PDF export not implemented. From chat (read-only, deterministic): completed this week/month, streak, busiest weekday, planned time per category, overdue count, this week vs last week |
| FR-CT-001..002 categories & tags | Implemented |
| FR-AP-001..004 account, preferences, context scheduling | Implemented — UI is English-only (assistant replies follow the language setting; no RTL UI translation). From chat: quiet hours, Do Not Disturb (on / off / for N hours / until a time, max 24 h), where reminders go (WhatsApp needs Pro and a linked number), language, check-ins, settings summary; each change echoes the new value and is undoable, and the app reloads its preferences |
| FR-OB-001..002 onboarding & tutorials | Implemented |
| FR-VF-003 voice conversation (Phase 2) | Not implemented |
| FR-LB-001 location-based (geofence) reminders | Implemented (Pro tier, expo-location geofencing, Nominatim geocoding searched near the user first, 350m default radius, saved places named in a chat task title attached automatically; a Free user who names a place gets the task plus an invitation to Pro and Location reminders ("Go to Settings"); a Pro user with the toggle off gets an in-chat card with the Location reminders toggle (then the permission dialog, then "Set Home on the map" if the place isn't saved; the app sends its toggle state with each message); personal places (home, uni, office, hostel) are never searched on the map; places the map can't find get a "Set it on the map" card; location commands accept "change its location to …", "add/check for location of …" and ordinals from the last shown list ("2nd task from today, …"); map-first place picker with a draggable pin and a live radius circle, Leaflet + OpenStreetMap tiles in a WebView, optional when offline) — device test pending: `docs/map-picker-checklist.md` |
| Future work (out of scope): FR-OB-003 guest mode, calendar integration, collaboration, payments/subscriptions, desktop app | Not planned for this release |

Known gaps and platform restrictions (including the Google Play `USE_EXACT_ALARM` restriction, offline-sync scope and OCR languages): [known-limitations.md](known-limitations.md).
