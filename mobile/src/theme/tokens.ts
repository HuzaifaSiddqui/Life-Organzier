import { Platform, type TextStyle, type ViewStyle } from "react-native";

/**
 * Design tokens — the only place raw colours, sizes and durations may live.
 * Every value here is documented in docs/design.md; change it there first.
 */

export type ColorScheme = "light" | "dark";

type Semantic = { fg: string; bg: string };

export type Palette = {
  canvas: string;
  surface: string;
  sheet: string;
  hairline: string;
  scrim: string;
  text: string;
  textSecondary: string;
  textTertiary: string;
  accent: string;
  onAccent: string;
  /** Accent at state opacities — pressed / selected / focus are all variations of the one accent. */
  accentSoft: string;
  accentPressed: string;
  accentFocus: string;
  highlight: string;
  success: Semantic;
  warning: Semantic;
  danger: Semantic;
  info: Semantic;
  priority: Record<"URGENT" | "HIGH" | "MEDIUM" | "LOW", string>;
  /** Curated category hues (index-stable across themes). Used for dots/icons only, never body text. */
  category: readonly string[];
  skeleton: string;
  inverseSurface: string;
  onInverse: string;
};

const light: Palette = {
  canvas: "#F6F5F2",
  surface: "#FFFEFB",
  sheet: "#FFFEFB",
  hairline: "rgba(25, 28, 34, 0.10)",
  scrim: "rgba(15, 18, 24, 0.40)",
  text: "#191C22",
  textSecondary: "#565C69",
  textTertiary: "#646A78",
  accent: "#0B66C2",
  onAccent: "#FFFFFF",
  accentSoft: "rgba(11, 102, 194, 0.10)",
  accentPressed: "rgba(11, 102, 194, 0.16)",
  accentFocus: "rgba(11, 102, 194, 0.40)",
  highlight: "rgba(224, 178, 99, 0.35)",
  success: { fg: "#2E7A4D", bg: "#E6F1E9" },
  warning: { fg: "#93600F", bg: "#F6EDDA" },
  danger: { fg: "#B03A36", bg: "#F7E5E3" },
  info: { fg: "#2C6390", bg: "#E3EDF5" },
  priority: { URGENT: "#B83B35", HIGH: "#B0581A", MEDIUM: "#8A6A06", LOW: "#3767AE" },
  category: ["#3A68C9", "#7552C0", "#367F55", "#B65E22", "#237F80", "#B4466F", "#8F6A0E", "#5A6576"],
  skeleton: "#EAE8E3",
  inverseSurface: "#22262E",
  onInverse: "#F1F2F5",
};

const dark: Palette = {
  canvas: "#0F1218",
  surface: "#171B23",
  sheet: "#1E232D",
  hairline: "rgba(231, 234, 240, 0.09)",
  scrim: "rgba(0, 0, 0, 0.55)",
  text: "#E7EAF0",
  textSecondary: "#A4AAB8",
  textTertiary: "#8A91A0",
  accent: "#5AAEFF",
  onAccent: "#08111E",
  accentSoft: "rgba(90, 174, 255, 0.14)",
  accentPressed: "rgba(90, 174, 255, 0.22)",
  accentFocus: "rgba(90, 174, 255, 0.50)",
  highlight: "rgba(226, 194, 94, 0.30)",
  success: { fg: "#6CC08B", bg: "#18271F" },
  warning: { fg: "#E0B263", bg: "#2A2316" },
  danger: { fg: "#F0827C", bg: "#2D1B1C" },
  info: { fg: "#82B5E3", bg: "#162331" },
  priority: { URGENT: "#F0827C", HIGH: "#F0A466", MEDIUM: "#E2C25E", LOW: "#86ADEA" },
  category: ["#86A8F0", "#AE95EA", "#79C59A", "#EFA06A", "#6FCAC6", "#EA8DB3", "#DDB65D", "#A3ADBD"],
  skeleton: "#222833",
  inverseSurface: "#E7EAF0",
  onInverse: "#171B23",
};

export const palettes: Record<ColorScheme, Palette> = { light, dark };

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 } as const;

