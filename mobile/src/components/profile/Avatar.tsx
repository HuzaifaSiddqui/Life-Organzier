import { useEffect, useState } from "react";
import { Image, StyleSheet, View } from "react-native";
import { avatarUri } from "../../services/profilePhoto";
import { useTheme } from "../../theme/ThemeProvider";
import { Text } from "../primitives";

/** "Yasir Imran" → "YI"; without a name, the email's first two letters. */
export function initials(displayName: string | null | undefined, email: string | null | undefined): string {
  if (displayName?.trim()) {
    const parts = displayName.trim().split(/\s+/);
    return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
  }
  return (email?.split("@")[0]?.slice(0, 2) ?? "?").toUpperCase();
}

/**
 * The user's photo in a circle, or their initials when there is none (or it can't load, e.g. offline the first time).
 */
export function Avatar({ photoUrl, displayName, email, size }: { photoUrl: string | null | undefined; displayName?: string | null; email?: string | null; size: number }) {
  const { colors } = useTheme();
  const uri = avatarUri(photoUrl);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [uri]);
  const round = { width: size, height: size, borderRadius: size / 2 };
  if (uri && !failed) {
    return <Image source={{ uri }} style={[round, { backgroundColor: colors.skeleton }]} onError={() => setFailed(true)} accessibilityIgnoresInvertColors />;
  }
  return (
    <View style={[round, styles.center, { backgroundColor: colors.surface }]}>
      <Text variant={size >= 64 ? "title2" : "bodyStrong"} style={{ color: colors.accentStrong }}>
        {initials(displayName, email)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({ center: { alignItems: "center", justifyContent: "center" } });
