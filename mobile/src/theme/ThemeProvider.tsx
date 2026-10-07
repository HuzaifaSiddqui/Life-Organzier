import AsyncStorage from "@react-native-async-storage/async-storage";
import { StatusBar } from "expo-status-bar";
import { NavigationBar } from "expo-navigation-bar";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useColorScheme } from "react-native";
import { elevation, motion, palettes, radii, spacing, typeScale, type ColorScheme, type Elevation, type Palette } from "./tokens";

export type ThemeMode = "system" | "light" | "dark";

/**
 * Dark mode stays off until every screen is migrated to the token system (see docs/design.md
 * migration log) — otherwise unmigrated light screens would sit inside dark chrome.
 */
const DARK_MODE_READY = false;

const STORAGE_KEY = "ui.themeMode";

export type Theme = {
  scheme: ColorScheme;
  colors: Palette;
  spacing: typeof spacing;
  radii: typeof radii;
  type: typeof typeScale;
  motion: typeof motion;
  elevation: (level: Elevation) => ReturnType<typeof elevation>;
};

type ThemeContextValue = Theme & { mode: ThemeMode; setMode: (mode: ThemeMode) => void };

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const system = useColorScheme();
  const [mode, setModeState] = useState<ThemeMode>("system");

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((v) => {
        if (v === "light" || v === "dark" || v === "system") setModeState(v);
      })
      .catch(() => undefined);
  }, []);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    void AsyncStorage.setItem(STORAGE_KEY, next).catch(() => undefined);
  }, []);

  const resolved: ColorScheme = mode === "system" ? (system === "dark" ? "dark" : "light") : mode;
  const scheme: ColorScheme = DARK_MODE_READY ? resolved : "light";

  const value = useMemo<ThemeContextValue>(
    () => ({
      scheme,
      colors: palettes[scheme],
      spacing,
      radii,
      type: typeScale,
      motion,
      elevation: (level) => elevation(level, scheme),
      mode,
      setMode,
    }),
    [scheme, mode, setMode],
  );

  const bars = scheme === "dark" ? "light" : "dark";
  return (
    <ThemeContext.Provider value={value}>
      <StatusBar style={bars} />
      <NavigationBar style={bars} />
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
