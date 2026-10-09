import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { EmailAuthProvider, reauthenticateWithCredential, updatePassword } from "firebase/auth";
import { useEffect, useState } from "react";
import { Alert, ScrollView, Share, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { InlineTimePickerField } from "../../components/DueDateTimePickers";
import { ScreenHeader } from "../../components/ScreenHeader";
import { Button, Card, Chip, SectionTitle, Snackbar, ui } from "../../components/ui";
import { colors, palette } from "../../constants/theme";
import { useAuth } from "../../context/AuthContext";
import { usePreferences } from "../../context/PreferencesContext";
import { useLocale } from "../../i18n/LocaleProvider";
import { auth } from "../../lib/firebase";
import type { MainStackParamList } from "../../navigation/MainStack";
import { getApiErrorMessage } from "../../services/api";
import {
  createCategory,
  deleteCategory,
  deleteTag,
  exportAllData,
  getAccount,
  getCategories,
  getTags,
  recoverAccount,
  requestAccountDeletion,
  savePhone,
  setDnd,
  updateProfile,
  type AccountInfo,
} from "../../services/settingsApi";
import { resetLocalData, syncNow } from "../../services/syncEngine";
import { syncReminders } from "../../services/reminders";
import type { UserSettings } from "../../types/models";

type Props = NativeStackScreenProps<MainStackParamList, "Settings">;

const LANGUAGES = [
  { key: "en", label: "English" },
  { key: "ur", label: "اردو Urdu" },
  { key: "ar", label: "العربية Arabic" },
  { key: "es", label: "Español" },
  { key: "fr", label: "Français" },
  { key: "zh", label: "中文" },
  { key: "hi", label: "हिन्दी" },
];
const COLORS = ["#2563EB", "#9333EA", "#16A34A", "#EA580C", "#CA8A04", "#DB2777", "#0891B2", "#475569"];

function to12h(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  if (!Number.isFinite(h)) return hhmm;
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m ?? 0).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

export function SettingsScreen({ navigation }: Props) {
  const { refreshProfile, firebaseUser } = useAuth();
  const { settings, update, categories, setCategories, phoneNumber, reload } = usePreferences();
  const { t } = useLocale();
  const [toast, setToast] = useState<string | null>(null);
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState(phoneNumber ?? "");
  const [newContext, setNewContext] = useState("");
  const [catName, setCatName] = useState("");
  const [catColor, setCatColor] = useState(COLORS[0]);
  const [tags, setTags] = useState<Array<{ tag: string; count: number }>>([]);
  const [pw, setPw] = useState({ current: "", next: "" });

  useEffect(() => {
    getAccount()
      .then((a) => {
        setAccount(a);
        setName(a.user.displayName ?? "");
      })
      .catch(() => undefined);
    getTags().then(setTags).catch(() => undefined);
  }, []);
  useEffect(() => setPhone(phoneNumber ?? ""), [phoneNumber]);

  if (!settings) {
    return (
      <View style={ui.screen}>
        <ScreenHeader title="Settings" onBack={() => navigation.goBack()} />
        <Text style={[styles.meta, { padding: 16 }]}>Settings will load when you're online.</Text>
      </View>
    );
  }

  const save = async (patch: Partial<UserSettings>, message = "Saved") => {
    const next = await update(patch);
    setToast(next ? message : "Couldn't save — are you online?");
  };

  const dndActive = settings.dndUntil && Date.parse(settings.dndUntil) > Date.now();

  return (
    <View style={ui.screen}>
      <ScreenHeader title="Settings" onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled">
        <SectionTitle title="Profile" />
        <Card style={{ gap: 10 }}>
          <Text style={ui.label}>Display name</Text>
          <View style={styles.row}>
            <TextInput style={[ui.input, { flex: 1 }]} value={name} onChangeText={setName} />
            <Chip
              label="Save"
              onPress={async () => {
                try {
                  await updateProfile(name);
                  await refreshProfile();
                  setToast("Profile updated");
                } catch (e) {
                  setToast(getApiErrorMessage(e));
                }
              }}
            />
          </View>
          <Text style={styles.meta}>{firebaseUser?.email}</Text>
        </Card>

        <SectionTitle title="Plan" />
        <Card style={{ gap: 8 }}>
          <View style={styles.row}>
            <Chip label="Free" selected={settings.tier === "FREE"} onPress={() => void save({ tier: "FREE" }, "Switched to Free")} />
            <Chip label="Pro" tone="accent" selected={settings.tier === "PRO"} onPress={() => void save({ tier: "PRO" }, "Pro enabled")} />
          </View>
          <Text style={styles.meta}>Pro adds deeper AI conversations for emotional support, WhatsApp reminders and analytics export. (Demo switch — payments are out of scope.)</Text>
        </Card>

        <SectionTitle title="Language & voice" />
        <Card style={{ gap: 10 }}>
          <View style={ui.wrap}>
            {LANGUAGES.map((l) => (
              <Chip key={l.key} small label={l.label} selected={settings.language === l.key} onPress={() => void save({ language: l.key }, "Language updated")} />
            ))}
          </View>
          <Text style={styles.meta}>Assistant replies, speech recognition and read-back follow this language. Time zone: {settings.timezone} (from your phone).</Text>
          <View style={styles.rowBetween}>
            <Text style={ui.body}>Read replies aloud</Text>
            <Switch value={settings.ttsEnabled} onValueChange={(ttsEnabled) => void save({ ttsEnabled })} />
          </View>
          <View style={ui.wrap}>
            {[0.75, 1, 1.25, 1.5].map((r) => (
              <Chip key={r} small label={`${r}× speed`} selected={settings.ttsRate === r} onPress={() => void save({ ttsRate: r })} />
            ))}
          </View>
        </Card>

        <SectionTitle title="Your day" />
        <Card style={{ gap: 10 }}>
          <Text style={ui.label}>Quiet hours (no reminders)</Text>
          <View style={styles.row}>
            <InlineTimePickerField value={to12h(settings.quietStart)} onChange={(t) => void save({ quietStart: t })} style={{ flex: 1 }} />
            <Text style={styles.meta}>to</Text>
            <InlineTimePickerField value={to12h(settings.quietEnd)} onChange={(t) => void save({ quietEnd: t })} style={{ flex: 1 }} />
          </View>
          <Text style={ui.label}>Active hours (when I may schedule work)</Text>
          <View style={styles.row}>
            <InlineTimePickerField value={to12h(settings.workStart)} onChange={(t) => void save({ workStart: t })} style={{ flex: 1 }} />
            <Text style={styles.meta}>to</Text>
            <InlineTimePickerField value={to12h(settings.workEnd)} onChange={(t) => void save({ workEnd: t })} style={{ flex: 1 }} />
          </View>
          <Text style={ui.label}>Daily capacity · {settings.dailyCapacityMinutes / 60} h</Text>
          <View style={ui.wrap}>
            {[240, 360, 480, 600, 720].map((m) => (
              <Chip key={m} small label={`${m / 60} h`} selected={settings.dailyCapacityMinutes === m} onPress={() => void save({ dailyCapacityMinutes: m })} />
            ))}
          </View>
        </Card>

        <SectionTitle title="Notifications" />
        <Card style={{ gap: 10 }}>
          <Text style={ui.label}>How often</Text>
          <View style={ui.wrap}>
            {(["ADAPTIVE", "FREQUENT", "MINIMAL", "NONE"] as const).map((f) => (
              <Chip key={f} small label={f.toLowerCase()} selected={settings.notificationFrequency === f} onPress={() => void save({ notificationFrequency: f })} />
            ))}
          </View>
          <Text style={ui.label}>Method</Text>
          <View style={ui.wrap}>
            {([["SOUND_VIBRATION", "Sound + vibration"], ["SOUND", "Sound only"], ["VIBRATION", "Vibration"], ["APP", "Silent"]] as const).map(([k, l]) => (
              <Chip key={k} small label={l} selected={settings.notificationMethod === k} onPress={() => void save({ notificationMethod: k })} />
            ))}
          </View>
          <Text style={ui.label}>Devices</Text>
          <View style={ui.wrap}>
            {([["ALL", "All devices"], ["PHONE", "Phone only"], ["DESKTOP", "Desktop only"], ["WHATSAPP", "WhatsApp only (Pro)"]] as const).map(([k, l]) => (
              <Chip key={k} small label={l} selected={settings.notificationDevices === k} onPress={() => void save({ notificationDevices: k })} />
            ))}
          </View>
          <Text style={ui.label}>Do not disturb {dndActive ? `· on until ${new Date(settings.dndUntil as string).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}</Text>
          <View style={ui.wrap}>
            {[
              ["2 hours", 120],
              ["4 hours", 240],
              ["Until tomorrow", Math.max(60, Math.round((new Date(new Date().setHours(32, 0, 0, 0)).getTime() - Date.now()) / 60000))],
              ["Off", 0],
            ].map(([l, m]) => (
              <Chip
                key={String(l)}
                small
                label={String(l)}
                onPress={async () => {
                  try {
                    await setDnd(Number(m));
                    await reload();
                    setToast(Number(m) ? "Do Not Disturb on" : "Do Not Disturb off");
                  } catch (e) {
                    setToast(getApiErrorMessage(e));
                  }
                }}
              />
            ))}
          </View>
          <View style={styles.rowBetween}>
            <Text style={[ui.body, { flex: 1 }]}>Critical reminders break through DND</Text>
            <Switch value={settings.criticalOverridesDnd} onValueChange={(criticalOverridesDnd) => void save({ criticalOverridesDnd })} />
          </View>
          <View style={styles.rowBetween}>
            <Text style={[ui.body, { flex: 1 }]}>{t("settings.checkins")}</Text>
            <Switch
              value={settings.checkinsEnabled}
              onValueChange={(checkinsEnabled) => {
                void save({ checkinsEnabled });
                void syncReminders();
              }}
              accessibilityLabel={t("settings.checkins")}
            />
          </View>
          <Text style={ui.meta}>{t("settings.checkinsHint")}</Text>
          {settings.checkinsEnabled ? (
            <>
              <Text style={ui.label}>{t("settings.checkinStyle")}</Text>
              <View style={ui.wrap}>
                {(["FUNNY", "SERIOUS", "GENTLE"] as const).map((tone) => (
                  <Chip
                    key={tone}
                    small
                    label={t(tone === "FUNNY" ? "settings.styleFunny" : tone === "SERIOUS" ? "settings.styleSerious" : "settings.styleGentle")}
                    selected={settings.checkinTone === tone}
                    onPress={() => {
                      void save({ checkinTone: tone });
                      void syncReminders();
                    }}
                  />
                ))}
              </View>
            </>
          ) : null}
          {__DEV__ ? (
            <View style={styles.rowBetween}>
              <Text style={[ui.meta, { flex: 1 }]}>{t("settings.researchMode")}</Text>
              <Switch value={settings.checkinResearchMode} onValueChange={(checkinResearchMode) => void save({ checkinResearchMode })} />
            </View>
          ) : null}
          <Button
            title="Refresh reminders now"
            kind="secondary"
            onPress={async () => {
              const n = await syncReminders();
              setToast(n === null ? "Offline — existing reminders kept" : `${n} reminders scheduled on this phone`);
            }}
          />
        </Card>

        <SectionTitle title="Contexts" />
        <Card style={{ gap: 10 }}>
          <Text style={styles.meta}>Places with their own routines and tasks. The current one filters what you see.</Text>
          <View style={ui.wrap}>
            {settings.contexts.map((c) => (
              <Chip
                key={c}
                small
                label={`${c}${settings.currentContext === c ? " (current)" : ""} ✕`}
                selected={settings.currentContext === c}
                onPress={() => void save({ contexts: settings.contexts.filter((x) => x !== c), currentContext: settings.currentContext === c ? null : settings.currentContext })}
              />
            ))}
          </View>
          <View style={styles.row}>
            <TextInput style={[ui.input, { flex: 1 }]} value={newContext} onChangeText={setNewContext} placeholder="e.g. In Village" placeholderTextColor="#646A78" />
            <Chip
              label="Add"
              onPress={() => {
                const c = newContext.trim();
                if (!c || settings.contexts.includes(c)) return;
                setNewContext("");
                void save({ contexts: [...settings.contexts, c] });
              }}
            />
          </View>
        </Card>

        <SectionTitle title="Categories" />
        <Card style={{ gap: 10 }}>
          <View style={ui.wrap}>
            {categories.map((c) => (
              <Chip
                key={c.id}
                small
                label={`${c.name}${c.predefined ? "" : " ✕"}`}
                onPress={
                  c.predefined
                    ? undefined
                    : async () => {
                        await deleteCategory(c.id).catch(() => undefined);
                        setCategories(await getCategories());
                      }
                }
              />
            ))}
          </View>
          <View style={styles.row}>
            <TextInput style={[ui.input, { flex: 1 }]} value={catName} onChangeText={setCatName} placeholder="New category, e.g. Traveling" placeholderTextColor="#646A78" />
            <Chip
              label="Add"
              onPress={async () => {
                const n = catName.trim();
                if (!n) return;
                try {
                  await createCategory(n, catColor);
                  setCatName("");
                  setCategories(await getCategories());
                } catch (e) {
                  setToast(getApiErrorMessage(e));
                }
              }}
            />
          </View>
          <View style={styles.row}>
            {COLORS.map((c) => (
              <Text key={c} onPress={() => setCatColor(c)} style={[styles.swatch, { backgroundColor: c }, catColor === c && styles.swatchOn]} />
            ))}
          </View>
        </Card>

        <SectionTitle title="Tags" />
        <Card style={{ gap: 8 }}>
          {tags.length ? (
            <View style={ui.wrap}>
              {tags.map((t) => (
                <Chip
                  key={t.tag}
                  small
                  label={`#${t.tag} (${t.count}) ✕`}
                  onPress={async () => {
                    await deleteTag(t.tag).catch(() => undefined);
                    setTags(await getTags());
                    void syncNow();
                  }}
                />
              ))}
            </View>
          ) : (
            <Text style={styles.meta}>No tags yet.</Text>
          )}
        </Card>

        <SectionTitle title="WhatsApp" />
        <Card style={{ gap: 8 }}>
          <Text style={styles.meta}>Link your number to chat with the assistant on WhatsApp. Pro users also get reminders there while the 24-hour window is open.</Text>
          <View style={styles.row}>
            <TextInput style={[ui.input, { flex: 1 }]} value={phone} onChangeText={setPhone} placeholder="+923001234567" placeholderTextColor="#646A78" keyboardType="phone-pad" />
            <Chip
              label="Save"
              onPress={async () => {
                try {
                  await savePhone(phone.trim() || null);
                  await reload();
                  setToast("WhatsApp number saved");
                } catch (e) {
                  setToast(getApiErrorMessage(e));
                }
              }}
            />
          </View>
        </Card>

        <SectionTitle title="Help & tutorials" />
        <Card style={{ gap: 8 }}>
          <View style={styles.rowBetween}>
            <Text style={ui.body}>Show feature tips</Text>
            <Switch value={settings.tutorialsEnabled} onValueChange={(tutorialsEnabled) => void save({ tutorialsEnabled })} />
          </View>
          <Button title="Show all tips again" kind="secondary" onPress={() => void save({ tutorialsSeen: [], tutorialsEnabled: true }, "Tips re-enabled")} />
          <Button title="Run setup again" kind="secondary" onPress={() => navigation.navigate("Onboarding")} />
        </Card>

        <SectionTitle title="Data & account" />
        <Card style={{ gap: 10 }}>
          <Button
            title="Export my data (CSV)"
            kind="secondary"
            onPress={async () => {
              try {
                const { csv, filename } = await exportAllData();
                await Share.share({ title: filename, message: csv });
              } catch (e) {
                setToast(getApiErrorMessage(e));
              }
            }}
          />
          <Button
            title="Re-sync from cloud"
            kind="secondary"
            onPress={() =>
              Alert.alert("Re-sync from cloud?", "Replaces the data cached on this phone with the cloud copy. Unsynced changes are kept in the queue.", [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Re-sync",
                  onPress: async () => {
                    await resetLocalData();
                    const ok = await syncNow();
                    setToast(ok ? "Synced from cloud" : "Couldn't reach the server");
                  },
                },
              ])
            }
          />
          <Text style={ui.label}>Change password</Text>
          <TextInput style={ui.input} value={pw.current} onChangeText={(current) => setPw({ ...pw, current })} placeholder="Current password" placeholderTextColor="#646A78" secureTextEntry />
          <TextInput style={ui.input} value={pw.next} onChangeText={(next) => setPw({ ...pw, next })} placeholder="New password (8+ characters)" placeholderTextColor="#646A78" secureTextEntry />
          <Button
            title="Update password"
            kind="secondary"
            onPress={async () => {
              const user = auth.currentUser;
              if (!user?.email || pw.next.length < 8) {
                setToast("New password must be at least 8 characters");
                return;
              }
              try {
                await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, pw.current));
                await updatePassword(user, pw.next);
                setPw({ current: "", next: "" });
                setToast("Password updated");
              } catch {
                setToast("Couldn't update password — check your current password.");
              }
            }}
          />
          {account?.deletion ? (
            <Card tone="danger" style={{ gap: 8 }}>
              <Text style={ui.body}>Your account is scheduled for deletion on {new Date(account.deletion.permanentAt).toLocaleDateString()}.</Text>
              <Button
                title="Keep my account"
                onPress={async () => {
                  await recoverAccount();
                  setAccount(await getAccount());
                  setToast("Account recovered");
                }}
              />
            </Card>
          ) : (
            <Button
              title="Delete my account"
              kind="danger"
              onPress={() =>
                Alert.alert("Delete account?", "Your account will be deleted in 30 days. Sign in before then and tap “Keep my account” to recover it.", [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Delete",
                    style: "destructive",
                    onPress: async () => {
                      try {
                        await requestAccountDeletion();
                        setAccount(await getAccount());
                      } catch (e) {
                        setToast(getApiErrorMessage(e));
                      }
                    },
                  },
                ])
              }
            />
          )}
          <Text style={styles.meta}>Privacy: your data is stored in your Life Organizer database and the AI runs on your own server — nothing is sold or shared.</Text>
        </Card>
      </ScrollView>
      <Snackbar text={toast} onHide={() => setToast(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  meta: { fontFamily: "Inter_400Regular", fontSize: 12, color: colors.textMuted, lineHeight: 17 },
  swatch: { width: 26, height: 26, borderRadius: 13 },
  swatchOn: { borderWidth: 3, borderColor: palette.ink },
});
