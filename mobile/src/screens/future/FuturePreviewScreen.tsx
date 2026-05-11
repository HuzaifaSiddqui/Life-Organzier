import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { LinearGradient } from "expo-linear-gradient";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { ScreenHeader } from "../../components/ScreenHeader";
import { colors, radii, shadow } from "../../constants/theme";
import type { MainStackParamList } from "../../navigation/MainStack";

type Props = NativeStackScreenProps<MainStackParamList, "FuturePreview">;

function moduleEmoji(title: string): string {
  const t = title.toLowerCase();
  if (t.includes("calendar")) return "📅";
  if (t.includes("team") || t.includes("collaboration")) return "👥";
  if (t.includes("analytics")) return "📊";
  if (t.includes("api")) return "🔌";
  return "✨";
}

export function FuturePreviewScreen({ navigation, route }: Props) {
  const { title } = route.params;

  return (
    <View style={styles.root}>
      <ScreenHeader title={title} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        <View style={styles.hero}>
          <LinearGradient
            colors={["#1D99FF", "#47AFFF"]}
            start={{ x: 0, y: 0 }}
            end={{ x: 0, y: 1 }}
            style={styles.iconBubble}
          >
            <Text style={styles.iconEmoji}>{moduleEmoji(title)}</Text>
          </LinearGradient>
          <Text style={styles.title}>{title}</Text>
          <View style={styles.pill}>
            <Text style={styles.pillText}>Coming in FYP-2</Text>
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardLead}>
            This module is on the roadmap for the next phase. FYP-1 focuses on secure sign-in, task CRUD,
            chat parsing, and voice-friendly capture.
          </Text>
          <Text style={styles.cardHeading}>What you can expect</Text>
          <View style={styles.bullets}>
            <Text style={styles.bullet}>• Deeper integrations with your existing workflows</Text>
            <Text style={styles.bullet}>• Polished UI aligned with the Life Organizer design system</Text>
            <Text style={styles.bullet}>• Features gated behind auth and your synced profile</Text>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  body: {
    padding: 24,
    paddingBottom: 40,
    gap: 24,
  },
  hero: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderRadius: radii.xl,
    paddingVertical: 28,
    paddingHorizontal: 24,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadow,
  },
  iconBubble: {
    width: 72,
    height: 72,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
  },
  iconEmoji: {
    fontSize: 34,
  },
  title: {
    fontSize: 22,
    fontWeight: "600",
    color: colors.text,
    textAlign: "center",
    lineHeight: 28,
    marginBottom: 12,
  },
  pill: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: radii.pill,
    backgroundColor: "#EEF7FF",
  },
  pillText: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.primary,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.xl,
    padding: 24,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadow,
    gap: 16,
  },
  cardLead: {
    fontSize: 15,
    lineHeight: 22,
    color: colors.textMuted,
  },
  cardHeading: {
    fontSize: 16,
    fontWeight: "600",
    color: colors.text,
  },
  bullets: {
    gap: 10,
  },
  bullet: {
    fontSize: 15,
    lineHeight: 22,
    color: colors.textMuted,
  },
});
