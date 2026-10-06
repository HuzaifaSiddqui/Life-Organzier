function trim(s: string | undefined): string {
  return (s ?? "").trim();
}

/** Primary API base (must end with `/api` in normal setups). */
export function getPrimaryApiBaseUrl(): string {
  return trim(process.env.EXPO_PUBLIC_API_BASE_URL) || "http://localhost:5050/api";
}

/** Legacy export — same as primary (axios initial default before resolution runs). */
export const API_BASE_URL = getPrimaryApiBaseUrl();

/** Comma-separated full API base URLs, e.g. `http://192.168.0.12:5050/api` */
export function getEnvFallbackApiBaseUrls(): string[] {
  const raw = trim(process.env.EXPO_PUBLIC_API_FALLBACK_URLS);
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/** Comma-separated host IPs only; port is taken from the primary URL (default 5000). */
export function getEnvExtraHostIps(): string[] {
  const raw = trim(process.env.EXPO_PUBLIC_API_HOST_IPS);
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export function inferPortFromApiUrl(apiUrl: string): number {
  try {
    const u = new URL(apiUrl.includes("://") ? apiUrl : `http://${apiUrl}`);
    if (u.port) return parseInt(u.port, 10);
    return u.protocol === "https:" ? 443 : 80;
  } catch {
    return 5000;
  }
}

export function normalizeApiBase(url: string): string {
  let u = url.trim().replace(/\/+$/, "");
  if (!u.endsWith("/api")) {
    u = `${u}/api`;
  }
  return u;
}

export function healthCheckUrlFromApiBase(apiBase: string): string {
  const base = apiBase.trim().replace(/\/+$/, "");
  const root = base.endsWith("/api") ? base.slice(0, -4) : base;
  return `${root}/health`;
}
