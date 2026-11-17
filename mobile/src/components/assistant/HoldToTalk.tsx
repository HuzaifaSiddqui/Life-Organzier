import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { Easing, FadeInDown, FadeOutDown, useAnimatedStyle, useReducedMotion, useSharedValue, withDelay, withRepeat, withTiming, cancelAnimation } from "react-native-reanimated";
import { usePreferences } from "../../context/PreferencesContext";
import { useDeviceSpeechRecognition } from "../../hooks/useDeviceSpeechRecognition";
import { useLocale } from "../../i18n/LocaleProvider";
import { sendToAssistant } from "../../services/assistantApi";
import { hapticDone, hapticTap, hapticWarn } from "../../services/haptics";
import { scheduleReminderSync } from "../../services/reminders";
import { readTasks, syncNow } from "../../services/syncEngine";
import { useTheme } from "../../theme/ThemeProvider";
import { SPEECH_LANG, speechHints } from "../../utils/speechHints";
import { Icon } from "../icons/Icon";
import { PressableScale, Text } from "../primitives";

export type HoldPhase = "idle" | "listening" | "sending" | "reply";

/**
 * Hold-to-talk on the ✦ button (UI v3): hold = listen for as long as the finger is down (the screen stays where it is),
 * let go = send what was said to the assistant (the same engine as the chat), and a small card above the tab bar shows
 * the words and the reply. A crisis reply opens the chat at once (its safety flow lives there).
 */
export function useHoldToTalk(openChat: () => void) {
  const { settings } = usePreferences();
  const [phase, setPhase] = useState<HoldPhase>("idle");
  const [heard, setHeard] = useState("");
  const [reply, setReply] = useState<{ text: string; error?: boolean } | null>(null);
  const holding = useRef(false);
  const finished = useRef(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lang = SPEECH_LANG[settings?.language ?? "en"] ?? "en-US";
  const hints = useRef<string[]>([]);

  const scheduleHide = (ms: number) => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      setPhase("idle");
      setReply(null);
      setHeard("");
    }, ms);
  };

  const finish = useCallback(
    async (text: string) => {
      if (finished.current) return;
      finished.current = true;
      const said = text.trim();
      if (!said) {
        hapticWarn();
        setPhase("reply");
        setReply({ text: "", error: true });
        scheduleHide(2500);
        return;
      }
      setHeard(said);
      setPhase("sending");
      try {
        const r = await sendToAssistant({ text: said, voice: true });
        if (r.message.intent === "crisis") {
          setPhase("idle");
          setReply(null);
          openChat();
          return;
        }
        hapticDone();
        setReply({ text: r.message.content });
        setPhase("reply");
        scheduleHide(9000);
        // Whatever it changed (a task, a routine) shows on Today and Plan, and its alarms are planned.
        void syncNow().then(() => scheduleReminderSync(0));
      } catch {
        setReply({ text: "", error: true });
        setPhase("reply");
        scheduleHide(6000);
      }
    },
    [openChat],
  );

  const speech = useDeviceSpeechRecognition({
    onTranscriptChange: setHeard,
    onRecognitionEnd: (full) => {
      // Older Android ends on a pause even in hold mode: carry on while the finger is still down.
      if (holding.current) {
        void speech.start(full, lang, hints.current, { hold: true });
        return;
      }
      void finish(full);
    },
    onError: () => {
      if (holding.current) return;
      void finish(heardRef.current);
    },
  });
  const heardRef = useRef("");
  heardRef.current = heard;

  const begin = useCallback(async () => {
    if (!speech.speechSupported) {
      openChat();
      return;
    }
    if (hideTimer.current) clearTimeout(hideTimer.current);
    holding.current = true;
    finished.current = false;
    setHeard("");
    setReply(null);
    setPhase("listening");
    hapticTap();
    hints.current = speechHints(await readTasks().catch(() => []));
    const ok = await speech.start("", lang, hints.current, { hold: true });
    if (!ok) {
      holding.current = false;
      setPhase("idle");
      openChat();
    }
  }, [lang, openChat, speech]);

  const end = useCallback(() => {
    if (!holding.current) return;
    holding.current = false;
    speech.stop();
    // If the recogniser never reports its end, send what was heard anyway.
    setTimeout(() => void finish(heardRef.current), 2500);
  }, [finish, speech]);

  const dismiss = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setPhase("idle");
    setReply(null);
    setHeard("");
  }, []);

  useEffect(() => () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
  }, []);

  return { phase, heard, reply, begin, end, dismiss };
}

