# Life Organizer — AI Assistant Architecture

## Running it

```bash
# one-time
ollama pull qwen2.5:7b
ollama pull nomic-embed-text
cd backend && npx prisma migrate deploy && npx prisma generate

# every time
cd backend && npm run dev          # API on :5050
cd mobile  && npx expo run:android # rebuild needed: expo-document-picker + expo-speech were added

# checks
cd backend && npm test             # 24 unit tests (NLU, clarity, scheduling, reminders, extraction)
cd backend && npm run smoke        # 60 HTTP checks against a temporary DB-only user
cd backend && npm run e2e          # multi-turn conversation against the real local LLM
```

## Design principle

A small local model (Qwen 2.5 7B) is good at language but bad at arithmetic and consistency. So the LLM does
**narrow, schema-constrained jobs** (intent when rules are unsure, titles, empathetic replies,
memory extraction, sub-task names, topics), while **dates, clarity scoring, scheduling,
reminders, patterns and safety are deterministic code**. If Ollama is down, a circuit breaker
skips it and the assistant keeps working on rules.

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
| FR-DP-001..004 documents (PDF/DOCX/OCR, cleaning, deadlines/schedules/timetables with confidence thresholds, course info, prerequisite question) | Implemented — scanned PDFs need to be uploaded as images |
| FR-MH-001..004 mood (detection + confirmation, check-in, mood→task mapping, stress chunking/postpone, coping memories, crisis safety, Pro conversation) | Implemented |
| FR-PL-001..002 patterns & recommendations with visible confidence | Implemented |
| FR-WA-001..002 WhatsApp (webhook, multi-turn, numbered replies, image OCR, Pro reminders, 24h rule, bulk guard) | Implemented — needs Twilio credentials in `.env` |
| FR-VF-001..002 voice in/out (confidence < 80 % re-ask, 2 s silence, 2 min cap, TTS with rate/language) | Implemented with on-device STT (not Whisper) |
| FR-MS-001..004 sync (offline queue, idempotent creates, field-level merge, versions/history 90 days, backoff) | Implemented — local store is AsyncStorage, not SQLite |
| FR-AN-001..002 analytics (ranges, comparison, categories, heatmap, routines, insights, CSV export) | Implemented — PDF export not implemented |
| FR-CT-001..002 categories & tags | Implemented |
| FR-AP-001..004 account, preferences, context scheduling | Implemented — UI is English-only (assistant replies follow the language setting; no RTL UI translation) |
| FR-OB-001..002 onboarding & tutorials | Implemented |
| FR-OB-003 guest mode, FR-LB-001 geofence reminders, FR-VF-003 voice conversation (Phase 2), payments | Not implemented |
