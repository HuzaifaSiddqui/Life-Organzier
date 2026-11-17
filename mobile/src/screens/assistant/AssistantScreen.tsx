import { palettes } from "../../theme/tokens";
import { LinearGradient } from "expo-linear-gradient";
import { scheduleReminderSync } from "../../services/reminders";
import { syncNow } from "../../services/syncEngine";
import { ComposerPlusMenu } from "../../components/assistant/ComposerPlusMenu";
import { useLocale } from "../../i18n/LocaleProvider";
import { isOnline, pickChatDocument, type PickedDoc } from "../../services/chatDocuments";
import { documentLearning, uploadDocument } from "../../services/documentsApi";
import { loadConversationMessages, toChat, type RawMessage } from "../../services/assistantApi";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Keyboard,
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AssistantCards } from "../../components/assistant/AssistantCards";
import { MentionPicker } from "../../components/collab/MentionPicker";
import { ListeningWaveform } from "../../components/ListeningWaveform";
import { MicIcon } from "../../components/icons/MicIcon";
import { platformFeatures } from "../../constants/platformFeatures";
import { Icon } from "../../components/icons/Icon";
import { SendIcon } from "../../components/icons/SendIcon";
import { HelpButton, SyncBadge, TutorialTip } from "../../components/ui";
import { colors, palette, radii } from "../../constants/theme";
import { usePreferences } from "../../context/PreferencesContext";
import { useDeviceSpeechRecognition } from "../../hooks/useDeviceSpeechRecognition";
import type { MainStackParamList } from "../../navigation/MainStack";
import { getApiErrorMessage, isNetworkError } from "../../services/api";
import { loadCurrentConversation, sendToAssistant, startNewConversation } from "../../services/assistantApi";
import { clashCardFor } from "../../services/calendar";
import { speak, stopSpeaking } from "../../services/speech";
import { readTasks } from "../../services/syncEngine";
import { normalizeSpelled, VOICE_MIN_RUN } from "../../utils/spelled";
import { SPEECH_LANG, speechHints } from "../../utils/speechHints";
import type { ActionPayload, ChatMessage, QuickAction } from "../../types/models";

type Props = NativeStackScreenProps<MainStackParamList, "Assistant">;


const STARTERS = [
  "What should I work on now?",
  "Complete math assignment by Friday 3 PM",
  "Plan my day",
  "I'm feeling stressed",
  "Daily meditation at 6 AM for 10 minutes",
];

/** Replies that changed nothing in the user's tasks or routines (no sync needed after them). */
const CHAT_ONLY = /^(?:chat|chat_fallback|smalltalk|support|greeting|thanks|help|unclear|capabilities|document_answer|read_back)$/;

const CLIENT_SCREENS: Record<string, keyof MainStackParamList> = {
  Routines: "Routines",
  Memory: "Memory",
  TaskList: "TaskList",
  AddTask: "AddTask",
  Documents: "Documents",
  Settings: "Settings",
  Mood: "Mood",
  Collab: "Collab",
};

