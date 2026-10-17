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

## Notification actions

- **Every notification button opens the app.** There is no background task handler (`expo-task-manager` isn't
  installed), so action buttons — reminder Done / Snooze and check-in Started / Not today / Done / +30 min / Update…
  — briefly open the app and apply the answer there. A tap that launches the app from a cold start is picked up
  with `getLastNotificationResponseAsync` and handled once (the OS reports the same tap again on later starts, so the
  handled response is remembered).
- **Answering offline:** the task changes on the phone straight away and the answer is queued with its tap time; it is
  sent after the next successful sync (reconnect or app open). Until then the server may still fire a check-in that
  the answer would have cancelled, and a "next" check-in (e.g. completion after "Started") is only scheduled after
  the answer reaches the server.
- **Android shows at most 3 action buttons**; the completion check-in uses exactly 3 (Done / +30 min / Update…). The
  other options (partly done, +15 / +60, didn't get to it) are in the in-app sheet.
- **Check-ins in quiet hours or Do Not Disturb are skipped, not moved** (FR-RN-004 §4).

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

## WhatsApp (FR-WA)

- **Pro only.** Free accounts that are linked get one "WhatsApp is a Pro feature" reply a day and nothing is processed.
- **24-hour window.** WhatsApp only allows free-form messages within 24 hours of the user's last message. Reminders are sent only inside that window (no approved templates); outside it the phone's local notification covers it, and a send rejected by Twilio for a closed window (error 63016) marks the reminder skipped, not retried.
- **Sandbox join expiry.** On the Twilio sandbox each tester must send the `join <code>` message first, and that join expires after 72 hours of inactivity; then messages stop until they join again.
- **No voice notes.** Audio messages get a "please type" reply. **No calls** (future work).
- **Replies are English.** Questions are understood in English, Urdu and Roman Urdu, but deadline and class answers are written in English.
- **In-memory state per server process.** The per-number message queue, link-failure counts and "once an hour/day" notices (each capped at 10,000 entries, oldest dropped first) reset on restart (lost messages are covered by the "please resend" sweep every 5 minutes). Several backend instances would need these in the database.
- **Lost messages.** A message still unanswered after 5 minutes and not being processed (e.g. the server restarted mid-way) gets "Sorry, I missed that, please resend". A slow job on the same server is left alone; with several backend instances one instance can't see another's jobs.
- **Crisis messages are answered for everyone.** The crisis check runs on every WhatsApp text before the link/Pro checks, so unlinked numbers and Free accounts get the support resources too; nothing about such a message is stored.
- **Push needs EAS setup** (projectId, FCM V1 key, `google-services.json`, dev-client rebuild; `docs/push-setup.md`). Without it, a task added on WhatsApp appears at the next sync. The push text (task title) passes through Expo and Google FCM. Pending push receipts are kept in memory, so a restart skips their check (a dead token is removed the next time a push to it fails).
- **Urgent alerts** are WhatsApp messages only (no calls), one per task, for pending HIGH/URGENT tasks due within 3 hours. Tasks already started (IN_PROGRESS) get none. Outside the 24-hour window none is sent and the app's local notification is relied on.
- **Snooze** only works by replying to a WhatsApp reminder (max 3 per task, 15 min–4 h, never past the due time). A snooze that lands in quiet hours or Do Not Disturb moves to when they end and the reply says the new time; it is refused only if that is after the due time. In the app, use the notification's Snooze button.
- **Sign-out push removal** is queued on the phone when offline and retried on app start/foreground for up to 48 hours (no login needed: the server checks the token plus the device's install id). Until it goes through, that phone can still get "Added from WhatsApp" pushes for the signed-out account.
- **Check-ins don't go to WhatsApp.** With notification devices set to "WhatsApp only", the phone schedules neither reminders nor check-ins, and check-ins have no WhatsApp path yet.
- **Routine reminders** (not tasks) are not sent on WhatsApp.
- **Classes are routines.** "Next class" counts Academic timetable routines, routines with a room, and routines named like a class (class, lecture, lab, tutorial, period, seminar). "Next week" questions aren't understood yet.

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

## Estimate accuracy and evaluation

- **Estimate ratios need history.** A category gets a ratio after 5 usable tasks (started and completed the same local day, no partial-progress answers, not rescheduled after starting, ratio between 0.2 and 4). Until then no suggestion is shown. "Actual" time is `completedAt − startedAt`, i.e. when the user told the app, so it is biased towards check-in times.
- **A suggestion shown on the task form is logged once per category and duration per form session**, so reopening the form can log it again; the report dedupes displays per user, category, duration and day.
- **Estimate ratios are biased by check-in-anchored times.** "Actual" is `completedAt − startedAt`, and both are often the moment the user tapped a check-in, so tasks finished through a check-in drift towards the check-in schedule. The report splits ratios by completion method (check-in vs manual); the in-app pattern uses both.
- **Wilson intervals assume independent check-ins.** Check-ins cluster by user, so the intervals are too narrow. The report shows distinct users and a per-user average beside every rate; trust those first when few users take part.
- **Section (d) of the report (estimate accuracy before/after suggestions) is descriptive, not causal** — practice and novelty effects cannot be separated from the suggestion.
- **Gemini availability changes the first-step source mix and is not randomised.** Comparisons by source (Gemini / Ollama / library) are descriptive; only the research-mode shown-vs-withheld comparison is randomised.
- **Evaluation numbers are small-sample**; see `docs/checkins-evaluation-method.md`.
- **The Roman Urdu held-out set must be filled before the report is written** (it is empty now): a teammate who hasn't read `entities.ts` adds messages (`backend/tests/eval/README.md`); the extractor's Roman Urdu scores on the development set are optimistic.
- **Roman Urdu dates:** "kal" always means tomorrow (never yesterday); "hafta/haftay" is only read as "week" next to "agle/is"; daily-routine phrases like "har roz" are not detected by the rules (the LLM may catch them).

## Location reminders

- **iOS 20-region limit.** If a user has more than 20 active location-linked tasks across
  different places, only the 20 most-used places are monitored. Tasks at other places are
  still shown in the app but won't trigger arrival notifications.
- **Background permission required.** On Android, geofence triggers only fire with "Allow all
  the time" location permission. With "While using the app", the app checks position once on
  each foreground entry — no exit detection, no background triggers.
- **4-hour per-visit dedup.** A location notification fires at most once per 4 hours per task
  at that place. Leaving and re-entering resets this (exit event clears the dedup), but GPS
  drift near a geofence boundary can cause multiple enter/exit cycles.
- **Nominatim coverage.** OpenStreetMap data is patchy in smaller Pakistani cities and for
  informal place names; individual shop branches are often missing (e.g. a pharmacy branch that
  exists but was never mapped). Search looks within ~30 km, then ~39 km, then anywhere, and the
  picker says the map may not list the shop. If a search returns nothing, users can set the location manually
  using "Use current location" (standing at the place) or by saving a place in Settings.
- **GPS drift in urban areas.** Accuracy is 10–100 m depending on the phone and surroundings.
  The default 350 m radius absorbs most drift; the 200 m "Precise" preset may trigger
  inconsistently near tall buildings.
- **Geofence entry delay.** Android batches geofence events; there can be a delay of up to
  ~2 minutes between physically entering the radius and receiving the notification.
- **Offline task creation.** A location cannot be attached to a task created offline (the
  geocode endpoint needs a connection). The app tells the user to add the location once
  they're back online.
- **Chat auto-pick for single geocode result.** When a chat query returns exactly one Nominatim
  result, it is attached without confirmation. If it's the wrong branch of a chain (e.g. the
  user said "Fazal Din" meaning a different branch), they can change it from the task detail.
  Multiple results always show a numbered picker.

## Location reminders: more detail

- **Slow search for unmapped places.** A place that isn't nearby takes up to three Nominatim calls (one per second), so an empty result can take about 3 s.
- **Saved place named in a task title (chat).** When no place is named as such, a saved place that appears as a whole word in the title ("Print notes at uni") is attached. "work", "kaam" and "house" are ignored because they are common in titles; other names can still match by accident, and the location can be removed from the task. The task form does not do this.
- **Country fallback** without a position covers Pakistan, India, UAE, UK and USA (by timezone); other timezones search worldwide.
- **Nominatim usage policy**: at most 1 request per second for the whole backend and an in-memory 24 h cache (lost on restart, per server process). Search results are in English.
- **Place names in chat are found by rules, not the LLM.** "near …", "when I reach …" and "… ja ke / pohunch ke" accept any name; "at / from / in / se / par / pe" need a place word (store, market, university, ghar, …) or one of the user's saved place names, so "at Packages" is missed until "Packages" is saved. The task title keeps the place text. Everyday words map to saved places: ghar → Home, uni → University, daftar / kaam → Office, masjid → Mosque.
- **The phone's copy of tasks decides what an arrival announces.** A task completed on another device is still announced until this phone syncs. "Done" on the notification opens the app to complete the tasks (no background handler).
- **A place always needs coordinates.** "Enter name manually" uses the current position; without location access it can't be saved (the picker says so). There are no label-only places, and so no "save as frequent place" prompt: every place picked or found is already a saved place.
- **Older places have no address** (`displayAddress` was added later); they show only their name.
- **The Location reminders toggle and the first-time Home / University sheet are per phone**, not synced.
- **"Radius updated" is shown inside the location sheet**, not as a Snackbar, because the sheet covers the app's Snackbar while it is open.

## Safety

- Crisis detection is a deterministic phrase list (English, Roman Urdu, Urdu script) in
  `backend/src/modules/mood/crisis.ts`. It must be reviewed by a native Urdu speaker before release, and the
  helpline numbers in `CRISIS_RESOURCES` must be verified (`// VERIFY BEFORE RELEASE`). A mental-health helpline
  is intentionally left as a placeholder (not shown) until someone verifies one.
