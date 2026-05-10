import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { LogoMark } from "./branding/LogoMark";
import { colors, radii, shadow } from "../constants/theme";

type Props = {
  message: string;
};

export function BrandedBootLoader({ message }: Props) {
  return (
    <View style={styles.wrap}>
      <LogoMark size={44} />
      <View style={styles.card}>
        <ActivityIndicator size="large" color={colors.primary} />
        <Text style={styles.message}>{message}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: "center",
    gap: 20,
    width: "100%",
    maxWidth: 340,
  },
  card: {
    width: "100%",
    borderRadius: radii.xl,
    backgroundColor: colors.surface,
    paddingVertical: 28,
    paddingHorizontal: 24,
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.border,
    ...shadow,
  },
  message: {
    marginTop: 14,
    fontSize: 15,
    lineHeight: 22,
    color: colors.textMuted,
    fontWeight: "500",
    textAlign: "center",
  },
});
