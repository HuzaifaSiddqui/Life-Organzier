# Rollback to the Ollama baseline

The baseline is the app as it was on 28 Oct 2026: tag **`baseline-ollama-v1`** (branch `baseline/ollama-v1`), commit
**2988159** (main after PRs #11–#22, including routine reminders #19). Its numbers are in
[`docs/baselines/ollama-v1.md`](baselines/ollama-v1.md). New behaviour is merged **off by default**; every layer below
returns to the baseline without losing data. Use the first layer that is enough.

## Layer 1 — environment switch (seconds, no deploy)

Set these in `backend/.env` and restart the backend (`npm run dev`, or the process manager). This reproduces the
baseline's AI behaviour on any later version, as long as each new feature is behind a flag that defaults to off.

```dotenv
# Baseline AI: local Ollama for chat and documents, Gemini only for check-in copy (as on 28 Oct 2026)
AI_ENABLED=true
AI_PROVIDER=ollama
OLLAMA_MODEL=qwen2.5:7b
OLLAMA_URL=http://127.0.0.1:11434
EMBEDDING_MODEL=nomic-embed-text
GEMINI_MODEL=gemini-3.8-flash
# GEMINI_API_KEY=<set: check-in first-step copy tries Gemini, then Ollama, then the built-in library>
# GEMINI_FALLBACK unset (Gemini is not in the chat/document chain)
MEANING_ROUTER=off
UNKNOWN_LOG=on
```

Every flag added after the baseline must be listed in `docs/rollout.md` with its baseline value (off). Setting all
of them to that value is part of this layer. Unset = baseline.

Ollama must be running with the same models: `ollama pull qwen2.5:7b && ollama pull nomic-embed-text` (baseline
digests: qwen2.5:7b `845dbda0ea48`, nomic-embed-text `0a109f422b47`; Ollama 0.34.3).

## Layer 2 — redeploy the tag (minutes)

When a change can't be switched off (a bug in code that always runs):

```bash
git fetch --tags
git worktree add ../life-organizer-baseline baseline-ollama-v1   # or: git checkout baseline-ollama-v1
cd ../life-organizer-baseline/backend && npm ci && npx prisma generate
npm run dev
```

- **Do not run `prisma migrate reset` or `db push`.** The baseline code works against a newer database as long as
  later migrations are additive only (new nullable columns and tables; nothing dropped, renamed or made required),
  which is the rule from 28 Oct 2026 on. The old Prisma client ignores columns it doesn't know.
- Don't run `prisma migrate deploy` from the baseline checkout against a newer database; it is not needed (the
  baseline's migrations are already applied) and Prisma will only report the newer ones as unknown.
- Offline copy of the whole repository: `../backups/life-organizer-baseline-ollama-v1.bundle`
  (`git clone life-organizer-baseline-ollama-v1.bundle life-organizer && git -C life-organizer checkout baseline-ollama-v1`).

## Layer 3 — the previous app on the phone

The backend API only gets additive changes, so the baseline APK keeps working against a newer backend, and a newer
APK against the baseline backend ignores fields that aren't there. To put the baseline app back:

```bash
git checkout baseline-ollama-v1
cd mobile && npm ci && npx expo run:android      # or install the APK built from this tag, if kept
```

Keep the APK built from the tag (`mobile/android/app/build/outputs/apk/…`) with the backups so this needs no build.

## Database

- **Backup at the baseline:** `../backups/life-organizer-db-baseline-ollama-v1.dump` (custom format, development
  database, 28 Oct 2026; local only, never committed: it holds personal data).
- Restore into a **new** database, never over the live one:
  `createdb life_organizer_restore && pg_restore -d life_organizer_restore ../backups/life-organizer-db-baseline-ollama-v1.dump`,
  then point `DATABASE_URL` at it.
- Rolling back code never needs a database rollback (migrations are additive). Data written by new features stays
  in its own columns/tables and is simply unused by the baseline.
- The test database (`TEST_DATABASE_URL`) and the shadow database (`SHADOW_DATABASE_URL`) are never used for data.

## Checking the rollback worked

```bash
cd backend && npm run eval:assistant && npm run eval:queries && npm run eval:documents && npm run eval:router
npx tsx scripts/bench-latency.ts --ai
```

Compare with `docs/baselines/ollama-v1.md`: the numbers must match (latency within normal variation).
