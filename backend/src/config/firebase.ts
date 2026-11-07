import admin from "firebase-admin";
import type { Auth } from "firebase-admin/auth";

let initialized = false;

export function initFirebase(): void {
  if (initialized) return;
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      "Missing FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, or FIREBASE_PRIVATE_KEY in environment."
    );
  }

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId,
      clientEmail,
      privateKey,
    }),
  });
  initialized = true;
}

/** Route tests only: a token checker in place of Firebase. Refused unless NODE_ENV is "test". */
let testAuth: Pick<Auth, "verifyIdToken"> | null = null;
export function useTestAuth(auth: Pick<Auth, "verifyIdToken"> | null): void {
  if (process.env.NODE_ENV !== "test") throw new Error("useTestAuth is for tests only");
  testAuth = auth;
}

export function getFirebaseAuth(): Auth {
  if (testAuth && process.env.NODE_ENV === "test") return testAuth as Auth;
  if (!initialized) initFirebase();
  return admin.auth();
}
