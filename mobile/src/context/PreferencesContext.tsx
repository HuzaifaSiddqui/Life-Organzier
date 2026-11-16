import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import { flushPushQueue, registerForPush, startPushListeners } from "../services/push";
import { useAuth } from "./AuthContext";
import type { Category, UserSettings } from "../types/models";
import { getCategories, getSettings, type WhatsappLink } from "../services/settingsApi";
import { readCache, writeCache } from "../services/localCache";
import { OutboxRefused, onOutboxPending, onOutboxRejected, send, startOutbox } from "../services/outbox";
import { scheduleReminderSync } from "../services/reminders";
import { startSyncEngine, syncNow } from "../services/syncEngine";
import { startCheckinQueue } from "../services/checkins";
import { startCalendarWatch } from "../services/calendar";
import { startLocationReminders } from "../services/locationReminders";
import { configureReminders, startReminderResponses, syncReminders } from "../services/reminders";
import { openAppScreen } from "../navigation/navigationRef";
import { trackAppOpen } from "../services/insightsApi";

type PreferencesValue = {
  settings: UserSettings | null;
  categories: Category[];
  whatsapp: WhatsappLink;
  loading: boolean;
  reload: () => Promise<void>;
  /**
   * Applies the change on screen at once and sends it (or keeps it until online). Resolves with the new settings;
   * `null` only when the server refused it, in which case the change is already undone.
   */
  update: (patch: Partial<UserSettings>) => Promise<UserSettings | null>;
  setCategories: (c: Category[]) => void;
  markTutorialSeen: (key: string) => Promise<void>;
  isPro: boolean;
};

const PreferencesContext = createContext<PreferencesValue | undefined>(undefined);

const CACHE_SETTINGS = "settings";
const CACHE_CATEGORIES = "categories";
const CACHE_WHATSAPP = "whatsapp-link";

/**
 * Loads the user's preferences once signed in and starts the background services that make the
 * app work like an assistant: offline sync, reminder planning, and interaction tracking.
 */
