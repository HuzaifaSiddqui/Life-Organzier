import { palettes } from "../theme/tokens";

const light = palettes.light;

export const blue = {
  50: "#EEF7FF",
  100: "#DBEEFF",
  200: "#B7DCFF",
  300: "#85C4FF",
  400: "#47AFFF",
  500: "#1D99FF",
  600: "#007FF0",
  700: "#0065C3",
  800: "#0557A0",
  900: "#0A4A84",
} as const;

/**
 * @deprecated Legacy names mapped onto light-theme tokens (src/theme/tokens.ts) so unmigrated
 * screens pick up the new palette. Migrated screens must use useTheme() instead.
 */
export const colors = {
  bg: light.canvas,
  surface: light.surface,
  surfaceSoft: light.accentSoft,
  text: light.text,
  textMuted: light.textSecondary,
  primary: light.accent,
  primaryDark: light.accent,
  border: light.hairline,
  success: light.success.fg,
  danger: light.danger.fg,
  focusRing: light.accentFocus,
};

export const radii = {
  xl: 20,
  lg: 16,
  md: 12,
  pill: 999,
};

export const shadow = {
  shadowColor: "#191C22",
  shadowOpacity: 0.04,
  shadowRadius: 3,
  shadowOffset: { width: 0, height: 1 },
  elevation: 1,
} as const;

/** Floating bottom nav / stronger chrome */
export const shadowNav = {
  shadowColor: "#000000",
  shadowOpacity: 0.12,
  shadowRadius: 16,
  shadowOffset: { width: 0, height: 4 },
  elevation: 8,
} as const;

/** Bento tiles */
export const shadowTile = {
  shadowColor: "#000000",
  shadowOpacity: 0.04,
  shadowRadius: 4,
  shadowOffset: { width: 0, height: 2 },
  elevation: 1,
} as const;

/** @deprecated See `colors`. One accent: the old assistant purple now maps to the brand accent. */
export const palette = {
  ai: light.accent,
  aiSoft: light.accentSoft,
  aiDark: light.accent,
  warning: light.warning.fg,
  warningSoft: light.warning.bg,
  danger: light.danger.fg,
  dangerSoft: light.danger.bg,
  success: light.success.fg,
  successSoft: light.success.bg,
  info: light.info.fg,
  infoSoft: light.info.bg,
  muted: light.textTertiary,
  ink: light.text,
} as const;

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24 } as const;
