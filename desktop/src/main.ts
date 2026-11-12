import { app, BrowserWindow, ipcMain, Menu, nativeImage, net, Notification, powerMonitor, protocol, shell, Tray } from "electron";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { APP_NAME, relaunchCommand, windowsIdentity, type WindowsIdentity } from "./appIdentity";
import { APP_ORIGIN, APP_SCHEME, CSP, isExternalAllowed, resolveAppFile } from "./appProtocol";
import { IPC, type DesktopReminder } from "./bridge";
import { planTimers, sanitizeReminders } from "./reminderScheduler";

/**
 * Life Organizer for Windows (docs/desktop.md). Runs the app's web build (mobile/, `expo export -p web`) from
 * app://lifeorganizer/, fires reminders as Windows notifications even while the window is hidden in the tray
 * (FR-RN-002), and can start with Windows. All app logic, the API and AI stay in the web build and the backend.
 */

const DEV_URL = process.env.LO_DEV_URL; // `npm run dev`: load the Expo web dev server instead of the export
const startHidden = process.argv.includes("--hidden");

protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let paused = false;
let reminders: DesktopReminder[] = [];
const timers = new Map<string, NodeJS.Timeout>();
/** Shown notifications. Electron drops a click handler once its notification is garbage-collected. */
const shown = new Set<Notification>();
let identity: WindowsIdentity;

const webRoot = () => (app.isPackaged ? path.join(process.resourcesPath, "web") : path.resolve(__dirname, "../../../mobile/dist"));
const iconPath = () => path.join(app.getAppPath(), "build", "icon.png");
/** Windows draws the window / taskbar icon from the .ico (several sizes); PNG elsewhere. */
const windowIcon = () => path.join(app.getAppPath(), "build", process.platform === "win32" ? "icon.ico" : "icon.png");
const dataFile = (name: string) => path.join(app.getPath("userData"), name);

function readJson<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(dataFile(name), "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(name: string, value: unknown): void {
  try {
    fs.writeFileSync(dataFile(name), JSON.stringify(value));
  } catch (error) {
    console.warn(`Could not save ${name}`, error);
  }
}

/* ------------------------------------------------------------------ window */

type Bounds = { x?: number; y?: number; width: number; height: number; maximized?: boolean };

function showWindow(): void {
  if (!win) createWindow();
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow(): void {
  const saved = readJson<Bounds>("window.json", { width: 1280, height: 820 });
  win = new BrowserWindow({
    ...saved,
    minWidth: 420,
    minHeight: 560,
    show: false,
    title: APP_NAME,
    icon: windowIcon(),
    backgroundColor: "#F8FAFC",
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true },
  });
  if (saved.maximized) win.maximize();
  // Taskbar button, jump list and pinning use Life Organizer's name and icon, not electron.exe's.
  if (process.platform === "win32") {
    win.setAppDetails({ appId: identity.appId, appIconPath: identity.icon, appIconIndex: 0, relaunchCommand: relaunchCommand(identity), relaunchDisplayName: APP_NAME });
  }
  // The title bar keeps the app's name (the web build sets document.title per screen).
  win.on("page-title-updated", (e) => e.preventDefault());
  win.once("ready-to-show", () => {
    if (!startHidden) win?.show();
  });

  // Links: http(s) / mailto / tel / wa.me open in the system's apps; the app itself never navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalAllowed(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    const own = url.startsWith(APP_ORIGIN) || (DEV_URL && url.startsWith(DEV_URL));
    if (own) return;
    e.preventDefault();
    if (isExternalAllowed(url)) void shell.openExternal(url);
  });

  const saveBounds = () => {
    if (!win || win.isMinimized()) return;
    writeJson("window.json", { ...win.getNormalBounds(), maximized: win.isMaximized() });
  };
  win.on("resize", saveBounds);
  win.on("move", saveBounds);
  // Closing hides to the tray so reminders keep firing; Quit is in the tray menu.
  win.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    win?.hide();
  });
  win.on("closed", () => {
    win = null;
  });

  void win.loadURL(DEV_URL ?? `${APP_ORIGIN}/`);
}

/* --------------------------------------------------------------- reminders */

function clearTimers(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
}

