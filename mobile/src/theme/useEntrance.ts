import { useEffect, useRef } from "react";
import { FadeInDown, useReducedMotion } from "react-native-reanimated";
import { motion } from "./tokens";

/**
 * Staggered fade + rise for a screen's first render only. Returns an `entering` animation for
 * item `index`, or undefined after the first render / beyond the first N items / under reduce motion —
 * so virtualised rows re-mounting on scroll or refresh never re-animate.
 */
export function useEntrance(): (index: number) => ReturnType<typeof FadeInDown.delay> | undefined {
  const reduceMotion = useReducedMotion();
  const first = useRef(true);
  useEffect(() => {
    const t = setTimeout(() => {
      first.current = false;
    }, motion.duration.slow + motion.stagger.step * motion.stagger.maxItems);
    return () => clearTimeout(t);
  }, []);
  return (index) => {
    if (!first.current || reduceMotion || index >= motion.stagger.maxItems) return undefined;
    return FadeInDown.delay(index * motion.stagger.step)
      .duration(motion.duration.base)
      .withInitialValues({ opacity: 0, transform: [{ translateY: motion.stagger.offsetY }] });
  };
}
