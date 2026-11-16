import { OutboxRefused, send, type SendInput } from "../../services/outbox";
import { useCacheLoader } from "../../hooks/useCachedQuery";
import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { ScreenHeader } from "../../components/ScreenHeader";
import { Button, Card, Chip, ConfidenceMeter, EmptyState, HelpButton, SectionTitle, Snackbar, ui } from "../../components/ui";
import { colors, palette } from "../../constants/theme";
import type { MainStackParamList } from "../../navigation/MainStack";
import { getApiErrorMessage, isNetworkError } from "../../services/api";
import { getMemory } from "../../services/insightsApi";
import type { MemoryItem, Pattern } from "../../types/models";
import { relativeTime } from "../../utils/format";
import { showAlert } from "../../services/dialog";

type Props = NativeStackScreenProps<MainStackParamList, "Memory">;

const KIND_INFO: Record<string, { title: string }> = {
  PREFERENCE: { title: "Preferences" },
  COPING: { title: "What helps you" },
  GOAL: { title: "Goals" },
  FACT: { title: "About you" },
  COURSE: { title: "Courses & studies" },
  EPISODE: { title: "Past conversations" },
};
const ORDER = ["PREFERENCE", "COPING", "GOAL", "FACT", "COURSE", "EPISODE"];

function pretty(content: string): string {
  return content.replace(/^User's\s+/i, "Your ").replace(/^User\s+/i, "You ").replace(/^User:\s*/i, "");
}

export function MemoryScreen({ navigation }: Props) {
  const [memories, setMemories] = useState<MemoryItem[] | null>(null);
  const [patterns, setPatterns] = useState<Pattern[]>([]);
  const [draft, setDraft] = useState("");
  const [kind, setKind] = useState<MemoryItem["kind"]>("PREFERENCE");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const cached = useCacheLoader();
  /** Memory changes show at once; sent now or when back online. A refusal reloads the server's copy. */
  const sendChange = async (input: SendInput) => {
    try {
      const sent = await send(input);
      if (sent) void load();
    } catch (e) {
      if (!(e instanceof OutboxRefused)) throw e;
      setToast(e.message);
      void load();
    }
  };

  const load = useCallback(async () => {
    try {
      await cached("memory", getMemory, (r) => {
        setMemories(r.memories);
        setPatterns(r.patterns);
      });
    } catch (e) {
      // Offline: the saved copy stays on screen.
      if (isNetworkError(e)) return;
      setToast(getApiErrorMessage(e));
      setMemories((m) => m ?? []);
    }
  }, [cached]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const grouped = ORDER.map((k) => ({ kind: k, items: (memories ?? []).filter((m) => m.kind === k) })).filter((g) => g.items.length);

  return (
    <View style={ui.screen}>
      <ScreenHeader
        title="What I know about you"
        onBack={() => navigation.goBack()}
        right={<HelpButton title="Your assistant's memory" text="I remember preferences, what helps you, goals and course details from our conversations and documents, and I learn patterns from your activity. Everything here is used to personalise planning — you can correct or delete any of it." />}
      />
      <ScrollView contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled">
        <Card tone="accent" style={{ gap: 10 }}>
          <Text style={ui.h2}>Teach me something</Text>
          <TextInput
            style={ui.input}
            value={draft}
            onChangeText={setDraft}
            placeholder="e.g. I study best after Isha prayer"
            placeholderTextColor={palette.muted}
          />
          <View style={ui.wrap}>
            {(["PREFERENCE", "COPING", "GOAL", "FACT"] as const).map((k) => (
              <Chip key={k} small label={KIND_INFO[k].title} selected={kind === k} onPress={() => setKind(k)} />
            ))}
          </View>
          <Button
            title="Remember this"
            kind="tonal"
            onPress={async () => {
              const text = draft.trim();
              if (text.length < 3) return;
              const now = new Date().toISOString();
              setMemories((list) => [{ id: `local-${Date.now()}`, kind, content: text, importance: 0.5, reinforcedCount: 1, source: "user", createdAt: now, updatedAt: now }, ...(list ?? [])]);
              setDraft("");
              setToast("Got it — I'll remember that.");
              await sendChange({ method: "POST", path: "/memory", body: { content: text, kind }, label: "Memory" });
            }}
          />
        </Card>

        <SectionTitle title="Patterns I've noticed" />
        {patterns.length ? (
          patterns.map((p) => (
            <Card key={p.key} style={{ gap: 8 }}>
              <Text style={ui.body}>{p.description}</Text>
              <ConfidenceMeter value={p.confidence} label={p.active ? "Using this to plan for you" : "Still observing — not used yet"} />
            </Card>
          ))
        ) : (
          <Text style={styles.meta}>Nothing yet — patterns appear as you complete tasks, routines and mood check-ins.</Text>
        )}

        {memories === null ? (
          <ActivityIndicator color={palette.ai} />
        ) : grouped.length === 0 ? (
          <EmptyState title="I don't know much about you yet" text="Tell me things in the assistant — like what helps when you're stressed or when you work best." />
        ) : (
          grouped.map((g) => (
            <View key={g.kind} style={{ gap: 8 }}>
              <SectionTitle title={`${KIND_INFO[g.kind]?.title ?? g.kind}`} />
              {g.items.map((m) => (
                <Card key={m.id} style={{ gap: 6 }}>
                  {editing?.id === m.id ? (
                    <>
                      <TextInput style={ui.input} value={editing.text} onChangeText={(text) => setEditing({ id: m.id, text })} multiline />
                      <View style={ui.wrap}>
                        <Chip
                          small
                          selected
                          label="Save"
                          onPress={async () => {
                            const content = editing.text;
                            setMemories((list) => (list ?? []).map((x) => (x.id === m.id ? { ...x, content, updatedAt: new Date().toISOString() } : x)));
                            setEditing(null);
                            await sendChange({ method: "PUT", path: `/memory/${m.id}`, body: { content }, key: `memory:${m.id}`, label: "Memory" });
                          }}
                        />
                        <Chip small label="Cancel" onPress={() => setEditing(null)} />
                      </View>
                    </>
                  ) : (
                    <>
                      <Text style={ui.body}>{pretty(m.content)}</Text>
                      <View style={styles.rowBetween}>
                        <Text style={styles.meta}>
                          {m.reinforcedCount > 1 ? `Mentioned ${m.reinforcedCount}× · ` : ""}
                          updated {relativeTime(m.updatedAt)}
                        </Text>
                        <View style={{ flexDirection: "row", gap: 14 }}>
                          <Pressable onPress={() => setEditing({ id: m.id, text: m.content })} hitSlop={8}>
                            <Text style={styles.action}>Correct</Text>
                          </Pressable>
                          <Pressable
                            onPress={async () => {
                              setMemories((list) => (list ?? []).filter((x) => x.id !== m.id));
                              await sendChange({ method: "DELETE", path: `/memory/${m.id}`, key: `memory:${m.id}`, label: "Memory" });
                            }}
                            hitSlop={8}
                          >
                            <Text style={[styles.action, { color: palette.danger }]}>Forget</Text>
                          </Pressable>
                        </View>
                      </View>
                    </>
                  )}
                </Card>
              ))}
            </View>
          ))
        )}

        {memories?.length ? (
          <Button
            title="Forget everything"
            kind="secondary"
            onPress={() =>
              showAlert("Forget everything?", "I'll lose all preferences and learned patterns. Your tasks are not affected.", [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Forget",
                  style: "destructive",
                  onPress: async () => {
                    setMemories([]);
                    setPatterns([]);
                    await sendChange({ method: "DELETE", path: "/memory", key: "memory:all", label: "Memory" });
                  },
                },
              ])
            }
          />
        ) : null}
      </ScrollView>
      <Snackbar text={toast} onHide={() => setToast(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  meta: { fontFamily: "Inter_400Regular", fontSize: 12, color: colors.textMuted },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  action: { color: palette.ai, fontFamily: "Inter_600SemiBold", fontSize: 13 },
});
