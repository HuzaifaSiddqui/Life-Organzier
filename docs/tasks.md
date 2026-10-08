# Development Tasks

Feature-level status lives in [AI_ASSISTANT_ARCHITECTURE.md](AI_ASSISTANT_ARCHITECTURE.md) (FR coverage table);
known gaps in [known-limitations.md](known-limitations.md). This file tracks delivery phases.

**Final release:** 1 November 2026

| Phase | Scope | Status |
| --- | --- | --- |
| 1. Foundation | Expo app, Express + Prisma backend, PostgreSQL, environment setup | Complete |
| 2. Core platform | Firebase auth, user sync, task CRUD, dashboard, task forms | Complete |
| 3. AI layer | Chat assistant (rules + LLM NLU), clarity rules, confirmation flow, memory, voice input (on-device STT) and spoken replies (TTS) | Complete |
| 4. Smart features | Reminders (escalating, quiet hours, exact alarms), routines, scheduling, mood, patterns and recommendations, analytics + CSV export | Complete |
| 5. Documents | PDF / DOCX / image OCR extraction, grid timetables, AI action items for other documents, re-upload dedupe | Complete (OCR offline only for English — see known limitations) |
| 6. Channels and sync | WhatsApp via Twilio (needs credentials), offline task sync | Complete for tasks; routines/mood/memory are online-only |
| 7. UI redesign | Design system (tokens, primitives, Inter), all screens restyled | Restyled; dark mode and Urdu RTL not yet enabled (see docs/design.md flags) |
| 8. QA and release | Unit tests + CI, smoke script, security review, demo APK | In progress |

## FR-RN-004 check-ins (in progress)

| Phase | Scope | Status |
| --- | --- | --- |
| A | FR text in the FRD | Done |
| B | Data model (CheckinLog with slotStart, Task.startedAt/checkinCopy, settings), pure timing rules | Done |
| C | Message templates, background LLM copy, validator | In progress |
| D | Plan + respond endpoint, maintenance, style intent | Planned |
| E | Mobile notifications, Update… sheet, settings, planned-start field | Planned |
| F | Estimate accuracy, suggestions, evaluation report | Planned |
| G | Documentation | Planned |

Notes carried into later phases:
- **Phase D:** when a task's `scheduledStart` changes, mark the old slot's `SCHEDULED` CheckinLog rows `CANCELLED`.
- **Phase E:** cancel those check-ins' notifications on the phone when the slot changes.
- **Phase F:** exclude tasks rescheduled after starting (`rescheduledAfterStart`) from the estimate ratio.

## Open work before release

- Wire up `ConflictSheet` or remove it (sync conflicts currently resolve silently).
- Finish design-system migration so `DARK_MODE_READY` / `RTL_READY` can be turned on.
- Analytics PDF export (FR-AN-002) is not implemented; CSV export is.

## Future work (out of scope for this release)

Calendar integration · collaboration / shared tasks · FR-LB-001 location-based reminders ·
FR-OB-003 guest mode · payments / subscriptions · desktop app.
