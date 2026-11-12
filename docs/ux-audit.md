# UX audit and UI v2 proposal (12 Nov 2026)

Step 0 of the UI v2 task: audit and proposal only, no code changed. Method: each key flow was walked through the code
(`mobile/src`, main at `7b19f02`), counting taps from Home; each screen was checked against Nielsen's 10 heuristics
plus tap targets ≥ 48 dp, WCAG AA contrast, text scaling, screen-reader labels, empty / loading / error / offline
states and consistent wording. Tap counts are from the code and must be re-measured on the phone (PR 3 updates this
file with before / after numbers).

## 1. Tools used

No `/figma-use-motion`, `/design handoff`, `/design critique` or frontend-design / UX skill is installed (available:
morning, deep-research, xlsx, pdf, docx, pptx, docs, import-memory, skill-creator, google-workspace, chrome-browser,
built-in-browser, computer-use; plugins ponytail and headroom). Replacements, as agreed:

- motion: the written motion spec in §8;
- handoff: a "Handoff" section added to `docs/design.md` in each UI PR (tokens, components, states, copy keys);
- critique: the checklist pass in §4 (hierarchy, contrast, tap targets, spacing, consistency).

## 2. Key flows (taps from Home)

| # | Flow | Today's path | Taps | Friction / hidden |
|---|---|---|---|---|
| 1a | Add a task (form) | Tasks tab → "New task" (top right) → title → due date row → pick → confirm → scroll past ~15 controls → "Add task" | 6 + typing + long scroll | No add button on Home or within thumb reach; the save button is at the very bottom of a long form; every field is open at once |
| 1b | Add a task (chat) | Ask bar on Home → type → send (→ one chip if a detail is missing) | 2–3 | Good. The bar reads "Ask anything or add a task" but has no visible "+" |
| 2 | Complete a task | "Up next" → Mark done (only for the next task). Otherwise Tasks tab → swipe right, or open → "Mark complete" | 1 / 2 / 3 | Swipe complete and swipe postpone have **no Undo** (only delete has one); Home's "Today" rows can't be ticked for tasks (routines can); the swipe is the only fast path and is discoverable only through a tip |
| 3 | Start a task | "Up next" → Start (next task only); else chat "start X" or a check-in notification | 1 or typing | **No Start button on task detail or in the list**: the only visible Start is on Home's single "Up next" card |
| 4 | Create a routine | Scroll Home to "Organize" (bottom) → Routines → Add routine → name, how often, time → Save | 5–6 + scroll | Routines is below the fold on Home and not a tab; chat ("Daily meditation at 6 AM") is 2 taps but not suggested anywhere on the screen |
| 5 | Upload a document | Scroll Home to "Organize" → Documents → select file → picker → type → Extract → review → "Create N selected" | 6–7 + scroll | Upload isn't reachable from Home or the chat composer; three steps are explained only in a tip |
| 6 | Log a mood | Home "Check in" chip (only while a check-in is due); else scroll → Organize → Mood → pick → Log mood | 1 or 3 + scroll | The mood row disappears once logged; Mood is below the fold |
| 7 | Open the assistant | Assistant tab, or Home ask bar; voice: mic in the bar | 1 | Good |
| 8 | Answer a shared-task invitation | Push → Accept; Home "Shared with you" → Open → Accept; or bell → notice → Accept | 2 / 2 / 3 | Good (built in PR A). Decline needs a reason (by design) |
| 9 | Find tomorrow's tasks | Tasks tab → "Filters & sort" → Date range: Today / This week / This month (**no Tomorrow**) → scan; or chat "what do I have tomorrow" | 3 + scanning, or typing | **No one-tap Tomorrow** anywhere; filters are hidden behind a text link |

### After PR 2 (Home), taps from Home

| # | Flow | Before | After PR 2 |
|---|---|---|---|
| 1a | Open the task form | 2 (Tasks tab → New task) | **1** (floating "+" or "Task" under the ask bar) |
| 4 | Open Routines | 1 + a full scroll to "Organize" | **1**, no scroll (tile, shows "2 left today") |
| 5 | Open Documents / start an upload | 1 + a full scroll | **1**, no scroll ("Upload" or the tile) |
| 6 | Log a mood when no check-in is due | 1 + scroll, then pick + Log | **1** to Mood (tile, shows "Check in" / "Feeling calm"), then pick + Log |
| 2 / 3 | Start or finish the next task | 1 (Up next) | 1 (Next up), plus "then: …" shows what follows |
| — | Snooze the next task an hour | not possible in the app | **1** (Snooze 1 h, with Undo) |
| 8 | Shared-task invitation, bell | 2 / 3 | unchanged (both above the fold) |
| 9 | Tomorrow's tasks | 3 + scan | unchanged (PR 3) |

