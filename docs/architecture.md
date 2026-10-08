# Life Organizer Architecture

Detailed assistant design and feature status: [AI_ASSISTANT_ARCHITECTURE.md](AI_ASSISTANT_ARCHITECTURE.md).

## Stack

- **Mobile:** React Native 0.86 + Expo SDK 57 + TypeScript
- **Backend:** Express 4 + TypeScript (Node 24)
- **Database:** PostgreSQL + Prisma ORM
- **AI:** Ollama (local) — `qwen2.5:7b` for language, `nomic-embed-text` for embeddings; optional Gemini provider. Deterministic rules run when the model is unavailable
- **Speech:** on-device speech recognition (`expo-speech-recognition`) and text-to-speech (`expo-speech`); not Whisper
- **OCR / documents:** tesseract.js (images), pdf-parse + pdfjs-dist (PDF text and grid timetables), mammoth (DOCX)
- **Notifications:** server plans reminders; the phone schedules them as local notifications (`expo-notifications`)
- **Messaging:** WhatsApp through Twilio (webhook + outbound reminders; requires credentials)

## Architecture flow

```
Expo app ──HTTPS (Firebase ID token, X-Timezone, X-Device-Id)──▶ Express API ──▶ Prisma ──▶ PostgreSQL
   │ offline task queue (AsyncStorage)                                │
   │ local notifications                                               ├──▶ Ollama (LLM + embeddings)
   │ on-device STT / TTS                                               └──▶ Twilio WhatsApp
WhatsApp user ──Twilio webhook──▶ same assistant engine
```

## Assistant turn

```
message → crisis check → open-question resolution → NLU (rules, LLM only if unsure)
        → handler (create/update/plan/mood/…) → deterministic checks (clarity, past date,
          capacity, routine conflict) → reply with cards + one-tap actions → background learning
```

## Rules

- AI keys and model calls stay on the backend.
- Providers must be replaceable (`LlmProvider`).
- Chat, voice and WhatsApp share one assistant engine.
- Ollama failure falls back to deterministic rules (circuit breaker).
- Dates, scheduling, reminders and safety are deterministic code, never the LLM.
