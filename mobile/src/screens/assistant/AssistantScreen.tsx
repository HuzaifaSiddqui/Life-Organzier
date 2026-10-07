import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AssistantCards } from "../../components/assistant/AssistantCards";
import { ListeningWaveform } from "../../components/ListeningWaveform";
import { MicIcon } from "../../components/icons/MicIcon";
import { Icon } from "../../components/icons/Icon";
import { SendIcon } from "../../components/icons/SendIcon";
import { HelpButton, SyncBadge, TutorialTip } from "../../components/ui";
import { colors, palette, radii } from "../../constants/theme";
import { usePreferences } from "../../context/PreferencesContext";
import { useDeviceSpeechRecognition } from "../../hooks/useDeviceSpeechRecognition";
import type { MainStackParamList } from "../../navigation/MainStack";
import { getApiErrorMessage, isNetworkError } from "../../services/api";
import { loadCurrentConversation, sendToAssistant, startNewConversation } from "../../services/assistantApi";
import { speak, stopSpeaking } from "../../services/speech";
import type { ActionPayload, ChatMessage, QuickAction } from "../../types/models";

type Props = NativeStackScreenProps<MainStackParamList, "Assistant">;

const SPEECH_LANG: Record<string, string> = { en: "en-US", ur: "ur-PK", ar: "ar-SA", es: "es-ES", fr: "fr-FR", zh: "zh-CN", hi: "hi-IN" };

const STARTERS = [
  "What should I work on now?",
  "Complete math assignment by Friday 3 PM",
  "Plan my day",
  "I'm feeling stressed",
  "Daily meditation at 6 AM for 10 minutes",
];

const CLIENT_SCREENS: Record<string, keyof MainStackParamList> = {
  Routines: "Routines",
  Memory: "Memory",
  TaskList: "TaskList",
  AddTask: "AddTask",
  Documents: "Documents",
  Settings: "Settings",
  Mood: "Mood",
};

