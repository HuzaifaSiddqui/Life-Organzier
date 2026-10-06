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

export const colors = {
  bg: "#F8FAFC",
  surface: "#FFFFFF",
  surfaceSoft: blue[50],
  text: "#1E293B",
  textMuted: "#64748B",
  primary: blue[500],
  primaryDark: blue[700],
  border: "#E2E8F0",
  success: "#16A34A",
  danger: "#DC2626",
  focusRing: "rgba(29, 153, 255, 0.4)",
};

export const radii = {
  xl: 24,
  lg: 22,
  md: 16,
  pill: 999,
};

export const typography = {
  regular: "Inter",
  medium: "Inter",
  semibold: "Inter",
  bold: "Inter",
};

export const shadow = {
  shadowColor: "#000000",
  shadowOpacity: 0.08,
  shadowRadius: 12,
  shadowOffset: { width: 0, height: 6 },
  elevation: 2,
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

/** Assistant accent + semantic tones used across the AI surfaces. */
export const palette = {
  ai: "#6D5BD0",
  aiSoft: "#F1EEFD",
  aiDark: "#4B3BA8",
  warning: "#D97706",
  warningSoft: "#FFF7E6",
  danger: "#DC2626",
  dangerSoft: "#FEF2F2",
  success: "#16A34A",
  successSoft: "#F0FDF4",
  info: "#0284C7",
  infoSoft: "#EFF8FF",
  muted: "#94A3B8",
  ink: "#0F172A",
} as const;

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24 } as const;
