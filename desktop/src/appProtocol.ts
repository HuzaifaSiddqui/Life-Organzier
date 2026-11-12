import path from "node:path";

/** The app is served from app://lifeorganizer/ — a real origin (not file://, whose "null" origin the API's CORS rejects). */
export const APP_SCHEME = "app";
export const APP_HOST = "lifeorganizer";
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

/**
 * A request URL → the file to serve from the web build in `root`. Paths that would leave `root` are refused (null);
 * a path without a file extension is an app route, so it gets index.html (single-page app).
 */
export function resolveAppFile(root: string, requestUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (url.host !== APP_HOST) return null;
  let rel: string;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (rel.includes("\0")) return null;
  if (rel === "/" || !path.posix.extname(rel)) rel = "/index.html";
  const base = path.resolve(root);
  const file = path.resolve(base, "." + rel);
  return file === base || file.startsWith(base + path.sep) ? file : null;
}

/** Links that open outside the app (system browser, mail, phone, WhatsApp). Anything else is blocked. */
export function isExternalAllowed(url: string): boolean {
  try {
    return ["http:", "https:", "mailto:", "tel:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** Content Security Policy for the app pages: own code only; API / Firebase calls over http(s). */
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' http: https:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-src 'none'",
].join("; ");
