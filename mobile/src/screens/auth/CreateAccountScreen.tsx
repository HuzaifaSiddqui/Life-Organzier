import { zodResolver } from "@hookform/resolvers/zod";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { ScrollView, StyleSheet, TextInput, View } from "react-native";
import { z } from "zod";
import { ScreenHeader } from "../../components/ScreenHeader";
import { Icon } from "../../components/icons/Icon";
import { Button, Card, PressableScale, Text } from "../../components/ui";
import { useAuth } from "../../context/AuthContext";
import { useLocale } from "../../i18n/LocaleProvider";
import type { StringKey } from "../../i18n/strings";
import type { MainStackParamList } from "../../navigation/MainStack";
import { createAccountFromGuest } from "../../services/guest";
import { useTheme } from "../../theme/ThemeProvider";

const schema = z.object({
  name: z.string().max(60),
  email: z.string().email("guest.err.email"),
  password: z.string().min(8, "guest.err.password").regex(/[A-Za-z]/, "guest.err.password").regex(/[0-9]/, "guest.err.password"),
});
type FormValues = z.infer<typeof schema>;

type Props = NativeStackScreenProps<MainStackParamList, "CreateAccount">;

/**
 * Guest mode (FR-OB-003 §3): a guest creates an account. "Keep my data" links the email to the same account, so
 * everything stays; "Start fresh" deletes the guest data first. Either way the next step is email verification.
 */
export function CreateAccountScreen({ navigation }: Props) {
  const { t } = useLocale();
  const { colors, spacing, radii, type } = useTheme();
  const { firebaseUser, refreshAuthUser } = useAuth();
  const [keepData, setKeepData] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { control, handleSubmit, formState } = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { name: "", email: "", password: "" } });

  const onSubmit = handleSubmit(async (values) => {
    setBusy(true);
    setError(null);
    try {
      await createAccountFromGuest({ ...values, keepData });
      // The app moves on to "verify your email" (same screen as a normal sign-up).
      refreshAuthUser();
    } catch (e) {
      const code = (e as { code?: string }).code ?? "";
      setError(t(code.includes("email-already-in-use") || code.includes("credential-already-in-use") ? "guest.err.taken" : "guest.err.failed"));
    } finally {
      setBusy(false);
    }
  });

  if (!firebaseUser?.isAnonymous) {
    return (
      <View style={[styles.root, { backgroundColor: colors.canvas }]}>
        <ScreenHeader title={t("guest.createAccount")} onBack={() => navigation.goBack()} />
      </View>
    );
  }

  const input = [styles.input, type.body, { color: colors.text, borderColor: colors.hairline, borderRadius: radii.md, paddingHorizontal: spacing.md }];
  const fieldError = (key: keyof FormValues) => {
    const msg = formState.errors[key]?.message;
    return msg ? (
      <Text variant="caption" color="danger">
        {t(msg as StringKey)}
      </Text>
    ) : null;
  };
  const choice = (keep: boolean, title: StringKey, body: StringKey) => (
    <PressableScale
      onPress={() => setKeepData(keep)}
      accessibilityRole="radio"
      accessibilityState={{ checked: keepData === keep }}
      style={[styles.choice, { borderColor: keepData === keep ? colors.accent : colors.hairline, borderRadius: radii.md, padding: spacing.md, gap: spacing.xs }]}
    >
      <View style={styles.row}>
        <Icon name={keepData === keep ? "check" : "close"} size={16} color={keepData === keep ? colors.accent : colors.textTertiary} />
        <Text variant="bodyStrong" style={styles.flex}>
          {t(title)}
        </Text>
      </View>
      <Text variant="caption" color="secondary">
        {t(body)}
      </Text>
    </PressableScale>
  );

  return (
    <View style={[styles.root, { backgroundColor: colors.canvas }]}>
      <ScreenHeader title={t("guest.createAccount")} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }} keyboardShouldPersistTaps="handled">
        <Text variant="body" color="secondary">
          {t("guest.create.intro")}
        </Text>
        <Card style={{ gap: spacing.sm }}>
          <Text variant="callout">{t("guest.create.name")}</Text>
          <Controller control={control} name="name" render={({ field }) => <TextInput value={field.value} onChangeText={field.onChange} autoComplete="name" style={input} accessibilityLabel={t("guest.create.name")} />} />
          <Text variant="callout">{t("guest.create.email")}</Text>
          <Controller
            control={control}
            name="email"
            render={({ field }) => <TextInput value={field.value} onChangeText={field.onChange} autoCapitalize="none" keyboardType="email-address" autoComplete="email" style={input} accessibilityLabel={t("guest.create.email")} />}
          />
          {fieldError("email")}
          <Text variant="callout">{t("guest.create.password")}</Text>
          <Controller
            control={control}
            name="password"
            render={({ field }) => <TextInput value={field.value} onChangeText={field.onChange} secureTextEntry autoComplete="new-password" style={input} accessibilityLabel={t("guest.create.password")} />}
          />
          {fieldError("password")}
        </Card>
        <View style={{ gap: spacing.sm }} accessibilityRole="radiogroup">
          {choice(true, "guest.create.keep", "guest.create.keepBody")}
          {choice(false, "guest.create.fresh", "guest.create.freshBody")}
        </View>
        {error ? (
          <Text variant="callout" color="danger">
            {error}
          </Text>
        ) : null}
        <Button title={t("guest.createAccount")} loading={busy} onPress={() => void onSubmit()} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  input: { minHeight: 48, borderWidth: 1 },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  flex: { flex: 1 },
  choice: { borderWidth: 1.5 },
});
