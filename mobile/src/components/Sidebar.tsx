import { useEffect, useState } from "react";
import { Platform, ScrollView, StyleSheet, View } from "react-native";
import { useLocale } from "../i18n/LocaleProvider";
import { navigationRef, openAppScreen } from "../navigation/navigationRef";
import { useTheme } from "../theme/ThemeProvider";
import { layout, touchTarget } from "../theme/tokens";
import { activeSidebarRoute, shortcutFor, SIDEBAR_ITEMS } from "../utils/layout";
import { LogoMark } from "./branding/LogoMark";
import { Icon } from "./icons/Icon";
import { Button, PressableScale, Text } from "./primitives";

/** navigationRef is untyped (createNavigationContainerRef()), so the route is read as a plain { name }. */
const currentName = () => (navigationRef.isReady() ? (navigationRef.getCurrentRoute() as { name?: string } | undefined)?.name : undefined);

/** The route shown now, following every navigation change. */
function useCurrentRouteName(): string | undefined {
  const [name, setName] = useState(currentName);
  useEffect(() => {
    const update = () => setName(currentName());
    update();
    return navigationRef.addListener("state", update);
  }, []);
  return name;
}

/** Desktop shortcuts (web only): Ctrl/⌘+N new task, Ctrl/⌘+K assistant. Esc closes dialogs (the Modal handles it). */
function useShortcuts(): void {
  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;
    const onKey = (e: KeyboardEvent) => {
      const target = shortcutFor(e);
      if (!target) return;
      e.preventDefault();
      openAppScreen(target);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/**
 * Desktop layout (docs/design.md "Desktop layout"): start-side navigation that replaces the bottom nav and the
 * floating "+" on wide windows. Rendered by MainStack only when `useLayout().isWide`.
 */
export function Sidebar() {
  const { t } = useLocale();
  const { colors, spacing, radii } = useTheme();
  const active = activeSidebarRoute(useCurrentRouteName());
  useShortcuts();
  return (
    <View
      accessibilityRole="menu"
      accessibilityLabel={t("nav.menu")}
      style={[styles.root, { width: layout.sidebarWidth, backgroundColor: colors.surface, borderEndColor: colors.hairline, padding: spacing.lg, gap: spacing.lg }]}
    >
      <View style={[styles.brand, { gap: spacing.sm }]}>
        <LogoMark size={32} />
        <Text variant="title2" numberOfLines={1}>
          Life Organizer
        </Text>
      </View>
      <Button title={t("nav.newTask")} icon={<Icon name="plus" size={18} color={colors.onAccent} strokeWidth={2.2} />} onPress={() => openAppScreen("AddTask")} />
      <ScrollView contentContainerStyle={{ gap: spacing.xs }}>
        {SIDEBAR_ITEMS.map((item) => {
          const on = item.route === active;
          const label = t(item.label);
          return (
            <PressableScale
              key={item.route}
              scale={false}
              onPress={() => openAppScreen(item.route)}
              accessibilityRole="menuitem"
              accessibilityState={{ selected: on }}
              accessibilityLabel={label}
              style={[styles.item, { gap: spacing.md, paddingHorizontal: spacing.md, borderRadius: radii.md, backgroundColor: on ? colors.accentSoft : "transparent" }]}
              pressedStyle={{ backgroundColor: colors.accentSoft }}
            >
              <Icon name={item.icon} size={20} color={on ? colors.accent : colors.textSecondary} strokeWidth={on ? 2.1 : 1.8} />
              <Text variant={on ? "bodyStrong" : "body"} color={on ? "accent" : "primary"} numberOfLines={1}>
                {label}
              </Text>
            </PressableScale>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { borderEndWidth: StyleSheet.hairlineWidth },
  brand: { flexDirection: "row", alignItems: "center" },
  item: { flexDirection: "row", alignItems: "center", minHeight: touchTarget },
});
