import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, View, type GestureResponderEvent } from "react-native";
import { ScrollView } from "react-native-gesture-handler";
import Animated, { FadeIn, useReducedMotion } from "react-native-reanimated";
import { useLocale } from "../../i18n/LocaleProvider";
import { useTheme } from "../../theme/ThemeProvider";
import { timeline, withAlpha } from "../../theme/tokens";
import { freeGaps, layoutColumns, minutesOf, sameDay, slotStart, type DayPlan, type Placed, type TimelineItem } from "../../utils/timeline";
import { Text } from "../primitives";
import { clockLabel, hourLabel } from "./clock";
import { TimelineTile, type DropMode } from "./TimelineTile";

type Props = {
  days: Date[];
  plans: DayPlan[];
  now: Date;
  colorOf: (item: TimelineItem) => string;
  onTap: (item: TimelineItem) => void;
  onDrop: (item: TimelineItem, day: Date, start: number, end: number, mode: DropMode) => void;
  onSlot: (day: Date, minutes: number) => void;
  /** Free-time hints between these minutes (Day view): the user's working day. */
  freeFrom?: number;
  freeTo?: number;
  bottomInset: number;
  resetKey?: number;
};

const HOURS = Array.from({ length: 24 }, (_, h) => h);

/**
 * The Plan time grid for one day (Day view) or seven (Week view): hour lines, a live "now" line, tiles side by side
 * when they overlap, free-time hints, and a tap on an empty slot to add a task there. Opens scrolled to now (or to the
 * morning on another day).
 */
