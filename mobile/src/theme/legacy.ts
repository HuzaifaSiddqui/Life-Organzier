import { useTheme } from "./ThemeProvider";
import { palettes, type ColorScheme, type Palette } from "./tokens";

/**
 * Dark mode for the screens still written with the legacy names (`colors.text`, `palette.ai`, `ui.*`):
 * the same names, built from the current theme's palette. A screen calls `useLegacy()` for colours used while
 * rendering, and turns its module-level `StyleSheet.create({...})` into `makeStyles(l)` read with
 * `useLegacyStyles(makeStyles)`, which is built once per theme and shared by every instance.
 * New code uses `useTheme()` and the primitives instead (docs/design.md).
 */

export function legacyColors(p: Palette) {
  return {
    bg: p.canvas,
    surface: p.surface,
    surfaceSoft: p.accentSoft,
    text: p.text,
    textMuted: p.textSecondary,
    primary: p.accentStrong,
    primaryDark: p.accentStrong,
    border: p.hairline,
    success: p.success.fg,
    danger: p.danger.fg,
    focusRing: p.accentFocus,
  };
}

export function legacyPalette(p: Palette) {
  return {
    ai: p.accentStrong,
    aiSoft: p.accentSoft,
    aiDark: p.accentStrong,
    warning: p.warning.fg,
    warningSoft: p.warning.bg,
    danger: p.danger.fg,
    dangerSoft: p.danger.bg,
    success: p.success.fg,
    successSoft: p.success.bg,
    info: p.info.fg,
    infoSoft: p.info.bg,
    muted: p.textTertiary,
    ink: p.text,
  };
}

export type Legacy = { scheme: ColorScheme; p: Palette; colors: ReturnType<typeof legacyColors>; palette: ReturnType<typeof legacyPalette> };

const byScheme = new Map<ColorScheme, Legacy>();

export function legacyFor(scheme: ColorScheme): Legacy {
  let l = byScheme.get(scheme);
  if (!l) {
    const p = palettes[scheme];
    l = { scheme, p, colors: legacyColors(p), palette: legacyPalette(p) };
    byScheme.set(scheme, l);
  }
  return l;
}

/** The legacy colour names for the current theme. */
export function useLegacy(): Legacy {
  return legacyFor(useTheme().scheme);
}

const styleCache = new Map<unknown, Map<ColorScheme, unknown>>();

/** A screen's styles for the current theme; `make` must be a module-level function (it's the cache key). */
export function useLegacyStyles<T>(make: (l: Legacy) => T): T {
  const l = useLegacy();
  let perMake = styleCache.get(make);
  if (!perMake) {
    perMake = new Map();
    styleCache.set(make, perMake);
  }
  let styles = perMake.get(l.scheme) as T | undefined;
  if (!styles) {
    styles = make(l);
    perMake.set(l.scheme, styles);
  }
  return styles;
}