/** Two rings that grow and fade from the button while it listens (none with reduce motion). */
export function PulseRings({ active, size }: { active: boolean; size: number }) {
  const { colors } = useTheme();
  const reduce = useReducedMotion();
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.center]}>
      {[0, 1].map((i) => (
        <Ring key={i} delay={i * 600} active={active && !reduce} size={size} color={colors.brand} />
      ))}
    </View>
  );
}

function Ring({ active, delay, size, color }: { active: boolean; delay: number; size: number; color: string }) {
  const p = useSharedValue(0);
  useEffect(() => {
    if (active) p.value = withDelay(delay, withRepeat(withTiming(1, { duration: 1200, easing: Easing.out(Easing.quad) }), -1, false));
    else {
      cancelAnimation(p);
      p.value = 0;
    }
  }, [active, delay, p]);
  const style = useAnimatedStyle(() => ({ opacity: active ? 0.45 * (1 - p.value) : 0, transform: [{ scale: 1 + p.value * 0.9 }] }));
  return <Animated.View style={[{ position: "absolute", width: size, height: size, borderRadius: size / 2, backgroundColor: color }, style]} />;
}

/** The card above the tab bar: live words while listening, then the reply. */
export function VoiceBubble({ phase, heard, reply, onOpenChat, onClose, bottom }: { phase: HoldPhase; heard: string; reply: { text: string; error?: boolean } | null; onOpenChat: () => void; onClose: () => void; bottom: number }) {
  const { colors, elevation, radii, spacing } = useTheme();
  const { t } = useLocale();
  const reduce = useReducedMotion();
  if (phase === "idle") return null;
  const failed = phase === "reply" && reply?.error;
  return (
    <Animated.View
      entering={reduce ? undefined : FadeInDown.springify().damping(18)}
      exiting={reduce ? undefined : FadeOutDown.duration(150)}
      accessibilityLiveRegion="polite"
      style={[styles.bubble, elevation(2), { bottom, borderRadius: radii.xl, padding: spacing.lg, gap: spacing.sm }]}
    >
      {phase === "listening" ? (
        <>
          <View style={styles.row}>
            <Icon name="mic" size={16} color={colors.danger.fg} />
            <Text variant="label" style={{ color: colors.danger.fg }}>
              {t("voice.listening")}
            </Text>
          </View>
          <Text variant="headline" numberOfLines={4}>
            {heard || "…"}
          </Text>
        </>
      ) : (
        <>
          {heard ? (
            <Text variant="callout" color="secondary" numberOfLines={2}>
              “{heard}”
            </Text>
          ) : null}
          <Text variant="bodyStrong" numberOfLines={5} style={failed ? { color: colors.danger.fg } : undefined}>
            {phase === "sending" ? t("voice.thinking") : failed ? (heard ? t("voice.failed") : t("voice.noSpeech")) : reply?.text}
          </Text>
          {phase === "reply" ? (
            <View style={[styles.row, { justifyContent: "flex-end", gap: spacing.sm }]}>
              <PressableScale onPress={onClose} accessibilityRole="button" style={styles.link}>
                <Text variant="label" color="secondary">
                  {t("voice.close")}
                </Text>
              </PressableScale>
              <PressableScale onPress={onOpenChat} accessibilityRole="button" style={[styles.link, { backgroundColor: colors.accentSoft, borderRadius: radii.pill }]}>
                <Text variant="label" color="accent">
                  {t("voice.openChat")}
                </Text>
              </PressableScale>
            </View>
          ) : null}
        </>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: "center", justifyContent: "center" },
  bubble: { position: "absolute", left: 16, right: 16 },
  row: { flexDirection: "row", alignItems: "center", gap: 6 },
  link: { minHeight: 40, paddingHorizontal: 14, justifyContent: "center" },
});
