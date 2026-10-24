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
- **Urdu documents are read as English + Urdu** (`eng+urd`, likewise for the other languages), since most mix
  both. Urdu-script text is OCR'd, but only English and Roman Urdu dates are extracted by the rules (Urdu month
  names are not).
- **Scanned PDFs** (no text layer) are rendered on the server and OCR'd: at most the first 10 pages, within about
  90 seconds; the reply says how many pages were skipped. Each image gets up to 5 OCR passes (preprocessed in three
  page-segmentation modes, raw in two) within 45 seconds, so a large photo can take several seconds.
- **Week numbers** ("Week 7: Quiz 2") get a date only when the document states the semester start ("Semester starts:
  31 August 2026", "Week 1 (31 Aug…)"); otherwise the item is listed undated with "needs the semester start".
  Week N is the Monday of that week.
- **Dates without a year** take the year of the document's term ("Fall 2026": Aug–Dec 2026, Jan–Jul 2027) or of
  its other full dates; with neither, the next occurrence is used.
- **Numeric dates are day-first** (07-09-2026 = 7 September). US-style month-first documents are misread.
- **A document gets at most 150 seconds** (`DOCUMENT_TIME_LIMIT_MS`: OCR plus the AI pass). When time runs out the
  rules' items come back with a warning that the AI check wasn't finished; nothing fails. The phone waits up to 4
  minutes for an upload (3 for pasted text).
- **The 150 s limit covers the OCR queue too**: an image that only reaches the front with less than 8 s left is
  refused as busy rather than read past the limit; a scanned PDF stops at the limit with the pages read so far.
  A pass already running can't be interrupted, so a document can overrun by one OCR pass: about 1 s on the largest
  fixture, and images are scaled to at most 2500 px wide because at 4000 px a single pass took up to 53 s.
- **If the phone gives up waiting, the server still finishes and saves** (document and auto-created tasks). Sending
  the same file again within 24 hours returns that saved result instead of reading it again (the document is
  identified by a hash of its content, type and language); after 24 hours it is read again, and auto-created tasks
  are still not duplicated (same title, date and time). A saved result is reused only if it was produced by the
  current readers (`EXTRACTOR_VERSION`, stored in the result); after the readers change, the file is read again.
- **One OCR job runs at a time per language, and at most 3 may wait.** A fourth upload at that moment gets "I'm
  reading other documents right now, try again in a minute" (also on WhatsApp) instead of queuing.
- **The upload status after the file is sent is timed, not reported.** "Reading the document" then "Finding dates and
  classes" follow the server's order of work, but the server doesn't stream its stage; only the upload has a real
  percentage.
- **The AI pass on documents reads at most 6 chunks (about 15,000 characters) within 2 minutes**; later pages
  get the rules only. Model-only items are never created automatically.
- **OCR preprocessing** auto-rotates (EXIF), deskews up to ±10°, denoises, normalises contrast, sharpens and
  upscales to at least 2000 px. Pages upside down or rotated 90° without EXIF data are not corrected.
- **Deadlines from a photo or scanned PDF that read below 90 % OCR confidence are never created automatically**
  (capped at 94, under the 95 needed): a misread title ("Broject") can come with a clear date and time. They are
  listed for review instead. Schedules are not capped (they auto-create at 90).
- **Table header rows** ("Date | Day | Paper | Time", English, Roman Urdu or Urdu column names) never become items.
  When OCR garbles one header cell ("Te" for "Date"), the date column is taken from the first row, but only if
  that row has the same number of cells; otherwise the rows are skipped rather than guessed.
- **Grid timetables** (days down the side, 30-minute slots across, classes as boxes) are read by position:
  from the PDF text layer, or from a photo/screenshot (ruling lines removed for the day and time headers;
  class blocks found by their colour fill and read one by one). An image starts the grid reader when its
  OCR text has 6+ different "hh:mm" times, and the reader stops after its first header read unless it sees
  3+ different weekday labels (English, Roman Urdu, Urdu) as well. Image classes are capped at 85 % so they
  go to review, never auto-created: a section's timetable lists every group (G1, G2, G3) and the student
  ticks theirs. About 4–6 s extra.
- **Grid timetables: COMSATS-style course codes only.** A class block is recognised by a code of 2–5 capital
  letters and 3 digits, optionally a letter and a group ("CSC461", "MGT350", "CSC461 - G1", "CS-101L").
  Codes like "MATH 1A", "EE2020" (4 digits), "BIO-1101" or blocks with only a course name are not
  recognised, so those classes are missed.
- **Grid timetables: light-coloured block fills only.** Blocks must be a light fill (grey, blue, orange, …)
  on a white page; dark or saturated fills, outline-only boxes, dark-mode screenshots, handwritten or
  skewed photos are not read as a grid and fall back to the line-based rules.
- **Grid timetables: rooms are the weak part.** Rooms read from an image get their hyphen back ("D118" →
  "D-118"); one that doesn't look like a room code (capital-hyphen-digits, or a named lab with a code) keeps
  its text as read and the review row says "Check the room" (characters are never guessed). A misread that
  still has a valid shape isn't caught. On the real COMSATS screenshot: 12/12 classes right; rooms 8/12
  exact, 3 flagged ("p17", "p-117", "0-3"), 1 wrong unflagged ("N-115" for D-115). PDF rooms are exact text
  and are not changed.

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
- **In-memory state per server process.** The per-number message queue, link-failure counts, "once an hour/day" notices and push tickets awaiting a receipt (each capped at 10,000 entries, oldest dropped first) reset on restart (lost messages are covered by the "please resend" sweep every 5 minutes). Several backend instances would need these in the database.
- **Lost messages.** A message still unanswered after 5 minutes and not being processed (e.g. the server restarted mid-way) gets "Sorry, I missed that, please resend". A slow job on the same server is left alone; with several backend instances one instance can't see another's jobs.
- **Crisis messages are answered for everyone.** The crisis check runs on every WhatsApp text before the link/Pro checks, so unlinked numbers and Free accounts get the support resources too; nothing about such a message is stored.
- **Push needs EAS setup** (projectId, FCM V1 key, `google-services.json`, dev-client rebuild; `docs/push-setup.md`). Without it, a task added on WhatsApp appears at the next sync. The push text (task title) passes through Expo and Google FCM. Pending push receipts are kept in memory, so a restart skips their check (a dead token is removed the next time a push to it fails).
- **Urgent alerts** are WhatsApp messages only (no calls), one per task, for pending HIGH/URGENT tasks due within 3 hours. Tasks already started (IN_PROGRESS) get none. Outside the 24-hour window none is sent (logged once per task) and the app's local notification is relied on; if the user messages while the task is still urgent, the alert goes out on the next run.
- **Reminder texts are English only.** WhatsApp reminders, urgent alerts, snooze replies and the "Added from WhatsApp" push are written in English, whatever the app language.
- **Snooze** only works by replying to a WhatsApp reminder sent in the last 6 hours (otherwise "Nothing to snooze right now"; max 3 per task, 15 min–4 h, never past the due time). A snooze that lands in quiet hours or Do Not Disturb moves to when they end and the reply says the new time; it is refused only if that is after the due time. In the app, use the notification's Snooze button.
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
- **The app never opens the location dialog by itself.** A Pro user's task that gets a place (chat, form,
  WhatsApp) while location access or the Settings toggle is off shows a snackbar ("Grant" when access is
  refused, "Turn on" when only the toggle is off), once after launch and once per new such task; nothing
  fires until the user taps it. The toggle lives on the phone, so the chat reply itself can't say it is off.
