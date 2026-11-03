# Phone calendar (`CALENDAR_SYNC`)

Calendar integration (FRD §1.2 "Third-party calendar integration (Phase 2)"), built on the phone's own calendar store
with `expo-calendar`. **Off by default**: `CALENDAR_SYNC=on` in `backend/.env` turns it on for the server, and each
user then turns it on in **Settings → Phone calendar**. There is no Google OAuth and no `.ics` feed: Google, Outlook
and Samsung calendars that already sync to the phone are read where they are.

## What it does

| Part | Behaviour |
|---|---|
| Write (one way) | The app keeps a separate **"Life Organizer"** calendar on the phone and writes every dated task and every routine occurrence of the next 14 days into it. No other calendar is ever written to. |
| Read (busy time) | The phone's other calendars are read **on the phone only**: the clash warning, "what's on my calendar tomorrow" and "when am I free tomorrow". Event titles and times never go to the backend or any model. |
| Settings | Switch "Add tasks and routines to my calendar" (asks for calendar access the first time), the note "Turning this off keeps the events already added until you use Remove all", and "Remove all Life Organizer events" (count shown, confirm, then Undo). |
| Chat (app and voice) | "add this to my calendar", "what's on my calendar tomorrow", "when am I free tomorrow". "Am I free …" / "when am I free …" use the calendar only when the flag **and** the user's switch are on (the app sends its switch state with each message); otherwise they get the usual task-list answer plus "To include your phone calendar, turn on Phone calendar in Settings." "Add X to my calendar" with no task called X creates X as a new task, with Keep / Undo. On WhatsApp the agenda and "add" answer "ask me in the app" (WhatsApp can't see the phone); "am I free" gets the task-list answer. |

## Events

| Item | Event |
|---|---|
| Task with a scheduled start (work block) | Start → scheduled end, or start + duration, or start + 30 min |
| Task with a due time | 30 minutes at the due time |
| Date-only deadline | All-day event on that day |
| Task without a date | None |
| Routine occurrence | Its time and duration (30 min if no duration); all-day if it has no time |
| Completed task or routine occurrence | Kept, title starts with "✓ " (reopening removes the mark) |
| Deleted or archived task | Event deleted; restoring the task (Undo, within 24 h) creates it again |

**Sync (eventId map).** The phone keeps a map `t:<taskId>` / `r:<occurrenceId>` → `{ eventId, hash, start }` in
AsyncStorage (per user). Each sync compares what should be in the calendar with the map
(`mobile/src/utils/calendarSync.ts`: `desiredEvents` → `planOps` → `applyOps`): new → create, changed → update, gone →
delete. Every change path (form, chat, notification buttons, WhatsApp via push, undo) ends in the same reminder re-plan,
which also schedules a calendar sync (2 s debounce, one at a time), so an item can't get a second event.

- An event the user deleted in the calendar app is created again the next time its item changes.
- Routine occurrences come from `GET /api/calendar/feed` (window: today + 14 days). One missing from the feed is deleted
  only inside the window (routine deleted, paused or moved). Past ones stay in the calendar and are no longer tracked.
- Offline: tasks still sync (they live on the phone); routine events are left as they are until the feed answers.
- Tasks are read from the phone's task store, so tasks created offline get events at once. When such a task reaches the
  server it gets a new id: its event is deleted and created again under the new id (no duplicate).

**Busy time.** Clashes: timed events on the phone's other calendars that overlap the task (touching isn't a clash;
all-day events and events marked "free" never clash). Free time: gaps of 30 minutes or more between 8 AM and 10 PM
(from now, for today) around every timed event on the phone, Life Organizer's included.

**Clash warning.**
- Task form (new task, or an edit that changes the time): "You have Physics lecture at 3:00 PM" with "Change time" /
  "Add anyway".
