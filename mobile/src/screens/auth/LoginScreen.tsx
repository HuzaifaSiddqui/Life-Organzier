import { zodResolver } from "@hookform/resolvers/zod";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { signInWithEmailAndPassword } from "firebase/auth";
import { GradientPrimaryButton } from "../../components/GradientPrimaryButton";
import { colors, radii, shadow, palette } from "../../constants/theme";
import { auth } from "../../lib/firebase";
import type { AuthStackParamList } from "../../navigation/AuthStack";
import { z } from "zod";

const schema = z.object({
  email: z.string().email("Enter a valid email"),
  password: z.string().min(1, "Password is required"),
});

type FormValues = z.infer<typeof schema>;

type Props = NativeStackScreenProps<AuthStackParamList, "Login">;

export function LoginScreen({ navigation }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { control, handleSubmit } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: "", password: "" },
  });

  const close = () => navigation.goBack();

  const onSubmit = handleSubmit(async (values) => {
    setBusy(true);
    setError(null);
    try {
      await signInWithEmailAndPassword(auth, values.email.trim(), values.password);
    } catch {
      setError("Could not log in. Check your email and password.");
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
        <View style={styles.sheetWrap}>
          <View style={styles.card}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Log in</Text>
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
                    placeholderTextColor="#646A78"
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
                    placeholder="••••••••"
                    placeholderTextColor="#646A78"
                  />
                  {fieldState.error ? (
                    <Text style={styles.fieldError}>{fieldState.error.message}</Text>
                  ) : null}
                </View>
              )}
            />
            <View style={styles.forgotRow}>
              <Pressable onPress={() => navigation.navigate("ForgotPassword")}>
                <Text style={styles.forgot}>Forgot password?</Text>
              </Pressable>
            </View>
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <GradientPrimaryButton
              title="Log in"
              onPress={() => void onSubmit()}
              loading={busy}
              disabled={busy}
              style={{ marginTop: 8 }}
            />
            <Text style={styles.footer}>
              Need an account?{" "}
              <Text style={styles.footerLink} onPress={() => navigation.replace("Signup")}>
                Sign up
              </Text>
            </Text>
          </View>
        </View>
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
    backgroundColor: "rgba(15, 18, 24, 0.40)",
  },
  keyboard: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 20,
    paddingVertical: 24,
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
    fontFamily: "Inter_500Medium",
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
    fontFamily: "Inter_500Medium",
  },
  field: {
    marginBottom: 16,
  },
  label: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
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
    color: palette.danger,
    marginTop: 6,
    fontSize: 13,
  },
  forgotRow: {
    alignItems: "flex-end",
    marginBottom: 8,
  },
  forgot: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: colors.primary,
  },
  error: {
    color: palette.danger,
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
    fontFamily: "Inter_500Medium",
    color: colors.primary,
  },
});
