/**
 * Hidden "Server address" (Settings → long-press the version; release APK for the demo): what the user types →
 * the API base the app uses, or null when it isn't an address. Accepts "192.168.43.10", "192.168.43.10:5050",
 * "laptop.local", "http://host:5050", "https://host/api". No scheme → http; no port → `defaultPort` for http
 * (the backend's 5050), the scheme's own for https. Always ends in "/api".
 */
export function parseServerAddress(input: string, defaultPort = 5050): string | null {
  const raw = input.trim();
  if (!raw || /\s/.test(raw)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  // As typed: the URL parser would expand "192.168.1" to "192.168.0.1", so numeric hosts must be 4 parts here.
  const typedHost = withScheme.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[/:?#]/)[0];
  if (/^[\d.]+$/.test(typedHost) && !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(typedHost)) return null;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname;
  if (!host || !/^[a-z0-9.-]+$/i.test(host) || host.startsWith(".") || host.endsWith(".") || host.includes("..")) return null;
  if (/^\d+(\.\d+)*$/.test(host) && !/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(host)) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) && host.split(".").some((p) => Number(p) > 255)) return null;
  const port = url.port ? `:${url.port}` : url.protocol === "http:" ? `:${defaultPort}` : "";
  return `${url.protocol}//${host}${port}/api`;
}