- **Personal places are never searched on the map.** Home, university, office and hostel (and their aliases:
  ghar, house, uni, campus, daftar, work) come from the user's saved places; an unsaved one is set by the user
  ("Set Home on the map" in chat, or Settings → Saved places on WhatsApp). Shops and other named places are
  searched as before.
- **"The 2nd task" means the last list the chat showed** (Show my tasks, most urgent, top 3), in that order.
  Without a list in the conversation, an ordinal isn't understood and the chat asks which task.
- **A place in a new task needs a place word or a saved name.** "from KFC kalma chowk" (chowk), "from Ali
  Medical Store" (store) or a saved place are recognised; "from KFC Gulberg" alone is not (it could be a
  person or a thing), so the task is added without a location; "change its location to KFC Gulberg" works.
- **A place the map search can't find** (e.g. "KFC kalma chowk") gets a "Set it on the map" card; the
  picker searches near the user, or the pin can be dropped by hand.
- **The chat knows the toggle only from the app.** The app sends its Location reminders state with each
  message; WhatsApp can't, so it never shows the in-chat toggle.
- **Free users' places are text only.** Naming a place in chat adds the task without a geofence; the reply
  invites them to switch to Pro and turn on Location reminders (Pro is a demo switch in Settings).
- **Already there when the place is added.** Android's "already inside" geofence trigger can lag by minutes,
  so when a task gets a place while the app is open, the app checks the current position and announces at
  once if the user is within the radius (the once-per-visit mark stops a second notification). This check
  doesn't run on every app open, only when a task newly gets a place.
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

