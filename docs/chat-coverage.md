# Chat coverage

What a user can do by typing (app chat), speaking (voice) or messaging on WhatsApp. All three use one engine
(`assistant/dialogue.ts`), so a row applies to every channel unless it says otherwise.

**Chat today** is the state before the command registry (branch `feature/chat-commands`):
**yes** = works from a sentence, **partial** = only through a button the assistant shows or with narrow
wording, **no** = only in the app screens. **Command** is the registry command that covers it
(`backend/src/modules/assistant/commands/`); "—" means it stays app-only, with the reason.

**Status:** every command in the Command column is implemented, with rules in English, Urdu script and Roman
Urdu, and works with AI off.

**Tuned set, not accuracy.** `npm run eval:assistant` scores 211 utterances: 54/211 (25.6 %) with the rules before
the registry, 207/211 (98.1 %) after. The command rules were written against these rows, so 98.1 % only shows the
rules do what they were written to do (a regression check); it is not an estimate of accuracy on new messages.
The 4 misses are existing intent rules in `nlu.ts` (three mood / completion phrasings in Roman Urdu and English, one
"how far am I with X" progress question), left unchanged. The held-out set (`tests/eval/chat-holdout.json`) that
would give an honest accuracy number is still empty: it needs a teammate who hasn't read the rules to fill it.

## Tasks (FR-TM-001…008)

| Feature | FR | Chat today | Command |
|---|---|---|---|
| Add a task (text, voice, WhatsApp) | TM-001/002, WA-001 | yes | `create_task` (wrapped) |
| List tasks: today, tomorrow, this week, overdue, all | TM-003 | yes | `query_tasks` (wrapped) |
| When is X due / most urgent | TM-003 | yes | `query_tasks` (wrapped) |
| Change date, time, priority, title, duration | TM-004 | yes | `update_task` (wrapped) |
| Notes / description | TM-004 | no | `task_notes` |
| Per-task reminder mode (none, once, several, escalating) | TM-004, RN-001 | no | `task_reminder_mode` |
| Delete (confirmed, undo 24 h) | TM-005 | yes | `delete_task` (wrapped) |
| Complete | TM-007 | yes | `complete_task` (wrapped) |
| Start a task (in progress) | TM-007 | partial (button) | `task_start` |
| Reopen a completed task | TM-004 | no | `task_reopen` |
| Progress ("50% done"), progress question | TM-007 | yes | `set_progress`, `query_progress` (wrapped) |
| Split into parts | TM-007 | yes | `split_task` (wrapped) |
| Plan my day / find time | TM-006 | yes | `plan_day` (wrapped) |
| Missed / overdue choices | TM-008 | partial (buttons) | — buttons on the overdue message are enough |
| Undo the last change | TM-004 | yes (tasks only) | `undo` (wrapped, now also settings, routines and bulk) |

## Subtasks (FR-TM-007)

| Feature | Chat today | Command |
|---|---|---|
| Split into named parts | yes | `split_task` (wrapped) |
| Add one subtask to a task | no | `subtask_add` |
| List a task's subtasks | partial (count in the progress reply) | `subtask_list` |
| Complete a subtask by number or name | partial (by exact title only) | `subtask_complete` |

## Routines (FR-RM-001…004)

| Feature | Chat today | Command |
|---|---|---|
| Create a routine | yes | `create_routine` (wrapped) |
| List routines | no | `routine_list` |
| Change time, days, title, priority, duration | no ("make it mandatory" chip even went to tasks) | `routine_update` |
| Pause / resume | no | `routine_pause`, `routine_resume` |
| Delete (confirmed, undoable) | no | `routine_delete` |
| Done today / skip today (mandatory asks first) | partial (buttons) | `routine_complete_today`, `routine_skip_today` |
| Move one occurrence | partial (buttons) | `routine_reschedule_once` |
| Location context of a routine | no | — set in the routine form (rare, needs a context picker) |

