import { Pressable, StyleSheet, View } from "react-native";
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withSequence, withSpring, withTiming } from "react-native-reanimated";
import { useLocale } from "../../i18n/LocaleProvider";
import { useTheme } from "../../theme/ThemeProvider";
import { touchTarget } from "../../theme/tokens";
import type { TimelineItem } from "../../utils/timeline";
import { Icon } from "../icons/Icon";
import { Text } from "../primitives";
import { clockLabel } from "../plan/clock";

/**
 * One line of Today's agenda (UI v3): time, a colour bar (same colour as on Plan), title and what it is, and a round
 * tick with a 48 dp target. Ticking pops the tick and strikes the title at once (the change is saved behind it).
 */
export function AgendaRow({ item, color, onOpen, onToggle, past }: { item: TimelineItem; color: string; onOpen: () => void; onToggle: () => void; past?: boolean }) {
  const { colors, motion } = useTheme();
  const { t } = useLocale();
  const reduce = useReducedMotion();
  const pop = useSharedValue(1);
  const tickStyle = useAnimatedStyle(() => ({ transform: [{ scale: pop.value }] }));
  const timed = item.end > item.start;
  const meta = [item.kind === "routine" ? t("today.routine") : item.category, item.overdue ? t("plan.overdue") : null].filter(Boolean).join(" · ");
  const toggle = () => {
    if (!reduce) pop.value = withSequence(withTiming(0.7, { duration: motion.duration.fast }), withSpring(1, motion.spring.snappy));
    onToggle();
  };
  return (
    <Pressable
      onPress={onOpen}
      accessibilityRole="button"
      accessibilityLabel={[item.title, timed ? clockLabel(item.start) : t("today.anyTime"), meta].filter(Boolean).join(", ")}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.accentSoft }]}
    >
      <View style={styles.time}>
        {timed ? (
          <>
            <Text variant="label" tabular maxFontSizeMultiplier={1.15} style={{ color: past && !item.done ? colors.textSecondary : colors.text }}>
              {clockLabel(item.start)}
            </Text>
            {!item.deadline ? (
              <Text variant="caption" color="tertiary" tabular maxFontSizeMultiplier={1.1} style={styles.small}>
                {clockLabel(item.end)}
              </Text>
            ) : null}
          </>
        ) : (
          <Icon name="clock" size={16} color={colors.textTertiary} />
        )}
      </View>
      <View style={[styles.bar, { backgroundColor: item.overdue ? colors.danger.fg : color, opacity: item.done ? 0.35 : 1 }]} />
      <View style={styles.body}>
        <Text variant="bodyStrong" numberOfLines={2} style={[item.done && { textDecorationLine: "line-through", color: colors.textTertiary }]}>
          {item.title}
        </Text>
        {meta ? (
          <Text variant="caption" numberOfLines={1} style={{ color: item.overdue ? colors.danger.fg : colors.textTertiary }}>
            {meta}
          </Text>
        ) : null}
      </View>
      <Pressable
        onPress={toggle}
        hitSlop={(touchTarget - 28) / 2}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: item.done }}
        accessibilityLabel={t(item.done ? "today.untick" : "today.tick", { title: item.title })}
        style={styles.tickWrap}
      >
        <Animated.View style={[styles.tick, { borderColor: item.done ? colors.success.fg : colors.textTertiary, backgroundColor: item.done ? colors.success.fg : "transparent" }, tickStyle]}>
          {item.done ? <Icon name="check" size={16} color={colors.onAccent} strokeWidth={2.4} /> : null}
        </Animated.View>
      </Pressable>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 64, paddingVertical: 10, paddingHorizontal: 16 },
  time: { width: 64, alignItems: "flex-start" },
  small: { fontSize: 11 },
  bar: { width: 4, alignSelf: "stretch", borderRadius: 2 },
  body: { flex: 1, gap: 2 },
  tickWrap: { width: 28, height: 28, alignItems: "center", justifyContent: "center" },
  tick: { width: 28, height: 28, borderRadius: 14, borderWidth: 2, alignItems: "center", justifyContent: "center" },
});
