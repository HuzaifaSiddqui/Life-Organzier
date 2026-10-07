import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Circle, G, Path, Rect } from "react-native-svg";
import { colors } from "../../constants/theme";

/**
 * Small, dependency-free charts (react-native-svg).
 * Rules followed: one hue for single-series bars, thin marks with rounded data ends and 2px gaps,
 * sequential single-hue heatmap, values always reachable by tap (no color-only identity).
 */

const BAR_HUE = "#2563EB";

export function BarChart({ data, height = 140, unit = "" }: { data: Array<{ label: string; value: number }>; height?: number; unit?: string }) {
  const [active, setActive] = useState<number | null>(null);
  const [width, setWidth] = useState(0);
  const max = Math.max(1, ...data.map((d) => d.value));
  const gap = 2;
  const barW = data.length ? Math.max(3, Math.min(22, (width - gap * data.length) / data.length)) : 0;
  const shown = active !== null ? data[active] : null;
  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      <Text style={styles.readout}>{shown ? `${shown.label}: ${shown.value}${unit}` : "Tap a bar to see its value"}</Text>
      <Svg width={width} height={height}>
        {[0.5, 1].map((f) => (
          <Rect key={f} x={0} y={height - f * (height - 4)} width={width} height={1} fill="#EEF2F6" />
        ))}
        {data.map((d, i) => {
          const h = Math.max(d.value > 0 ? 3 : 0, (d.value / max) * (height - 6));
          const x = i * (barW + gap) + (width - data.length * (barW + gap)) / 2;
          const r = Math.min(4, barW / 2, h / 2);
          const y = height - h;
          return (
            <G key={d.label + i}>
              <Path
                d={`M${x},${height} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + barW - r},${y} Q${x + barW},${y} ${x + barW},${y + r} L${x + barW},${height} Z`}
                fill={BAR_HUE}
                opacity={active === null || active === i ? 1 : 0.35}
              />
              <Rect x={x - gap / 2} y={0} width={barW + gap} height={height} fill="transparent" onPress={() => setActive(active === i ? null : i)} />
            </G>
          );
        })}
      </Svg>
      <View style={styles.axisRow}>
        <Text style={styles.axis}>{data[0]?.label ?? ""}</Text>
        <Text style={styles.axis}>{data[data.length - 1]?.label ?? ""}</Text>
      </View>
    </View>
  );
}

function arc(cx: number, cy: number, r: number, start: number, end: number): string {
  const s = { x: cx + r * Math.cos(start), y: cy + r * Math.sin(start) };
  const e = { x: cx + r * Math.cos(end), y: cy + r * Math.sin(end) };
  const large = end - start > Math.PI ? 1 : 0;
  return `M${s.x},${s.y} A${r},${r} 0 ${large} 1 ${e.x},${e.y}`;
}

/** Category share donut with a labelled values list (secondary encoding). */
export function Donut({ data, size = 132 }: { data: Array<{ label: string; value: number; color: string }>; size?: number }) {
  const total = data.reduce((s, d) => s + d.value, 0);
  const r = size / 2 - 10;
  let angle = -Math.PI / 2;
  const gapRad = data.length > 1 ? 0.04 : 0;
  return (
    <View style={styles.donutRow}>
      <Svg width={size} height={size}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke="#EEF2F6" strokeWidth={14} fill="none" />
        {total > 0 &&
          data.map((d) => {
            const sweep = (d.value / total) * Math.PI * 2;
            const start = angle + gapRad / 2;
            const end = angle + sweep - gapRad / 2;
            angle += sweep;
            if (end <= start) return null;
            return sweep >= Math.PI * 2 - 0.001 ? (
              <Circle key={d.label} cx={size / 2} cy={size / 2} r={r} stroke={d.color} strokeWidth={14} fill="none" />
            ) : (
              <Path key={d.label} d={arc(size / 2, size / 2, r, start, end)} stroke={d.color} strokeWidth={14} fill="none" strokeLinecap="butt" />
            );
          })}
      </Svg>
      <View style={{ flex: 1, gap: 6 }}>
        {data.map((d) => (
          <View key={d.label} style={styles.legendRow}>
            <View style={[styles.swatch, { backgroundColor: d.color }]} />
            <Text style={styles.legendLabel} numberOfLines={1}>
              {d.label}
            </Text>
            <Text style={styles.legendValue}>{total ? Math.round((d.value / total) * 100) : 0}%</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const DAYS = ["S", "M", "T", "W", "T", "F", "S"];
const HEAT = ["#EEF2F6", "#DBEAFE", "#93C5FD", "#3B82F6", "#1D4ED8"];

/** Completions by weekday × hour (sequential, single hue). Tap a cell for its count. */
export function Heatmap({ grid }: { grid: number[][] }) {
  const [active, setActive] = useState<{ d: number; h: number } | null>(null);
  const max = Math.max(1, ...grid.flat());
  const hours = Array.from({ length: 18 }, (_, i) => i + 6);
  return (
    <View style={{ gap: 4 }}>
      <Text style={styles.readout}>
        {active ? `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][active.d]} ${active.h}:00 — ${grid[active.d]?.[active.h] ?? 0} completed` : "Tap a cell · darker = more tasks completed"}
      </Text>
      {grid.map((row, d) => (
        <View key={d} style={styles.heatRow}>
          <Text style={styles.heatDay}>{DAYS[d]}</Text>
          {hours.map((h) => {
            const v = row[h] ?? 0;
            const step = v === 0 ? 0 : Math.min(4, 1 + Math.floor((v / max) * 3.999));
            return (
              <Pressable
                key={h}
                onPress={() => setActive({ d, h })}
                style={[styles.cell, { backgroundColor: HEAT[step] }, active?.d === d && active.h === h && styles.cellActive]}
              />
            );
          })}
        </View>
      ))}
      <View style={styles.axisRow}>
        <Text style={[styles.axis, { marginLeft: 16 }]}>6 AM</Text>
        <Text style={styles.axis}>12 PM</Text>
        <Text style={styles.axis}>11 PM</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  readout: { fontFamily: "Inter_400Regular", fontSize: 12, color: colors.textMuted, marginBottom: 6 },
  axisRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 4 },
  axis: { fontFamily: "Inter_400Regular", fontSize: 11, color: colors.textMuted },
  donutRow: { flexDirection: "row", alignItems: "center", gap: 16 },
  legendRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  swatch: { width: 10, height: 10, borderRadius: 3 },
  legendLabel: { flex: 1, fontFamily: "Inter_400Regular", fontSize: 13, color: colors.text },
  legendValue: { fontSize: 13, color: colors.text, fontFamily: "Inter_600SemiBold" },
  heatRow: { flexDirection: "row", alignItems: "center", gap: 2 },
  heatDay: { width: 14, fontFamily: "Inter_400Regular", fontSize: 10, color: colors.textMuted },
  cell: { flex: 1, aspectRatio: 1, borderRadius: 3 },
  cellActive: { borderWidth: 1.5, borderColor: colors.text },
});
