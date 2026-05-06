import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { StyleSheet, Text, View } from "react-native";
import type { MainStackParamList } from "../../navigation/MainStack";

type Props = NativeStackScreenProps<MainStackParamList, "FuturePreview">;

export function FuturePreviewScreen({ route }: Props) {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>{route.params.title}</Text>
      <View style={styles.pill}>
        <Text style={styles.pillText}>Coming in FYP-2</Text>
      </View>
      <Text style={styles.body}>
        This screen is a visual placeholder for a module planned in the next phase of the project. The
        FYP-1 MVP focuses on authentication, task management, chat parsing, and voice-friendly capture.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 24,
    backgroundColor: "#f7f8fb",
    gap: 16,
  },
  title: {
    fontSize: 24,
    fontWeight: "700",
    color: "#0f172a",
  },
  pill: {
    alignSelf: "flex-start",
    backgroundColor: "#e0f2fe",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#bae6fd",
  },
  pillText: {
    color: "#0369a1",
    fontWeight: "700",
    letterSpacing: 0.3,
  },
  body: {
    fontSize: 15,
    color: "#475569",
    lineHeight: 22,
  },
});