export const radii = { sm: 8, md: 12, lg: 20, pill: 999 } as const;

/** Minimum touch target (Android 48dp; also satisfies iOS 44pt). */
export const touchTarget = 48;

export const fonts = {
  regular: "Inter_400Regular",
  medium: "Inter_500Medium",
  semibold: "Inter_600SemiBold",
  bold: "Inter_700Bold",
  urdu: "NotoNastaliqUrdu_400Regular",
  urduBold: "NotoNastaliqUrdu_700Bold",
} as const;

type TypeStyle = Required<Pick<TextStyle, "fontFamily" | "fontSize" | "lineHeight" | "letterSpacing">> & {
  urduFamily: string;
  /** Cap for system font scaling so dense UI never breaks. */
  maxScale: number;
};

/** Latin tracking: large headers ≈ -0.02em, small labels ≈ +0.02em. */
const type = (fontFamily: string, fontSize: number, lineHeight: number, tracking: number, urduFamily: string, maxScale: number): TypeStyle => ({
  fontFamily,
  fontSize,
  lineHeight,
  letterSpacing: +(fontSize * tracking).toFixed(2),
  urduFamily,
  maxScale,
});

export const typeScale = {
  display: type(fonts.bold, 32, 38, -0.02, fonts.urduBold, 1.3),
  title1: type(fonts.bold, 24, 30, -0.02, fonts.urduBold, 1.3),
  title2: type(fonts.semibold, 20, 26, -0.02, fonts.urduBold, 1.4),
  headline: type(fonts.semibold, 17, 24, -0.01, fonts.urduBold, 1.4),
  body: type(fonts.regular, 15, 22, 0, fonts.urdu, 1.5),
  bodyStrong: type(fonts.semibold, 15, 22, 0, fonts.urduBold, 1.5),
  callout: type(fonts.regular, 14, 20, 0, fonts.urdu, 1.4),
  caption: type(fonts.regular, 13, 18, 0.02, fonts.urdu, 1.3),
  label: type(fonts.semibold, 12, 16, 0.02, fonts.urduBold, 1.3),
} as const;

export type TypeVariant = keyof typeof typeScale;

/** Nastaliq needs a tall line box and no tracking; Android also needs font padding to avoid clipping. */
export const urduLineHeightRatio = 1.9;

export type Elevation = 0 | 1 | 2;

/** 0 = canvas, 1 = cards/containers, 2 = sheets/dialogs/floating chrome. */
export function elevation(level: Elevation, scheme: ColorScheme): ViewStyle {
  if (level === 0) return {};
  const p = palettes[scheme];
  const border: ViewStyle = { borderWidth: 1, borderColor: p.hairline };
  // Dark: depth comes from lighter surfaces + hairline; shadows are invisible on dark canvases.
  if (scheme === "dark") return { ...border, backgroundColor: level === 1 ? p.surface : p.sheet };
  const shadow =
    level === 1
      ? Platform.select<ViewStyle>({ ios: { shadowColor: "#191C22", shadowOpacity: 0.04, shadowRadius: 3, shadowOffset: { width: 0, height: 1 } }, default: { elevation: 1 } })
      : Platform.select<ViewStyle>({ ios: { shadowColor: "#191C22", shadowOpacity: 0.12, shadowRadius: 16, shadowOffset: { width: 0, height: 6 } }, default: { elevation: 8 } });
  return { ...border, ...shadow, backgroundColor: level === 1 ? p.surface : p.sheet };
}

export const motion = {
  duration: { fast: 150, base: 220, slow: 300, /** skeleton breathing, one direction */ pulse: 900 },
  /** Press feedback on buttons and tappable cards. */
  pressScale: 0.97,
  spring: {
    press: { damping: 22, stiffness: 340, mass: 0.6 },
    gentle: { damping: 20, stiffness: 180, mass: 1 },
  },
  /** How long a snackbar stays; longer when it offers Undo. */
  snackbar: { plain: 3500, withAction: 6000 },
  /** First-render list entrance: fade + translateY, first N items only. */
  stagger: { step: 40, maxItems: 8, offsetY: 8 },
} as const;
