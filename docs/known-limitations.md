# Known limitations

Gaps and platform restrictions in the current release. Feature status: [AI_ASSISTANT_ARCHITECTURE.md](AI_ASSISTANT_ARCHITECTURE.md).

## Reminders

- **Google Play and exact alarms.** `app.json` requests `USE_EXACT_ALARM` and `SCHEDULE_EXACT_ALARM` so reminders
  fire on time on Android 14+. That's fine for the demo APK, but Google Play only allows `USE_EXACT_ALARM` for
  apps whose core function is an alarm clock or calendar. A Play Store release must drop `USE_EXACT_ALARM`
  and either request `SCHEDULE_EXACT_ALARM` at runtime (the user grants it in system settings) or fall back to
  inexact alarms (Android may then delay a reminder by up to about an hour; expo-notifications already falls back
  automatically when exact alarms aren't allowed).
- **Local notification cap.** iOS keeps at most 64 pending local notifications. The app schedules the soonest 60
  and logs how many later ones it skipped; they're scheduled on a later re-sync (app open, any task/routine/
  settings change). If the app isn't opened for days, later reminders may be missing until it is.
- Reminders are planned 7 days ahead; the WhatsApp reminder job only runs when Twilio is configured.

## Offline sync

- **Only tasks sync offline.** Routines, mood logs, memories, documents and settings call the API directly and
  need a connection.
- **Conflicts compare device clocks.** A true conflict (both sides changed the same field) is resolved by the newer
  `clientModifiedAt`, which comes from the device clock. A phone with a wrong clock can win or lose conflicts
  incorrectly. Fields changed on only one side always merge correctly.
- **No conflict UI.** `ConflictSheet` exists in `mobile/src/components/primitives/feedback.tsx` but no screen uses it;
  conflicts resolve silently on the server.

## Check-in answers

- **An answer is claimed before the task is updated.** The respond endpoint marks the check-in ANSWERED first (so
  concurrent or repeated taps apply once), then updates the task. If the task update fails (e.g. the database drops
  mid-request), a retry returns `alreadyAnswered` and that answer is lost; the user would change the task by hand.

## Documents and OCR

- **OCR languages.** tesseract.js downloads language data on first use and caches it in the backend's working
  directory. Only `eng.traineddata` is committed (`backend/eng.traineddata`, ~5 MB, used when the server is started
  from `backend/`). Every other language offered in the app — including Urdu (`urd`) — is downloaded from the
  jsDelivr CDN at runtime, so OCR in those languages fails without internet.
  - To bundle Urdu: download `https://cdn.jsdelivr.net/npm/@tesseract.js-data/urd/4.0.0_best_int/urd.traineddata.gz`
    (~1.0 MB compressed), gunzip it into `backend/` as `urd.traineddata` (a few MB), and commit it — or set
    `langPath`/`cachePath` in `createWorker` (`documents/textExtraction.ts`) to a dedicated `tessdata/` folder.
- Scanned PDFs without a text layer must be uploaded as images.
- Grid timetables are read from the PDF text layer; image timetables use the line-based extraction only.

## Task classification

- **Study sessions for an exam become fixed events.** "Study for exam tomorrow 5 PM for 2 hours" is classified
  FIXED, because `FIXED_RE` in `assistant/entities.ts` matches "exam" together with a time. The study session is then
  treated as an unmovable event (not auto-scheduled, not offered for moving) and gets no start/completion check-ins.
- **Most student tasks are classified DEADLINE.** `classifyTaskType` marks "assignment", "submit", "due", "by …" as
  DEADLINE before looking at duration. In chat, a DEADLINE task with a duration is auto-scheduled only when a free
  slot ends before its deadline; otherwise it is created without a work block (no check-ins) and the reply offers
  "Find time for it". Tasks added through the task form get a work block only if the user sets a planned start.

## Platform and UI

- Dark mode and Urdu right-to-left layout are built but switched off (`DARK_MODE_READY`, `RTL_READY`); see
  [design.md](design.md) for the checklist before turning them on.
- Speech recognition is on-device (no Whisper); quality depends on the phone's speech service.
- WhatsApp needs Twilio credentials; without them the webhook only works with `WHATSAPP_ALLOW_UNSIGNED=true` (local testing).

## Check-in first steps

- **Task titles go to Google when Gemini is configured.** With `GEMINI_API_KEY` set, the first step for each
  scheduled task is requested from Gemini. Only the task title and planned duration are sent (no description,
  notes, mood or user details), but titles can still be personal ("Doctor appointment for …"). Unset the key to
  keep everything local (Ollama for English, keyword library for Urdu).
- **Ollama writes English first steps only**; Urdu users get Gemini or the keyword library.
- The keyword library covers common student tasks; anything else gets a check-in without a first step.
- **Gemini on a free key is often busy.** In testing about half the calls returned 503 (high demand) or 429. Failed
  calls fall back to the library; for slots more than 30 minutes away the backend retries Gemini up to twice in
  the background. After a 429 Gemini is skipped for 10 minutes (`GEMINI_RATE_LIMIT_COOLDOWN_MS`); background
  calls are spaced at least 4 s apart (`GEMINI_MIN_INTERVAL_MS`). `/health` shows the last Gemini error type.

## Safety

- Crisis detection is a deterministic phrase list (English, Roman Urdu, Urdu script) in
  `backend/src/modules/mood/crisis.ts`. It must be reviewed by a native Urdu speaker before release, and the
  helpline numbers in `CRISIS_RESOURCES` must be verified (`// VERIFY BEFORE RELEASE`). A mental-health helpline
  is intentionally left as a placeholder (not shown) until someone verifies one.
