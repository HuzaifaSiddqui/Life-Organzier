import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { InlineTimePickerField } from "../../components/DueDateTimePickers";
import { Button, Card, Chip, ProgressBar, ui } from "../../components/ui";
import { colors, palette } from "../../constants/theme";
import { usePreferences } from "../../context/PreferencesContext";
import type { MainStackParamList } from "../../navigation/MainStack";
import { ensureNotificationPermissions, syncReminders } from "../../services/reminders";
import type { UserSettings } from "../../types/models";

type Props = NativeStackScreenProps<MainStackParamList, "Onboarding">;

const STEPS = 5;
const LANGS = [
  { key: "en", label: "English" },
  { key: "ur", label: "اردو Urdu" },
  { key: "ar", label: "العربية Arabic" },
];
const SUGGESTED_CONTEXTS = ["At Home", "At Work", "At University", "In Village", "Traveling"];

export function OnboardingScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const { settings, update } = usePreferences();
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Partial<UserSettings>>({});
  const [customContext, setCustomContext] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (settings) {
      setDraft({
        language: settings.language,
        quietStart: settings.quietStart,
        quietEnd: settings.quietEnd,
        workStart: settings.workStart,
        workEnd: settings.workEnd,
        dailyCapacityMinutes: settings.dailyCapacityMinutes,
        notificationFrequency: settings.notificationFrequency,
        contexts: settings.contexts,
      });
    }
  }, [settings]);

  const finish = async (patch: Partial<UserSettings> = {}) => {
    setSaving(true);
    await update({ ...draft, ...patch, onboardingCompleted: true });
    setSaving(false);
    void syncReminders();
    navigation.replace("Dashboard");
  };

  // Save progress after every step (FR-OB-001 §4).
  const next = async () => {
    setSaving(true);
    await update(draft);
    setSaving(false);
    setStep((s) => s + 1);
  };

  const set = (patch: Partial<UserSettings>) => setDraft((d) => ({ ...d, ...patch }));
  const contexts = draft.contexts ?? [];

  if (step === 0) {
    return (
      <View style={[ui.screen, styles.center, { paddingTop: insets.top + 24 }]}>
        
        <Text style={styles.title}>Meet your personal assistant</Text>
        <Text style={styles.text}>
          I plan around your energy, remember what matters to you, and check in when things get heavy. A quick setup (about 2 minutes) helps me fit your life from day one.
        </Text>
        <Button title="Set up now" kind="tonal" onPress={() => setStep(1)} style={{ alignSelf: "stretch" }} />
        <Button title="Start using — set up later" kind="ghost" onPress={() => void finish()} style={{ alignSelf: "stretch" }} />
      </View>
    );
  }

  return (
    <View style={[ui.screen, { paddingTop: insets.top + 8 }]}>
      <ScrollView contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.stepLabel}>Step {step} of {STEPS}</Text>
        <ProgressBar value={(step / STEPS) * 100} color={palette.ai} />

        {step === 1 ? (
          <Card style={{ gap: 12 }}>
            <Text style={ui.h2}>Which language should I use?</Text>
            <View style={ui.wrap}>
              {LANGS.map((l) => (
                <Chip key={l.key} label={l.label} selected={draft.language === l.key} onPress={() => set({ language: l.key })} />
              ))}
            </View>
            <Text style={styles.meta}>Your time zone is detected from this phone ({Intl.DateTimeFormat().resolvedOptions().timeZone}).</Text>
          </Card>
        ) : null}

        {step === 2 ? (
          <Card style={{ gap: 12 }}>
            <Text style={ui.h2}>When is your day?</Text>
            <Text style={ui.label}>I schedule work between</Text>
            <View style={styles.row}>
              <InlineTimePickerField value={draft.workStart ?? "8:00 AM"} onChange={(t) => set({ workStart: t })} style={{ flex: 1 }} />
              <Text style={styles.meta}>and</Text>
              <InlineTimePickerField value={draft.workEnd ?? "10:00 PM"} onChange={(t) => set({ workEnd: t })} style={{ flex: 1 }} />
            </View>
            <Text style={ui.label}>How many hours of tasks per day is comfortable?</Text>
            <View style={ui.wrap}>
              {[240, 360, 480, 600].map((m) => (
                <Chip key={m} small label={`${m / 60} h`} selected={draft.dailyCapacityMinutes === m} onPress={() => set({ dailyCapacityMinutes: m })} />
              ))}
            </View>
          </Card>
        ) : null}

        {step === 3 ? (
          <Card style={{ gap: 12 }}>
            <Text style={ui.h2}>Reminders</Text>
            <Text style={ui.label}>Quiet hours — no reminders between</Text>
            <View style={styles.row}>
              <InlineTimePickerField value={draft.quietStart ?? "10:00 PM"} onChange={(t) => set({ quietStart: t })} style={{ flex: 1 }} />
              <Text style={styles.meta}>and</Text>
              <InlineTimePickerField value={draft.quietEnd ?? "8:00 AM"} onChange={(t) => set({ quietEnd: t })} style={{ flex: 1 }} />
            </View>
            <Text style={ui.label}>How often should I remind you?</Text>
            <View style={ui.wrap}>
              {([["ADAPTIVE", "Smart (recommended)"], ["FREQUENT", "Frequently"], ["MINIMAL", "Only critical"]] as const).map(([k, l]) => (
                <Chip key={k} small label={l} selected={draft.notificationFrequency === k} onPress={() => set({ notificationFrequency: k })} />
              ))}
            </View>
            <Button title="Allow notifications" kind="secondary" onPress={() => void ensureNotificationPermissions()} />
          </Card>
        ) : null}

        {step === 4 ? (
          <Card style={{ gap: 12 }}>
            <Text style={ui.h2}>Where do you spend your time?</Text>
            <Text style={styles.meta}>Each place can have its own routines — e.g. meditation “At Home”, breakfast at the hostel “At University”.</Text>
            <View style={ui.wrap}>
              {[...new Set([...SUGGESTED_CONTEXTS, ...contexts])].map((c) => (
                <Chip key={c} label={c} selected={contexts.includes(c)} onPress={() => set({ contexts: contexts.includes(c) ? contexts.filter((x) => x !== c) : [...contexts, c] })} />
              ))}
            </View>
            <View style={styles.row}>
              <TextInput style={[ui.input, { flex: 1 }]} value={customContext} onChangeText={setCustomContext} placeholder="Add your own" placeholderTextColor="#646A78" />
              <Chip
                label="Add"
                onPress={() => {
                  const c = customContext.trim();
                  if (c && !contexts.includes(c)) set({ contexts: [...contexts, c] });
                  setCustomContext("");
                }}
              />
            </View>
          </Card>
        ) : null}

        {step === 5 ? (
          <Card tone="accent" style={{ gap: 10 }}>
            <Text style={ui.h2}>How to work with me</Text>
            <Text style={ui.body}>Just talk: “Complete math assignment by Friday 3 PM” — I'll ask if anything's missing.</Text>
            <Text style={ui.body}>Tap the mic to speak instead of typing.</Text>
            <Text style={ui.body}>Tell me what helps you — “music calms me when I'm stressed” — and I'll remember.</Text>
            <Text style={ui.body}>I learn your productive hours and plan hard work there.</Text>
            <Text style={ui.body}>Upload a syllabus and I'll add deadlines and classes.</Text>
          </Card>
        ) : null}

        <View style={styles.row}>
          <Button title="Back" kind="secondary" onPress={() => setStep((s) => Math.max(0, s - 1))} style={{ flex: 1 }} />
          {step < STEPS ? (
            <Button title="Next" kind="tonal" loading={saving} onPress={() => void next()} style={{ flex: 2 }} />
          ) : (
            <Button title="Let's go" kind="tonal" loading={saving} onPress={() => void finish()} style={{ flex: 2 }} />
          )}
        </View>
        <Button title="Skip setup" kind="ghost" onPress={() => void finish()} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: "center", justifyContent: "center", padding: 24, gap: 16 },
  title: { fontSize: 26, fontFamily: "Inter_700Bold", color: colors.text, textAlign: "center" },
  text: { fontFamily: "Inter_400Regular", fontSize: 15, color: colors.textMuted, textAlign: "center", lineHeight: 22 },
  stepLabel: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: palette.ai },
  meta: { fontFamily: "Inter_400Regular", fontSize: 12, color: colors.textMuted },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
});
