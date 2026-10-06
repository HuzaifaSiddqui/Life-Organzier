import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useAuth } from "./AuthContext";
import type { Category, UserSettings } from "../types/models";
import { getCategories, getSettings, saveSettings } from "../services/settingsApi";
import { startSyncEngine, syncNow } from "../services/syncEngine";
import { configureReminders, startReminderResponses, syncReminders } from "../services/reminders";
import { openAppScreen } from "../navigation/navigationRef";
import { trackAppOpen } from "../services/insightsApi";

type PreferencesValue = {
  settings: UserSettings | null;
  categories: Category[];
  phoneNumber: string | null;
  loading: boolean;
  reload: () => Promise<void>;
  update: (patch: Partial<UserSettings>) => Promise<UserSettings | null>;
  setCategories: (c: Category[]) => void;
  markTutorialSeen: (key: string) => Promise<void>;
  isPro: boolean;
};

const PreferencesContext = createContext<PreferencesValue | undefined>(undefined);

/**
 * Loads the user's preferences once signed in and starts the background services that make the
 * app work like an assistant: offline sync, reminder planning, and interaction tracking.
 */
export function PreferencesProvider({ children }: { children: ReactNode }) {
  const { dbUser } = useAuth();
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [phoneNumber, setPhoneNumber] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    if (!dbUser) return;
    setLoading(true);
    try {
      const [s, c] = await Promise.all([getSettings(), getCategories().catch(() => [] as Category[])]);
      setSettings(s.settings);
      setPhoneNumber(s.phoneNumber);
      setCategories(c);
    } catch {
      // Offline: keep whatever we had; screens degrade gracefully.
    } finally {
      setLoading(false);
    }
  }, [dbUser]);

  useEffect(() => {
    if (!dbUser) {
      setSettings(null);
      return;
    }
    void reload();
    const stop = startSyncEngine();
    void configureReminders();
    trackAppOpen();
    void syncNow().then(() => syncReminders());
    const stopResponses = startReminderResponses((target) => {
      if (target.taskId) openAppScreen("TaskDetail", { taskId: target.taskId });
      else if (target.routineOccurrenceId) openAppScreen("Routines");
    });
    return () => {
      stop();
      stopResponses();
    };
  }, [dbUser, reload]);

  const update = useCallback(async (patch: Partial<UserSettings>) => {
    try {
      const next = await saveSettings(patch);
      setSettings(next);
      return next;
    } catch {
      return null;
    }
  }, []);

  const markTutorialSeen = useCallback(
    async (key: string) => {
      if (!settings || settings.tutorialsSeen.includes(key)) return;
      const seen = [...settings.tutorialsSeen, key];
      setSettings({ ...settings, tutorialsSeen: seen });
      await update({ tutorialsSeen: seen });
    },
    [settings, update],
  );

  const value = useMemo(
    () => ({
      settings,
      categories,
      phoneNumber,
      loading,
      reload,
      update,
      setCategories,
      markTutorialSeen,
      isPro: settings?.tier === "PRO",
    }),
    [settings, categories, phoneNumber, loading, reload, update, markTutorialSeen],
  );
  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function usePreferences(): PreferencesValue {
  const ctx = useContext(PreferencesContext);
  if (!ctx) throw new Error("usePreferences must be used within PreferencesProvider");
  return ctx;
}