export function PreferencesProvider({ children }: { children: ReactNode }) {
  const { dbUser } = useAuth();
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [whatsapp, setWhatsapp] = useState<WhatsappLink>({ linked: false, maskedNumber: null });
  const [loading, setLoading] = useState(false);

  const settingsRef = useRef<UserSettings | null>(null);
  settingsRef.current = settings;

  const applySettings = useCallback((next: UserSettings) => {
    settingsRef.current = next;
    setSettings(next);
    void writeCache(CACHE_SETTINGS, next);
  }, []);

  const reload = useCallback(async () => {
    if (!dbUser) return;
    setLoading(true);
    try {
      const [s, c] = await Promise.all([getSettings(), getCategories().catch(() => null)]);
      // Changes still waiting in the outbox stay on screen until the server has them.
      applySettings({ ...s.settings, ...pendingPatch.current });
      const link = s.whatsapp ?? { linked: false, maskedNumber: null };
      setWhatsapp(link);
      void writeCache(CACHE_WHATSAPP, link);
      if (c) {
        setCategories(c);
        void writeCache(CACHE_CATEGORIES, c);
      }
    } catch {
      // Offline: the saved copy stays on screen.
    } finally {
      setLoading(false);
    }
  }, [dbUser, applySettings]);

  // The saved copy first, so the name, settings and Pro features are there at once and offline.
  useEffect(() => {
    if (!dbUser) return;
    let live = true;
    void Promise.all([readCache<UserSettings>(CACHE_SETTINGS), readCache<Category[]>(CACHE_CATEGORIES), readCache<WhatsappLink>(CACHE_WHATSAPP)]).then(([s, c, w]) => {
      if (!live) return;
      if (s && !settingsRef.current) {
        settingsRef.current = s;
        setSettings(s);
      }
      if (c) setCategories((prev) => (prev.length ? prev : c));
      if (w) setWhatsapp(w);
    });
    return () => {
      live = false;
    };
  }, [dbUser]);

  // Sign-out may have left push unregisters queued (e.g. offline): retry on start and on every return to the app.
  useEffect(() => {
    void flushPushQueue();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void flushPushQueue();
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (!dbUser) {
      setSettings(null);
      return;
    }
    void reload();
    const stop = startSyncEngine();
    const stopOutbox = startOutbox();
    void configureReminders();
    trackAppOpen();
    // Push registration waits for the reminder sync, which asks for notification permission the first time.
    void syncNow().then(() => syncReminders()).then(() => registerForPush());
    const stopResponses = startReminderResponses((target) => {
      if (target.taskId) openAppScreen("TaskDetail", { taskId: target.taskId });
      else if (target.taskIds?.length) openAppScreen("TaskList", { ids: target.taskIds });
      else if (target.routineOccurrenceId) openAppScreen("Routines");
    });
    // Check-in answers made offline are sent (with their tap time) after the next successful sync.
    const stopCheckins = startCheckinQueue(() => void syncReminders());
    // P2: tasks added on WhatsApp arrive by push and trigger a sync.
    const stopPush = startPushListeners();
    // CALENDAR_SYNC: calendar edits come back on foreground and every 15 min (nothing while it's off).
    const stopCalendar = startCalendarWatch();
    return () => {
      stop();
      stopOutbox();
      stopCalendar();
      stopResponses();
      stopCheckins();
      stopPush();
    };
  }, [dbUser, reload]);

  // FR-LB-001: geofences follow the task cache while a Pro user is signed in.
  const tier = settings?.tier;
  useEffect(() => {
    if (!dbUser || !tier) return;
    return startLocationReminders({ isPro: tier === "PRO" });
  }, [dbUser, tier]);

  // Settings fields changed on screen that the server hasn't confirmed yet (kept over a refresh).
  const pendingPatch = useRef<Partial<UserSettings>>({});

  const update = useCallback(
    async (patch: Partial<UserSettings>) => {
      const before = settingsRef.current;
      if (!before) return null;
      const optimistic = { ...before, ...patch };
      applySettings(optimistic);
      pendingPatch.current = { ...pendingPatch.current, ...patch };
      try {
        const saved = await send<{ settings: UserSettings }>({ method: "PUT", path: "/settings", body: patch, key: "settings", merge: true, label: "Settings" });
        if (saved) {
          for (const k of Object.keys(patch)) delete (pendingPatch.current as Record<string, unknown>)[k];
          applySettings({ ...saved.settings, ...pendingPatch.current });
        }
        scheduleReminderSync();
        return settingsRef.current;
      } catch (e) {
        if (!(e instanceof OutboxRefused)) throw e;
        for (const k of Object.keys(patch)) delete (pendingPatch.current as Record<string, unknown>)[k];
        // Undo only the fields of this change; anything changed since stays.
        const undo = Object.fromEntries(Object.keys(patch).map((k) => [k, before[k as keyof UserSettings]]));
        applySettings({ ...(settingsRef.current ?? before), ...undo });
        return null;
      }
    },
    [applySettings],
  );

  // Everything waiting has been sent: the server's copy is the truth again (also for changes made on other devices).
  useEffect(() => {
    return onOutboxPending((count) => {
      if (count > 0 || !Object.keys(pendingPatch.current).length) return;
      pendingPatch.current = {};
      void reload();
    });
  }, [reload]);

  // A settings change sent later (it was made offline) that the server refused: show the server's copy again.
  useEffect(() => {
    return onOutboxRejected(({ op }) => {
      if (op.key !== "settings") return;
      pendingPatch.current = {};
      void reload();
    });
  }, [reload]);

  const saveCategories = useCallback((c: Category[]) => {
    setCategories(c);
    void writeCache(CACHE_CATEGORIES, c);
  }, []);

  const markTutorialSeen = useCallback(
    async (key: string) => {
      if (!settings || settings.tutorialsSeen.includes(key)) return;
      const seen = [...settings.tutorialsSeen, key];
      await update({ tutorialsSeen: seen });
    },
    [settings, update],
  );

  const value = useMemo(
    () => ({
      settings,
      categories,
      whatsapp,
      loading,
      reload,
      update,
      setCategories: saveCategories,
      markTutorialSeen,
      isPro: settings?.tier === "PRO",
    }),
    [settings, categories, whatsapp, loading, reload, update, saveCategories, markTutorialSeen],
  );
  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function usePreferences(): PreferencesValue {
  const ctx = useContext(PreferencesContext);
  if (!ctx) throw new Error("usePreferences must be used within PreferencesProvider");
  return ctx;
}
