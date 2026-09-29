import { zodResolver } from "@hookform/resolvers/zod";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { createUserWithEmailAndPassword, sendEmailVerification } from "firebase/auth";
import { GradientPrimaryButton } from "../../components/GradientPrimaryButton";
import { colors, radii, shadow } from "../../constants/theme";
import { auth } from "../../lib/firebase";
import type { AuthStackParamList } from "../../navigation/AuthStack";
import { z } from "zod";

const schema = z
  .object({
    email: z.string().email("Enter a valid email"),
    password: z
      .string()
      .min(8, "Use at least 8 characters")
      .regex(/[A-Za-z]/, "Include letters")
      .regex(/[0-9]/, "Include numbers"),
    confirm: z.string().min(1, "Confirm your password"),
  })
  .refine((data) => data.password === data.confirm, {
    message: "Passwords do not match",
    path: ["confirm"],
  });

type FormValues = z.infer<typeof schema>;

type Props = NativeStackScreenProps<AuthStackParamList, "Signup">;

export function SignupScreen({ navigation }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { control, handleSubmit } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: "", password: "", confirm: "" },
  });

  const close = () => navigation.goBack();

  const onSubmit = handleSubmit(async (values) => {
    setBusy(true);
    setError(null);
    try {
      const cred = await createUserWithEmailAndPassword(auth, values.email.trim(), values.password);
      await sendEmailVerification(cred.user);
    } catch {
      setError("Could not create account. The email may already be in use.");
    } finally {
      setBusy(false);
    }
  });

  return (
    <View style={styles.root}>
      <Pressable style={styles.backdrop} onPress={close} accessibilityLabel="Dismiss" />

      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.keyboard}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.scrollContent}
          bounces={false}
        >
          <View style={styles.sheetWrap}>
            <View style={styles.card}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>Sign up</Text>
                <Pressable
                  onPress={close}
                  hitSlop={12}
                  accessibilityRole="button"
                  accessibilityLabel="Close"
                  style={({ pressed }) => [styles.closeBtn, pressed && { opacity: 0.7 }]}
                >
                  <Text style={styles.closeBtnText}>✕</Text>
                </Pressable>
              </View>

              <Controller
                control={control}
                name="email"
                render={({ field, fieldState }) => (
                  <View style={styles.field}>
                    <Text style={styles.label}>Email</Text>
                    <TextInput
                      value={field.value}
                      onChangeText={field.onChange}
                      onBlur={field.onBlur}
                      autoCapitalize="none"
                      keyboardType="email-address"
                      style={styles.input}
                      placeholder="you@example.com"
                      placeholderTextColor="#94a3b8"
                    />
                    {fieldState.error ? (
                      <Text style={styles.fieldError}>{fieldState.error.message}</Text>
                    ) : null}
                  </View>
                )}
              />
              <Controller
                control={control}
                name="password"
                render={({ field, fieldState }) => (
                  <View style={styles.field}>
                    <Text style={styles.label}>Password</Text>
                    <TextInput
                      value={field.value}
                      onChangeText={field.onChange}
                      onBlur={field.onBlur}
                      secureTextEntry
                      style={styles.input}
                      placeholder="At least 8 characters"
                      placeholderTextColor="#94a3b8"
                    />
                    {fieldState.error ? (
                      <Text style={styles.fieldError}>{fieldState.error.message}</Text>
                    ) : null}
                  </View>
                )}
              />
              <Controller
                control={control}
                name="confirm"
                render={({ field, fieldState }) => (
                  <View style={styles.field}>
                    <Text style={styles.label}>Confirm password</Text>
                    <TextInput
                      value={field.value}
                      onChangeText={field.onChange}
                      onBlur={field.onBlur}
                      secureTextEntry
                      style={styles.input}
                      placeholder="Repeat password"
                      placeholderTextColor="#94a3b8"
                    />
                    {fieldState.error ? (
                      <Text style={styles.fieldError}>{fieldState.error.message}</Text>
                    ) : null}
                  </View>
                )}
              />
              {error ? <Text style={styles.error}>{error}</Text> : null}
              <GradientPrimaryButton
                title="Create account"
                onPress={() => void onSubmit()}
                loading={busy}
                disabled={busy}
                style={{ marginTop: 8 }}
              />
              <Text style={styles.footer}>
                Already have an account?{" "}
                <Text style={styles.footerLink} onPress={() => navigation.replace("Login")}>
                  Log in
                </Text>
              </Text>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "transparent",
  },
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: "rgba(15, 23, 42, 0.52)",
  },
  keyboard: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 20,
    paddingVertical: 24,
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: "center",
    paddingVertical: 8,
  },
  sheetWrap: {
    width: "100%",
    maxWidth: 400,
    alignSelf: "center",
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.xl,
    padding: 24,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadow,
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 20,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: "600",
    color: colors.text,
  },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surfaceSoft,
  },
  closeBtnText: {
    fontSize: 18,
    color: colors.textMuted,
    fontWeight: "600",
  },
  field: {
    marginBottom: 16,
  },
  label: {
    fontSize: 14,
    fontWeight: "500",
    color: colors.text,
    marginBottom: 8,
  },
  input: {
    height: 56,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingHorizontal: 16,
    fontSize: 16,
    backgroundColor: colors.surface,
    color: colors.text,
  },
  fieldError: {
    color: "#b91c1c",
    marginTop: 6,
    fontSize: 13,
  },
  error: {
    color: "#b91c1c",
    textAlign: "center",
    marginBottom: 8,
  },
  footer: {
    textAlign: "center",
    marginTop: 16,
    fontSize: 14,
    color: colors.textMuted,
  },
  footerLink: {
    fontWeight: "600",
    color: colors.primary,
  },
});
