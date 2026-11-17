import { GoogleSignin, statusCodes } from "@react-native-google-signin/google-signin";
import { GoogleAuthProvider } from "firebase/auth";
import { GOOGLE_WEB_CLIENT_ID } from "../constants/config";
import { useGoogleCredential, type GoogleResult } from "./googleCredential";

/**
 * "Continue with Google" on the phone: the native Google account sheet returns an id token for the app's Web client
 * (Firebase's Google provider), which signs in to Firebase. Desktop / web: googleSignIn.web.ts (same exports).
 */

let configured = false;

/** Shown only when the Web client ID is in the build (EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID). */
export function googleSignInAvailable(): boolean {
  return Boolean(GOOGLE_WEB_CLIENT_ID);
}

export async function signInWithGoogle(): Promise<GoogleResult> {
  if (!configured) {
    GoogleSignin.configure({ webClientId: GOOGLE_WEB_CLIENT_ID });
    configured = true;
  }
  try {
    await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
    // A fresh account choice each time (not the last account silently).
    await GoogleSignin.signOut().catch(() => undefined);
    const res = await GoogleSignin.signIn();
    if (res.type !== "success" || !res.data.idToken) return { kind: "cancelled" };
    return await useGoogleCredential(GoogleAuthProvider.credential(res.data.idToken));
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === statusCodes.SIGN_IN_CANCELLED || code === statusCodes.IN_PROGRESS) return { kind: "cancelled" };
    throw e;
  }
}
