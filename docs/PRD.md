# Life Organizer - PRD

## Vision

Life Organizer is an AI-powered productivity assistant that helps users create, organize and
complete tasks through manual input, chat, voice, documents and WhatsApp, and that adapts to
their habits and wellbeing.

## Goals

- Intelligent task management with clarity checks and smart scheduling
- AI-based task creation from natural language and documents
- Voice interaction
- Reliable reminders
- Mood-aware support
- Productivity insights from learned patterns

## Main modules (current release)

| Module | Status |
| --- | --- |
| Authentication and profile (Firebase) | Implemented |
| Task management (types, subtasks, soft delete, undo, versions) | Implemented |
| AI chat assistant (shared engine for chat / voice / WhatsApp) | Implemented |
| Voice assistant (on-device speech-to-text, text-to-speech) | Implemented; full voice conversation mode not implemented |
| Routines | Implemented |
| Reminder system | Implemented |
| Documents and OCR | Implemented (English OCR works offline; other languages download at runtime) |
| Mood tracking and support | Implemented |
| Analytics | Implemented (CSV export; PDF export not implemented) |
| Offline sync | Implemented for tasks only |
| WhatsApp channel | Implemented; needs Twilio credentials |

## Future work (out of scope)

Calendar integration · collaboration · location-based reminders (FR-LB-001) · guest mode
(FR-OB-003) · payments / subscriptions · desktop app.

## Constraints

- Delivery target: 1 November 2026.
- AI services must remain replaceable and accessed only through the backend.
- Free to run: local AI (Ollama), no paid services required.
