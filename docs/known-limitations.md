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
- **Tasks classified DEADLINE are not auto-scheduled at creation.** `classifyTaskType` marks "assignment", "submit",
  "due", "by …" as DEADLINE before looking at duration, and chat creation only auto-schedules DURATION/FLEXIBLE tasks
  and only offers "Find time for it" when there is no duration. A DEADLINE task with a duration therefore has no
  `scheduledStart` (and no check-ins) until the user books a slot ("Find time for it" in task detail) or sets a
  planned start.

## Platform and UI

- Dark mode and Urdu right-to-left layout are built but switched off (`DARK_MODE_READY`, `RTL_READY`); see
  [design.md](design.md) for the checklist before turning them on.
- Speech recognition is on-device (no Whisper); quality depends on the phone's speech service.
- WhatsApp needs Twilio credentials; without them the webhook only works with `WHATSAPP_ALLOW_UNSIGNED=true` (local testing).

## Safety

- Crisis detection is a deterministic phrase list (English, Roman Urdu, Urdu script) in
  `backend/src/modules/mood/crisis.ts`. It must be reviewed by a native Urdu speaker before release, and the
  helpline numbers in `CRISIS_RESOURCES` must be verified (`// VERIFY BEFORE RELEASE`). A mental-health helpline
  is intentionally left as a placeholder (not shown) until someone verifies one.
