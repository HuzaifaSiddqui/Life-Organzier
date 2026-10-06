import { useEffect, useRef, useState } from "react";
import { Animated, Easing, Pressable, StyleSheet, Text, View } from "react-native";
import { colors, palette } from "../../constants/theme";

const PHASES = [
  { label: "Breathe in", seconds: 4, to: 1 },
  { label: "Hold", seconds: 4, to: 1 },
  { label: "Breathe out", seconds: 6, to: 0.55 },
] as const;

/** Guided 4-4-6 breathing (FR-MH-002 stress relief). */
export function BreathingExercise({ minutes }: { minutes: number }) {
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState(0);
  const [remaining, setRemaining] = useState(minutes * 60);
  const scale = useRef(new Animated.Value(0.55)).current;

  useEffect(() => {
    if (!running) return;
    const p = PHASES[phase];
    Animated.timing(scale, { toValue: p.to, duration: p.seconds * 1000, easing: Easing.inOut(Easing.sin), useNativeDriver: true }).start();
    const t = setTimeout(() => setPhase((x) => (x + 1) % PHASES.length), p.seconds * 1000);
    return () => clearTimeout(t);
  }, [running, phase, scale]);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      setRemaining((r) => {
        if (r <= 1) {
          setRunning(false);
          return 0;
        }
        return r - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [running]);

  const done = remaining === 0;
  return (
    <View style={styles.wrap}>
      <View style={styles.stage}>
        <Animated.View style={[styles.circle, { transform: [{ scale }] }]} />
        <Text style={styles.phase}>{done ? "Well done 🌿" : running ? PHASES[phase].label : "Ready?"}</Text>
      </View>
      <Text style={styles.meta}>
        {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")} left
      </Text>
      <Pressable
        style={[styles.button, running && { backgroundColor: colors.surface, borderWidth: 1, borderColor: palette.ai }]}
        onPress={() => {
          if (done) {
            setRemaining(minutes * 60);
            setPhase(0);
          }
          setRunning((r) => !r);
        }}
      >
        <Text style={[styles.buttonText, running && { color: palette.ai }]}>{running ? "Pause" : done ? "Again" : "Start"}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "center", gap: 8, paddingVertical: 8 },
  stage: { width: 150, height: 150, alignItems: "center", justifyContent: "center" },
  circle: { position: "absolute", width: 150, height: 150, borderRadius: 75, backgroundColor: "#DDD6FE" },
  phase: { fontSize: 16, fontWeight: "700", color: palette.aiDark },
  meta: { fontSize: 12, color: colors.textMuted },
  button: { backgroundColor: palette.ai, paddingHorizontal: 22, paddingVertical: 9, borderRadius: 999 },
  buttonText: { color: "#fff", fontWeight: "700" },
});