## Place picker map

- **Map tiles come from the public OpenStreetMap server**, which is for light use only (fine for the project and
  testing, not for a large release). To switch to a keyed provider, change `mobile/src/config/map.ts` only.
- **The map needs internet.** Offline (or if the WebView fails) the picker shows a short note with "Try again", and
  retries by itself when the connection returns; search needs internet too, so offline only "Use current location"
  and a manual name work, as before.
- **Switching light / dark while the picker is open reloads the map** (a second or so) to take the new colours; the
  pin, radius and markers come back where they were.
- Tile requests carry the project's GitHub URL as their Referer (`config/map.ts`), which identifies the app to the
  OpenStreetMap tile servers as their policy asks.
- The map is not accessible to screen readers; search, current location and the name field do everything it does.
- Native module: after pulling this, rebuild the app (`npx expo run:android`).

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

## Chat commands

- **Undoing a routine delete restores the routine, not its history.** Deleting removes its past occurrences
  (done/skipped marks); undo recreates the routine with the same id and settings and fresh upcoming occurrences.
  The confirmation says so.
- **One undo step per conversation.** "Undo" reverts the newest chat change (a command or a task edit); older
  command changes can't be undone from chat. Settings and routine changes undo for 15 minutes, deletes for 24 hours.
- **Routine names without the word "routine".** "Skip gym today" and "move today's gym to 8 PM" look for a routine
  first; when no routine matches (and the message didn't say "routine"), the message is handled as a task instead.
- **Insights from chat use the analytics ranges**: "this week" is the last 7 days and "this month" the last 30, not
  calendar weeks. "Time per category" is the planned duration of completed tasks (tasks have no time tracking);
  tasks without a duration are counted but not timed. The streak counts days with a completed task or routine.
- **Bulk changes act on at most 25 tasks per confirmation**; the preview says how many more there are, and the
  same request again handles the next ones. Moving a parent task moves its subtasks with it, so a subtask whose
  parent is in the same batch isn't moved twice.
- **One question per multi-request reply.** If two parts of a message both need an answer, the first is asked and
  the reply names the other to send again. Parts are split only at and / aur / then / also / phir (and the Urdu
  words), not at commas alone.
- **Some command replies are still English for Urdu users.** In Urdu (`commands/copy.ts`): every settings and bulk
  reply, confirm buttons, "answer yes or no" / "pick a number" re-asks, the expired-preview reply and the undo reply.
  Still English: routine commands (list, change, pause/resume, delete, done/skip today, move once), task-field
  commands (notes, reminder mode, start, reopen, tags, category, subtasks), insights, help and the "here's what I can
  do" suggestions, "Which routine / task do you mean?", and the "Send this again after answering" line of a
  multi-request reply. Task titles, routine names and times are shown as written. The rules understand English,
  Urdu script and Roman Urdu; Urdu-script clock times are only read inside ranges such as "رات 11 سے صبح 7 تک".
- **The LLM router adds up to two model calls** when the rules are unsure (on top of the existing intent call), so
  those messages are slower with a local model. It never runs with AI off.
