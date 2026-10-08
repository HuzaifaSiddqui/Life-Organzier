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

| Token | Light | Dark | Use |
|---|---|---|---|
| `canvas` | `#F6F5F2` | `#0F1218` | Screen background (elevation 0) |
| `surface` | `#FFFEFB` | `#171B23` | Cards/containers (elevation 1) |
| `sheet` | `#FFFEFB` | `#1E232D` | Sheets, dialogs, floating chrome (elevation 2) |
| `hairline` | `rgba(25,28,34,0.10)` | `rgba(231,234,240,0.09)` | 1px borders |
| `scrim` | `rgba(15,18,24,0.40)` | `rgba(0,0,0,0.55)` | Behind sheets |
| `text` | `#191C22` (15.7:1) | `#E7EAF0` (15.6:1) | Primary text |
| `textSecondary` | `#565C69` (6.2:1) | `#A4AAB8` (8.1:1) | Supporting text |
| `textTertiary` | `#646A78` (5.0:1) | `#8A91A0` (5.9:1) | Hints, placeholders, timestamps |
| `accent` | `#0B66C2` (5.2:1) | `#5AAEFF` (8.0:1) | Brand accent, links, primary buttons |
| `onAccent` | `#FFFFFF` (5.7:1) | `#08111E` (8.1:1) | Text on accent fill |
| `accentSoft` | accent @ 10% | accent @ 14% | Selected / tonal backgrounds |
| `accentPressed` | accent @ 16% | accent @ 22% | Pressed backgrounds |
| `accentFocus` | accent @ 40% | accent @ 50% | Focus ring (`outline`) |
| `highlight` | `rgba(224,178,99,0.35)` | `rgba(226,194,94,0.30)` | Search-match highlight |
| `skeleton` | `#EAE8E3` | `#222833` | Skeleton blocks, progress tracks |
| `inverseSurface` / `onInverse` | `#22262E` / `#F1F2F5` | `#E7EAF0` / `#171B23` | Snackbar |

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
| `Sheet` | Bottom sheet (elevation 2) | `visible`, `onClose`, `title` | Springs up from the bottom; tap the scrim or press back to close; `accessibilityViewIsModal`; safe-area padding |
| `Skeleton` | Loading placeholder | `height`, `width`, `radius` | Compose skeletons that match the final layout. No bare spinners for content. Hidden from screen readers |
| `Snackbar` | Transient feedback + Undo | `text`, `tone` `neutral · success · warning · danger`, `action`, `onHide` | Inverse surface, above bottom nav, polite live region. Use an Undo action for delete / complete / edit |
| `EmptyState` | Empty screen or section | `icon` (emoji or node), `title`, `text`, `action` | Short helpful copy that teaches by example ("Try typing 'Submit report Friday 3 PM'") plus one action |
| `ErrorState` | Inline recoverable error | `error` (the caught value), `onRetry`, `assistant` | Copy comes from `friendlyError` kind; raw messages are never shown. `assistant` → "Assistant unavailable – your tasks still work" |
| `SyncBadge` | Offline / pending / syncing / failed | — (subscribes to `syncEngine`) | Hidden when synced. Retry when failed or offline |
| `ConflictSheet` | "Keep mine / Use cloud version" | `visible`, `mine`, `cloud`, `onKeepMine`, `onUseCloud`, `onClose` | **Not wired up:** `syncEngine` has no conflict detection yet |
| `SectionTitle`, `ProgressBar`, `ConfidenceMeter`, `HighlightText`, `TutorialTip`, `HelpButton` | Composites in `ui.tsx` | as before | Token-styled. `ProgressBar` has a progressbar role/value and is never width-animated. `HelpButton` opens a `Sheet` |

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

Not added: `expo-blur` (solid surfaces first; candidate for the chat composer), a charts library (`react-native-svg` + `components/charts` are enough), and a keyboard library (`KeyboardAvoidingView` first).

## Migration log

**Phase 0 (foundation): done.** Tokens, ThemeProvider, i18n/LocaleProvider, primitives, fonts, and the legacy theme remapped onto tokens. Unmigrated screens already pick up the new palette, fonts (via `ui.*` styles) and restyled primitives, but they still use static light styles, hard-coded copy and some legacy `Animated` code.

| Screen | Status |
|---|---|
| Assistant (chat + voice) | ⏳ next |
| Dashboard / Today | ⏳ |
| Task list | ⏳ (legacy `Animated` + `PanResponder` swipe) |
| Task detail / Add / Edit (TaskForm) | ⏳ |
| Routines | ⏳ |
| Documents (upload & extraction review) | ⏳ |
| Mood | ⏳ |
| Insights / Memory (analytics) | ⏳ |
| Auth: Welcome, Login, Signup, Forgot password, Email verification | ⏳ |
| Onboarding (+ notification pre-permission) | ⏳ |
| Settings / Profile (theme + language switch flow) | ⏳ |
| Shared: BottomNav, ScreenHeader, TaskCard, AssistantCards, Charts, ListeningWaveform, BreathingExercise, splash | ⏳ (migrated alongside their first screen) |

A screen counts as migrated when it uses primitives and `useTheme()` only (no `constants/theme`, no `ui.*`, no raw hex), all copy is in `strings.ts`, it has skeleton / empty / error / offline states, and it passes the accessibility checklist (contrast, 48dp targets, font scaling, RTL, reduce motion, TalkBack order) in light + dark, English + Urdu, at 360 dp.