function fire(item: DesktopReminder): void {
  timers.delete(item.id);
  reminders = reminders.filter((r) => r.id !== item.id);
  writeJson("reminders.json", reminders);
  if (paused || !Notification.isSupported()) return;
  const n = new Notification({ title: item.title || APP_NAME, body: item.body, icon: iconPath() });
  shown.add(n);
  n.on("click", () => {
    shown.delete(n);
    showWindow();
    win?.webContents.send(IPC.click, item);
  });
  n.on("close", () => shown.delete(n));
  n.show();
}

/** (Re)arms every timer from `reminders`: after a new plan, at start-up (saved plan) and after the PC wakes up. */
function arm(): void {
  clearTimers();
  for (const { item, delay } of planTimers(reminders, Date.now())) {
    timers.set(item.id, setTimeout(() => fire(item), delay));
  }
}

function schedule(items: DesktopReminder[]): void {
  reminders = items;
  writeJson("reminders.json", reminders);
  arm();
}

/* -------------------------------------------------------------------- tray */

function launchAtLogin(): boolean {
  return app.getLoginItemSettings().openAtLogin;
}

function setLaunchAtLogin(on: boolean): void {
  app.setLoginItemSettings({ openAtLogin: on, args: ["--hidden"] });
  buildTrayMenu();
}

function buildTrayMenu(): void {
  tray?.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Open ${APP_NAME}`, click: showWindow },
      { type: "separator" },
      {
        label: "Pause reminders",
        type: "checkbox",
        checked: paused,
        click: (m) => {
          paused = m.checked;
          writeJson("settings.json", { paused });
        },
      },
      { label: "Start with Windows", type: "checkbox", checked: launchAtLogin(), click: (m) => setLaunchAtLogin(m.checked) },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

function createTray(): void {
  const image = nativeImage.createFromPath(iconPath()).resize({ width: 16, height: 16 });
  tray = new Tray(image);
  tray.setToolTip(APP_NAME);
  tray.on("click", showWindow);
  buildTrayMenu();
}

/* --------------------------------------------------------------- lifecycle */

/**
 * Development runs are plain electron.exe: give Windows a Start Menu shortcut with this app's id, name and icon so
 * notifications say "Life Organizer" and a click relaunches this app (docs/desktop.md). The installer does this
 * for the packaged app.
 */
function registerDevShortcut(): void {
  if (process.platform !== "win32" || !identity.shortcut) return;
  try {
    fs.mkdirSync(path.dirname(identity.shortcut), { recursive: true });
    const exists = fs.existsSync(identity.shortcut);
    shell.writeShortcutLink(identity.shortcut, exists ? "replace" : "create", {
      target: identity.target,
      args: identity.args,
      appUserModelId: identity.appId,
      icon: identity.icon,
      iconIndex: 0,
      description: APP_NAME,
    });
  } catch (error) {
    console.warn("Could not create the development shortcut", error);
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  identity = windowsIdentity({ packaged: app.isPackaged, execPath: process.execPath, appPath: app.getAppPath(), appData: app.getPath("appData") });
  app.setAppUserModelId(identity.appId); // Windows shows notifications only for apps with an id
  registerDevShortcut();
  app.on("second-instance", showWindow);

  app.whenReady().then(() => {
    protocol.handle(APP_SCHEME, async (request) => {
      const file = resolveAppFile(webRoot(), request.url);
      if (!file || !fs.existsSync(file)) return new Response("Not found", { status: 404 });
      const res = await net.fetch(pathToFileURL(file).toString());
      const headers = new Headers(res.headers);
      headers.set("Content-Security-Policy", CSP);
      return new Response(res.body, { status: res.status, headers });
    });

    ipcMain.handle(IPC.schedule, (_e, items: unknown) => schedule(sanitizeReminders(items)));
    ipcMain.handle(IPC.clear, () => schedule([]));
    ipcMain.handle(IPC.getLogin, () => launchAtLogin());
    ipcMain.handle(IPC.setLogin, (_e, on: unknown) => setLaunchAtLogin(on === true));

    if (!DEV_URL) Menu.setApplicationMenu(null);
    paused = readJson<{ paused?: boolean }>("settings.json", {}).paused === true;
    reminders = sanitizeReminders(readJson<unknown>("reminders.json", []));
    arm(); // the saved plan fires even before the app is online again (FR-MS-001)
    powerMonitor.on("resume", arm);

    createWindow();
    createTray();
  });

  app.on("before-quit", () => {
    quitting = true;
  });
  // The tray keeps the app (and its reminders) running with no window open.
  app.on("window-all-closed", () => undefined);
}
