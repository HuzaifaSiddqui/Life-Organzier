# Life Organizer — Design System

Single source of truth for the mobile UI (`mobile/`). Future UI work follows this file; any deviation is written here **first**.

## Principles

- **Simple, clean, productivity-focused.** Reference standard: Linear, Things 3, Apple Design Award apps.
- **Calm over alarming.** Overdue/missed states offer 2–3 clear actions, never red walls or guilt copy.
- **Never expose technical AI details.** No raw API/error text, no model names; map errors to plain-language copy (`friendlyError`).
- **Whitespace and type separate content, not borders.** No boxes within boxes.
- **Colour is never the only signal.** Always pair it with an icon, label or shape.
- **Presentation layer only.** UI work doesn't touch services, the axios layer, Firebase auth, notification scheduling, zod schemas, navigation structure or state behaviour.

## Where things live

| Path | What |
|---|---|
| `mobile/src/theme/tokens.ts` | All tokens: colours (both themes), type, spacing, radii, elevation, motion |
| `mobile/src/theme/ThemeProvider.tsx` | `ThemeProvider`, `useTheme()`; system/light/dark override (persisted in AsyncStorage `ui.themeMode`); StatusBar + Android nav-bar button style |
| `mobile/src/theme/useEntrance.ts` | First-render staggered entrance hook |
| `mobile/src/i18n/strings.ts` | UI copy, `en` + `ur` (Urdu must define every key — enforced by type) |
| `mobile/src/i18n/LocaleProvider.tsx` | `useLocale()` → `{ language, isRTL, restartRequired, t }`, `plural()` |
| `mobile/src/components/primitives/` | Shared primitives (below) |
| `mobile/src/components/ui.tsx` | Re-exports primitives + small composites (SectionTitle, ProgressBar, ConfidenceMeter, HighlightText, TutorialTip, HelpButton) + deprecated static `ui` styles |
| `mobile/src/utils/friendlyError.ts` | `friendlyError(e)` → `offline · timeout · server · generic` |
| `mobile/src/utils/priorityColors.ts` | `priorityColor / priorityPill / categoryColor` — token-backed, take an optional `Palette` |
| `mobile/src/constants/theme.ts` | **Deprecated.** Legacy names mapped to light tokens for unmigrated screens. Delete when migration completes |

## Tokens

### Colour

Exactly one brand accent. Pressed, selected and focus states are opacity variations of it. Semantic and priority colours are desaturated and kept separate from the accent. Every text/background pair below was checked against WCAG AA (body text ≥ 4.5:1, large text and icons ≥ 3:1).

**UI v2 (12 Nov 2026): the palette comes from the logo** (`assets/branding/app-logo.svg`: Primary Blue `#1D99FF`, Light Blue `#E5F4FF`, Dark Blue `#005BB5`, white; adaptive-icon background `#0A6FD6`). Ratios below are against canvas (light) / canvas (dark); full table in `docs/ux-audit.md` §7.

| Token | Light | Dark | Use |
|---|---|---|---|
| `canvas` | `#F5F8FC` | `#0B1220` | Screen background (elevation 0) |
| `surface` | `#FFFFFF` | `#131B2B` | Cards/containers (elevation 1) |
| `sheet` | `#FFFFFF` | `#1A2436` | Sheets, dialogs, floating chrome (elevation 2) |
| `hairline` | `rgba(15,27,45,0.10)` | `rgba(230,237,247,0.09)` | 1px borders |
| `scrim` | `rgba(11,18,32,0.40)` | `rgba(0,0,0,0.55)` | Behind sheets |
| `text` | `#0F1B2D` (16.2:1) | `#E6EDF7` (15.9:1) | Primary text |
| `textSecondary` | `#4A5566` (7.1:1) | `#A9B4C4` (8.9:1) | Supporting text |
| `textTertiary` | `#5E6A7B` (5.2:1) | `#8C98AA` (6.4:1) | Hints, placeholders, timestamps |
| `accent` | `#0A6FD6` (4.6:1; = icon background) | `#4DB0FF` (8.0:1) | **Fills**: primary buttons, selected borders, progress, icons |
| `onAccent` | `#FFFFFF` (4.9:1 on accent) | `#04111F` (8.1:1) | Text on accent fill |
| `accentStrong` | `#005BB5` (6.2:1; 5.8:1 on `accentSoft`; = Dark Blue) | `#4DB0FF` (5.7:1 on `accentSoft`) | **Text** in the accent colour: links, selected chips, tonal / ghost buttons. `<Text color="accent">` renders it |
| `brand` | `#1D99FF` | `#1D99FF` | The logo blue: illustration only, never text or a fill behind text (2.98:1) |
| `accentSoft` | accent @ 10% | accent @ 14% | Selected / tonal backgrounds |
| `accentPressed` | accent @ 16% | accent @ 22% | Pressed backgrounds |
| `accentFocus` | accent @ 40% | accent @ 50% | Focus ring (`outline`) |
| `highlight` | `rgba(224,178,99,0.35)` | `rgba(226,194,94,0.30)` | Search-match highlight |
| `skeleton` | `#E6EBF2` | `#1C2638` | Skeleton blocks, progress tracks |
| `chartGrid` / `heat` | `#E6EBF2` / `#EEF3F9 → #E5F4FF → #8CC6FF → #1D99FF → #005BB5` | `#1C2638` / `#1A2436 → #12304D → #1F5A8F → #3C93E0 → #4DB0FF` | Chart gridlines and tracks; 5-step heat map (logo blues) |
| `inverseSurface` / `onInverse` | `#1A2436` / `#E6EDF7` | `#E6EDF7` / `#131B2B` | Snackbar |

Rule: accent on `accentSoft` is 4.3:1 in light (fails for small text), so text on a tinted background always uses `accentStrong`; `accent` is for fills, borders and icons. Legacy `constants/theme` maps `colors.primary` and `palette.ai` to `accentStrong` for the same reason.

**Semantic** (`fg` text/icon, `bg` tint; fg ≥ 4.5:1 on its own tint):

| | Light fg / bg | Dark fg / bg |
|---|---|---|
| `success` | `#2E7A4D` / `#E6F1E9` | `#6CC08B` / `#18271F` |
| `warning` | `#93600F` / `#F6EDDA` | `#E0B263` / `#2A2316` |
| `danger` | `#B03A36` / `#F7E5E3` | `#F0827C` / `#2D1B1C` |
| `info` | `#2C6390` / `#E3EDF5` | `#82B5E3` / `#162331` |