export function AssistantScreen({ navigation, route }: Props) {
  const insets = useSafeAreaInsets();
  const { settings } = usePreferences();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [speakReplies, setSpeakReplies] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const voiceTurnRef = useRef(false);
  const handledParamsRef = useRef<string | null>(null);

  useEffect(() => {
    if (settings) setSpeakReplies(settings.ttsEnabled);
  }, [settings]);

  const scrollToEnd = useCallback(() => {
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 60);
  }, []);

  useEffect(() => {
    let alive = true;
    loadCurrentConversation()
      .then((c) => {
        if (!alive) return;
        setConversationId(c.conversationId);
        setMessages(c.messages);
      })
      .catch((e) => alive && setNotice(isNetworkError(e) ? "You're offline — the assistant needs the server. Your tasks still work offline." : getApiErrorMessage(e)))
      .finally(() => {
        if (alive) {
          setLoading(false);
          scrollToEnd();
        }
      });
    return () => {
      alive = false;
      stopSpeaking();
    };
  }, [scrollToEnd]);

  const send = useCallback(
    async (input: { text?: string; payload?: ActionPayload; label?: string; voice?: boolean }) => {
      const shown = input.text ?? input.label ?? "";
      if (busy || (!shown && !input.payload)) return;
      setNotice(null);
      setBusy(true);
      const tempId = `tmp-${Date.now()}`;
      if (shown) {
        setMessages((m) => [...m, { id: tempId, role: "USER", content: shown, createdAt: new Date().toISOString(), pending: true }]);
      }
      scrollToEnd();
      try {
        const reply = await sendToAssistant({ ...input, conversationId });
        setConversationId(reply.conversationId);
        setMessages((m) => [
          ...m.map((x) => (x.id === tempId && reply.userMessage ? { ...x, id: reply.userMessage.id, pending: false } : x)),
          reply.message,
        ]);
        const shouldSpeak = speakReplies || input.voice || reply.message.intent === "read_back";
        if (shouldSpeak) speak(reply.message.speak ?? reply.message.content, { language: settings?.language, rate: settings?.ttsRate });
      } catch (e) {
        setMessages((m) => m.filter((x) => x.id !== tempId));
        if (input.text) setDraft(input.text);
        setNotice(isNetworkError(e) ? "You're offline — I couldn't reach the assistant. Your message is back in the box." : getApiErrorMessage(e, "The assistant couldn't respond."));
      } finally {
        setBusy(false);
        scrollToEnd();
      }
    },
    [busy, conversationId, scrollToEnd, settings?.language, settings?.ttsRate, speakReplies],
  );

  const { start, stop, listening, speechSupported } = useDeviceSpeechRecognition({
    onTranscriptChange: setDraft,
    onRecognitionEnd: (full, confidence) => {
      const text = full.trim();
      if (!voiceTurnRef.current) return;
      voiceTurnRef.current = false;
      if (!text) return;
      // FR-VF-001: below 80% confidence ask the user to repeat instead of guessing.
      if (confidence >= 0 && confidence < 0.8) {
        setNotice(`I didn't catch that clearly ("${text}"). Try again, or edit and send.`);
        return;
      }
      setDraft("");
      void send({ text, voice: true });
    },
    onError: (m) => setNotice(m),
  });

  const startVoice = useCallback(async () => {
    stopSpeaking();
    setNotice(null);
    voiceTurnRef.current = true;
    const ok = await start("", SPEECH_LANG[settings?.language ?? "en"] ?? "en-US");
    if (!ok) voiceTurnRef.current = false;
  }, [settings?.language, start]);

  // Entry points: voice mode, prefilled text, or a one-tap action from another screen.
  useEffect(() => {
    if (loading) return;
    const p = route.params;
    const key = JSON.stringify(p ?? {});
    if (!p || handledParamsRef.current === key) return;
    handledParamsRef.current = key;
    if (p.payload) void send({ payload: p.payload, label: p.label });
    else if (p.prefill && p.autoSend) void send({ text: p.prefill });
    else if (p.prefill) setDraft(p.prefill);
    if (p.voice) void startVoice();
  }, [loading, route.params, send, startVoice]);

  const onAction = useCallback(
    (action: QuickAction | { payload: ActionPayload; label: string }) => {
      const payload = action.payload;
      if (payload?.type === "open_task" && typeof payload.taskId === "string") {
        navigation.navigate("TaskDetail", { taskId: payload.taskId });
        return;
      }
      if (payload?.type === "navigate" && typeof payload.screen === "string") {
        const screen = CLIENT_SCREENS[payload.screen];
        if (screen) navigation.navigate(screen as never);
        return;
      }
      if (payload) void send({ payload, label: action.label });
      else if ("text" in action && action.text) void send({ text: action.text });
    },
    [navigation, send],
  );

  const newChat = useCallback(async () => {
    try {
      const id = await startNewConversation();
      setConversationId(id);
      setMessages([]);
    } catch (e) {
      setNotice(getApiErrorMessage(e));
    }
  }, []);

  const last = messages[messages.length - 1];

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={[styles.header, { paddingTop: Math.max(insets.top, 12) }]}>
        <Pressable onPress={() => navigation.goBack()} hitSlop={12}>
          <Icon name="back" size={24} color={colors.text} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Assistant</Text>
          <Text style={styles.subtitle}>{busy ? "Thinking…" : "Remembers your context across chats"}</Text>
        </View>
        <Pressable
          onPress={() => {
            stopSpeaking();
            setSpeakReplies((s) => !s);
          }}
          style={[styles.iconBtn, speakReplies && { backgroundColor: palette.aiSoft, borderColor: palette.ai }]}
          accessibilityLabel="Toggle spoken replies"
        >
          <Icon name="speaker" size={18} color={speakReplies ? colors.primary : colors.textMuted} />
        </Pressable>
        <Pressable onPress={() => void newChat()} style={styles.iconBtn} accessibilityLabel="New conversation">
          <Icon name="plus" size={18} color={colors.textMuted} />
        </Pressable>
        <HelpButton
          title="Talking to your assistant"
          text="Type or speak naturally. I can add tasks and routines, update or complete them, plan your day, track your mood, and I remember what you tell me (see Me → What I know). Tap the suggestions under my replies to act in one tap."
          example={'"Move the physics assignment to Monday and make it urgent"'}
        />
      </View>

      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={styles.thread}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
      >
        <SyncBadge />
        <TutorialTip id="assistant" title="Just talk to me" text="Say things like “Remind me to call Ali tomorrow at 5 PM” or “I'm 50% done with the essay”. I'll ask when something is unclear." />
        {loading ? (
          <ActivityIndicator style={{ marginTop: 40 }} color={palette.muted} />
        ) : messages.length === 0 ? (
          <View style={styles.welcome}>
            <Text style={styles.welcomeTitle}>Hi! How can I help today?</Text>
            <Text style={styles.welcomeText}>I learn your habits, plan around your most productive hours and check in on how you feel.</Text>
            <View style={styles.starters}>
              {STARTERS.map((s) => (
                <Pressable key={s} style={styles.starter} onPress={() => void send({ text: s })}>
                  <Text style={styles.starterText}>{s}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        ) : (
          messages.map((m) => (
            <View key={m.id} style={[styles.msgRow, m.role === "USER" ? styles.right : styles.left]}>
              <View style={[styles.bubble, m.role === "USER" ? styles.userBubble : styles.aiBubble, m.pending && { opacity: 0.6 }]}>
                <Text style={[styles.msgText, m.role === "USER" && { color: colors.bg }]}>{m.content}</Text>
              </View>
              {m.role === "ASSISTANT" && m.cards?.length ? (
                <View style={styles.cards}>
                  <AssistantCards
                    cards={m.cards}
                    onOpenTask={(taskId) => navigation.navigate("TaskDetail", { taskId })}
                    onAction={(payload, label) => onAction({ payload, label })}
                  />
                </View>
              ) : null}
              {m.role === "ASSISTANT" && (m.learned?.length || m.memoriesUsed) ? (
                <View style={styles.memoryRow}>
                  {m.learned?.length ? <Text style={styles.memoryText}>Remembered: {m.learned[0].replace(/^User\s+/i, "")}</Text> : null}
                  {!m.learned?.length && m.memoriesUsed ? <Text style={styles.memoryText}>Used {m.memoriesUsed} thing{m.memoriesUsed === 1 ? "" : "s"} I know about you</Text> : null}
                </View>
              ) : null}
              {m.role === "ASSISTANT" && m.id === last?.id && m.actions?.length ? (
                <View style={styles.actions}>
                  {m.actions.map((a, i) => (
                    <Pressable
                      key={`${a.label}-${i}`}
                      onPress={() => onAction(a)}
                      disabled={busy}
                      style={({ pressed }) => [
                        styles.action,
                        a.style === "primary" && styles.actionPrimary,
                        a.style === "danger" && styles.actionDanger,
                        pressed && { opacity: 0.8 },
                      ]}
                    >
                      <Text style={[styles.actionText, (a.style === "primary" || a.style === "danger") && { color: colors.bg }]}>{a.label}</Text>
                    </Pressable>
                  ))}
                </View>
              ) : null}
            </View>
          ))
        )}
        {busy ? (
          <View style={[styles.msgRow, styles.left]}>
            <View style={[styles.bubble, styles.aiBubble, styles.typing]}>
              <ActivityIndicator size="small" color={palette.muted} />
              <Text style={styles.typingText}>Thinking…</Text>
            </View>
          </View>
        ) : null}
        {notice ? <Text style={styles.notice}>{notice}</Text> : null}
      </ScrollView>

      <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, 10) }]}>
        {listening ? (
          <View style={styles.listening}>
            <ListeningWaveform />
            <Text style={styles.listeningText}>{draft || "Listening… I'll stop after a short pause"}</Text>
            <Pressable onPress={stop} style={styles.stopBtn}>
              <Text style={{ color: colors.bg, fontFamily: "Inter_600SemiBold" }}>Stop</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.inputRow}>
            <TextInput
              style={styles.input}
              value={draft}
              onChangeText={setDraft}
              placeholder="Tell me anything…"
              placeholderTextColor={palette.muted}
              multiline
              maxLength={2000}
              onSubmitEditing={() => {
                const t = draft.trim();
                if (t) {
                  setDraft("");
                  void send({ text: t });
                }
              }}
            />
            {speechSupported ? (
              <Pressable onPress={() => void startVoice()} style={styles.micBtn} accessibilityLabel="Speak">
                <MicIcon size={20} color={colors.text} />
              </Pressable>
            ) : null}
            <Pressable
              onPress={() => {
                const t = draft.trim();
                if (!t) return;
                setDraft("");
                void send({ text: t });
              }}
              disabled={busy || !draft.trim()}
              style={[styles.sendBtn, (busy || !draft.trim()) && { opacity: 0.5 }]}
              accessibilityLabel="Send"
            >
              <SendIcon size={18} />
            </Pressable>
          </View>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingBottom: 10,
    backgroundColor: colors.bg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  title: { fontSize: 17, fontFamily: "Inter_600SemiBold", color: colors.text },
  subtitle: { fontSize: 12, fontFamily: "Inter_400Regular", color: colors.textMuted },
  iconBtn: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  thread: { padding: 14, gap: 12, paddingBottom: 24 },
  welcome: { marginTop: 24, gap: 10, alignItems: "center" },
  welcomeTitle: { fontSize: 22, fontFamily: "Inter_600SemiBold", color: colors.text, textAlign: "center" },
  welcomeText: { fontSize: 14, fontFamily: "Inter_400Regular", color: colors.textMuted, textAlign: "center", lineHeight: 20, paddingHorizontal: 12 },
  starters: { width: "100%", gap: 8, marginTop: 8 },
  starter: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, paddingHorizontal: 16, paddingVertical: 14 },
  starterText: { color: colors.text, fontFamily: "Inter_500Medium", fontSize: 15 },
  msgRow: { gap: 6, maxWidth: "100%" },
  left: { alignItems: "flex-start" },
  right: { alignItems: "flex-end" },
  bubble: { maxWidth: "88%", borderRadius: 18, paddingHorizontal: 14, paddingVertical: 10 },
  userBubble: { backgroundColor: colors.text, borderBottomRightRadius: 4 },
  aiBubble: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderBottomLeftRadius: 4 },
  msgText: { fontSize: 15, lineHeight: 22, fontFamily: "Inter_400Regular", color: colors.text },
  cards: { width: "92%" },
  memoryRow: { paddingLeft: 4 },
  memoryText: { fontSize: 12, fontFamily: "Inter_400Regular", color: colors.textMuted },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, maxWidth: "95%" },
  action: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
  actionPrimary: { backgroundColor: colors.text, borderColor: colors.text },
  actionDanger: { backgroundColor: palette.danger, borderColor: palette.danger },
  actionText: { fontSize: 13, fontFamily: "Inter_500Medium", color: colors.text },
  typing: { flexDirection: "row", gap: 8, alignItems: "center" },
  typingText: { color: colors.textMuted },
  notice: { color: palette.warning, textAlign: "center", fontFamily: "Inter_400Regular", fontSize: 13, paddingHorizontal: 12 },
  composer: { backgroundColor: colors.bg, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, paddingHorizontal: 12, paddingTop: 10 },
  inputRow: { flexDirection: "row", alignItems: "flex-end", gap: 8 },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 120,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingTop: 11,
    paddingBottom: 11,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: colors.text,
    backgroundColor: colors.surface,
  },
  micBtn: { width: 44, height: 44, borderRadius: 22, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center" },
  sendBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.text, alignItems: "center", justifyContent: "center" },
  listening: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 44 },
  listeningText: { flex: 1, color: colors.text, fontFamily: "Inter_400Regular", fontSize: 14 },
  stopBtn: { backgroundColor: palette.danger, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
});
