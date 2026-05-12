import { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import { colors } from "../constants/theme";

const BAR_COUNT = 5;

export function ListeningWaveform() {
  const anims = useRef(Array.from({ length: BAR_COUNT }, () => new Animated.Value(0.35))).current;

  useEffect(() => {
    const loops = anims.map((v, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.timing(v, {
            toValue: 1,
            duration: 280 + i * 40,
            easing: Easing.inOut(Easing.sin),
            useNativeDriver: true,
          }),
          Animated.timing(v, {
            toValue: 0.25,
            duration: 280 + i * 40,
            easing: Easing.inOut(Easing.sin),
            useNativeDriver: true,
          }),
        ])
      )
    );
    loops.forEach((l, i) => {
      setTimeout(() => l.start(), i * 80);
    });
    return () => {
      loops.forEach((l) => l.stop());
    };
  }, [anims]);

  return (
    <View style={styles.wrap}>
      {anims.map((v, i) => (
        <Animated.View
          key={i}
          style={[
            styles.bar,
            {
              transform: [
                {
                  scaleY: v.interpolate({
                    inputRange: [0.25, 1],
                    outputRange: [0.45, 1],
                  }),
                },
              ],
              opacity: v.interpolate({
                inputRange: [0.25, 1],
                outputRange: [0.55, 1],
              }),
            },
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "center",
    gap: 5,
    height: 36,
  },
  bar: {
    width: 5,
    height: 32,
    borderRadius: 3,
    backgroundColor: colors.primary,
  },
});
