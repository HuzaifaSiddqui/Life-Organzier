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
- **Undo**: each change stores one undo step in the conversation state (`UndoRecord`: settings, routine,
  deleted routine, routine occurrence, task batch). "Undo" or the Undo button reverts the newest change, a
  command's or a task edit's, whichever came last. Window: 15 minutes, deletes 24 hours.
- **Bulk** (`bulk.ts`): move all of today to another day, complete all with a tag, delete all completed, postpone
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
  all, they win. No match → `capabilities.ts` replies with 4–5 things I can do closest to the message (never a
  generic chat answer); the same happens for chit-chat when no model is available. Help is built from the registry.
- **WhatsApp**: command replies are plain text; options become a numbered list (`formatReply`), "1" answers them,
  app-only buttons (open a screen) are dropped, lists cap at 8.
- **Eval**: `npm run eval:assistant` (rules only, AI off) scores `tests/eval/assistant-eval.json` per command;
  `tests/eval/chat-holdout.json` is for a teammate and never tuned on.

## FR coverage

| Area | Status |
|---|---|
| FR-TM-001..008 tasks (Clarity Index, mandatory clarifications, type classification, chat edits, soft delete 24h, undo, scheduling, overload, splitting, progress, missed/overdue handling) | Implemented. From chat also: notes/description, per-task reminder mode, start, reopen, add/remove tags, category, add/list/complete subtasks (each undoable) |
| FR-RM-001..004 routines (frequency, priority, mandatory confirm, time-locked vs flexible, contexts) | Implemented. From chat: list, change time/days/title/priority/duration, pause/resume, delete (confirmed, undo 24 h), done/skip today, move one occurrence |
| FR-RN-001..003 reminders (escalating, peak-hour critical reminder, quiet hours, DND, adaptive on ignored reminders, per-task overrides, OS notifications with Done/Snooze) | Implemented |
| FR-DP-001..004 documents (PDF/DOCX/OCR, cleaning, deadlines/schedules/timetables with confidence thresholds, course info, prerequisite question, grid timetable PDFs, AI action items for other documents with date grounding, re-upload dedupe, CNIC/phone masking) | Implemented — scanned PDFs are rendered on the server and OCR'd (first 10 pages); images are preprocessed with sharp (EXIF rotate, deskew, denoise, contrast, upscale) and read in several page-segmentation modes, keeping the most confident; only English OCR works offline. Deadline rules (`documents/dateRules.ts`, dates still read by `entities.ts`): multi-line records joined, table columns mapped from the header row, week numbers from the semester start in the document (else undated, "needs the semester start"), ranges keep the end date, 2-digit years, OCR slips repaired inside date tokens only, day-first numbers, the year inferred from the term or the document's other dates; tickets, bills and notices found by event words and always reviewed; header rows are never items; deadlines OCR'd at below 90 % confidence are always reviewed. With AI on, every document also gets a model pass (masked text, chunks of 2,500 characters with overlap, at most 6 chunks / 2 minutes): items it agrees with gain confidence (reviewed kinds stay ≤ 90), model-only items are review-only (≤ 80), and its dates must appear in the document. Each document gets at most 150 s (OCR + AI, `DOCUMENT_TIME_LIMIT_MS`); past that the rules' result comes back with a warning. The OCR queue refuses work (503 "try again in a minute") when 3 jobs are already waiting. Accuracy is measured by `npm run eval:documents` on synthetic fixtures: [document-eval-results.md](document-eval-results.md) |
| FR-MH-001..004 mood (detection + confirmation, check-in, mood→task mapping, stress chunking/postpone, coping memories, crisis safety, Pro conversation) | Implemented |
| FR-PL-001..002 patterns & recommendations with visible confidence | Implemented |
| FR-RN-004 start & completion check-ins (planner, templates + first step, respond endpoint, mobile notifications and sheet, estimate-ratio suggestions, evaluation report) | **COMPLETE** (device test pending) |
| FR-WA-001..002 WhatsApp (webhook, multi-turn, numbered replies, image OCR, reminders, 24h rule, bulk guard) | Implemented, **Pro-only** for everything (chat, tasks, images/PDFs, queries, reminders). **Verified linking**: the app shows an 8-character code, the user sends `LINK <code>` from WhatsApp (code hashed, 10-min expiry, 5 failures/hour per number); numbers can't be typed in. Webhook dedupes by MessageSid, answers with empty TwiML and replies through the REST API, one message at a time per number. Reminders re-plan on the server, are claimed atomically and re-checked against quiet hours/DND before sending, and are stored in the WhatsApp chat so "done"/"1" completes that task. Needs Twilio credentials in `.env`; manual test: `docs/whatsapp-e2e-checklist.md` |
| P2 Expo push: tasks/routines created on WhatsApp reach the phone | Implemented: `push/pushService.ts` behind a `PushProvider` interface (Expo; batches of 100, tickets and receipts, tokens deleted on DeviceNotRegistered, never logged; sign-out removal is queued on the phone and retried offline). A WhatsApp-created task or routine (chat or a document sent there) sends a visible "Added from WhatsApp" push with `{type: "sync"}`; the app syncs and re-plans local alarms. Needs EAS setup: `docs/push-setup.md` |
| P3 Urgent WhatsApp alerts (Pro, message only, no calls) | Implemented: `isUrgent` = pending, HIGH/URGENT priority, due within 3 h. One message per task (ReminderLog level URGENT), only inside the 24 h window (else `WHATSAPP_SKIPPED_WINDOW`), held back by quiet hours, DND and the daily cap. "Reply done / snooze 1h" works: snoozes are SNOOZE rows that survive re-plans (max 3 per task, 15 min–4 h, never past the due time; a time in quiet hours/DND moves to when they end, and the reply says so) |
| Deadline and class questions ("what's due today", "when is X due", overdue, most urgent, today's/next class, where is my class; en/ur/Roman Urdu) | Implemented, rule-based (`assistant/queries.ts`, answers in `assistant/queryAnswers.ts`); classes come from routines (`Routine.location` holds the room, only when it appears in the timetable), never from raw document text. Short plain-text replies; WhatsApp lists cap at 8 with "…and N more" |
| FR-VF-001..002 voice in/out (confidence < 80 % re-ask, 2 s silence, 2 min cap, TTS with rate/language) | Implemented with on-device STT (not Whisper) |
| FR-MS-001..004 sync (offline queue, idempotent creates, field-level merge, versions/history 90 days, backoff) | Implemented for tasks only — local store is AsyncStorage, not SQLite; conflicts resolve last-write-wins without UI (see known-limitations.md) |
| FR-AN-001..002 analytics (ranges, comparison, categories, heatmap, routines, insights, CSV export) | Implemented — PDF export not implemented. From chat (read-only, deterministic): completed this week/month, streak, busiest weekday, planned time per category, overdue count, this week vs last week |
| FR-CT-001..002 categories & tags | Implemented |
| FR-AP-001..004 account, preferences, context scheduling | Implemented — UI is English-only (assistant replies follow the language setting; no RTL UI translation). From chat: quiet hours, Do Not Disturb (on / off / for N hours / until a time, max 24 h), where reminders go (WhatsApp needs Pro and a linked number), language, check-ins, settings summary; each change echoes the new value and is undoable, and the app reloads its preferences |
| FR-OB-001..002 onboarding & tutorials | Implemented |
| FR-VF-003 voice conversation (Phase 2) | Not implemented |
| FR-LB-001 location-based (geofence) reminders | Implemented (Pro tier, expo-location geofencing, Nominatim geocoding searched near the user first, 350m default radius, saved places named in a chat task title attached automatically; map-first place picker with a draggable pin and a live radius circle, Leaflet + OpenStreetMap tiles in a WebView, optional when offline) — device test pending: `docs/map-picker-checklist.md` |
| Future work (out of scope): FR-OB-003 guest mode, calendar integration, collaboration, payments/subscriptions, desktop app | Not planned for this release |

Known gaps and platform restrictions (including the Google Play `USE_EXACT_ALARM` restriction, offline-sync scope and OCR languages): [known-limitations.md](known-limitations.md).
