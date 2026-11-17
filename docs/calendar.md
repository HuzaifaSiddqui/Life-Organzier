# Phone calendar (`CALENDAR_SYNC`)

Calendar integration (FRD §1.2 "Third-party calendar integration (Phase 2)"), built on the phone's own calendar store
with `expo-calendar`. **Off by default**: `CALENDAR_SYNC=on` in `backend/.env` turns it on for the server, and each
user then turns it on in **Settings → Phone calendar**. There is no Google OAuth and no `.ics` feed: Google, Outlook
and Samsung calendars that already sync to the phone are read where they are.

**One-way since 17 Nov 2026 (owner's decision): phone calendar → Life Organizer.** The app never writes to a
calendar. Earlier versions wrote tasks and routines into the calendar and read edits back (two-way); that is removed,
and those events are deleted once after the update (see "Clean-up" below).

## What it does

| Part | Behaviour |
|---|---|
| Import | Upcoming events in the phone's calendars (from yesterday to **30 days ahead**, every calendar, all-day ones included) are offered as tasks. The user chooses: **From your calendar** (Today's card → Review, or the note "2 new in your calendar · Review") lists them by day with **Add** and **Skip** each, and **Add all** / **Skip all**. Nothing is created without the user. |
| Read (busy time) | The same events are read **on the phone only** for the clash warning, "what's on my calendar tomorrow" and "when am I free tomorrow". |
| Settings | Switch "Bring in events from my phone calendar" (asks for calendar access the first time) and the note "Turning this off stops looking for new events. Tasks you already added stay." |
| Chat (app and voice) | "what's on my calendar tomorrow", "when am I free tomorrow" (cards filled in on the phone). "Add X to my calendar" puts X in the plan only: an existing task gets "is already in your plan. I read your phone calendar but don't add to it" with Open; a new X is created as a task with the same line. On WhatsApp the agenda answers "ask me in the app". |

## Import rules (`mobile/src/utils/calendarSync.ts`, tested in `calendarSync.test.ts`)

- **When**: when the app opens or comes to the foreground, every 15 minutes while it's open, and after every
  re-plan (2 s debounce, one at a time). Not instantly.
- **Which events**: every event in every calendar from 24 hours ago to 30 days ahead that hasn't ended, has a title,
  and doesn't carry the old app marker ("Created by Life Organizer").
- **Each instance is its own**: the key is the event id plus its start, so a weekly class is offered once per week.
- **Never twice**: an added or skipped key is remembered (per user, on the phone) and not offered again. Keys of
  events that started more than a day ago are forgotten.
- **Already a task**: an event whose title matches a task (any case) at the same start minute (timed) or on the same
  day (all-day) isn't offered.
- **The task made**: timed event → due on its day at its start time, planned for its span (`scheduledStart` /
  `scheduledEnd`, duration), type Fixed; all-day → due that day, no time (multi-day: the first day). Notes:
  "From your calendar" and the event's location. It goes through the offline queue like any task, so it reaches
  the server, the desktop app and reminders.
- Android stores all-day events at UTC midnight: their day is read in UTC so they don't land on the day before.

## Clean-up of the two-way version's events

The first sync after the update (calendar access granted) reads the old state (`life-organizer:calendar:v1:<uid>`):
- a separate "Life Organizer" calendar the app created is deleted with its events;
- in any other calendar it used (the user's Google calendar), only events whose notes carry the marker, plus the
  events in the old map, are deleted; the user's own events are never touched;
- the old state is then removed and the switch keeps its old position. If anything fails, it runs again next time.
- Tests: `mobile/src/utils/__tests__/calendarService.test.ts`.

## Busy time

Clashes: timed events on the phone's calendars that overlap the task (touching isn't a clash; all-day events and
events marked "free" never clash). Free time: gaps of 30 minutes or more between 8 AM and 10 PM (from now, for today).

**Clash warning.**
- Task form (new task, or an edit that changes the time): "You have Physics lecture at 3:00 PM" with "Change time" /
  "Add anyway".
- Chat: a clear task is created at once by the server, so the phone checks after the reply and adds
  "You have X at 3 PM. Keep it?" with Keep / Undo.

## Privacy

- Calendar access is asked for only when the user turns the switch on (or taps "Turn on calendar" in a chat card).
- Denied access leaves the switch off with a note; nothing else changes. Access revoked later: reading stops silently.
- Events stay on the phone. Only the events the user **adds** leave it, as ordinary tasks (title, time, location note).
  Skipped and waiting events are never sent anywhere.

## Flag off

`CALENDAR_SYNC` unset or `off`: `GET /api/calendar/feed` → `{ enabled: false }`, the calendar chat commands are hidden,
the Settings section isn't shown, and the phone never reads a calendar. A phone whose switch was never turned on (and
has nothing to clean up) reads one local value per re-plan and stops there.

## Desktop

The computer has no phone calendar: the Settings card is hidden there. Events added on the phone arrive on the
desktop as tasks through sync.

## Phone checklist (Android, backend `CALENDAR_SYNC=on`)

1. Update from a build that had two-way sync on → open the app → the old "Life Organizer" events disappear from
   Google Calendar (only those); your own events stay.
2. Settings → Phone calendar → turn the switch on → Allow.
3. Add "Dentist" tomorrow 4–4:45 PM in Google Calendar → open the app → note "1 new event in your calendar · Review"
   and a Today card "New in your calendar".
4. Review → Add → a task "Dentist" tomorrow, planned 4:00–4:45 PM, note "From your calendar"; it's on Plan. Its
   calendar event is unchanged.
5. Skip another event → it's not offered again after reopening the app.
6. A weekly event → each week is its own row. Add all → one task per row.
7. Create a task "Gym" tomorrow 7 PM in the app, then the same event in the calendar → not offered.
8. "add dentist to my calendar" in chat → "already in your plan … I don't add to it", nothing new in the calendar.
9. Turn the switch off → the card goes; tasks already added stay.