**Priority:** FR-TM-003 fixes the hues (red, orange, yellow, blue); these are desaturated versions. Always render the priority label next to its colour.

| | Light | Dark |
|---|---|---|
| `URGENT` | `#B83B35` | `#F0827C` |
| `HIGH` | `#B0581A` | `#F0A466` |
| `MEDIUM` | `#8A6A06` | `#E2C25E` |
| `LOW` | `#3767AE` | `#86ADEA` |

**Category hues:** a curated set of 8. Users pick from these; there is no free colour picker. Each index is the same hue in both themes. Category colours are for dots and icons only (≥ 3:1), never body text.

| # | Light | Dark | Default for |
|---|---|---|---|
| 0 | `#3A68C9` | `#86A8F0` | Work |
| 1 | `#7552C0` | `#AE95EA` | Personal |
| 2 | `#367F55` | `#79C59A` | Health |
| 3 | `#B65E22` | `#EFA06A` | Academic |
| 4 | `#237F80` | `#6FCAC6` | — |
| 5 | `#B4466F` | `#EA8DB3` | — |
| 6 | `#8F6A0E` | `#DDB65D` | Finance |
| 7 | `#5A6576` | `#A3ADBD` | Unknown/other |

Custom categories store the light hex. `categoryColor()` maps it to the dark twin by index.

### Typography

Fonts: **Inter** (400/500/600/700) and **Noto Nastaliq Urdu** (400/700), loaded with `expo-font` in `App.tsx`. Only these 6 files are imported (by subpath), not the package roots.

| Variant | Family | Size / line | Tracking | Max scale |
|---|---|---|---|---|
| `display` | Inter Bold | 32 / 38 | −0.64 | 1.3 |
| `title1` | Inter Bold | 24 / 30 | −0.48 | 1.3 |
| `title2` | Inter SemiBold | 20 / 26 | −0.40 | 1.4 |
| `headline` | Inter SemiBold | 17 / 24 | −0.17 | 1.4 |
| `body` | Inter Regular | 15 / 22 | 0 | 1.5 |
| `bodyStrong` | Inter SemiBold | 15 / 22 | 0 | 1.5 |
| `callout` | Inter Regular | 14 / 20 | 0 | 1.4 |
| `caption` | Inter Regular | 13 / 18 | +0.26 | 1.3 |
| `label` | Inter SemiBold | 12 / 16 | +0.24 | 1.3 |

- **Urdu:** if the content contains Arabic script, or it's non-string content while the UI language is Urdu, `Text` switches to Nastaliq. Line height becomes `fontSize × 1.9`, tracking 0, and Android `includeFontPadding: true` (it's `false` for Inter) so ascenders and descenders aren't clipped. Bold variants use Nastaliq 700.
- `maxFontSizeMultiplier` defaults to the variant's max scale, so system font scaling stays on but is capped.
- Use `tabular` (tabular numerals) for times, dates, counts and percentages.

### Spacing (strict 4/8 grid)

`xs 4 · sm 8 · md 12 · lg 16 · xl 24 · xxl 32 · xxxl 48`. Screen gutter is `lg` (16).

### Radii

`sm 8` (small buttons, skeletons) · `md 12` (cards, buttons, inputs, snackbar) · `lg 20` (sheet top corners) · `pill 999` (chips, icon buttons, badges).

### Elevation (`useTheme().elevation(level)`)

| Level | Use | Light | Dark |
|---|---|---|---|
| 0 | Canvas | — | — |
| 1 | Cards, containers | `surface` + hairline + iOS shadow (opacity 0.04, radius 3, y 1) / Android `elevation: 1` | `surface` + hairline, no shadow |
| 2 | Sheets, dialogs, floating chrome | `sheet` + hairline + iOS shadow (0.12, radius 16, y 6) / Android `elevation: 8` | `sheet` + hairline, no shadow |

Shadows are invisible on dark canvases, so in dark mode depth comes from lighter surfaces. Tinted (toned) cards drop the border and shadow.

### Motion

| Token | Value | Use |
|---|---|---|
| `duration.fast` | 150 ms | Exits, small fades |
| `duration.base` | 220 ms | Most transitions, snackbar in |
| `duration.slow` | 300 ms | Upper bound |
| `duration.pulse` | 900 ms | Skeleton breathing (one direction) |
| `pressScale` | 0.97 | Press feedback |
| `spring.press` | damping 22, stiffness 340, mass 0.6 | Press in/out |
| `spring.gentle` | damping 20, stiffness 180, mass 1 | Sheet entrance |
| `stagger` | step 40 ms, max 8 items, offsetY 8 | First-render list entrance |
| `snackbar` | 3500 ms plain / 6000 ms with action | Snackbar dwell |

Rules:
- Use Reanimated for all new animation, never the legacy `Animated` API. Animate only `transform` and `opacity`, and never layout properties.
- No linear easing. Use springs for press feedback and timing curves for fades.
- **Reduce motion:** `PressableScale` drops the scale, `Skeleton` stops pulsing, and `useEntrance` returns nothing.
- Entrance animation runs only on a screen's first render and only for the first 8 items. It never replays on scroll, refresh or re-render.
- Haptics (`expo-haptics`): a light impact on task completion and when a swipe passes its threshold, and nowhere else.
- Swipes use `react-native-gesture-handler` and must not capture vertical scrolling.

### Touch targets

Minimum **48 dp** (`touchTarget`). Smaller visuals reach it with `hitSlop`: IconButton is 40 visual, small Button 40, Chip 28/32.

## Components (`components/primitives`, re-exported from `components/ui`)