## Reminders and notifications (FR-RN-001…004, FR-AP-002)

| Feature | Chat today | Command |
|---|---|---|
| Snooze a WhatsApp reminder | yes (WhatsApp) | `snooze_task` (wrapped) |
| Per-task reminder mode | no | `task_reminder_mode` |
| Quiet hours (read / change) | no | `settings_quiet_hours` |
| Do Not Disturb on / off / for N hours / until a time | no | `settings_dnd` |
| Where reminders go: phone, WhatsApp (Pro), both | no | `settings_notify_devices` |
| Check-ins on / off, style | yes | `set_checkin_style` (wrapped, now undoable) |
| Notification method (sound / vibration) | no | — a device setting, the app screen previews the sound |

## Categories and tags (FR-CT-001/002)

| Feature | Chat today | Command |
|---|---|---|
| Category and #tags when adding a task | yes | `create_task` (wrapped) |
| Change a task's category | partial ("move it to category X") | `task_category` |
| Add / remove tags on a task | partial (add with #tag only) | `task_tags` |
| Create / rename / delete categories and tags | no | — app screen (colours, merging) |

## Locations (FR-LB-001, Pro)

| Feature | Chat today | Command |
|---|---|---|
| Place named when adding a task | yes | `create_task` (wrapped) |
| Remove / change a task's place | yes | `manage_location` (wrapped) |
| Manage saved places | no | — needs the map picker |

## Documents (FR-DP-001…004)

| Feature | Chat today | Command |
|---|---|---|
| Upload a timetable / outline | partial (WhatsApp photo or PDF; app has the Documents screen) | — needs a file, not a sentence |
| Class questions from the timetable | yes | `query_tasks` (wrapped) |

## Insights and analytics (FR-AN-001/002, FR-PL-001/002)

| Feature | Chat today | Command |
|---|---|---|
| Tasks completed this week / month | no | `insights_completed` |
| Streak (days in a row with something done) | no | `insights_streak` |
| Busiest / most productive day | no | `insights_busiest_day` |
| Time per category | no | `insights_category_time` |
| Overdue count | partial (overdue list) | `insights_overdue` |
| This week vs last week | no | `insights_compare_week` |
| Pattern recommendations | partial (buttons on suggestions) | — shown proactively, accepted by tap |

## Mood and support (FR-MH-001…004)

| Feature | Chat today | Command |
|---|---|---|
| Log a mood, get suggestions | yes | `log_mood` (wrapped) |
| Talk / support (Pro deep replies) | yes | `support` (wrapped) |
| Crisis resources | yes, always first | not a command: runs before everything |
| Mood history | no | — the Mood screen chart is clearer than text |

## Settings and account (FR-AP-001…004)

| Feature | Chat today | Command |
|---|---|---|
| Language (English / Urdu) | no | `settings_language` |
| Context switch ("I'm at work") | yes | `switch_context` (wrapped) |
| Show my settings | no | `settings_show` |
| Work hours, daily capacity | no | — app screen (rarely changed) |
| Account delete, export, sign out | no | — kept out of chat on purpose (security) |
| Pro upgrade | no | — needs the payment screen |

## Several things at once

| Feature | Chat today | Command |
|---|---|---|
| Move all of today to another day | no | `bulk_move_today` |
| Complete all tasks with a tag | no | `bulk_complete_tag` |
| Delete all completed tasks | no | `bulk_delete_completed` |
| Postpone non-urgent tasks | partial (button after stress / crisis) | `bulk_postpone_nonurgent` |
| Several requests in one message | no | multi-clause split (`commands/multi.ts`) |

Bulk commands show a preview (titles, at most 25 tasks), ask once, and undo as one batch.

## Help and fallback

| Feature | Chat today | Command |
|---|---|---|
| "What can you do?" | partial (six examples) | `help`, built from the registry |
| Message nothing understands | asks "task or just telling me?" | 4–5 relevant suggestions from the registry; with AI on, a two-stage LLM router picks a command first |