- Chat: a clear task is created at once by the server, so the phone checks after the reply and adds
  "You have X at 3 PM. Keep it?" with Keep / Undo (Undo removes the task the same way the reply's Undo does).

**Which calendar.** The phone stores the id of its calendar and whether this app created it. When that id is gone
(e.g. a reinstall cleared the app's storage), a calendar titled "Life Organizer" is adopted instead, and because the
event map is empty its events are deleted first and then rebuilt, so nothing is duplicated. Without a title match a
new calendar is created (and marked as created by the app).

**Remove all.** Shows how many events will go, asks, then acts on the **stored** calendar only (never a title match):
a calendar this app created is deleted with all its events; an adopted one keeps the calendar and loses only the events
in the map. Syncing is turned off. Undo turns syncing on again, which re-creates the current tasks and the next 14 days
of routines; past routine events don't come back (the dialog says so). Turning the switch off only stops updates; the
events stay (the note beside the switch says so).

## Privacy

- Calendar access is asked for only when the user turns the switch on (or taps "Turn on calendar" in a chat card), with
  the reason in the system dialog (iOS) and in the Settings line above the switch (Android has no reason text).
- Denied access leaves the switch off with a note ("Calendar access is off. You can allow it in your phone's settings");
  nothing else changes. Access revoked later: syncing and reading stop silently.
- The server sends routine occurrences (which it already has) and chat cards that say only the day or the task; the
  phone fills them in. No event title, time or calendar name from the phone is sent anywhere.

## Flag off

`CALENDAR_SYNC` unset or `off`: `GET /api/calendar/feed` → `{ enabled: false }`, the calendar chat commands are hidden
(rules, router, help), the Settings section isn't shown, and the phone never reads or writes a calendar. A phone whose
switch was never turned on reads one local value per re-plan and stops there (no network, no calendar call).

## Build needed for the phone test

`expo-calendar` is a **native module**: the phone needs a new development build (`cd mobile && npx expo run:android`,
then `npx expo start --dev-client -c`). A dev client built before this change doesn't contain it: the app still runs,
because the module is loaded lazily, and calendar actions report "The calendar needs the latest version of the app".

Planned rebuild: `expo-calendar` is the only new native module in this PR. `expo-print` (analytics PDF export, from
the audit build order) is an Expo SDK 57 module too and can go into the same development build when it is added;
`expo-task-manager` (background notification actions) is already installed and needs no new native code.

## Phone checklist (Android, new dev build, backend `CALENDAR_SYNC=on`)

1. Settings → Phone calendar is shown; with the backend flag off (restart) it is not.
2. Turn the switch on → system dialog → Allow. A "Life Organizer" calendar appears in Google Calendar / Samsung
   Calendar (may need enabling under the app's calendar list).
3. Add a task "Physics report" Friday 3 PM → a 30-minute event at 3 PM. Change it to 5 PM → the same event moves (no
   second event). Mark done → "✓ Physics report". Reopen → mark gone.
4. A deadline with a date and no time (`CHAT_FIXES_V2=on`, or the form without a time) → an all-day event on the right
   day (check it doesn't show on the day before: Android all-day events are stored at UTC midnight).
5. Delete the task → event gone. Undo within the snackbar → event back once.
6. A daily routine at 7 PM for 45 min → 14 events 7:00–7:45 PM. Pause the routine → its events from today on go; earlier days stay.
7. In Google Calendar (synced to the phone) add "Lecture" Friday 3–4 PM. New task Friday 3:30 PM in the form → "You have
   Lecture at 3:00 PM" → Change time / Add anyway both behave. Same in chat ("submit report Friday 3:30 pm") → "Keep it?"
   card → Undo removes the task (and its event).
8. Chat: "what's on my calendar tomorrow" lists events from all calendars; "when am I free tomorrow" lists gaps; "add
   this to my calendar" after creating a task → "In your calendar"; "add dentist on Friday 4 pm to my calendar" (no such
   task) → task created with Keep / Undo. With the switch off: "am I free tomorrow evening?" gives the task list plus
   the Settings line, and the agenda card offers "Turn on calendar".
9. Settings → Remove all → the dialog shows the count → Remove → the Life Organizer calendar is gone, other calendars
   untouched → Undo → events back.
9a. Reinstall (or clear app data) with the Life Organizer calendar still on the phone → turn the switch on → its old
   events are replaced, not doubled; Remove all then removes the events but leaves that (adopted) calendar.
10. Deny the permission (fresh install, or revoke in system settings) → switch stays off with the note; the rest of the
   app works.
11. Airplane mode: edit a dated task → its event updates; routines unchanged until online.
12. iPhone (if available): repeat 2–5; check the reason text in the permission dialog.