| Component | Purpose | Props / variants | States & rules |
|---|---|---|---|
| `Text` | All text | `variant` (type scale), `color` (`primary · secondary · tertiary · accent · onAccent · success · warning · danger · info · onInverse`), `tabular`, `center` | Auto Urdu font and line height; capped font scaling. Don't use RN `Text` directly in migrated screens |
| `PressableScale` | Base of every tappable | `pressedStyle`, `scale` (false for full-width list rows) | Pressed → spring to 0.97 plus `pressedStyle`; focused → 2px `accentFocus` outline; disabled → 45% opacity and `accessibilityState.disabled` |
| `Button` | Actions | `kind`: `primary · secondary · tonal · ghost · danger`; `size`: `md` (48) / `sm` (40 + hitSlop); `icon`, `loading` | Loading shows a spinner and `busy`. One `primary` per view. `danger` is a calm tint, not solid red |
| `IconButton` | Icon-only action | `icon`, **`accessibilityLabel` (required)**, `variant` `plain`/`tonal`, `selected` | 40 visual / 48 target |
| `Chip` | Filters, quick replies, tags | `label`, `selected`, `tone` `accent`/`danger`, `small`, `leading` (e.g. `Dot`) | Selected = soft accent fill + accent border/text; `accessibilityState.selected`. Without handlers it renders as static text |
| `Dot` | Priority/category marker | `color`, `size` | Always next to a label |
| `Card` | Elevation-1 container | `tone`: `neutral · accent · success · warning · danger`; `onPress` | Never nest cards. Tappable cards get press scale |
| `ListItem` | Row | `title`, `subtitle`, `leading`, `trailing`, `onPress` | Min height 56. No scale, pressed tint only |
| `Sheet` | Bottom sheet (elevation 2) | `visible`, `onClose`, `title` | Springs up from the bottom; tap the scrim or press back to close; `accessibilityViewIsModal`; safe-area padding. Sizes to its content and does not avoid the keyboard: don't put text fields in it (see `LocationPickerSheet`) |
| `KeyboardPad` | Keeps content above the on-screen keyboard | `style` | Pads the bottom by the keyboard height (Android 15+ is edge-to-edge and no longer resizes the window). One wraps the whole app in `RootNavigator`, so screens need nothing. A `Modal` is a separate window: the routine form wraps its content in one; the place picker uses `KeyboardAvoidingView` |
| `Skeleton` | Loading placeholder | `height`, `width`, `radius` | Compose skeletons that match the final layout. No bare spinners for content. Hidden from screen readers |
| `Snackbar` | Transient feedback + Undo | `text`, `tone` `neutral · success · warning · danger`, `action`, `onHide` | Inverse surface, above bottom nav, polite live region. Use an Undo action for delete / complete / edit |
| `EmptyState` | Empty screen or section | `icon` (emoji or node), `title`, `text`, `action` | Short helpful copy that teaches by example ("Try typing 'Submit report Friday 3 PM'") plus one action |
| `ErrorState` | Inline recoverable error | `error` (the caught value), `onRetry`, `assistant` | Copy comes from `friendlyError` kind; raw messages are never shown. `assistant` → "Assistant unavailable – your tasks still work" |
| `SyncBadge` | Offline / pending / syncing / failed | — (subscribes to `syncEngine`) | Hidden when synced. Retry when failed or offline |
| `ConflictSheet` | "Keep mine / Use cloud version" | `visible`, `mine`, `cloud`, `onKeepMine`, `onUseCloud`, `onClose` | **Not wired up:** `syncEngine` has no conflict detection yet |
| `SectionTitle`, `ProgressBar`, `ConfidenceMeter`, `HighlightText`, `TutorialTip`, `HelpButton` | Composites in `ui.tsx` | as before | Token-styled. `ProgressBar` has a progressbar role/value and is never width-animated. `HelpButton` opens a `Sheet` |

**Feature components (FR-LB-001 location reminders)** — built from the primitives above, `useTheme()` and `t()` only:

