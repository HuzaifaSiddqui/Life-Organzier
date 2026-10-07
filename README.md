# Life-Organzier
An AI Life Organizer

**API & client implementation reference:** [docs/API_IMPLEMENTATION.md](docs/API_IMPLEMENTATION.md)

## Project Delivery Roadmap

**Target completion date: 1 November 2026**

The objective is to deliver the complete proposed Life Organizer system, including all approved modules, integrated workflows, testing, and a production-ready release by 1 November 2026.

### Delivery Phases

| Phase | Dates | Scope | Deliverable |
| --- | --- | --- | --- |
| 1. Foundation and Architecture | 21-27 Sep | Architecture, frontend, backend, database, development environment, API and AI design | Development-ready foundation |
| 2. Core Platform | 28 Sep-7 Oct | Authentication, user management, task management, dashboard, database models, and APIs | Complete productivity platform foundation |
| 3. AI Intelligence Layer | 8-17 Oct | NLP task understanding, AI chat assistant, task extraction, voice processing, and speech-to-text | AI assistant for creating and managing tasks |
| 4. Smart Features and Automation | 18-22 Oct | Reminders, notifications, recommendations, analytics, and personalization | Smart productivity features |
| 5. External Integrations | 23-25 Oct | Calendar, messaging where required, cloud services, and external APIs | Connected external ecosystem |
| 6. Advanced Modules | 26-27 Oct | OCR/document processing, collaboration, offline synchronization, location-based reminders, and additional AI capabilities | Feature-complete application |
| 7. System Integration | 28 Oct | End-to-end workflows, frontend/backend integration, database validation, AI integration, and external API validation | Integrated working application |
| 8. QA and Stabilization | 29-30 Oct | Functional, regression, security, and performance testing; bug fixing | Release candidate |
| 9. Deployment and Final Release | 31 Oct-1 Nov | Production deployment, final builds, environment configuration, demo validation, and documentation | Production-ready FYP system |

### Milestones

- Architecture complete: 27 Sep 2026
- Database, backend foundation, and authentication complete: 4 Oct 2026
- Core platform complete: 7 Oct 2026
- AI/NLP complete: 17 Oct 2026
- Voice assistant complete: 17 Oct 2026
- Smart features complete: 22 Oct 2026
- External integrations complete: 25 Oct 2026
- Advanced modules complete: 27 Oct 2026
- End-to-end system complete: 28 Oct 2026
- QA and stabilization complete: 30 Oct 2026
- Production release: 1 Nov 2026

### Final Objective

Deliver a complete, functional, tested, and production-ready Life Organizer platform by **1 November 2026**.

git checkout Staging-LifeOrganizer
git pull origin Staging-LifeOrganizer


git add .
git commit -m "feature update"
git push


# Expo app lives in `mobile/` — run these from repo root after `cd mobile`
cd mobile
npx expo start -c
npx expo prebuild --clean
npx expo run:android

cd backend
npm run dev

cd backend
npx prisma studio

## Local development setup

One-time:

```bash
ollama pull qwen2.5:7b          # assistant model (low-spec machine: set OLLAMA_MODEL=qwen2.5:1.5b in backend/.env)
ollama pull nomic-embed-text    # memory search embeddings
cd backend && npm install && npx prisma migrate deploy && npx prisma generate
cd ../mobile && npm install
```

Every time:

```bash
cd backend && npm run dev                     # API on http://localhost:5050 — /health shows AI model status
adb reverse tcp:5050 tcp:5050                 # phone on USB reaches the API at 127.0.0.1:5050 (redo after replugging)
cd mobile && npx expo start --dev-client      # or `npx expo run:android` after native changes
```

Checks (also run by GitHub Actions on every push): `cd backend && npm run typecheck && npm test`, `cd mobile && npx tsc --noEmit`.

