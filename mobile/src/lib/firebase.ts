import AsyncStorage from "@react-native-async-storage/async-storage";
import { initializeApp, getApps, getApp, type FirebaseApp } from "firebase/app";
import {
  initializeAuth,
  getAuth,
  getReactNativePersistence,
  type Auth,
} from "firebase/auth";

const firebaseConfig = {
  apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY ?? "",
  authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN ?? "",
  projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID ?? "",
  storageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET ?? "",
  messagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ?? "",
  appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID ?? "",
};

function getFirebaseApp(): FirebaseApp {
  if (getApps().length) {
    return getApp();
  }
  return initializeApp(firebaseConfig);
}

const app = getFirebaseApp();

function createAuth(): Auth {
  try {
    return initializeAuth(app, {
      persistence: getReactNativePersistence(AsyncStorage),
    });
  } catch {
    return getAuth(app);
  }
}

export const auth = createAuth();