To confirm on the phone (counts from the layout; the fold is about 720 dp on a mid-range Android).

## 3. Problems ranked by impact on the 5-minute demo

Demo path assumed: Home first impression → add a task by chat and by form → start / complete it → tomorrow's plan →
routine → document → mood → shared task.

| Rank | Problem | Where | Heuristic | Fix (§5) |
|---|---|---|---|---|
| 1 | Home's first screen is text-heavy and its most used destinations (Routines, Documents, Mood) are at the bottom | Home | #6 recognition, #8 minimalist | Quick-access tiles with live counts above the fold (P2) |
| 2 | Swipe complete / postpone have no Undo; swipe label uses an emoji (⏭) | Tasks | #3 user control, #5 error prevention | Undo snackbar on every swipe; icon instead of emoji (P3) |
| 3 | No Start on task detail or list rows | Task detail, Tasks | #7 flexibility, #6 | Start button (existing `start_task` path) (P3) |
| 4 | No "Tomorrow" view | Tasks | #7, #6 | Today / Tomorrow / Week chips always visible (P3) |
| 5 | No add button within thumb reach; "New task" sits top right | Home, Tasks | Fitts, #7 | Floating "+" / quick-capture row (P2) |
| 6 | Task form shows ~15 controls; save button only after a long scroll | Add / Edit task | #8, #5 | Essentials first, "More options" collapsed, sticky save (P3) |
| 7 | Inconsistent words: New task / Add task; Mark done / Mark complete / Complete / Done; Postpone / Reschedule / Not today; Me / Profile | Many | #4 consistency | One glossary (§6), applied via `t()` (P3/P4) |
| 8 | Legacy screens: raw hex, emoji, `ui.*` styles; dark mode and Urdu not checked; few screen-reader labels | Task detail, form, Routines, Documents, Settings, Onboarding, Mood | #4, a11y | Polish pass (P4) |
| 9 | Home routine tick is 20 dp + 10 dp slop = 40 dp (< 48) | Home | a11y | 48 dp target (P2) |
| 10 | Missing states: task detail / form / Mood have no empty or offline state; several screens show raw "Couldn't …" without retry | Detail, Mood, Documents | #9 recover from errors | `EmptyState` / `ErrorState` with retry (P3/P4) |

Primitives already meet 48 dp (`Button sm`, `Chip` and `IconButton` add hit slop to 48), and the current palette
passes AA; the problems above are layout, discoverability and the legacy screens.

### Screen scan (counts from code; legacy = `constants/theme` / `ui.*` uses)

| Screen | Empty | Loading | Error | Offline | a11y labels | Raw hex | Emoji | Legacy |
|---|---|---|---|---|---|---|---|---|
| Home (Dashboard) | yes | skeleton | retry | sync badge | 5 | 0 | 0 | 0 |
| Assistant | — | yes | yes | yes | 4 | 0 | 0 | 1 |
| Tasks | yes | — | toast | badge | 0 | 1 | 2 | 1 |
| Task detail | — | spinner | toast | — | 0 | 1 | 1 | 19 |
| Task form | — | — | inline | — | 0 | 3 | 1 | 29 |
| Routines | yes | — | toast | — | 1 | 1 | 0 | 29 |
| Documents | yes | yes | yes | partial | 1 | 5 | 2 | 28 |
| Mood | — | — | toast | — | 0 | 1 | 0 | 9 |
| Insights | yes | yes | yes | — | 0 | 0 | 1 | 1 |
| Settings | partial | — | yes | — | 3 | 5 | 3 | 41 |
| People & sharing / Notifications | yes | skeleton | `ErrorState` | — | 7 | 0 | 0 | 0 |
| Onboarding | — | — | — | — | 0 | 1 | 0 | 23 |

## 4. Critique pass (checklist)

