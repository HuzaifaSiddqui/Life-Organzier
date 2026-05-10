import { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import { colors, radii } from "../constants/theme";

type Props = {
  height?: number;
  width?: number | `${number}%`;
  style?: object;
};

export function Skeleton({ height = 16, width = "100%", style }: Props) {
  const shimmer = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(shimmer, {
        toValue: 1,
        duration: 1200,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: true,
      })
    );
    loop.start();
    return () => loop.stop();
  }, [shimmer]);

  const translateX = shimmer.interpolate({
    inputRange: [0, 1],
    outputRange: [-240, 240],
  });

  return (
    <View style={[styles.base, { height, width }, style]}>
      <Animated.View style={[styles.shimmer, { transform: [{ translateX }] }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    overflow: "hidden",
    backgroundColor: colors.surfaceSoft,
    borderRadius: radii.md,
  },
  shimmer: {
    height: "100%",
    width: 120,
    backgroundColor: "#ffffff88",
  },
});
