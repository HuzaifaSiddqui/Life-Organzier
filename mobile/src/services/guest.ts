import axios from "axios";
import {
  createUserWithEmailAndPassword,
  EmailAuthProvider,
  linkWithCredential,
  sendEmailVerification,
  signInAnonymously,
  signOut,
  updateProfile,
} from "firebase/auth";
import { healthCheckUrlFromApiBase } from "../constants/config";
import { auth } from "../lib/firebase";
import { api, apiPost } from "./api";
import { resolveAndApplyApiBase } from "./apiResolver";

/**
 * Guest mode (FR-OB-003, server switch GUEST_MODE). A guest is a Firebase anonymous account: the server keeps its
 * data like anyone's. Creating an account links an email to the same Firebase account, so the data stays
 * ("Keep my data"), or deletes the guest first ("Start fresh").
 */

/** Whether this server offers "Continue as guest" (its /health says so). False when it can't be reached. */
export async function guestModeAvailable(): Promise<boolean> {
  await resolveAndApplyApiBase().catch(() => false);
  const base = api.defaults.baseURL;
  if (!base) return false;
  try {
    const res = await axios.get<{ guestMode?: boolean }>(healthCheckUrlFromApiBase(base), { timeout: 4000 });
    return res.data?.guestMode === true;
  } catch {
    return false;
  }
}

export async function continueAsGuest(): Promise<void> {
  await signInAnonymously(auth);
}

export type CreateAccountInput = { name: string; email: string; password: string; keepData: boolean };

/**
 * Turns the guest into an account. Both ways end with an unverified email account, so the app shows the usual
 * "verify your email" step; the server makes the user a normal account at the next sync after that.
 */
export async function createAccountFromGuest(input: CreateAccountInput): Promise<void> {
  const guest = auth.currentUser;
  if (!guest?.isAnonymous) throw new Error("Not a guest");
  const email = input.email.trim();
  if (input.keepData) {
    // Same Firebase account, now with an email and password: every task, routine and memory stays.
    const cred = await linkWithCredential(guest, EmailAuthProvider.credential(email, input.password));
    if (input.name.trim()) await updateProfile(cred.user, { displayName: input.name.trim() });
    await sendEmailVerification(cred.user);
    await cred.user.reload();
    return;
  }
  // Start fresh: the guest and its data go first, then a brand-new account.
  await discardGuestData();
  const cred = await createUserWithEmailAndPassword(auth, email, input.password);
  if (input.name.trim()) await updateProfile(cred.user, { displayName: input.name.trim() });
  await sendEmailVerification(cred.user);
}

/** Deletes the guest's data on the server (and its Firebase account). */
export async function discardGuestData(): Promise<void> {
  await apiPost("/account/guest/discard");
}

/** A guest signing out: there is no account to come back to, so the data is deleted (the user was warned). */
export async function signOutGuest(): Promise<void> {
  await discardGuestData().catch(() => undefined); // offline: the server deletes it after 60 unused days
  await signOut(auth);
}