| Check | Result |
|---|---|
| Hierarchy | Home: greeting, ask bar, stats, attention, up next, today, mood, insights, organize — nine blocks, two of them (stats, insights) compete with the next action. One primary action per screen is missing on Tasks (search, filters, new task and swipe hints all at once) and Task detail (five full-width buttons stacked) |
| Contrast | Tokens pass AA in both themes (§7). Legacy screens use `#646A78` placeholders on inputs (AA) but a few raw colours can't follow dark mode |
| Tap targets | Primitives ≥ 48 dp; hand-built controls on Home (routine tick 40 dp) and Tasks (text-link "Filters & sort") are smaller |
| Spacing | Home uses the 4-pt scale; legacy screens mix 10 / 14 / 18 px |
| Consistency | Two icon sets on Home (inline SVG paths vs `Icon`); wording drift (§6); three card styles (Card primitive, legacy `ui.card`, TaskCard) |
| Text scaling | Tokens cap scaling per style (`maxScale`); legacy `ui.*` text has no cap and wraps badly at 1.3× in the task list header |
| Screen reader | Good on Home / collab; missing on list rows' swipe actions (no accessibility actions), form chips have labels via `Chip` |

## 5. Proposed improvements (not built)

Effort in hours (one developer), risk to existing behaviour, taps saved on the flows in §2.

