import { linkWithCredential, signInWithCredential, type AuthCredential } from "firebase/auth";
import { auth } from "../lib/firebase";
import { discardGuestData } from "./guest";

/**
 * The step after Google returned a credential (phone or desktop). A guest (FR-OB-003) keeps their data: the Google
 * account is linked to the guest account. Anyone else signs in with it. The backend needs nothing new: the token has a
 * verified email, so /auth/sync-user makes (or keeps) a normal account.
 */
export type GoogleResult = { kind: "signed_in" } | { kind: "linked" } | { kind: "cancelled" } | { kind: "already_used"; credential: AuthCredential };

export async function useGoogleCredential(credential: AuthCredential): Promise<GoogleResult> {
  const current = auth.currentUser;
  if (current?.isAnonymous) {
    try {
      await linkWithCredential(current, credential);
      await current.reload();
      return { kind: "linked" };
    } catch (e) {
      // That Google account already has its own Life Organizer account: the caller asks before switching to it.
      if ((e as { code?: string }).code === "auth/credential-already-in-use") return { kind: "already_used", credential };
      throw e;
    }
  }
  await signInWithCredential(auth, credential);
  return { kind: "signed_in" };
}

/** A guest chose to switch to the Google account that already exists: the guest data goes, then sign in. */
export async function switchFromGuest(credential: AuthCredential): Promise<void> {
  await discardGuestData().catch(() => undefined); // offline: the server deletes it after 60 unused days
  await signInWithCredential(auth, credential);
}
