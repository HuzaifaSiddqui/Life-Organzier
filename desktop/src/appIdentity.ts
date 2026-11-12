import path from "node:path";

/**
 * How Windows knows the app: its AppUserModelID, the Start Menu shortcut that carries it, and the taskbar's
 * relaunch command. Windows takes a notification's name and icon from that shortcut, and starts the shortcut's
 * target when a notification is clicked after the app has quit. The installer (electron-builder NSIS) creates
 * the shortcut for the packaged app; a development run (`npm start` / `npm run dev`, plain electron.exe) needs
 * its own, or Windows shows "Electron" and a click opens Electron's default page.
 */

export const APP_NAME = "Life Organizer";
export const APP_ID = "com.lifeorganizer.desktop";

export type WindowsIdentity = {
  appId: string;
  /** Start Menu shortcut to create (development only; the installer makes the packaged one). */
  shortcut: string | null;
  /** Command line that starts this app (shortcut target + args, taskbar relaunch). */
  target: string;
  args: string;
  /** .ico Windows reads for the shortcut, taskbar and jump list (outside app.asar). */
  icon: string;
};

const quote = (s: string) => `"${s}"`;

export function windowsIdentity(opts: { packaged: boolean; execPath: string; appPath: string; appData: string }): WindowsIdentity {
  if (opts.packaged) {
    // The exe carries the icon (electron-builder embeds build/icon.ico); files inside app.asar are invisible to Windows.
    return { appId: APP_ID, shortcut: null, target: opts.execPath, args: "", icon: opts.execPath };
  }
  // A separate id keeps a dev run from taking over the installed app's notifications. The shortcut sits in its own
  // folder so its name can still be just "Life Organizer" next to the installer's shortcut.
  return {
    appId: `${APP_ID}.dev`,
    shortcut: path.join(opts.appData, "Microsoft", "Windows", "Start Menu", "Programs", `${APP_NAME} (development)`, `${APP_NAME}.lnk`),
    target: opts.execPath,
    args: quote(opts.appPath),
    icon: path.join(opts.appPath, "build", "icon.ico"),
  };
}

export function relaunchCommand(id: WindowsIdentity): string {
  return id.args ? `${quote(id.target)} ${id.args}` : quote(id.target);
}