| # | Improvement | Effort | Risk | Taps saved | Tier |
|---|---|---|---|---|---|
| A | **Quick-access tiles** on Home: Chat, Routines, Documents, Mood with live counts ("3 routines today", "1 document processing", "Mood: calm · 9 AM" / "Check in") from data the app already loads (`briefing.today.routines`, `listDocuments()` status, `briefing.mood`) | 3 | Low (read-only) | Routines / Documents / Mood: removes a full scroll each | 1 |
| B | **Quick capture** on Home: the ask bar keeps type + speak; add "+" (task form) and "Upload" (Documents with the picker open). "Snap" needs a camera module (`expo-image-picker` is not installed) — only if you approve a native module | 2 | Low | Add task (form): 1 tap; upload: 2 taps + scroll | 1 |
| C | **Add button within thumb reach**: a floating "+" on Home and Tasks (bottom right, above the nav), same target as B | 1 | Low | 1 tap on Tasks | 1 |
| D | **"Next up" focus card** (upgrade of today's "Up next"): title, planned time, Start / Done / Snooze 1 h, "then: …" line for the one after | 2 | Low (same actions) | Start / complete the next task: 1 tap (already), plus visibility | 1 |
| E | **Time-aware Home order** (deterministic: before 12:00 next up + today first; 12–18 next up + attention; after 18:00 done today + tomorrow preview + mood first) | 2 | Low | Tomorrow: 0 taps in the evening | 2 |
| F | **Undo on swipe complete / postpone** (snackbar 6 s), icon instead of ⏭, accessibility actions for the same two actions, swipe moved to Reanimated 4 + gesture-handler | 3 | Medium (gesture rewrite) — or 1 h for Undo only on the existing swipe | Recovering a wrong swipe: 4 taps → 1 | 1 (Undo) / 2 (rewrite) |
| G | **Long-press menu** on task rows: Start, Done, Tomorrow, Edit, Delete (Delete keeps its confirm and Undo) | 1 | Low (the menu exists as an alert; restyle to a `Sheet`) | — | 2 |
| H | **Start on task detail and list rows** (existing `start_task` path; never "rescheduled") | 1 | Low | Start a non-next task: typing → 2 taps | 1 |
| I | **Tomorrow chip**: Today / Tomorrow / This week chips always visible on Tasks; filters stay behind "Filters & sort" | 1 | Low (client filter) | Tomorrow: 3 + scan → 2 | 1 |
| J | **Progressive disclosure in the task form**: title, due date / time, **Planned start** (stays visible), priority first; "More options" (description, category, tags, type, duration, difficulty, context, reminders, places, status) collapsed with a summary line; sticky "Add task" button; smart defaults kept | 3 | Medium (form layout only; payload unchanged, covered by existing tests) | Add task (form): no long scroll; 1–2 taps | 1 |
| K | **Helpful empty states** with the next action ("No tasks tomorrow — Add one / Plan my day"); skeletons on Tasks, Detail, Routines, Mood | 2 | Low | — | 2 |
| L | **Optimistic updates**: complete / postpone already update the local store first (syncEngine); show the change at once and the Undo snackbar | 0.5 (with F) | Low | — | 1 |
| M | **Haptics** (`expo-haptics` is installed): light on complete, selection on chip, warning on delete (they follow the phone's own haptics setting) | 1 | Low | — | 2 |
| N | **Friendly offline / error messages** with Retry (`ErrorState`), one wording for "You're offline — changes will sync" | 2 | Low | — | 2 |
| O | **Consistent terminology** (§6) through `t()` | 2 | Low (copy only) | — | 2 |
| P | **First-run hints** for three actions (quick capture, swipe / long-press, Next up), dismissible, once (`TutorialTip` already stores dismissal) | 1 | Low | — | 2 |

## 6. Glossary (one word per action)

| Use | Instead of |
|---|---|
| Add task | New task, Create task |
| Done (button) / Mark as done (long label) | Mark complete, Complete, Completed (as an action) |
| Start | Begin, Focus |
| Move to tomorrow | Postpone, Reschedule to tomorrow, Not today (check-in keeps "Not today", it answers a question) |
| Snooze | Remind me later |
| Assistant | Chat, Ask (the bar keeps "Ask anything or add a task") |
| Me | Profile |
| Shared with you | Invitations |

## 7. Palette (from the logo)

The logo (`assets/branding/app-logo.svg`, `palette-reference.png`) uses **Primary Blue `#1D99FF`**, **Light Blue
`#E5F4FF`**, **Dark Blue `#005BB5`**, White, and the adaptive-icon background `#0A6FD6`. Raw `#1D99FF` fails AA for
text and for white text on it (2.98:1), so it stays a brand / illustration colour, never text or a button fill.

Proposed tokens (only `tokens.ts` changes; logo untouched):

| Token | Light | Dark |
|---|---|---|
| canvas | `#F5F8FC` (cool, matches the logo; today warm `#F6F5F2`) | `#0B1220` |
| surface | `#FFFFFF` | `#131B2B` |
| sheet | `#FFFFFF` | `#1A2436` |
| text | `#0F1B2D` | `#E6EDF7` |
| textSecondary | `#4A5566` | `#A9B4C4` |
| textTertiary | `#5E6A7B` | `#8C98AA` |
| accent (buttons, links) | `#0A6FD6` (= adaptive icon) | `#4DB0FF` (from `#1D99FF`) |
| onAccent | `#FFFFFF` | `#04111F` |
| accentStrong (selected chip text on tint) | `#005BB5` (= Dark Blue) | `#4DB0FF` |
| accentTint (selected chip / tile background) | `#E5F4FF` (= Light Blue) | `#12304D` |
| brand (illustration only) | `#1D99FF` | `#1D99FF` |
| success / warning / danger | unchanged (`#2E7A4D` / `#93600F` / `#B03A36`) | unchanged (`#6CC08B` / `#E0B263` / `#F0827C`) |

WCAG results (normal text needs 4.5:1):

| Pair | Light | Dark |
|---|---|---|
| text on canvas / surface | 16.23 / 17.28 | 15.89 / 13.21 (sheet) |
| textSecondary on canvas / surface | 7.09 / 7.55 | 8.93 / 7.42 |
| textTertiary on canvas / surface | 5.16 / 5.49 | 6.41 / 5.33 |
| accent on canvas / surface | 4.63 / 4.93 | 8.00 / 6.65 |
| onAccent on accent (primary button) | 4.93 | 8.12 |
| accentStrong on tint (selected chip) | 5.92 | 5.77 (accent on tint) |
| success / warning / danger on canvas | 4.92 / 5.03 / 5.63 | 8.51 / 9.56 / 7.30 |
| success / warning / danger on their bg | 4.52 / 4.60 / 4.93 | unchanged (already AA) |

All pass AA. One rule: on the light tint, selected text uses accentStrong (accent on tint is 4.40, large text only).
Alternative considered: keep today's palette (also AA). The logo palette is recommended because the app's warm canvas
and darker accent don't match the icon the user taps to open it. No new logo assets are needed for this option.

## 8. Motion spec (replaces the missing motion skill)

All with Reanimated 4, `useReducedMotion()` → no movement (opacity only, or instant). Durations from `motion` tokens.

| Moment | Motion | Duration / curve |
|---|---|---|
| Screen transition | native stack default (slide on Android); modal sheets slide up | platform |
| Press (buttons, cards, tiles) | scale 0.97 + pressed colour (exists in `PressableScale`) | spring `press` |
| List enter (first render only) | fade + translateY 8, first 8 items, 40 ms stagger (exists as tokens) | 220 ms ease-out |
| Complete a task | tick fills, title strikes, row fades to 60 %; haptic light | 220 ms |
| Swipe row | follows the finger; past 90 dp the action icon scales to 1.0; release springs back | spring `gentle` |
| Progress change | bar width animates | 300 ms ease-out |
| Bell badge | count change: scale 0.8 → 1 | 150 ms |
| Snackbar | slide up 16 + fade | 220 ms |
| Skeleton | breathing opacity 1 ↔ 0.5 | 900 ms (exists) |

Nothing animates per-row on scroll; no layout animations on lists longer than 8 items.

## 9. Home sketch (labelled)

```
┌──────────────────────────────────────────┐
│ THU 12 NOVEMBER           (sync) (bell•3)│  bell + badge: COLLAB_TASKS on
│ Good afternoon, Huzaifa                   │
│ 3 due today · 1 overdue · 2 done          │  today's summary (one line, was a stats card)
│ ┌──────────────────────────────────────┐ │
│ │ Ask anything or add a task     (mic) │ │  quick capture: type / speak
│ └──────────────────────────────────────┘ │
│ [+ Task] [Upload]                        │  quick capture: form / document
│ ┌ NEXT UP ─────────────────────────────┐ │
│ │ ● High · 3:00 PM–4:00 PM              │ │
│ │ Physics report                        │ │
│ │ [Start]  [Done]  [Snooze 1 h]         │ │
│ │ then: Gym · 6 PM                      │ │
│ └──────────────────────────────────────┘ │
│ [Assistant] [Routines 3 today]           │  quick-access tiles with counts
│ [Documents 1 processing] [Mood: check in]│
│ ┌ Shared with you (1) ─────────────────┐ │  COLLAB_TASKS on, only with an invitation
│ │ Lab report · from @sana   [Open]     │ │
│ └──────────────────────────────────────┘ │
├─────────────── fold (~720 dp) ───────────┤
│ NEEDS ATTENTION (if any)                 │
│ TODAY        Plan my day                 │  routines + tasks, tick on both
│ CHECK IN (mood chips, while due)         │
│ INSIGHTS (with the FR confidence)        │
│                                    (+)   │  floating add, thumb reach
│ [Home] [Tasks] [Assistant] [Insights] [Me]│
└──────────────────────────────────────────┘
```

Evening order (after 18:00): summary → "Done today" → "Tomorrow" preview (first 3) → mood check-in → next up.

## 10. Navigation

Today: Home, Tasks, Assistant, Insights, Me. Routines, Documents and Mood are rows in Home's "Organize" card at the
bottom (and Memory).

| Option | What | For | Against |
|---|---|---|---|
| **A (recommended)** | Keep the 5 tabs; Routines, Documents, Mood become Home tiles above the fold | No navigation change, nothing to relearn, safest before the deadline | Still not reachable from other tabs in one tap |
| B | Replace Insights with Routines; Insights moves to Me and a Home tile | Routines (daily use) one tap from anywhere | Insights is part of the FR demo; one more tap to it |
| C | Centre "+" capture button (Home, Tasks, +, Assistant, Me); Insights into Me | Strongest add affordance | Biggest change; Insights deeper; more code in the 1.5 days left |
| D | 6 tabs | Everything one tap | Labels too small at 360 dp; against platform guidance (3–5) |

## 11. Libraries

- **Skiper UI**: React + Tailwind components on shadcn/ui for Next.js, animated with Framer Motion / GSAP (free tier
  needs attribution). Web only.
- **Vengeance UI**: React / Next.js components on Radix UI + Tailwind + Framer Motion, copied in by a CLI. Web only.
- **animmasterlib**: not found under that name (no npm / GitHub match); can't be verified.

None can run in React Native. Use them only as visual / motion references, re-built with RN primitives and
Reanimated 4. Nothing to install.

## 12. Tiers and plan

| PR | Content | Tier | Effort |
|---|---|---|---|
| 1 | Logo-based tokens (§7), `tokens.ts` only, design.md tokens table + handoff | 1 | 1.5 h |
| 2 | Home: summary line, quick capture (+ Task, Upload), Next up card, tiles with counts, 48 dp ticks, floating "+", nav option A | 1 | 5 h |
| 3 | Key flows: Undo on swipe (F, Undo only), Start on detail / rows (H), Tomorrow chip (I), task-form disclosure (J), optimistic + Undo (L); re-measure taps here | 1 | 6 h |
| 4 | Polish: legacy screens to primitives (detail, form, Routines, Mood first), empty / error / offline states (K, N), glossary (O), first-run hints (P), haptics (M) | 2 | 6–8 h |
| 5 | Motion (§8), time-aware Home order (E), swipe on Reanimated (F rewrite), long-press sheet (G) | 2 | 4 h |

Deadline Saturday 14 Nov 12:00. Tier 1 (PRs 1–3) ≈ 12.5 h, which fits by Friday night; Tier 2 only if Tier 1 is
merged and demo-ready.
