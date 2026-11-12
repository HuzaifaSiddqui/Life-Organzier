import { initializeApp, getApps, getApp, type FirebaseApp } from "firebase/app";
import { browserLocalPersistence, getAuth, initializeAuth, type Auth } from "firebase/auth";

/** Web / desktop build of lib/firebase.ts: the same project, with the browser's own sign-in persistence. */

const firebaseConfig = {
  apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY ?? "",
  authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN ?? "",
  projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID ?? "",
  storageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET ?? "",
  messagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ?? "",
  appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID ?? "",
};

const app: FirebaseApp = getApps().length ? getApp() : initializeApp(firebaseConfig);

function createAuth(): Auth {
  try {
    return initializeAuth(app, { persistence: browserLocalPersistence });
  } catch {
    return getAuth(app);
  }
}

export const auth = createAuth();
