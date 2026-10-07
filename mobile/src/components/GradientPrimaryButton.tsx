import { LinearGradient } from "expo-linear-gradient";
import { ActivityIndicator, Pressable, StyleSheet, Text, type ViewStyle } from "react-native";
import { shadow, colors } from "../constants/theme";

type Props = {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  style?: ViewStyle;
  /** Default 56 — prototype primary CTAs */
  height?: number;
};

export function GradientPrimaryButton({
  title,
  onPress,
  disabled,
  loading,
  style,
  height = 56,
}: Props) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.pressable,
        { opacity: pressed && !disabled ? 0.92 : 1, transform: [{ scale: pressed && !disabled ? 0.97 : 1 }] },
      ]}
    >
      <LinearGradient
        colors={[colors.text, colors.text]}
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 1 }}
        style={[styles.gradient, { minHeight: height }, style]}
      >
        {loading ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.text}>{title}</Text>
        )}
      </LinearGradient>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pressable: {
    borderRadius: 16,
    overflow: "hidden",
    alignSelf: "stretch",
    width: "100%",
    ...shadow,
  },
  gradient: {
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
    width: "100%",
  },
  text: {
    color: "#fff",
    fontSize: 16,
    fontFamily: "Inter_500Medium",
  },
});