export function PlanTimeline({ days, plans, now, colorOf, onTap, onDrop, onSlot, freeFrom, freeTo, bottomInset, resetKey }: Props) {
  const { colors, radii } = useTheme();
  const { t } = useLocale();
  const reduce = useReducedMotion();
  const scroll = useRef<ScrollView>(null);
  const [width, setWidth] = useState(0);
  const [dragging, setDragging] = useState(false);
  const hourH = timeline.hourHeight;
  const colW = width ? (width - timeline.gutter) / days.length : 0;
  const todayIndex = days.findIndex((d) => sameDay(d, now));
  const placed = useMemo(() => plans.map((p) => layoutColumns(p.timed)), [plans]);
  const firstKey = days[0]?.toDateString();

  // Scroll to "now" on today, else to the morning (or the first item if earlier). Done once the grid has its size
  // (a scroll before layout is lost on Android), and again whenever the shown days change.
  const pending = useRef(true);
  useEffect(() => {
    pending.current = true;
  }, [firstKey, days.length]);
  const scrollIfPending = () => {
    if (!pending.current || !scroll.current) return;
    pending.current = false;
    const earliest = Math.min(...plans.flatMap((p) => p.timed.map((i) => i.start)), 24 * 60);
    const target = todayIndex >= 0 ? minutesOf(now) - 90 : Math.min(timeline.firstHour * 60, earliest - 30);
    scroll.current.scrollTo({ y: Math.max(0, (target / 60) * hourH), animated: false });
  };
  useEffect(() => {
    if (width) requestAnimationFrame(scrollIfPending);
  });

  const slotPress = (day: Date) => (e: GestureResponderEvent) => onSlot(day, slotStart((e.nativeEvent.locationY / hourH) * 60));

  const gaps = days.length === 1 && freeFrom != null && freeTo != null ? freeGaps(plans[0]?.timed ?? [], Math.max(freeFrom, todayIndex === 0 ? minutesOf(now) : 0), freeTo, 60) : [];

  return (
    <ScrollView
      ref={scroll}
      scrollEnabled={!dragging}
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{ paddingBottom: bottomInset, paddingTop: 12 }}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      onContentSizeChange={() => requestAnimationFrame(scrollIfPending)}
    >
      <View style={{ height: 24 * hourH }}>
        {HOURS.map((h) => (
          <View key={h} style={[styles.hourRow, { top: h * hourH, height: hourH }]} pointerEvents="none">
            <Text variant="caption" color="tertiary" maxFontSizeMultiplier={1.1} style={[styles.hourLabel, { width: timeline.gutter - 8 }]}>
              {h === 0 ? "" : hourLabel(h)}
            </Text>
            <View style={[styles.hourLine, { backgroundColor: colors.hairline }]} />
          </View>
        ))}
        {colW
          ? days.map((d, i) => (
              <Pressable
                key={d.toDateString()}
                onPress={slotPress(d)}
                accessibilityRole="button"
                accessibilityLabel={t("plan.addAt", { time: d.toDateString() })}
                style={[styles.column, { left: timeline.gutter + i * colW, width: colW, borderStartColor: i > 0 ? colors.hairline : "transparent", backgroundColor: i === todayIndex && days.length > 1 ? withAlpha(colors.accent, 0.04) : "transparent" }]}
              />
            ))
          : null}
        {gaps.map((g) => (
          <View
            key={g.start}
            pointerEvents="none"
            style={[styles.free, { top: (g.start / 60) * hourH + 4, height: ((g.end - g.start) / 60) * hourH - 8, left: timeline.gutter + 6, right: 6, borderColor: colors.hairline, borderRadius: radii.sm }]}
          >
            <Text variant="caption" color="tertiary" maxFontSizeMultiplier={1.1}>
              {t("plan.free", { time: `${clockLabel(g.start)} – ${clockLabel(g.end)}` })}
            </Text>
          </View>
        ))}
        {colW ? (
          <Animated.View key={firstKey} entering={reduce ? undefined : FadeIn.duration(180)} style={[StyleSheet.absoluteFill, { left: timeline.gutter }]} pointerEvents="box-none">
            {placed.map((items, di) =>
              items.map((item: Placed) => (
                <TimelineTile
                  key={item.key}
                  item={item}
                  dayIndex={di}
                  days={days.length}
                  colW={colW}
                  color={colorOf(item)}
                  onTap={onTap}
                  onDragging={setDragging}
                  resetKey={resetKey}
                  onDrop={(it, delta, start, end, mode) => onDrop(it, days[Math.max(0, Math.min(days.length - 1, di + delta))], start, end, mode)}
                />
              )),
            )}
          </Animated.View>
        ) : null}
        {todayIndex >= 0 && colW ? <NowLine now={now} left={timeline.gutter + (days.length > 1 ? todayIndex * colW : 0)} width={days.length > 1 ? colW : width - timeline.gutter} /> : null}
      </View>
    </ScrollView>
  );
}

function NowLine({ now, left, width }: { now: Date; left: number; width: number }) {
  const { colors } = useTheme();
  const top = (minutesOf(now) / 60) * timeline.hourHeight;
  return (
    <View pointerEvents="none" style={[styles.now, { top: top - 5, left: left - 5, width: width + 5 }]} accessibilityElementsHidden importantForAccessibility="no">
      <View style={[styles.nowDot, { backgroundColor: colors.danger.fg }]} />
      <View style={[styles.nowLine, { backgroundColor: colors.danger.fg }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  hourRow: { position: "absolute", left: 0, right: 0, flexDirection: "row" },
  hourLabel: { textAlign: "right", marginTop: -8, paddingEnd: 6, fontSize: 11 },
  hourLine: { flex: 1, height: StyleSheet.hairlineWidth },
  column: { position: "absolute", top: 0, bottom: 0, borderStartWidth: StyleSheet.hairlineWidth },
  free: { position: "absolute", borderWidth: 1, borderStyle: "dashed", justifyContent: "flex-start", paddingHorizontal: 10, paddingTop: 8 },
  now: { position: "absolute", height: 10, flexDirection: "row", alignItems: "center", zIndex: 40 },
  nowDot: { width: 10, height: 10, borderRadius: 5 },
  nowLine: { flex: 1, height: 2 },
});
