# FRD gap audit

Audit of `docs/FRs/FUNCTIONAL REQUIREMENTS.md` (v1.0, 51 requirement IDs) against `main` at `3563cca` (3 Nov 2026).
Docs only: no code was changed. Evidence was read from the code, the tests and the status docs
([AI_ASSISTANT_ARCHITECTURE.md → FR coverage](AI_ASSISTANT_ARCHITECTURE.md#fr-coverage),
[known-limitations.md](known-limitations.md), [frd-deviations.md](frd-deviations.md)). "Not verified" means the code
path exists but this audit found no test or device check for that point.

**Status:** done = every key requirement is met, or met through a deviation the owner already approved;
partial = the core is built but some named requirement is missing; missing = not built;
out of scope = only where the owner has said so (the desktop app, per `CLAUDE.md`; new Urdu / Roman Urdu work is
deferred until after the 10 Nov evaluation). Features the FRD itself marks out of scope or Phase 2 are counted as
**missing** here, as instructed.

**Effort** (for whatever is missing): S = under a day, M = 1–3 days, L = more than 3 days or needs a new subsystem.
Items marked *native* need a new native module and a dev-client rebuild (`npx expo run:android`).

## Summary

| Status | Count (51 FR IDs) | Items listed below the table (11) |
|---|---|---|
| done | 33 | 0 |
| partial | 16 | 1 (other Pro claims) |
| missing | 2 (FR-VF-003, FR-OB-003) | 9 (one of them is FR-VF-003 again) |
| out of scope | 0 (desktop parts are noted inside rows) | 1 (desktop app) |

## Requirements

| ID | Requirement | Status | Evidence | What is missing | Effort |
|---|---|---|---|---|---|
| FR-TM-001 | Add task via text chat (Clarity Index, mandatory clarifications, type classification, auto-create ≥95 %) | done | `assistant/dialogue.ts`, `draft.ts`, `entities.ts`; `tests/assistant.test.ts`; `npm run eval:assistant` 211/215 on main | Nothing. Deviation: dated deadline without a time → end of day (`CHAT_FIXES_V2`, off; frd-deviations.md) | – |
| FR-TM-002 | Add task via voice (2 s silence, 2 min cap, confidence < 80 % re-ask, Whisper) | partial | On-device STT (`mobile/src/services/speech`), `utils/__tests__/speechHints.test.ts`, `spelled.test.ts` | Whisper is not used and "100+ languages" depends on the phone's speech service. Record as a deviation, or switch to the server-side whisper.cpp already used for WhatsApp Agent voice notes (`backend/src/ai/stt.ts`) | S (record deviation) / M (server STT) |
| FR-TM-003 | View tasks: filter, sort, search with highlight, swipe and long-press actions | done | `screens/tasks/TaskListScreen.tsx` (SwipeRow, filters, sort), `TaskCard.tsx` (HighlightText, onLongPress) | Nothing | – |
| FR-TM-004 | Edit task (chat and UI), versions, device ID, undo | done | `Task.version`, `Task.deviceId`, `TaskVersion`; chat edits in `assistant/handlers.ts`; `tests/chatCommands.test.ts` | Nothing | – |
| FR-TM-005 | Soft delete with 24 h undo, permanent delete, archive | done | `Task.deletedAt`, `Task.archived`; purge in `jobs/maintenance.ts` | Nothing | – |
| FR-TM-006 | Scheduling algorithm (peak hours, overload at 8 h, spacing, deadline-before-deadline) | done | `scheduling/schedulingService.ts` | "Prevent adding to overloaded days" is a warning plus suggestions, not a hard block (matches "Ask user") | – |
| FR-TM-007 | Partial completion and task splitting (progress, subtasks, parent auto-complete, collapse) | done | `Task.progress`, `Task.parentTaskId`; `TaskCard` expand/collapse; chat subtask commands | Not verified: rescheduling a parent also moves its children | S (verify, add a test) |
| FR-TM-008 | Missed/overdue handling by type, no auto-reschedule | done | `assistant/briefing.ts` `getAttention` (4 options for deadlines, missed time-locked routines, flexible reschedule offer) | Nothing | – |
| FR-RM-001 | Create routine (frequencies, clarifications, learned times) | done | `routines/routineService.ts`; `tests/intervalRoutines.test.ts`, `routineReminders.test.ts` | Nothing ("Custom" = every N days, 2–30) | – |
| FR-RM-002 | Routine categories and priority (mandatory confirm, conflicts) | done | `RoutinePriority` enum; mandatory skip confirmation; conflict check in scheduling | Nothing | – |
| FR-RM-003 | Smart routine rescheduling (time-locked vs flexible) | done | `briefing.ts` `markMissedOccurrences`; one-occurrence moves from chat | Nothing | – |
| FR-RM-004 | Location-context routines (manual contexts) | done | `Routine.locationContext`, `UserSettings.contexts` / `currentContext` | Auto-detect from geolocation is "Future" in the FRD (see below) | – |
| FR-RN-001 | Smart escalating reminders (peak-hour critical reminder, adaptive, quiet hours) | done | `reminders` module; `tests/reminders.test.ts`, `urgent.test.ts` | Nothing | – |
| FR-RN-002 | Delivery: OS notifications offline, push, WhatsApp (Pro, 24 h rule), Done/Snooze/View buttons | partial | `mobile/src/services/reminders.ts`, `push/pushService.ts`, `tests/push.test.ts`, `whatsapp.test.ts` | Every notification button opens the app (no background handler); 99.9 % delivery is not measured. Desktop notifications: out of scope | M *native* (expo-task-manager) |
| FR-RN-003 | Reminder preferences: global, per task, DND with critical override | partial | `UserSettings` (quietStart/End, notificationFrequency/Method/Devices, dndUntil, criticalOverridesDnd); `Task.reminderMode` | Per task, only the frequency can be overridden. Missing: per-task timing ("1 day before", custom), method and "when" (only offline / work hours). Not verified: queued reminders shown when DND ends | M |
| FR-RN-004 | Start and completion check-ins | done | `checkins/*`; the FRD lists each criterion's tests (`checkins.test.ts`, `checkinService.test.ts`, `checkinCopy.test.ts`) | Device test pending | – |
| FR-DP-001 | Upload and process (PDF/JPG/PNG/DOCX, 10 MB, type question, OCR confidence warning, cleaning) | partial | `documents/documentProcessing.ts`, `tests/documentOcr.test.ts`; DocumentsScreen type selector | Storage used is not shown. Multiple files per upload not verified. Urdu language question deferred (English-only scope) | S |
| FR-DP-002 | Extract deadlines (confidence thresholds, EOD assumption, review list) | done | `documents/dateRules.ts`, `tests/dateRules.test.ts`; `eval:documents` rules-only recall 99.4 %, precision 100 % | Nothing (date sheets: PR #34, on hold) | – |
| FR-DP-003 | Extract schedules and timetables → routines | done | `tests/gridTimetable.test.ts`, `gridImage.test.ts` | Limits listed in known-limitations.md (COMSATS-style codes, light block fills) | – |
| FR-DP-004 | Topics and context, prerequisite question | done | `documentProcessing.ts` course memory; `dialogue.ts` prerequisite check | Nothing | – |
| FR-MH-001 | Mood tracking (chat detection + confirm, 1–10 scale, daily check-in, context, history) | done | `mood/moodService.ts`, `MoodScreen.tsx`, daily prompt in `dialogue.ts` / `handlers.ts` | Nothing | – |
| FR-MH-002 | Mood-based recommendations | partial | Mood → task mapping, breathing exercise (`BreathingExercise.tsx`) | Music recommendations and learned preferences ("user listens to Urdu ghazals when stressed") are missing | M |
| FR-MH-003 | Adaptive rescheduling during stress (chunks, postpone non-urgent, never forced) | done | `schedulingService.ts` 45/15 chunks; `commands/bulk.ts`; `briefing.ts` very-stressed card | Music under "support resources" is the same gap as FR-MH-002 | – |
| FR-MH-004 | Conversational support (Pro), coping insights, no clinical claims | done | Empathetic replies, coping memories, `tests/crisis.test.ts` | "Offers to play calming music": same gap as FR-MH-002 | – |
| FR-PL-001 | Identify patterns with confidence | done | `patterns` module, `UserPattern` | Nothing | – |
| FR-PL-002 | Pattern recommendations, visible confidence, ≥ 50 % threshold | done | `patterns` module; InsightsScreen | Nothing | – |
| FR-WA-001 | Receive and process WhatsApp messages (multi-turn, text/voice/image) | done | `whatsapp/*`, `whatsappAgent/*`; `tests/whatsapp.test.ts`, `whatsappAgent.test.ts` | Deviation: per-user WhatsApp Agent (frd-deviations.md). Voice notes only on the Agent path | – |
| FR-WA-002 | WhatsApp reminders (Pro, 24 h rule, bulk guard) | done | Same; `tests/urgent.test.ts` | Needs Twilio / Agent credentials for a live test | – |
| FR-VF-001 | Voice input (STT) | partial | Same as FR-TM-002 | Same as FR-TM-002 (Whisper) | S / M |
| FR-VF-002 | Voice output (TTS, speed / voice / language, "read back") | done | expo-speech; `handlers.ts` `readBack` | Not verified: voice choice (only rate and language were seen) | S (verify) |
| FR-VF-003 | Conversational voice chat (Pro, FRD "Phase 2") | missing | – | Continuous listen → engine → spoken reply loop, barge-in, hands-free UI. Can reuse STT, `handleAssistantMessage` and TTS | L |
| FR-MS-001 | Offline-first (local DB, cloud backup, sync on foreground / manual / periodic) | partial | `mobile/src/services/syncEngine.ts`, `tests/sync.test.ts` | Only tasks work offline; routines, mood, memories, documents and settings need a connection. Local store is AsyncStorage, not SQLite. No "when to sync" preference | L |
| FR-MS-002 | Conflict resolution (LWW + field merge, sync status) | partial | Field-level merge on the server; `tests/sync.test.ts` | No "conflict" status shown; conflicts are compared by device clock | S |
| FR-MS-003 | Instant sync, queue, backoff, other devices notified | partial | `syncEngine.ts` queue and backoff | Tasks only (see FR-MS-001); other devices get a push only for WhatsApp-created items | M (with FR-MS-001) |
| FR-MS-004 | Versions and internal history (90 days) | done | `TaskVersion`; 90-day purge in `jobs/maintenance.ts` | Nothing | – |
| FR-AN-001 | Track and calculate metrics | done | `analytics/analyticsService.ts` | Nothing | – |
| FR-AN-002 | Analytics dashboard, ranges, comparison, insights, export | partial | `InsightsScreen.tsx`; CSV export | PDF export (with charts) is missing | M *native* (expo-print) |
| FR-CT-001 | Predefined and custom categories (colour, NLP suggestion, multi-filter) | done | `Category` model; `entities.ts` category rules; TaskListScreen | Nothing | – |
| FR-CT-002 | Tags (autocomplete, AND/OR filter, suggestions, manage in settings) | done | `Task.tags`; tag filter mode in TaskListScreen; chat add/remove tags | Not verified: "delete unused tags" in settings | S (verify) |
| FR-LB-001 | Location-based reminders (Pro, geofence, presets, multiple tasks per place) | done | `mobile/src/services/locationReminders.ts`, `utils/__tests__/geofence.test.ts`, `tests/locations.test.ts`, `presetRadius.test.ts` | Device test pending (`docs/map-picker-checklist.md`) | – |
| FR-AP-001 | Account management (profile, password, deletion with 30-day recovery, subscription, export) | partial | SettingsScreen (password change with re-auth), `account/accountRoutes.ts` (`/account/recover`, CSV export) | No subscription management, payment method or billing history (tier is a settings switch). PDF export missing (FR-AN-002). Not verified: recovery email link; sign-out on all devices after a password change | L (payments) / S (rest) |
| FR-AP-002 | Notification preferences (quiet hours, frequency, method, devices, per task) | partial | Same as FR-RN-003 | Per-task timing and method overrides (same gap as FR-RN-003). "Desktop only": out of scope | (in FR-RN-003) |
| FR-AP-003 | Language and localisation (7 languages, RTL, prayer times, holidays, currency) | partial | `i18n/strings.ts` en + ur; RTL built behind `RTL_READY` (off) | UI is English; Arabic, Spanish, French, Chinese and Hindi are missing. Prayer times, regional holidays and currency are missing. New Urdu work is deferred until after 10 Nov (owner's rule) | M (prayer / holidays / currency) / L (languages) |
| FR-AP-004 | Context-aware scheduling (contexts, filtered views, switching) | done | `UserSettings.contexts` / `currentContext`, `Task.locationContext` | Automatic detection is "Future" in the FRD (see below) | – |
| FR-EH-001 | Offline scenarios (launch offline, badge, offline tasks and reminders, upload blocked) | partial | `syncEngine.ts`, local notifications | Bound to FR-MS-001: non-task screens need a connection. Not verified: the "Offline" badge and the "Sync failed. Retry?" notice | M (with FR-MS-001) |
| FR-EH-002 | Network interruptions (no duplicates, backoff, auto-resume) | done | Idempotent creates and backoff in `syncEngine.ts`; `tests/sync.test.ts` | Not verified: the exact 5 s → 160 s schedule and the notice after 5 retries | S (verify) |
| FR-EH-003 | Invalid input and clarification (low clarity options, past dates, typos) | done | `dialogue.ts` (low clarity, typo suggestion), `lib/text.ts` Levenshtein | Nothing | – |
| FR-EH-004 | Database and sync errors (repair, conflict chooser, backups, version mismatch) | partial | Repair path in `syncEngine.ts` | Conflict chooser ("Keep mine / Use cloud"): `ConflictSheet` exists but nothing uses it. Cloud backups for 90 days are an operations task (Postgres backups), not app code | S (UI) / S (backup script) |
| FR-OB-001 | Account creation and first login (verification, setup steps, skip, tutorial) | partial | `EmailVerificationScreen.tsx`, `OnboardingScreen.tsx` | Social login (Google / Apple) is missing; phone-number sign-up not verified | M *native* |
| FR-OB-002 | Feature tutorials (first-use tips, don't-show-again, "?" help, re-enable) | done | `components/ui.tsx` tooltip and help button; `tutorialsEnabled` / `tutorialsSeen` | Video tutorials are "Future" in the FRD (see below) | – |
| FR-OB-003 | Guest mode (local-only data, convert to account) | missing | – | Local-only mode for every entity, reminders without an account, "save my data?" migration on sign-up, 30-day nudge. Depends on FR-MS-001 offline storage | L |

## Items the FRD marks out of scope, Phase 2 or Future

| Item | FRD reference | Status | What it would need | Effort |
|---|---|---|---|---|
| **Calendar integration** | §1.2 "Third-party calendar integration (Phase 2)" | missing (to build; owner's instructions to follow) | Cheapest $0 route: device calendars through `expo-calendar` (*native*). Google, Outlook and Samsung calendars already sync to the phone, so no OAuth or keys are needed. Read busy events into `schedulingService` as fixed blocks; optionally write scheduled tasks and classes to a "Life Organizer" calendar; permission flow; a setting per calendar; tests for the merge rules. Server-side Google Calendar (OAuth, token storage) is the larger alternative | L |
| **Task collaboration** | §1.2 "Advanced team collaboration features" | missing (to build; owner's instructions to follow) | Data model for shared lists or tasks (owner, members, role) through an additive migration; invite by email or code; every query scoped by membership as well as `userId`; sync and conflict handling for shared items; notify members on change (existing push); UI for sharing, members and assignee | L |
| Payment processing | §1.2 (external gateway); FR-AP-001 subscription | missing | Gateway checkout (test mode), webhook that sets `tier`, billing history, cancel / upgrade. Real money conflicts with the $0 rule; a demo-only upgrade screen is the realistic version | L |
| Video conferencing | §1.2 | missing | WebRTC or an embedded Jitsi room, signalling, permissions. Unrelated to the FYP's aims | L |
| Advanced ML model training | §1.2 | missing | Training pipeline, labelled data, evaluation. Conflicts with the rule that the LLM does narrow, schema-constrained jobs only | L |
| Auto-detect context from geolocation | FR-RM-004 §3, FR-AP-004 §4 | missing | Saved places + geofences already exist (FR-LB-001): on entering a place that is mapped to a context, switch `currentContext`; time-based fallback (9–5 = work). Free-tier question: geofencing is Pro today | M |
| Conversational voice chat | FR-VF-003 (Phase 2) | missing | See the FR-VF-003 row | L |
| Video tutorials | FR-OB-002 §5 | missing | Record 30-second clips, host them (bundle size vs a link), link them from the "?" help | M (mostly content) |
| Budget tracking and expense management | §16.2 Pro list (no FR ID) | missing | Expense model, entry by chat ("spent 500 on books"), currency (FR-AP-003), monthly summary | L |
| Other Pro claims (extended memory, faster pattern detection, priority support) | §16.2 | partial | Not separate features in code. Either define a Pro limit (e.g. memory items kept) or drop them from the tier list | S |
| Desktop app | §2 personas, FR-RN-002, FR-MS-001, FR-AP-002 | out of scope | Owner's decision (`CLAUDE.md`) | – |

## Medium and large items

- **L:** calendar integration, task collaboration, FR-MS-001 (+ FR-MS-003, FR-EH-001) offline for every entity,
  FR-OB-003 guest mode, FR-VF-003 voice conversation, FR-AP-001 payments, FR-AP-003 further UI languages, budget
  tracking, video conferencing, ML training.
- **M:** FR-RN-002 background notification actions, FR-RN-003 / FR-AP-002 per-task timing and method,
  FR-MH-002 music and learned preferences, FR-AN-002 PDF export, FR-AP-003 prayer times / holidays / currency,
  FR-OB-001 social login, FR-TM-002 / FR-VF-001 server-side Whisper (if chosen over a deviation note),
  context auto-detect, video tutorials.

## Recommended build order before the 10 Nov freeze

There are seven days. Calendar integration and collaboration alone are two L items, so the order puts them first and
everything after them is "if time allows". Each item merges behind its own flag (off) with an additive migration, as
usual. Items that need a native module are grouped so the dev client is rebuilt once.

1. **Calendar integration** (L, *native*): device calendars via `expo-calendar` → busy blocks in scheduling, then
   optional write-back. Highest value for students (class and exam clashes) and it builds on scheduling that already
   exists.
2. **Task collaboration, minimum version** (L): share one task or list with another account by invite code; members
   can see it and complete it; the owner edits; membership-scoped queries; a push on change. Assignees, roles and
   shared routines come later.
3. **Small gaps closed in one batch** (S each): use the existing `ConflictSheet` for true conflicts
   (FR-MS-002 / FR-EH-004), show storage used (FR-DP-001), record the on-device STT deviation (FR-TM-002 / FR-VF-001),
   and add the verification tests flagged above (parent reschedule, unused tags, DND queue, retry schedule).
4. **Per-task reminder timing and method** (M, FR-RN-003 / FR-AP-002): the reminder planner already exists; this adds
   fields and a form section.
5. **Analytics PDF export** (M, *native* expo-print; rebuild together with item 1): closes FR-AN-002 and part of
   FR-AP-001.
6. **Background notification actions** (M, *native* expo-task-manager; same rebuild): Done / Snooze without
   opening the app (FR-RN-002).
7. **Prayer times, holidays, currency** (M, FR-AP-003): prayer times can be computed on the device, with no API
   and no cost.

After the freeze (too large or too risky for seven days): offline storage for every entity (FR-MS-001 → enables
FR-OB-003 guest mode), FR-VF-003 voice conversation, social login, mood music, context auto-detect, payments, budget
tracking, more UI languages (also blocked by the English-only rule until 10 Nov), video tutorials, video
conferencing and ML training (not recommended for this project).
