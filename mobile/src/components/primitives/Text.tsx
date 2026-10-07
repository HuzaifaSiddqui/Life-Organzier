import type { ReactNode } from "react";
import { Platform, Text as RNText, type TextProps as RNTextProps, type TextStyle } from "react-native";
import { useLocale } from "../../i18n/LocaleProvider";
import { useTheme } from "../../theme/ThemeProvider";
import { urduLineHeightRatio, type Palette, type TypeVariant } from "../../theme/tokens";

export type TextColor = "primary" | "secondary" | "tertiary" | "accent" | "onAccent" | "success" | "warning" | "danger" | "info" | "onInverse";

export type TextProps = RNTextProps & {
  variant?: TypeVariant;
  color?: TextColor;
  /** Times, dates, counts, percentages. */
  tabular?: boolean;
  center?: boolean;
};

const ARABIC_SCRIPT = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;

function isUrdu(children: ReactNode, uiUrdu: boolean): boolean {
  if (typeof children === "string") return ARABIC_SCRIPT.test(children);
  if (Array.isArray(children)) return children.some((c) => typeof c === "string" && ARABIC_SCRIPT.test(c));
  return uiUrdu;
}

export function colorFor(c: Palette, color: TextColor): string {
  switch (color) {
    case "primary":
      return c.text;
    case "secondary":
      return c.textSecondary;
    case "tertiary":
      return c.textTertiary;
    case "accent":
      return c.accent;
    case "onAccent":
      return c.onAccent;
    case "onInverse":
      return c.onInverse;
    default:
      return c[color].fg;
  }
}

/**
 * The only text component screens should use. Switches to Nastaliq (taller line box, no tracking,
 * Android font padding on) whenever the content is Urdu script, so mixed-language content renders right.
 */
export function Text({ variant = "body", color = "primary", tabular, center, style, children, maxFontSizeMultiplier, ...rest }: TextProps) {
  const { colors, type } = useTheme();
  const { language } = useLocale();
  const t = type[variant];
  const urdu = isUrdu(children, language === "ur");
  const base: TextStyle = urdu
    ? {
        fontFamily: t.urduFamily,
        fontSize: t.fontSize,
        lineHeight: Math.round(t.fontSize * urduLineHeightRatio),
        letterSpacing: 0,
        ...Platform.select({ android: { includeFontPadding: true } }),
      }
    : {
        fontFamily: t.fontFamily,
        fontSize: t.fontSize,
        lineHeight: t.lineHeight,
        letterSpacing: t.letterSpacing,
        ...Platform.select({ android: { includeFontPadding: false } }),
      };
  return (
    <RNText
      maxFontSizeMultiplier={maxFontSizeMultiplier ?? t.maxScale}
      style={[base, { color: colorFor(colors, color) }, tabular && { fontVariant: ["tabular-nums"] }, center && { textAlign: "center" }, style]}
      {...rest}
    >
      {children}
    </RNText>
  );
}
