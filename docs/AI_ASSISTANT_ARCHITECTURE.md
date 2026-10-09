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

`crisis check → working-memory resolution (answer to the open question, or topic switch) →
NLU (rules → LLM if unsure) → handler → reply with cards + one-tap actions → background learning`.

The same engine serves the app chat, voice, and WhatsApp, so memory is shared across channels.

## FR coverage

| Area | Status |
|---|---|
| FR-TM-001..008 tasks (Clarity Index, mandatory clarifications, type classification, chat edits, soft delete 24h, undo, scheduling, overload, splitting, progress, missed/overdue handling) | Implemented |
| FR-RM-001..004 routines (frequency, priority, mandatory confirm, time-locked vs flexible, contexts) | Implemented |
| FR-RN-001..003 reminders (escalating, peak-hour critical reminder, quiet hours, DND, adaptive on ignored reminders, per-task overrides, OS notifications with Done/Snooze) | Implemented |
| FR-DP-001..004 documents (PDF/DOCX/OCR, cleaning, deadlines/schedules/timetables with confidence thresholds, course info, prerequisite question, grid timetable PDFs, AI action items for other documents with date grounding, re-upload dedupe, CNIC/phone masking) | Implemented — scanned PDFs need to be uploaded as images; only English OCR works offline |
| FR-MH-001..004 mood (detection + confirmation, check-in, mood→task mapping, stress chunking/postpone, coping memories, crisis safety, Pro conversation) | Implemented |
| FR-PL-001..002 patterns & recommendations with visible confidence | Implemented |
| FR-RN-004 start & completion check-ins (planner, templates + first step, respond endpoint, mobile notifications and sheet, estimate-ratio suggestions, evaluation report) | **COMPLETE** (device test pending) |
| FR-WA-001..002 WhatsApp (webhook, multi-turn, numbered replies, image OCR, Pro reminders, 24h rule, bulk guard) | Implemented — needs Twilio credentials in `.env` |
| FR-VF-001..002 voice in/out (confidence < 80 % re-ask, 2 s silence, 2 min cap, TTS with rate/language) | Implemented with on-device STT (not Whisper) |
| FR-MS-001..004 sync (offline queue, idempotent creates, field-level merge, versions/history 90 days, backoff) | Implemented for tasks only — local store is AsyncStorage, not SQLite; conflicts resolve last-write-wins without UI (see known-limitations.md) |
| FR-AN-001..002 analytics (ranges, comparison, categories, heatmap, routines, insights, CSV export) | Implemented — PDF export not implemented |
| FR-CT-001..002 categories & tags | Implemented |
| FR-AP-001..004 account, preferences, context scheduling | Implemented — UI is English-only (assistant replies follow the language setting; no RTL UI translation) |
| FR-OB-001..002 onboarding & tutorials | Implemented |
| FR-VF-003 voice conversation (Phase 2) | Not implemented |
| Future work (out of scope): FR-OB-003 guest mode, FR-LB-001 geofence reminders, calendar integration, collaboration, payments/subscriptions, desktop app | Not planned for this release |

Known gaps and platform restrictions (including the Google Play `USE_EXACT_ALARM` restriction, offline-sync scope and OCR languages): [known-limitations.md](known-limitations.md).
