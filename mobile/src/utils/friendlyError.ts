import axios from "axios";

export type ErrorKind = "offline" | "timeout" | "server" | "generic";

/**
 * Maps any thrown value to a plain-language category for UI copy. Raw API messages are never shown.
 * Handles both axios errors and the plain Errors re-thrown by services/api `unwrap`.
 */
export function friendlyError(e: unknown): ErrorKind {
  if (axios.isAxiosError(e)) {
    if (e.code === "ECONNABORTED" || e.code === "ETIMEDOUT") return "timeout";
    if (!e.response) return "offline";
    return e.response.status >= 500 ? "server" : "generic";
  }
  const msg = e instanceof Error ? e.message : "";
  if (/timeout|timed out/i.test(msg)) return "timeout";
  if (/network error|network request failed/i.test(msg)) return "offline";
  return "generic";
}
