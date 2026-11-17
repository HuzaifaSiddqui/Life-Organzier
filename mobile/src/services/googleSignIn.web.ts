import { GoogleAuthProvider, linkWithPopup, signInWithPopup } from "firebase/auth";
import { GOOGLE_WEB_CLIENT_ID } from "../constants/config";
import { auth } from "../lib/firebase";
import { desktopBridge } from "./desktopBridge";
import { useGoogleCredential, type GoogleResult } from "./googleCredential";

/**
 * Web / desktop build of services/googleSignIn.ts (same exports).
 * - Desktop app: Firebase's popup needs an http(s) page and the app runs on app://, so the Electron shell opens
 *   Google's sign-in in its own window and returns the id token (desktop/src/googleAuth.ts).
 * - Plain browser (expo start --web): Firebase's popup.
 */

export function googleSignInAvailable(): boolean {
  return Boolean(GOOGLE_WEB_CLIENT_ID);
}

export async function signInWithGoogle(): Promise<GoogleResult> {
  const bridge = desktopBridge();
  if (bridge?.googleSignIn) {
    const idToken = await bridge.googleSignIn(GOOGLE_WEB_CLIENT_ID);
    if (!idToken) return { kind: "cancelled" };
    return useGoogleCredential(GoogleAuthProvider.credential(idToken));
  }
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  try {
    const current = auth.currentUser;
    if (current?.isAnonymous) {
      try {
        await linkWithPopup(current, provider);
        await current.reload();
        return { kind: "linked" };
      } catch (e) {
        const credential = GoogleAuthProvider.credentialFromError(e as never);
        if ((e as { code?: string }).code === "auth/credential-already-in-use" && credential) return { kind: "already_used", credential };
        throw e;
      }
    }
    await signInWithPopup(auth, provider);
    return { kind: "signed_in" };
  } catch (e) {
    const code = (e as { code?: string }).code ?? "";
    if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") return { kind: "cancelled" };
    throw e;
  }
}
