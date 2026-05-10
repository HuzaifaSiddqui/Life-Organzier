import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { onAuthStateChanged, type User as FirebaseUser } from "firebase/auth";
import { auth } from "../lib/firebase";
import { api } from "../services/api";
import { resolveAndApplyApiBase } from "../services/apiResolver";
import type { User } from "../types/models";

type AuthContextValue = {
  firebaseUser: FirebaseUser | null;
  dbUser: User | null;
  bootstrapping: boolean;
  authReady: boolean;
  /** False until first API base URL probe pass finishes (success or exhausted). */
  apiEndpointsReady: boolean;
  refreshProfile: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

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

  useEffect(() => {
    let cancelled = false;
    void resolveAndApplyApiBase().finally(() => {
      if (!cancelled) setApiEndpointsReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshProfile = useCallback(async () => {
    if (!auth.currentUser) {
      setDbUser(null);
      return;
    }
    setBootstrapping(true);
    try {
      await resolveAndApplyApiBase();
      const user = await syncAndLoadProfile();
      setDbUser(user);
    } catch {
      setDbUser(null);
    } finally {
      setBootstrapping(false);
    }
  }, []);

  useEffect(() => {
    if (!apiEndpointsReady) return;

    const unsub = onAuthStateChanged(auth, async (user) => {
      setFirebaseUser(user);
      if (!user) {
        setDbUser(null);
        setBootstrapping(false);
        setAuthReady(true);
        return;
      }
      setBootstrapping(true);
      try {
        await resolveAndApplyApiBase();
        const u = await syncAndLoadProfile();
        setDbUser(u);
      } catch {
        setDbUser(null);
      } finally {
        setBootstrapping(false);
        setAuthReady(true);
      }
    });

    return unsub;
  }, [apiEndpointsReady]);

  const value = useMemo(
    () => ({
      firebaseUser,
      dbUser,
      bootstrapping,
      authReady,
      apiEndpointsReady,
      refreshProfile,
    }),
    [firebaseUser, dbUser, bootstrapping, authReady, apiEndpointsReady, refreshProfile]
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
