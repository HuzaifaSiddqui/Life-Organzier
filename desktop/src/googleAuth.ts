/**
 * "Continue with Google" in the desktop app. Firebase's popup sign-in needs an http(s) page and the app runs on
 * app://, so the shell opens Google's sign-in page in its own window (OpenID Connect, response_type=id_token) and
 * catches the redirect to GOOGLE_REDIRECT before anything loads there; the id token goes back to the app, which signs
 * in to Firebase with it. Pure and tested (test/desktop.test.ts).
 *
 * The OAuth "Web client" (Firebase console → Authentication → Google) must list GOOGLE_REDIRECT under
 * "Authorized redirect URIs" (docs/desktop.md).
 */

export const GOOGLE_REDIRECT = "http://localhost:53682/google-auth";

export function googleAuthUrl(clientId: string, nonce: string, state: string): string {
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: GOOGLE_REDIRECT,
    response_type: "id_token",
    scope: "openid email profile",
    nonce,
    state,
    prompt: "select_account",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p.toString()}`;
}

export type GoogleRedirect = { idToken: string } | { error: string } | null;

/** The id token from Google's redirect, an error, or null when `url` isn't the redirect (keep waiting). */
export function readGoogleRedirect(url: string, expected: { nonce: string; state: string; clientId: string }): GoogleRedirect {
  if (!url.startsWith(GOOGLE_REDIRECT)) return null;
  const hash = url.includes("#") ? url.slice(url.indexOf("#") + 1) : "";
  const query = url.includes("?") ? url.slice(url.indexOf("?") + 1).split("#")[0] : "";
  const p = new URLSearchParams(hash || query);
  if (p.get("error")) return { error: p.get("error") as string };
  if (p.get("state") !== expected.state) return { error: "state_mismatch" };
  const idToken = p.get("id_token");
  if (!idToken) return { error: "no_token" };
  const claims = decodeJwtPayload(idToken);
  // The token must be for this app and this sign-in (Firebase verifies the signature itself).
  if (!claims || claims.nonce !== expected.nonce || claims.aud !== expected.clientId) return { error: "token_mismatch" };
  return { idToken };
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}
