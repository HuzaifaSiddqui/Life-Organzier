import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AppState } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { onAuthStateChanged, type User as FirebaseUser } from "firebase/auth";
import * as Network from "expo-network";
import { auth } from "../lib/firebase";
import { api } from "../services/api";
import { applyLastGoodApiBase, resolveAndApplyApiBase } from "../services/apiResolver";
import type { User } from "../types/models";
import { syncPendingTasks } from "../services/tasksApi";
import { clearUserCache } from "../services/localCache";
import { clearOutbox } from "../services/outbox";
import { canUseApp } from "../utils/guest";

type AuthContextValue = {
  firebaseUser: FirebaseUser | null;
  dbUser: User | null;
  /** True while a background profile sync is running. Never blocks navigation. */
  bootstrapping: boolean;
  /** True once Firebase has restored (or ruled out) a session. Needs no network. */
  authReady: boolean;
  /** False until the first API probe pass finishes (success or not). Informational only. */
  apiEndpointsReady: boolean;
  refreshProfile: () => Promise<void>;
  /** Changes the profile on screen (and its saved copy) at once, e.g. a new display name before the server answers. */
  patchDbUser: (patch: Partial<User>) => void;
  /**
   * Re-reads the signed-in Firebase user after it changed in place (a guest linked an email, FR-OB-003): Firebase
   * keeps the same object, so screens wouldn't see the change otherwise.
   */
  refreshAuthUser: () => void;
  authVersion: number;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

/** Last profile the server returned, per Firebase uid, so the app works offline from the first frame. */
const STORAGE_CACHED_USER = "life-organizer:cached-db-user:v1";

async function loadCachedUser(uid: string): Promise<User | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_CACHED_USER);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { uid?: string; user?: User };
    return parsed.uid === uid && parsed.user ? parsed.user : null;
  } catch {
    return null;
  }
}

async function saveCachedUser(uid: string, user: User): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_CACHED_USER, JSON.stringify({ uid, user }));
  } catch {
    /* ignore */
  }
}

async function clearCachedUser(): Promise<void> {
  try {
    await AsyncStorage.removeItem(STORAGE_CACHED_USER);
  } catch {
    /* ignore */
  }
}

async function syncAndLoadProfile(): Promise<User | null> {
  await api.post("/auth/sync-user", {});
  const res = await api.get("/users/me");
  const data = res.data as { success: boolean; data?: { user: User } };
  if (data.success && data.data?.user) {
    return data.data.user;
  }
  return null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [firebaseUser, setFirebaseUser] = useState<FirebaseUser | null>(null);
  const [dbUser, setDbUser] = useState<User | null>(null);
  const [bootstrapping, setBootstrapping] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [apiEndpointsReady, setApiEndpointsReady] = useState(false);
  /** True once the server profile has been fetched this session (cached copies don't count). */
  const profileSyncedRef = useRef(false);
  /** The signed-in uid, so sign-out can remove that user's saved copies and unsent changes. */
  const lastUidRef = useRef<string | null>(null);

  /**
   * Background: find the server, sync the profile, flush the offline queue. Failures keep the
   * cached profile; the next reconnect or app foreground retries.
   */
  const syncProfile = useCallback(async () => {
    const user = auth.currentUser;
    if (!user || !canUseApp(user)) return;
    setBootstrapping(true);
    try {
      const reachable = await resolveAndApplyApiBase();
      setApiEndpointsReady(true);
      if (!reachable) return;
      const fresh = await syncAndLoadProfile();
      // Signed out or switched account while we were waiting.
      if (auth.currentUser?.uid !== user.uid) return;
      if (fresh) {
        profileSyncedRef.current = true;
        setDbUser(fresh);
        await saveCachedUser(user.uid, fresh);
      }
      await syncPendingTasks();
    } catch {
      // Offline or server error: keep the cached profile.
    } finally {
      setBootstrapping(false);
    }
  }, []);

  const refreshProfile = useCallback(async () => {
    if (!canUseApp(auth.currentUser)) {
      setDbUser(null);
      return;
    }
    await syncProfile();
  }, [syncProfile]);

  useEffect(() => {
    void applyLastGoodApiBase();
  }, []);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      setFirebaseUser(user);
      profileSyncedRef.current = false;
      if (user) lastUidRef.current = user.uid;
      if (!user) {
        const previous = lastUidRef.current;
        lastUidRef.current = null;
        if (previous) {
          void clearUserCache(previous);
          void clearOutbox(previous);
        }
        setDbUser(null);
        setBootstrapping(false);
        setAuthReady(true);
        void clearCachedUser();
        // Login and sign-up still need a server address: find it in the background.
        void resolveAndApplyApiBase().finally(() => setApiEndpointsReady(true));
        return;
      }
      // Wait for email verification before syncing with the API (Firebase sends the link from console).
      if (!canUseApp(user)) {
        setDbUser(null);
        setBootstrapping(false);
        setAuthReady(true);
        return;
      }
      // Open the app immediately with the cached profile; the server catches up in the background.
      const cached = await loadCachedUser(user.uid);
      if (auth.currentUser?.uid !== user.uid) return;
      setDbUser(cached);
      setAuthReady(true);
      void syncProfile();
    });

    return unsub;
  }, [syncProfile]);

  // Back online, or back in the app: retry if the server profile hasn't been fetched yet.
  useEffect(() => {
    const retry = () => {
      if (!canUseApp(auth.currentUser)) return;
      if (profileSyncedRef.current) {
        void syncPendingTasks();
      } else {
        void syncProfile();
      }
    };
    const net = Network.addNetworkStateListener((state) => {
      if (state.isConnected) retry();
    });
    const app = AppState.addEventListener("change", (state) => {
      if (state === "active" && !profileSyncedRef.current) retry();
    });
    return () => {
      net.remove();
      app.remove();
    };
  }, [syncProfile]);

  const [authVersion, setAuthVersion] = useState(0);
  const refreshAuthUser = useCallback(() => {
    setFirebaseUser(auth.currentUser);
    setAuthVersion((v) => v + 1);
    if (!canUseApp(auth.currentUser)) setDbUser(null);
  }, []);

  const patchDbUser = useCallback((patch: Partial<User>) => {
    const uid = auth.currentUser?.uid;
    setDbUser((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      if (uid) void saveCachedUser(uid, next);
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({
      firebaseUser,
      dbUser,
      bootstrapping,
      authReady,
      apiEndpointsReady,
      refreshProfile,
      patchDbUser,
      refreshAuthUser,
      // `authVersion` changes the value object when the same Firebase user changed in place.
      authVersion,
    }),
    [firebaseUser, dbUser, bootstrapping, authReady, apiEndpointsReady, refreshProfile, patchDbUser, refreshAuthUser, authVersion]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}
