import { useEffect, useRef } from "react";
import { useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from "react-native-reanimated";

/**
 * UI v2 motion (docs/ux-audit.md §8): a small "pop" (scale from `from` to 1) that plays only when `key` changes
 * after the first render — never on mount, so lists don't animate as they load. Off with reduce-motion.
 * Used for the done tick (key = done) and the bell badge (key = count).
 */
export function usePop(key: unknown, opts: { from: number; duration: number; when?: boolean }) {
  const reduce = useReducedMotion();
  const scale = useSharedValue(1);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (reduce || opts.when === false) return;
    scale.value = opts.from;
    scale.value = withTiming(1, { duration: opts.duration });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
}
