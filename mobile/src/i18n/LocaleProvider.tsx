import AsyncStorage from "@react-native-async-storage/async-storage";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { I18nManager } from "react-native";
import { usePreferences } from "../context/PreferencesContext";
import { dictionaries, type Language, type StringKey } from "./strings";

/**
 * Flipping layout direction while screens still hold hard-coded English would mirror half-migrated
 * UI. Turn on once every screen's copy lives in strings.ts (docs/design.md migration log).
 */
const RTL_READY = false;

const STORAGE_KEY = "ui.language";

type LocaleValue = {
  language: Language;
  isRTL: boolean;
  /** Direction was changed natively; takes effect after an app restart. */
  restartRequired: boolean;
  t: (key: StringKey, vars?: Record<string, string | number>) => string;
};

const LocaleContext = createContext<LocaleValue | undefined>(undefined);

const toUiLanguage = (code: string | null | undefined): Language => (code === "ur" ? "ur" : "en");

/** Must sit inside PreferencesProvider: the user's language setting drives UI copy. */
export function LocaleProvider({ children }: { children: ReactNode }) {
  const { settings } = usePreferences();
  // Cached so signed-out screens (and first paint) use the last known language.
  const [cached, setCached] = useState<Language>("en");
  const [restartRequired, setRestartRequired] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((v) => setCached(toUiLanguage(v)))
      .catch(() => undefined);
  }, []);

  const language = settings ? toUiLanguage(settings.language) : cached;

  useEffect(() => {
    if (!settings) return;
    void AsyncStorage.setItem(STORAGE_KEY, language).catch(() => undefined);
    const wantRTL = RTL_READY && language === "ur";
    if (I18nManager.isRTL !== wantRTL) {
      I18nManager.allowRTL(wantRTL);
      I18nManager.forceRTL(wantRTL);
      setRestartRequired(true);
    }
  }, [settings, language]);

  const t = useCallback(
    (key: StringKey, vars?: Record<string, string | number>) => {
      const s: string = dictionaries[language][key] ?? dictionaries.en[key];
      return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
    },
    [language],
  );

  const value = useMemo(() => ({ language, isRTL: I18nManager.isRTL, restartRequired, t }), [language, restartRequired, t]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleValue {
  const ctx = useContext(LocaleContext);
  if (!ctx) throw new Error("useLocale must be used within LocaleProvider");
  return ctx;
}

/** Picks the `.one` / `.other` variant of a key. */
export function plural(count: number, one: StringKey, other: StringKey): StringKey {
  return count === 1 ? one : other;
}