| Component | Use | Notes |
|---|---|---|
| `LocationPickerSheet` | Add / edit a place for a task, add or edit a saved place | Its own `Modal` (slide, `scrim` backdrop closes it) with a fixed panel at 85% of the screen inside a `KeyboardAvoidingView` (`padding` on iOS, `height` on Android). **Map first.** Top to bottom: handle, title + close, saved-place `Chip`s (one tap saves), search (500 ms debounce, 3+ letters, never auto-focused) with results listed under it (max 140 high) and shown as pins on the map, the `MapPicker` (opens on the current position, else Home, else the timezone's default view), "Tap the map or drag the pin" hint, then a scrolling details area: "Use current location", place name (a typed name is never overwritten), Home / University / Office naming `Chip`s, address, radius `Chip`s (Precise 200m / Nearby 350m / Area 750m) whose circle on the map updates live, "Reminder radius: 350 m", "Save location". A map tap or the end of a pin drag looks the spot up (`placeAt`) after 600 ms, never while dragging. While the keyboard is up the map collapses (stays loaded): typing a search gives the results the whole space; typing a name keeps the details visible. In Saved places, editing a place and moving the pin or picking a result moves that place (same name). Offline the map shows a short note and everything else works |
| `MapPicker` | The map inside `LocationPickerSheet` (and read-only on Saved places) | Leaflet in a `react-native-webview`, inlined from `node_modules` (`components/map/leaflet.generated.ts`, `npm run map:assets`), tiles and attribution from `config/map.ts` ("© OpenStreetMap contributors" always shown). Accent pin (draggable when `interactive`), accent radius circle, `textSecondary` dots for saved places and accent dots for search results; colours come from `useTheme()`. Props: `center` (recentres on change), `pin`, `radiusM`, `markers`, `interactive`, `onPinMoved`, `onMarkerTapped`, `onFailed`. Messages both ways are validated (`utils/map.ts`); the WebView may load only its own page (`isMapPageUrl`), other links open in the browser. Page or tiles failing → `warning` note with an icon and a secondary "Try again" button instead of the map; it also retries by itself when the connection comes back (`expo-network`). A light/dark switch remounts the page with the new colours (pin, circle and markers are sent again) |
| `TaskLocationsField` | Location chips on the task form and task detail (Pro only); tap opens `LocationActionSheet` (new, unsaved tasks: the picker) | `Chip` with a leading `pin` + `IconButton` close to remove; "Add location" secondary button; "Grant" hint when reminders are off; detail shows "· 1.2 km away" |
| `LocationActionSheet` | Tapping a location chip on a synced task | Compact `Sheet`: name, address (`displayAddress`) and "1.2 km away" as the confirmation (no map), radius `Chip`s that save at once (inline "Radius updated"), "Change location" (opens the picker) and "Remove from task" (Undo for 5 s) |
| `LocationOnboardingSheet` | First time Location reminders are turned on and allowed | One `Sheet` of `ListItem` rows: Home, University, Office and every other saved place (address, or "Tap to set location"; a check when saved). A row opens `LocationPickerSheet`, which saves at once. "Add another place" (no limit) and "Done". No text fields, no wizard |
| `WhatsappLinkCard` | Settings → WhatsApp | `Card`. Free: lock icon + "WhatsApp is a Pro feature". Pro, not linked: "Get link code" → the `LINK XXXXXXXX` message in a selectable `accentSoft` box, the bot number, "works for 10 minutes", "Open WhatsApp" (wa.me deep link with the message filled in) and "I've sent it" (re-checks). Linked: check icon + "Linked to ••••••567" and ghost "Unlink" (confirm alert). No phone-number field |
| `WhatsappAgentCard` | Settings → WhatsApp, under `WhatsappLinkCard` (hidden when the server has the feature off) | `Card`. Free: lock icon + "WhatsApp Agent is a Pro feature" (like `WhatsappLinkCard`). Header: title + small `Chip` status with an icon (Connected `check` / Needs reconnect `info` / Error `info` / Paused for a minute `clock` / Not connected `lock`). Not connected: 4 numbered steps, a masked (`secureTextEntry`) token-styled `TextInput` for the key, an `info`-tinted privacy box with a `lock` icon (not end-to-end encrypted, Meta handles messages, availability depends on Meta, key stored encrypted), a consent `Switch`, one primary Connect (disabled until consent + key), and a `globe` caption for "Agents not in your WhatsApp?" (no dead end). Connected: "Key ••••1234" (never shown again), a `warning` box with an icon when a reminder fell back to a notification, secondary "Send test message", reminder `Chip`s (Phone only / WhatsApp / Both, default Both) or a caption when switched off, a voice-notes `Switch` (on by default) whose caption says when the server can't transcribe right now, ghost Disconnect (confirm alert). Server error codes map to copy (`utils/whatsappAgent.ts`), never raw text. Copy `waAgent.*`: English, and **Roman Urdu** in the `ur` dictionary (this feature supports English and Roman Urdu only) |
| `LocationSetupCard` | Assistant chat, under a Pro task that names a place while Location reminders are off or the place isn't saved | `Card` with a `ListItem` (pin icon, "Location reminders", "Remind me about this task at Home") and a themed `Switch`. On: the system permission dialog; refused → `danger` caption. Then, if the place isn't saved, a secondary `sm` "Set Home on the map" button opening `LocationPickerSheet` (name prefilled, attaches to the task); saved → `success` caption "Done. You'll get a reminder when you arrive at Home." Reads the live toggle and task state, so an old card stays correct |
| `LocationSnackbar` | App-level location messages (permission hint, "Location removed · Undo", and, Pro only, when a task with a place exists while location reminders can't fire, at the first check after launch and for each new such task not added from chat (chat tasks get `LocationSetupCard`): "Grant location access for arrival reminders · Grant" if access is refused, "Turn on Location reminders to get a reminder when you arrive · Turn on" if only the toggle is off; the button turns the toggle on and opens the system dialog if needed) | `Snackbar` mounted next to `CheckinSheet`, fed by `showLocationSnackbar` |
| `DeadlineReviewItem` | Documents → each extracted deadline under review | Notes on a `warning`/`info` soft background, each with an icon (colour is never the only signal): no date / "needs the semester start" (a week number), "11:59 PM assumed", "found by AI", range start, year from the document; with DOC_EVIDENCE, "the AI's source line isn't in the document" (`warning`) and, with DOC_AGREE, "two AI readers found this" (`info`); with DOC_DATESHEET, "Year corrected from X to Y. Please check it." (`warning`, `docReview.yearCorrected`, English only until after 10 Nov 2026). Two secondary `sm` buttons with `calendar` / `clock` icons open the native date / time picker (Android dialog, iOS `Sheet` with Done); picking a date ticks the item, picking a time clears "assumed". The source words below as a `caption` (3 lines max). Nothing is created until "Create selected" |
| `DocumentTextView` | Documents → result, only when the server sends the text (DOC_FALLBACK_UI) | A `Card` with a secondary `sm` "See what was read" button (`doc` icon) that shows the extracted (masked) text as `caption` lines. With no results it is the empty screen instead: `warning` card, headline "I read this text but found no dates.", hint, the text, and two `sm` buttons "Pick lines" (tonal) / "Add manually" (secondary → AddTask). Pick mode: each line is a `PressableScale` checkbox row (accent box with `check` icon, `accentSoft` when picked, `accessibilityRole=checkbox`); "Review N picked lines" turns them into review items, nothing is created. Copy `docRoute.*`, English only until after 10 Nov 2026 (Urdu falls back to English) |
| `DocumentInstruction` (`InstructionInput`, `InstructionPanel`) | Documents → upload card (optional request) and the top of the review, only when the server has DOC_INSTRUCTIONS on | Upload: a `body` text field (hairline border, `radii.md`, min height 44) labelled "What do you need from this document? (optional)" with example `Chip`s that fill it. Review: a `Card` saying "Filtered by: … (12 of 148 items)" with `secondary` `sm` buttons "Show everything" / "Show only what I asked for" and "Change request" (opens the same field with Apply / Cancel); when the request isn't settled the card is `warning` toned and asks first: person `Chip`s for "which one?", the nearest names when nobody matches, or what was and wasn't understood, plus "Show everything (no request)" and the line "Nothing was added automatically until this is settled." Items the request leaves out are hidden and never pre-ticked; a `caption` counts them. Copy `docInstr.*`, English only until after 10 Nov 2026 |
| `CalendarSettingsCard` | Settings → "Phone calendar" section, only when the server has CALENDAR_SYNC on | `ListItem` with a `calendar` icon (accent), title "Add tasks and routines to my calendar", the line saying where events go (the Google calendar of the signed-up account, else a separate "Life Organizer" calendar) and that only the app's events are changed, as subtitle and a `Switch` (accent track); a `secondary` caption "Turning this off keeps the events already added until you use Remove all."; a `danger` caption when access is denied or the build lacks the module; a ghost `sm` "Remove all Life Organizer events" (only when there are events) → system `Alert` with the count (Cancel / destructive Remove) → screen `Snackbar` "Life Organizer events removed · Undo" |
| `CalendarCard`, `CalendarClashCard` (assistant) | Chat replies with a `calendar` card; the clash card is added on the phone after chat creates a task | Agenda: `Card` with rows (`caption` time column 112 wide, "All day" for all-day events, `body` title, 2 lines max) or "Nothing on your calendar."; free time: one `body` line per gap and a `caption` "Between 8 AM and 10 PM, 30 minutes or more."; add: `success` caption "In your calendar…". Sync off: `body` "Calendar sync is off." + secondary `sm` "Turn on calendar" (`calendar` icon). Clash: `warning` `Card` "You have X at 3 PM. Keep it?" with secondary "Keep" / ghost "Undo"; the answer replaces the buttons. New task from "add X to my calendar": the same Keep / Undo card (neutral tone) "Keep it?". Copy `calendar.*`, English only until after 10 Nov 2026 |
| Document type line (Documents → result, legacy styles) | Only when the server sends a type (DOC_ROUTING) | "Read as: {type}", a note for type Other (nothing added automatically) and "Wrong type? Read it again as:" with small `Chip`s for the other types; tapping one re-reads the stored text as that type (nothing is created) |
| Schedule review row (Documents → Extracted schedules, legacy styles) | Each class read from a document | Title, weekday chips, time and room inputs, confidence line. A room read from an image that doesn't look like a room code adds a `warning` caption "Check the room: it may have been misread from the image." (`docReview.checkRoom`, English/Urdu); editing the room removes it |
| `SavedPlacesScreen` | Settings → Saved places | A read-only `MapPicker` (200 high, one-finger panning off so the screen scrolls, pinch zooms) with a dot per place, centred and zoomed to fit them all; a dot opens that place. Below: `ListItem` rows (name, radius, use count), trash `IconButton` with confirm, skeleton / empty / error states |

**Feature components (task collaboration, `COLLAB_TASKS`)**, built from the primitives, `useTheme()` and `t()` only (copy `collab.*`, English only until after 10 Nov 2026):

| Component | Use | Notes |
|---|---|---|
| `ShareWithField` (`components/collab/`) | New task → "Share with (optional)" under the form (`TaskForm` `extra` slot, in a `Card`) | Renders nothing when the server has the feature off. A `body` text field (hairline, `radii.md`, 48 high) "Type @ to mention someone": an `@` at a word start lists the user's connections as `ListItem`s (username, or any word of the name, starts with what follows), max 6; a tap adds a selected `Chip` with a `user` icon and an `IconButton` close. No connections: a caption and a secondary `sm` "People & sharing" button. With someone picked: an `accent` `callout` line "Will be shared with @x, @y: together" (or ": only for them"; a polite live region), `Chip`s "Do it together" / "Only for them" and a caption saying what happens (on my plan now / not on my timeline; joins theirs when they accept). The submit button becomes "Share task"; the task list's success `Snackbar` ("Shared with @x …") has Undo (cancel for everyone, then delete my copy), then "Sharing undone" |
| `StateChip` (`components/collab/`) | A participant's state on a shared task | Pill (`radii.pill`, 24 high) with an icon and a `label`: Waiting (`clock`, neutral), Asked again (`info`, warning), Accepted (`check`, info), In progress (`clock`, info), Done (`check`, success), Declined (`close`, neutral), Removed it (`trash`, neutral). Neutral = `textSecondary` on `skeleton` |
| `CollabScreen` (Profile → People & sharing; a collab push opens it) | Requests · People · Shared, as `Chip` tabs ("Requests (2)" counts what waits for me) | No username yet: an `accent` `Card` with the username field and Save on top of every tab. **Requests:** incoming requests as `ListItem`s with tonal Accept / ghost Decline; task cards as `Card`s ("{name} wants to do this together with you" / "assigned this to you"; a changed task is `warning` toned: "changed this task. Accept it again"), title, notes, due + length, "With …", then tonal Accept, secondary "Another time", ghost Decline; Activity: notices as `ListItem`s (`info` icon accent when unread, `bell` when read; marked read on open). **People:** "You are @name · Change", a search field with a `search` icon ("Username or full email"; sent only for a username prefix of 3+ or a whole email, 250 ms debounce, older request aborted; otherwise a `secondary` caption "Type at least 3 letters of a username, or a whole email address."), results with tonal Add / static "Requested" / tonal Accept / static "Connected" chips; "Your people" with a trash `IconButton` (confirm alert; blocked → alert listing the open shared tasks); "Requests you sent" with ghost "Cancel request". **Shared:** a `Card` per task: title (+ "Cancelled" chip), "Together · From @x" or "Assigned · Not on your timeline", due · length · "2 of 3 done", each participant with a `StateChip` (and "(you)"), a `warning` caption "Picked Fri 6 PM" for a different time, ghost "Send again" for a declined member and a ghost `sm` "Remove" beside each member (owner; confirm alert "Remove @x from …?", destructive Remove), then "Open my task", Edit and ghost "Cancel for everyone" (confirm); a member sees a ghost "Leave" (confirm alert, destructive Leave). Skeleton / empty (`people` icon) / `ErrorState` states; action errors in a `warning` `Snackbar` |
| `SharedTaskEditScreen` | Owner: Edit (title, notes, due date and time, length chips); member: "Another time" (title read-only, date and time only) | Reuses `TaskFormDueDateRow` / `TaskFormDueTimeRow`. Caption says who will be asked again / told; one primary button ("Save and ask again" / "Accept for this time") |
| `SharedTaskEditScreen` → decline | "Decline" on a card, the accept screen or a "Decline" chat answer | Header "Why are you declining?"; a `Card` with the title, a `secondary` callout "{owner} will see your reason.", quick-pick `Chip`s (Too busy right now / Not my task / Wrong time for me), a multiline field (200 characters, hairline, `radii.md`) and a `tertiary` tabular count "n/200"; a `danger` "Decline" button (disabled until there is a reason) and a ghost "Keep it". Errors in a `danger` callout |
| `QuickTiles` (`components/home/`) | Home, below Next up (UI v2) | 2 × 2 grid of `PressableScale` tiles (`surface`, hairline, `radii.md`, min 64 dp): an `accentSoft` icon square (`accentStrong` icon), `bodyStrong` label and a one-line `caption`. The caption is live (`accent`: "2 left today", "All done today", "Check in", "Feeling calm") from the briefing Home already loads, else a plain `secondary` hint ("Ask or plan", "Daily habits", "Syllabus, timetable"). Tiles: Assistant, Routines, Documents, Mood. Screen-reader label "Routines, 2 left today". Rules in `utils/homeCards.ts` (tested) |
| `FloatingAddButton` (`components/`) | Home and Tasks, bottom right above the bottom nav (UI v2) | 56 dp `accent` circle, `plus` icon in `onAccent`, `elevation(2)`, label "Add task" → the task form. Hidden while a snackbar is showing (they share the strip above the nav, so Undo stays reachable) |
| Next up card (Home) | Home, above the fold (UI v2) | `Card tone="accent"`: priority dot + label, `headline` title, time / category; buttons Start (primary, `play`), Done (secondary, `check`), Remind in 1 h (ghost, `clock`); a `tertiary` caption "then: Gym · 7:00 PM" (`thenUp`). Snooze schedules a local reminder in 1 h through the notification-snooze store (`snoozeTaskReminder`), snackbar "I'll remind you about … at 4:10 PM" with Undo |
| Quick capture (Home) | Under the ask bar (UI v2) | The ask bar keeps type + speak (mic); a row of two `sm` buttons: "Task" (tonal → task form) and "Upload" (secondary → Documents). No "Snap" (no camera module) |
| Task form (`TaskForm`, Add / Edit) | UI v2 PR 3: progressive disclosure | First card: Title, due date, due time, Priority, **Type** (incl. Fixed time + hint), **Planned start** (+ "Find time" with a duration). Then **Share with** (`extra`, COLLAB_TASKS) as its own card. Then a "More options" row (48 dp, `label` + a `hint` line, chevron; `accessibilityState.expanded`): collapsed it lists every field that has a value ("Academic · #uni · 1h 30m · Hard", `utils/taskFormSummary.ts`, tested), else "Notes, category, tags, length, difficulty, place, reminders". Opened: notes, category (+ suggestion), tags, length (+ estimate), difficulty, context, reminders, places, status (edit). Hidden with `display: none`, never unmounted (fields keep their state). Save is pinned in a footer (hairline top, safe-area bottom) with the error above it. Payload and submit (calendar clash check, share) unchanged |
| Tasks list (UI v2 PR 3) | Tasks | Range chips always visible under the status chips: Any time / Today / **Tomorrow** / This week / This month (`utils/taskRange.ts`, tested; moved out of "Filters & sort"). Swipe right "Done" (`check`), left "Tomorrow" (`calendar`) — icon + word, no emoji — both with a snackbar **Undo** that puts the task back exactly: previous status **and progress** (`utils/taskUndo.ts`, tested; the calendar ✓ follows the status), or the previous dates. Rows of open, synced tasks get a tonal `IconButton` Start (`play`, label "Start {title}") under the priority |
| Task detail Start (UI v2 PR 3) | Task detail | Primary "Start" (`play`) above "Mark complete" for open, synced tasks ("Mark complete" becomes secondary then: one primary). Same `start_task` path as Home (`startTaskNow`) |
| Action names (UI v2 PR 4) | Everywhere | One word per action (`action.*`, en + ur; glossary in `docs/ux-audit.md` §6): Add task, Mark as done, Reopen task, Move to tomorrow, Plan it, Edit, Archive, Delete, Cancel, Do it now. The Tasks long-press menu is the same on iOS and Android |
| Haptics (`services/haptics.ts`, UI v2 PR 4) | Done (task, routine, Next up), Start, range chips, Move to tomorrow, before Delete | `expo-haptics` (already in the build): success on done, selection on start / chip / move, warning before a delete confirm. Follows the phone's haptics setting; no-op where unavailable. Never the only feedback (each action also shows text) |
| Empty states (UI v2 PR 4) | Tasks, Home → Today, Routines | `EmptyState` with the reason and the next step: Tasks by why it's empty (`utils/emptyStates.ts`, tested): search → Clear search; filters / status → Clear filters; Today → Add task + Plan my day; Tomorrow / none → Add task + Ask the assistant (first button primary, the second secondary, `sm`). Home Today: Add task (tonal) + Plan my day. Routines: Add routine. Copy `empty.*` |
| Evening order (Home, UI v2 PR 4) | Home from 18:00 local time (`isEvening`) | The mood check-in moves above Next up, followed by a "Tomorrow" card (first 3 open top-level tasks for tomorrow from the phone's task store, `tomorrowPreview`, tested; "See all" → Tasks with Tomorrow selected). Nothing else moves; the done count is in the summary line |
| `NotificationsScreen` (Home bell) | All in-app notices | `ScreenHeader` "Notifications" with a ghost `sm` "Mark all read" when anything is unread; a `Card` of `ListItem`s: the notice line, relative time, `info` icon (accent) when unread or `bell` (tertiary) when read, a `check` `IconButton` "Mark read" on unread rows; a tap marks it read and opens its task, the card to answer, or People & sharing. Skeleton / `EmptyState` (bell) / `ErrorState`; pull to refresh |
| `NotificationBell`, `SharedWithYouCard` (`components/collab/HomeShared`) | Home header (right of the sync badge) and above the day's summary | Bell: 40×40 target, `bell` icon, a `danger` pill badge (unread count, "9+" above 9, 2-pt canvas border); its label says the count. Card (`accent` tone): `people` icon + headline "Shared with you", up to two invitations (title, "{owner} wants to do this together with you" / "assigned this to you" · due) each with a tonal `sm` "Open" (→ the accept screen), then "{n} more waiting". Both render nothing while COLLAB_TASKS is off |
| `MentionPicker` (`components/collab`) | Chat composer, above the input, while an "@" is being typed | A hairline `surface` box with a `label` "Your people" and up to 5 `ListItem`s (`user` icon, @username, display name); a tap replaces the "@…" with "@username ". "No one in your people matches …" caption when nothing matches. Nothing while COLLAB_TASKS is off |
| Task detail → "Shared task" | A task that is my copy of a shared one | `ListItem` (`people` icon, "See everyone's progress", chevron) under the main card, opening the Shared tab |

Icons added: `pin` (map pin) and `people` (two people), same 1.8 stroke line style.

`Sheet` is a bottom-anchored flex child inside the modal (not `position: absolute`), so it re-measures when its content changes after opening (the picker grows from search to results to the radius step).

Legacy prop renames done in Phase 0: Button `kind="ai"` → `"tonal"`, Card/Chip `tone="ai" | "primary"` → `"accent"`, `Toast` → `Snackbar`.

## Language, i18n & RTL

- UI languages: **English** and **Urdu**. The `language` setting `ur` gives the Urdu UI; every other value (ar, es, fr, …) gives English UI, and those values still drive assistant replies and speech.
- Every UI string goes through `t("key")` from `useLocale()`. Screens move their copy into `strings.ts` as they migrate. Plurals use separate `.one` / `.other` keys via `plural()`.
- The language is cached in AsyncStorage (`ui.language`) so signed-out screens and first paint use the last known language.
- **RTL:** use logical style props only (`start/end`, `marginStart/End`, `paddingStart/End`, `borderTopStartRadius`, …), never `left/right`. Directional icons and swipe directions mirror in Urdu. Switching direction calls `I18nManager.forceRTL` and needs an app restart, so `useLocale().restartRequired` drives the "Restart to switch layout" prompt (copy keys `restart.*`). The flow is designed during the Settings migration.

## Rollout flags (flip only when the migration log is complete)

| Flag | File | Effect while `false` | Also flip |
|---|---|---|---|
| `DARK_MODE_READY` | `theme/ThemeProvider.tsx` | App always renders the light theme | `app.json` `userInterfaceStyle` → `"automatic"` (otherwise native pickers/alerts mismatch). Needs a rebuild |
| `RTL_READY` | `i18n/LocaleProvider.tsx` | Urdu copy shows, but layout stays LTR | — |

Checklist before flipping a flag:

- [ ] When setting `DARK_MODE_READY = true`, also set `app.json` `userInterfaceStyle` to `"automatic"` and rebuild the app (native change). Don't change `userInterfaceStyle` earlier: native pickers and alerts would render dark inside a light app.
- [ ] Every screen in the migration log is ✅ and checked in light + dark.

## Do / Don't

- **Do** take every colour, size, radius, duration and spring from tokens. Raw hex values, font sizes and durations belong only in `tokens.ts`.
- **Do** use `StyleSheet` with the typed theme. **Don't** add styling frameworks (NativeWind, Tamagui, styled-components).
- **Do** give every icon-only control `accessibilityLabel` + `accessibilityRole`, and set `accessibilityState` for selected / disabled / checked.
- **Do** memoise list items, use stable keys and set `windowSize` / `initialNumToRender` on long lists. **Don't** put blur or heavy shadows inside scrolling lists.
- **Don't** use pure black or flat greys (`#000`, `#333`, `#666`), or a second accent colour. The old assistant purple now maps to the accent.
- **Don't** show raw API or error text. Use `ErrorState` or `friendlyError`.
- **Don't** use red for overdue states. Use the `warning` tone and offer actions.
- **Don't** show the clarity score. Draft cards show what's missing ("Needs: time, duration"), or "Please confirm" / "Ready to add". The score stays internal (auto-create vs review, logging). Confidence is shown only where the FRs require it (recommendations, document extraction).

## Dependencies added for UI

All installed with `npx expo install`. The native ones need a **new development build**.

| Package | Why | Native |
|---|---|---|
| `react-native-reanimated` 4.5 + `react-native-worklets` | UI-thread animation (press, sheet, skeleton, entrance) | yes |
| `react-native-gesture-handler` | Swipe actions that don't fight scrolling; `GestureHandlerRootView` at app root | yes |
| `expo-haptics` | Completion / swipe-threshold feedback | yes |
| `expo-font` | Font loading (config plugin added to `app.json`) | yes |
| `expo-navigation-bar` | Android nav-bar button style per theme (edge-to-edge: the bar is transparent over `canvas`) | yes |
| `@expo-google-fonts/inter`, `@expo-google-fonts/noto-nastaliq-urdu` | Font files | no |
| `expo-location`, `expo-task-manager` | FR-LB-001 geofence reminders (config plugin in `app.json` adds fine/coarse/background location) | yes |
| `react-native-webview` | FR-LB-001 map picker (Leaflet page) | yes |
| `expo-calendar` | CALENDAR_SYNC: the "Life Organizer" calendar and busy time (config plugin in `app.json` adds the calendar permissions and the iOS reason text); loaded lazily so older dev clients keep working | yes |
| `leaflet` (dev dependency) | Inlined into `components/map/leaflet.generated.ts` by `npm run map:assets`; nothing loads from a CDN | no |

App-level transient messages with no screen of their own (e.g. the one-time location-permission hint, `components/LocationPermissionHint.tsx`) use the same `Snackbar`, mounted once next to `CheckinSheet` in `RootNavigator` and fed by a small listener in the service.

Not added: `expo-blur` (solid surfaces first; candidate for the chat composer), a charts library (`react-native-svg` + `components/charts` are enough), and a keyboard library (the `KeyboardPad` primitive covers screens; don't add `KeyboardAvoidingView` to screens, it would pad twice. Text entry in a popup uses a `Modal` + `KeyboardAvoidingView`, as `LocationPickerSheet` does).

## Handoff (UI v2)

Per UI v2 PR: what changed for whoever builds the next screen. Audit, flows and plan: `docs/ux-audit.md`.

- **PR 4, polish (12 Nov 2026).** New copy goes in `strings.ts` with Urdu; action labels come from `action.*` only. Haptics only through `services/haptics.ts`. An empty list always names the reason and offers a next step. Home's time rule is `isEvening()` (deterministic, local clock).
- **PR 3, key flows (12 Nov 2026).** Start everywhere goes through `startTaskNow` (assistant `start_task`; keeps the plan, never "rescheduled"); unsynced (local-id) tasks get no Start. Any new swipe must keep its Undo and a visible alternative (row Start, long-press menu). Form copy `taskForm.*`, list copy `tasks.*`, `task.start*` (en + ur).
- **PR 2, Home (12 Nov 2026).** Order: date / sync / bell → greeting → summary line ("3 due today · 1 overdue · 2 done", overdue in `danger`) → ask bar (type, speak) → quick row (Task, Upload) → context chips → Shared with you (COLLAB_TASKS) → Next up → tiles → tip → Needs attention → Today (workload bar moved here from the old stats card) → Check in → Insights → Organize (Memory only; Routines, Documents and Mood are tiles). Copy `home.*` in `strings.ts` (en + ur). New behaviour, approved: "Remind in 1 h" on Next up (local reminder, Undo; first named "Snooze 1 h"). The floating "+" also sits on Tasks.
- **PR 1, colour (12 Nov 2026).** Only `theme/tokens.ts` holds colours. New tokens `accentStrong`, `brand`, `chartGrid`, `heat`. Use `colors.accent` for fills / borders / icons and `<Text color="accent">` (→ `accentStrong`) for text. Placeholders: `palette.muted` (legacy) or `colors.textTertiary`. Remove / tick marks are the `close` / `check` icons, never "✕" / "✓" text. Category colours offered in Settings are `palettes.light.category` (the curated 8). The native splash background (`app.json`, `#F6F5F2`) is unchanged: changing it needs a new build.

## Migration log

**UI v2, PR 4 (polish, 12 Nov 2026).** O: action names unified (Tasks header and long-press, task detail, Add screen title). M: haptics on done / start / chips / move / before delete. K: empty states with next actions on Tasks, Home Today and Routines. E: evening order on Home (check-in + Tomorrow card first after 18:00). Tasks also follows its `filter` parameter when opened again.

**UI v2, PR 3 (key flows, 12 Nov 2026).** Task form: essentials first, "More options" collapsed with a summary, pinned Save. Tasks: Tomorrow chip, range chips visible, Undo on swipe complete / move, icon swipe labels, row Start. Task detail: Start. Next up button renamed "Remind in 1 h". The task form, Tasks and task detail stay legacy-styled otherwise (PR 4).

**UI v2, PR 2 (Home, 12 Nov 2026).** Dashboard partly migrated: new parts on primitives + `useTheme()` + `t()` (summary line, quick row, Next up, `QuickTiles`, `FloatingAddButton`, workload); the older blocks (attention, today, check in, insights) keep their English copy for PR 4. The stats card became the summary line; the Organize card keeps only Memory.

**UI v2, PR 1 (colour, 12 Nov 2026).** Logo palette in `tokens.ts` (both themes, AA checked); `accentStrong` for accent text (`Text` primitive, legacy `colors.primary` / `palette.ai`). Raw colours and glyph icons removed from the Tier 1 screens: task detail (1 hex, "✓" → `check`), task form (3 hex, "✕" tag chip → `close`), Routines (1), Documents (3 hex + 2 `#fff`, "✓" → `check`), Settings (4 hex, 8-colour list → category tokens, 3 "✕" chips → `close` + labels "Remove …"), Onboarding (1). Also tokenised: placeholders on Login, Signup, Forgot password, Tasks, Memory, Mood, the date / time pickers and the root navigator; Insights charts (bar colour, grid, heat ramp). No raw hex left outside `tokens.ts`, `constants/theme` and the logo components.

**Phase 0 (foundation): done.** Tokens, ThemeProvider, i18n/LocaleProvider, primitives, fonts, and the legacy theme remapped onto tokens. Unmigrated screens already pick up the new palette, fonts (via `ui.*` styles) and restyled primitives, but they still use static light styles, hard-coded copy and some legacy `Animated` code.

| Screen | Status |
|---|---|
| Assistant (chat + voice) | ⏳ next |
| Dashboard / Today | ⏳ |
| Task list | ⏳ (legacy `Animated` + `PanResponder` swipe) |
| Task detail / Add / Edit (TaskForm) | ⏳ (legacy; "Planned start" date + time rows are always shown now, not only with a duration; "Find time" still needs a duration. Type chip "Fixed event" renamed "Fixed time" (hint "class, meeting, exam — the planner never moves it"), picked by itself for a new task with a class / meeting / exam word until the user taps a type) |
| Routines | ⏳ (legacy; the form's "How often?" adds an "Every few days" chip: "Repeat every 2–7 days" chips, a "Starting" date row (`TaskFormDueDateRow`) and a preview line; the list shows "Every other day, starting 25 Oct". The form has a "Reminder" switch (RN `Switch`, on by default; off = no reminder and no set time) above the time field, and the "Flexible" chip is gone; the list shows "no reminder" for routines without a time. "Add routine" (primary `Button`) is now the first item on the screen, above the tip, instead of the bottom "＋ New routine". Opened with `routineId` (chat card / "Open routine"), it shows that routine's form. English only, like the rest of this screen) |
| Documents (upload & extraction review) | ⏳ (migrated parts: `DeadlineReviewItem`, copy in `strings.ts` en + ur; `DocumentTextView`, `DocumentInstruction` and the type line's copy, `docRoute.*` / `docInstr.*` and `docReview.yearCorrected`, English only until after 10 Nov 2026; both appear only behind their server flags. The rest of the screen is legacy) |
| Mood | ⏳ |
| Insights / Memory (analytics) | ⏳ |
| Auth: Welcome, Login, Signup, Forgot password, Email verification | ⏳ |
| Onboarding (+ notification pre-permission) | ⏳ |
| Settings / Profile (theme + language switch flow) | ⏳ (the new "Phone calendar" section is a migrated component, `CalendarSettingsCard`; the screen around it is not) |
| Shared: BottomNav, ScreenHeader, TaskCard, AssistantCards, Charts, ListeningWaveform, BreathingExercise, splash | ⏳ (migrated alongside their first screen) |
| People & sharing (`CollabScreen`, `SharedTaskEditScreen`) | Built on primitives + `useTheme()` from the start, copy in `strings.ts` (`collab.*`, English only until after 10 Nov 2026); not yet checked in dark / Urdu / 360 dp. `SharedTaskEditScreen` reuses the legacy date/time rows. `ShareWithField` sits inside the legacy `TaskForm` |
| Calendar changes note (`CalendarChangesSnackbar`, app level next to `LocationSnackbar`) | `Snackbar` primitive; copy `calendar.pulled.*` ("\"X\" moved from your calendar", "… deleted from your calendar. The task is still in the app …", "N tasks updated …") with an "Open" action for one task. Settings → Phone calendar adds a caption (`calendar.twoWayHint`) saying calendar edits come back on open or every 15 minutes, not instantly. Chat routine card (`AssistantCards`) is now a `Pressable` that opens the routine |

A screen counts as migrated when it uses primitives and `useTheme()` only (no `constants/theme`, no `ui.*`, no raw hex), all copy is in `strings.ts`, it has skeleton / empty / error / offline states, and it passes the accessibility checklist (contrast, 48dp targets, font scaling, RTL, reduce motion, TalkBack order) in light + dark, English + Urdu, at 360 dp.