export function AssistantScreen({ navigation, route }: Props) {
  const insets = useSafeAreaInsets();
  const { settings, reload } = usePreferences();
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
  const { t } = useLocale();
  /** A document attached to the next message ("+" in the composer); sent with the typed text as its request. */
  const [attachment, setAttachment] = useState<PickedDoc | null>(null);
  /** Seconds a document has been reading (the "Reading your document…" bubble). */
  const [readingFor, setReadingFor] = useState<number | null>(null);

  useEffect(() => {
    if (settings) setSpeakReplies(settings.ttsEnabled);
  }, [settings]);

  const scrollToEnd = useCallback(() => {
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 60);
  }, []);
  const [keyboardOpen, setKeyboardOpen] = useState(false);

  // Keep the newest message in view when the keyboard opens (the app-wide KeyboardPad lifts the composer).
  useEffect(() => {
    const show = Keyboard.addListener("keyboardDidShow", () => {
      setKeyboardOpen(true);
      scrollToEnd();
    });
    const hide = Keyboard.addListener("keyboardDidHide", () => setKeyboardOpen(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, [scrollToEnd]);
  // Opening the chat lands on the newest message. Twice: the first jump can run before a long thread is laid out.
  useEffect(() => {
    if (loading) return;
    const jump = () => scrollRef.current?.scrollToEnd({ animated: false });
    const timers = [setTimeout(jump, 100), setTimeout(jump, 500)];
    return () => timers.forEach(clearTimeout);
  }, [loading]);

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

  /** CALENDAR_SYNC: a task chat just added overlaps an event on the phone's other calendars → Keep / Undo card. */
  const addClashCard = useCallback(async (message: ChatMessage) => {
    const task = message.cards?.find((c) => c.type === "task")?.task;
    const card = task ? await clashCardFor(task) : null;
    if (card) setMessages((m) => m.map((x) => (x.id === message.id ? { ...x, cards: [...(x.cards ?? []), card] } : x)));
  }, []);

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
        if (reply.message.intent === "task_created") void addClashCard(reply.message);
        // Chat can add, change or finish tasks and routines: bring the phone's copy and its reminders up to date now,
        // or a task added here gets no phone reminder until the next sync (WhatsApp would still remind).
        if (!CHAT_ONLY.test(reply.message.intent ?? "")) void syncNow().then(() => scheduleReminderSync(0));
        // Settings changed (or undone) from chat: refresh what the app shows and plans with.
        if (/^(?:settings_|checkin|undone)/.test(reply.message.intent ?? "")) void reload();
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
    [addClashCard, busy, conversationId, reload, scrollToEnd, settings?.language, settings?.ttsRate, speakReplies],
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
      // Spelled letters ("k f c", "kay ef see") as one word before the assistant reads it. Runs of 3+ only: this
      // changes every voice message ("section A B" stays); the server joins 2-letter runs in search questions.
      void send({ text: normalizeSpelled(text, VOICE_MIN_RUN), voice: true });
    },
    onError: (m) => setNotice(m),
  });

  const startVoice = useCallback(async () => {
    stopSpeaking();
    setNotice(null);
    voiceTurnRef.current = true;
    const hints = speechHints(await readTasks().catch(() => []));
    const ok = await start("", SPEECH_LANG[settings?.language ?? "en"] ?? "en-US", hints);
    if (!ok) voiceTurnRef.current = false;
  }, [settings?.language, start]);

  /** "+": pick a PDF, image or DOCX to send in this chat. */
  const pickAttachment = useCallback(async () => {
    const picked = await pickChatDocument();
    if (picked === "too_large") {
      setNotice(t("chatDoc.tooLarge"));
      return;
    }
    if (picked) setAttachment(picked);
  }, [t]);

  /**
   * Sends the attached document with the typed text as its request. The server reads it like any upload and writes
   * "file + request" and its summary (with a Review card) into this chat; those replace the temporary bubbles.
   */
  const sendDocument = useCallback(
    async (doc: PickedDoc, text: string) => {
      if (busy) return;
      setNotice(null);
      if (!(await isOnline())) {
        setNotice(t("chatDoc.offline"));
        return;
      }
      setBusy(true);
      setAttachment(null);
      setDraft("");
      const tempId = `tmp-doc-${Date.now()}`;
      setMessages((m) => [...m, { id: tempId, role: "USER", content: text || doc.name, createdAt: new Date().toISOString(), pending: true, attachment: { fileName: doc.name } }]);
      scrollToEnd();
      setReadingFor(0);
      const timer = setInterval(() => setReadingFor((s) => (s ?? 0) + 1), 1000);
      try {
        const r = await uploadDocument(doc, "AUTO", "eng", undefined, text || undefined, { conversationId });
        if (r.chat) {
          setConversationId(r.chat.conversationId);
          const added = r.chat.messages.map((x) => toChat(x as RawMessage));
          setMessages((m) => [...m.filter((x) => x.id !== tempId), ...added]);
          if (r.chat.learning) void watchLearning(r.document.id, r.chat.conversationId);
        } else {
          setMessages((m) => m.map((x) => (x.id === tempId ? { ...x, pending: false } : x)));
        }
      } catch (e) {
        setMessages((m) => m.filter((x) => x.id !== tempId));
        setAttachment(doc);
        setDraft(text);
        setNotice(getApiErrorMessage(e, t("chatDoc.failed")));
      } finally {
        clearInterval(timer);
        setReadingFor(null);
        setBusy(false);
        scrollToEnd();
      }
    },
    [busy, conversationId, scrollToEnd, t],
  );

  /**
   * DOC_KNOWLEDGE: the server keeps reading a sent document for facts about the user. Check every few seconds (up to 3
   * minutes, while this screen is open); when it added a "Tick the ones I should remember" message, show it.
   */
  const mountedRef = useRef(true);
  useEffect(() => () => void (mountedRef.current = false), []);
  const watchLearning = useCallback(async (documentId: string, convId: string) => {
    for (let i = 0; i < 45 && mountedRef.current; i++) {
      await new Promise((r) => setTimeout(r, 4000));
      const s = await documentLearning(documentId).catch(() => null);
      if (!s || s.status === "pending") continue;
      if (s.messageId) {
        const all = await loadConversationMessages(convId).catch(() => null);
        if (all && mountedRef.current) {
          setMessages((m) => [...m, ...all.filter((x) => !m.some((y) => y.id === x.id))]);
          scrollToEnd();
        }
      }
      return;
    }
  }, [scrollToEnd]);

  /** The send button and the keyboard's send: a document if one is attached, otherwise a normal message. */
  const submit = useCallback(() => {
    const text = draft.trim();
    if (attachment) {
      void sendDocument(attachment, text);
      return;
    }
    if (!text) return;
    setDraft("");
    void send({ text });
  }, [attachment, draft, send, sendDocument]);

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
    if (p.voice && speechSupported) void startVoice();
    if (p.attach) void pickAttachment();
  }, [loading, route.params, send, speechSupported, startVoice, pickAttachment]);

  const onAction = useCallback(
    (action: QuickAction | { payload: ActionPayload; label: string }) => {
      const payload = action.payload;
      if (payload?.type === "open_task" && typeof payload.taskId === "string") {
        navigation.navigate("TaskDetail", { taskId: payload.taskId });
        return;
      }
      if (payload?.type === "navigate" && typeof payload.screen === "string") {
        const screen = CLIENT_SCREENS[payload.screen];
        if (screen === "Routines") navigation.navigate("Routines", typeof payload.routineId === "string" ? { routineId: payload.routineId } : undefined);
        else if (screen) navigation.navigate(screen as never);
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
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: Math.max(insets.top, 12) }]}>
        <Pressable onPress={() => navigation.goBack()} hitSlop={12}>
          <Icon name="back" size={24} color={colors.text} />
        </Pressable>
        {/* UI v3: the assistant's mark, the same gradient as its button in the tab bar. */}
        <View style={styles.avatar}>
          <LinearGradient colors={[palettes.light.brand, palettes.light.accent]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[StyleSheet.absoluteFill, { borderRadius: 18 }]} />
          <Icon name="sparkle" size={18} color={palettes.light.onBrand} strokeWidth={2} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Assistant</Text>
          <Text style={styles.subtitle} numberOfLines={1}>{busy ? "Thinking…" : "Remembers your context"}</Text>
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
          text={`${platformFeatures.voiceInput ? "Type or speak naturally" : "Type naturally"}. I can add tasks and routines, update or complete them, plan your day, track your mood, and I remember what you tell me (see Me → What I know). Tap the suggestions under my replies to act in one tap.`}
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
                {m.attachment ? (
                  <View style={styles.attachLine}>
                    <Icon name="doc" size={16} color={m.role === "USER" ? colors.bg : colors.text} />
                    <Text style={[styles.attachName, m.role === "USER" && { color: colors.bg }]} numberOfLines={1}>
                      {m.attachment.fileName}
                    </Text>
                  </View>
                ) : null}
                {!m.attachment || m.content !== m.attachment.fileName ? <Text style={[styles.msgText, m.role === "USER" && { color: colors.bg }]}>{m.content}</Text> : null}
              </View>
              {m.role === "ASSISTANT" && m.cards?.length ? (
                <View style={styles.cards}>
                  <AssistantCards
                    cards={m.cards}
                    onOpenTask={(taskId) => navigation.navigate("TaskDetail", { taskId })}
                    onOpenRoutine={(routineId) => navigation.navigate("Routines", { routineId })}
                    onAction={(payload, label) => onAction({ payload, label })}
                    onOpenDocument={(documentId) => navigation.navigate("DocumentReview", { documentId })}
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
              <Text style={styles.typingText}>{readingFor !== null ? t("chatDoc.reading", { seconds: String(readingFor) }) : "Thinking…"}</Text>
            </View>
          </View>
        ) : null}
        {notice ? <Text style={styles.notice}>{notice}</Text> : null}
      </ScrollView>

      <View style={[styles.composer, { paddingBottom: keyboardOpen ? 10 : Math.max(insets.bottom, 10) }]}>
        {listening ? (
          <View style={styles.listening}>
            <ListeningWaveform />
            <Text style={styles.listeningText}>{draft || "Listening… I'll stop after a short pause"}</Text>
            <Pressable onPress={stop} style={styles.stopBtn}>
              <Text style={{ color: colors.bg, fontFamily: "Inter_600SemiBold" }}>Stop</Text>
            </Pressable>
          </View>
        ) : (
          <>
          <MentionPicker text={draft} onPick={setDraft} />
          {attachment ? (
            <View style={styles.attachChip}>
              <Icon name="doc" size={16} color={colors.text} />
              <Text style={styles.attachChipText} numberOfLines={1}>
                {attachment.name}
              </Text>
              <Pressable onPress={() => setAttachment(null)} hitSlop={10} accessibilityRole="button" accessibilityLabel={t("chatDoc.remove", { name: attachment.name })}>
                <Icon name="close" size={16} color={colors.textMuted} />
              </Pressable>
            </View>
          ) : null}
          {attachment ? <Text style={styles.attachHint}>{t("chatDoc.hint")}</Text> : null}
          <View style={styles.inputRow}>
            <ComposerPlusMenu disabled={busy} items={[{ key: "upload", icon: "upload", label: "chatPlus.upload", onPress: () => void pickAttachment() }]} />
            <TextInput
              style={styles.input}
              value={draft}
              onChangeText={setDraft}
              placeholder={attachment ? t("chatDoc.placeholder") : "Tell me anything…"}
              placeholderTextColor={palette.muted}
              multiline
              maxLength={2000}
              onSubmitEditing={submit}
            />
            {speechSupported ? (
              <Pressable onPress={() => void startVoice()} style={styles.micBtn} accessibilityLabel="Speak">
                <MicIcon size={20} color={colors.text} />
              </Pressable>
            ) : null}
            <Pressable
              onPress={submit}
              disabled={busy || (!draft.trim() && !attachment)}
              style={[styles.sendBtn, (busy || (!draft.trim() && !attachment)) && { opacity: 0.5 }]}
              accessibilityLabel="Send"
            >
              <SendIcon size={18} />
            </Pressable>
          </View>
          </>
        )}
      </View>
    </View>
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
  bubble: { maxWidth: "88%", borderRadius: 20, paddingHorizontal: 16, paddingVertical: 11 },
  userBubble: { backgroundColor: colors.primary, borderBottomRightRadius: 6 },
  avatar: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  aiBubble: { backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderBottomLeftRadius: 6 },
  msgText: { fontSize: 15, lineHeight: 22, fontFamily: "Inter_400Regular", color: colors.text },
  cards: { width: "92%" },
  memoryRow: { paddingLeft: 4 },
  memoryText: { fontSize: 12, fontFamily: "Inter_400Regular", color: colors.textMuted },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, maxWidth: "95%" },
  action: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
  actionPrimary: { backgroundColor: colors.primary, borderColor: colors.primary },
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
  attachLine: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 4 },
  attachName: { flexShrink: 1, fontSize: 13, fontFamily: "Inter_600SemiBold", color: colors.text },
  attachChip: { flexDirection: "row", alignItems: "center", gap: 8, alignSelf: "flex-start", maxWidth: "100%", paddingHorizontal: 12, paddingVertical: 8, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, marginBottom: 6 },
  attachChipText: { flexShrink: 1, fontSize: 13, fontFamily: "Inter_600SemiBold", color: colors.text },
  attachHint: { fontSize: 12, fontFamily: "Inter_400Regular", color: colors.textMuted, marginBottom: 6 },
  micBtn: { width: 44, height: 44, borderRadius: 22, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center" },
  sendBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.text, alignItems: "center", justifyContent: "center" },
  listening: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 44 },
  listeningText: { flex: 1, color: colors.text, fontFamily: "Inter_400Regular", fontSize: 14 },
  stopBtn: { backgroundColor: palette.danger, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
});
