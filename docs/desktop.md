# Desktop app (Windows)

The desktop app is the same app as the phone. The `mobile/` code is built for the web (react-native-web) and runs
inside an Electron shell in `desktop/`. It talks to the same backend, with the same Firebase sign-in, assistant,
sync and data. Nothing about AI runs on the desktop.

FRs it covers:
- Desktop is a primary channel (FR doc, role 2).
- FR-RN-002: desktop system notifications.
- FR-AP-002: "Desktop only" device choice.
- FR-MS-001/003: offline cache and sync across devices.

## How it is put together

| Piece | Where | What it does |
|---|---|---|
| Web build of the app | `mobile/` → `npx expo export -p web` → `mobile/dist` | Every screen, the assistant, sync, settings |
| Platform files | `mobile/src/**/*.web.ts(x)` | Desktop versions of phone-only modules. They have the same exports; `src/types/platformParity.ts` fails the typecheck if one falls behind |
| Desktop bridge | `mobile/src/services/desktopBridge.ts` ↔ `desktop/src/preload.ts` | `window.lifeOrganizer`: schedule / clear reminders, notification clicks, start with Windows |
| Electron main | `desktop/src/main.ts` | `app://lifeorganizer` protocol, window, tray, reminder timers, external links |
| Wide layout | `mobile/src/components/Sidebar.tsx`, `theme/useLayout.ts` | From 960 px wide: sidebar instead of the bottom nav, content capped at 760 px, sheets become dialogs (`docs/design.md` → Desktop layout) |

### Phone-only modules and their desktop versions

| Phone | Desktop |
|---|---|
| Local notifications (`services/reminders.ts`) | `reminders.web.ts` sends the same `/reminders/plan` to the shell. The shell fires Windows notifications even while the window is hidden in the tray. It honours "Notify on: Phone only / Desktop only / All" |
| Push (`services/push.ts`) | None. Task sync pulls every 2 min and the reminder plan refreshes every 10 min |
| Phone calendar (`services/calendar.ts`) | Off (the Settings card hides). The phone's calendar isn't on the computer |
| Location reminders, map picker | Off and hidden (they need the phone's background geofencing) |
| Voice input | Hidden: the Assistant's mic, the mic on Home's Ask bar and voice wording in Settings / help. Reading replies aloud still works |
| Sound / vibration style (Settings → Notifications → Method) | Hidden. It sets how the phone alerts; Windows decides how its notifications look and sound |
| `Alert.alert` confirmations | `services/dialog.ts` `showAlert()`: a themed in-app dialog (`DialogHost`) |
| Date / time wheels | The browser's own date / time input in a dialog (`DateTimePickerCompat.web.tsx`) |
| Share sheet (CSV export) | File download (`services/share.web.ts`) |
| Document upload | The browser `File` is sent (`utils/uploadPart.ts`) |

## Run it during development

```bash
cd backend && npm run dev                  # the API, as for the phone
cd mobile && npx expo start --web          # the app in a browser at http://localhost:8081 (fast refresh)
cd desktop && npm install && npm run dev   # the Electron shell around that dev server
```

`npm start` in `desktop/` runs the shell on the last export (`mobile/dist`) instead of the dev server.

## Build the installer

```bash
cd desktop
npm run dist        # expo export -p web → compile → electron-builder (NSIS)
```

The output is `desktop/release/LifeOrganizer-Setup-<version>.exe`. The installer is per user and lets you choose the
folder. It is not code-signed, so Windows SmartScreen asks for confirmation once ("More info → Run anyway").

**Before `npm run dist`:**
- **API address:** it is fixed at build time from `mobile/.env` (`EXPO_PUBLIC_API_BASE_URL`), as on the phone.
- **Stale address:** if you changed `.env`, delete `mobile/dist` first so the export can't reuse old code.
- **Production server:** list the desktop origin in the backend's `CORS_ORIGINS`:
  ```
  CORS_ORIGINS=app://lifeorganizer
  ```
  In development (`NODE_ENV` not production, no list) every origin is allowed.

## Behaviour

- **Closing the window** hides it to the tray, so reminders keep firing.
- **Tray menu:**
  - Open
  - Pause reminders
  - Start with Windows (the app then starts hidden in the tray)
  - Quit
- **Reminders:**
  - The schedule is saved, so reminders also fire after a restart before the app is online again.
  - After the PC wakes, reminders missed by up to 15 min fire late. Older ones are dropped.
  - Windows notifications have no action buttons. A click opens the task (or the check-in sheet) in the app.
- **Sign-in:** email and password through Firebase, kept in the app's own storage.
- **Name and icon in Windows:** Windows takes the name and icon of notifications, the taskbar button and the
  notification settings from the Start Menu shortcut that carries the app's id (`com.lifeorganizer.desktop`). It
  also starts that shortcut when a notification is clicked after the app has quit.
  - The installer creates this shortcut.
  - A development run (`npm start` / `npm run dev`) is plain `electron.exe`. It uses its own id
    (`com.lifeorganizer.desktop.dev`) and creates `Start Menu\Programs\Life Organizer (development)\Life Organizer.lnk`
    on start (`src/appIdentity.ts`).
  - If notifications ever say "Electron" or a click opens Electron's default page, a stray `Electron.lnk` with the
    app's id is in `%APPDATA%\Microsoft\Windows\Start Menu\Programs`. Delete it.
- **Links:** web, mail, phone and WhatsApp links open in the system's apps. The app window never navigates away.
- **Security:**
  - `contextIsolation`, sandboxed preload, no Node in the page.
  - A strict Content-Security-Policy on `app://` pages.
  - Files are served only from the web build. Path escapes are refused, which is tested.

## Checks

```bash
cd mobile && npx tsc --noEmit && npm test        # includes desktopWeb / desktopLayout tests
cd desktop && npm run typecheck && npm test      # scheduler, app:// paths, IPC channel parity, Windows identity
```

## Known limits

See `docs/known-limitations.md` → Desktop.
