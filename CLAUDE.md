# Life Organizer — guide for AI coding assistants

AI personal assistant (Final Year Project, deadline 1 Nov 2026). Users type, speak, upload documents
or message on WhatsApp; the app turns that into tasks, routines, reminders and a daily plan, tracks
mood and learns habits. Target users are students in Pakistan (English + Urdu).

## Stack

| Part | Tech |
|---|---|
| Mobile (`mobile/`) | Expo SDK 57, React Native 0.86, React 19, TypeScript, React Navigation (native stack), axios, Firebase Auth (client), expo-notifications, expo-speech / expo-speech-recognition, Reanimated 4 + gesture-handler, react-hook-form + zod |
| Backend (`backend/`) | Node 24, Express 4, TypeScript (ESM, run with `tsx`), Prisma 6 + PostgreSQL, firebase-admin, zod, multer, pdf-parse / pdfjs-dist, mammoth (DOCX), tesseract.js (OCR) |
| AI | Ollama (local): `qwen2.5:7b` chat (`OLLAMA_MODEL`), `nomic-embed-text` embeddings. Optional Gemini provider (off by default) |
| CI | `.github/workflows/ci.yml`: backend typecheck + tests, mobile typecheck |

## Repo layout

```
backend/
  src/app.ts, server.ts        Express app, routes under /api, /health
  src/ai/llm.ts                Provider chain (Ollama, Gemini) + circuit breaker, startup model check
  src/ai/embeddings.ts         Embeddings with hashed fallback
  src/lib/                     http (auth/user middleware, handle, HttpError), time, text helpers
  src/jobs/maintenance.ts      Hourly purge + WhatsApp reminder job
  src/modules/<area>/          Routes + services per area:
    assistant/  (dialogue.ts = turn pipeline, nlu.ts, entities.ts, draft.ts, handlers.ts, responder.ts, briefing.ts)
    tasks/ routines/ reminders/ scheduling/ sync/ documents/ memory/ mood/ patterns/
    analytics/ conversations/ settings/ account/ auth/ users/ events/ preferences/ whatsapp/
  prisma/schema.prisma, migrations/
  tests/*.test.ts              node:test unit tests (no DB / Firebase needed)
  scripts/http-smoke.ts, e2e-conversation.ts
mobile/
  src/screens/<area>/          Screens (dashboard, assistant, tasks, routines, documents, insights, mood, profile, auth, onboarding)
  src/components/primitives/   Design-system primitives (Text, Button, Card, Chip, Sheet, Snackbar, …)
  src/components/ui.tsx        Re-exports primitives + composites; deprecated static `ui` styles
  src/components/icons/Icon.tsx  The only icon set (line icons)
  src/theme/tokens.ts          All design tokens; ThemeProvider.tsx (`useTheme()`)
  src/i18n/strings.ts          UI copy (en + ur); LocaleProvider.tsx (`useLocale()`)
  src/services/                API clients, syncEngine (offline queue), reminders (local notifications), speech
  src/constants/theme.ts       Deprecated legacy palette mapped onto tokens (unmigrated screens)
```

## Run, test, typecheck

```bash
# one-time
ollama pull qwen2.5:7b && ollama pull nomic-embed-text
cd backend && npm install && npx prisma migrate deploy && npx prisma generate
cd ../mobile && npm install

# run
cd backend && npm run dev                 # http://localhost:5050 (PORT in backend/.env); GET /health
adb reverse tcp:5050 tcp:5050             # USB phone reaches the API at 127.0.0.1:5050
cd mobile && npx expo start --dev-client  # or `npx expo run:android` after native changes / new native deps

# checks
cd backend && npm run typecheck && npm test
cd mobile && npx tsc --noEmit
cd backend && npm run smoke               # HTTP checks; needs DB + running server
```

After adding native packages, restart Metro with `-c` (stale cache crashes the app).

## Architecture rules

- **The LLM does narrow, schema-constrained jobs only**: intent when rules are unsure, titles,
  empathetic replies, memory extraction, sub-task names, document action items. Output is JSON
  validated with zod; failures return `null` and the rules path continues.
- **Deterministic code owns** dates/times, the Clarity Index, scheduling, reminders, patterns,
  overload/conflict checks and **safety (crisis detection)**. Never route these through the LLM.
- **AI only via the backend.** The mobile app never calls a model or holds AI keys.
- **One engine for every channel.** App chat, voice and WhatsApp all go through
  `handleAssistantMessage` in `assistant/dialogue.ts`; memory is shared across channels.
- **Providers are replaceable** (`LlmProvider` in `ai/llm.ts`). If Ollama is down, the circuit
  breaker skips it and the assistant keeps working on rules.
- AI-proposed data is never trusted blindly: document dates must appear in the document; AI items
  are never auto-created; personal numbers (CNIC, phone) are masked before storage/LLM.
- Every query is scoped by `userId` from the verified Firebase token (`requireFirebaseUser` + `requireUser`).

## Authoritative docs

- `docs/AI_ASSISTANT_ARCHITECTURE.md` — **feature status** (FR coverage) and assistant pipeline.
- `docs/design.md` — **all UI work** (tokens, primitives, rules, migration log).
- `docs/API_IMPLEMENTATION.md` — REST API reference.
- `docs/FRs/FUNCTIONAL REQUIREMENTS.md` — functional requirements (FR-xx-nnn codes).
- `docs/known-limitations.md` — known gaps and platform restrictions.

## Out of scope (future work — do not implement)

- Calendar integration (Google/Outlook)
- Collaboration / shared tasks
- FR-LB-001 location-based (geofence) reminders
- FR-OB-003 guest mode
- Payments / subscriptions (the Pro tier is a settings flag, no billing)
- Desktop app

## Rules for changes

- Run backend `npm run typecheck && npm test` and mobile `npx tsc --noEmit` before finishing any task.
- Add a unit test for non-trivial logic (parsers, merge rules, planners, safety checks).
- UI work follows `docs/design.md` and updates it (tokens, components, migration log) in the same change.
  Use primitives + `useTheme()`; no raw hex, no emoji as icons, copy via `t()` where migrated.
- Keep docs in sync with code: update feature status in `docs/AI_ASSISTANT_ARCHITECTURE.md` and
  limitations in `docs/known-limitations.md` when behaviour changes.
- Stay in the TypeScript / React Native ecosystem (no Flutter or other rewrites); keep modules separated
  by area; reuse existing components and helpers before adding new ones.
- Never show technical AI details to users (model names, raw errors). The only scores shown are the
  confidence values the FRs require (pattern recommendations, document extraction).
- **Clarity score is internal only.** It drives auto-create vs review and is logged/stored, but users
  see which details are missing ("Needs: time, duration"), never a clarity percentage.
- Don't commit secrets (`.env` is git-ignored; document new variables in `backend/.env.example`).
- Database changes go through Prisma migrations, never `db push`.
- Low-spec machines can set `OLLAMA_MODEL=qwen2.5:1.5b` locally; the default stays `qwen2.5:7b`.
