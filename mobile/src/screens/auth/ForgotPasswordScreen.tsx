import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { sendPasswordResetEmail } from "firebase/auth";
import { colors, radii, shadow } from "../../constants/theme";
import { auth } from "../../lib/firebase";
import { z } from "zod";

const schema = z.object({
  email: z.string().email("Enter a valid email"),
});

type FormValues = z.infer<typeof schema>;

export function ForgotPasswordScreen() {
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { control, handleSubmit } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: "" },
  });

  const onSubmit = handleSubmit(async (values) => {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      await sendPasswordResetEmail(auth, values.email.trim());
      setInfo("If an account exists for this email, a reset link has been sent.");
    } catch {
      setError("Could not send reset email. Try again later.");
    } finally {
      setBusy(false);
    }
  });

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Reset password</Text>
      <Text style={styles.help}>Enter your email and we will send a secure reset link.</Text>
      <View style={styles.card}>
      <Controller
        control={control}
        name="email"
        render={({ field, fieldState }) => (
          <View style={styles.field}>
            <Text style={styles.label}>Email</Text>
            <TextInput
              {...field}
              onChangeText={field.onChange}
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
      {info ? <Text style={styles.info}>{info}</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Pressable style={styles.button} onPress={() => void onSubmit()} disabled={busy}>
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Send link</Text>}
      </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 20,
    backgroundColor: colors.bg,
    gap: 12,
  },
  title: {
    marginTop: 8,
    fontSize: 28,
    color: colors.text,
    fontWeight: "700",
  },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    padding: 16,
    ...shadow,
  },
  help: {
    color: colors.textMuted,
    fontSize: 14,
    marginBottom: 8,
  },
  field: {
    marginBottom: 4,
  },
  label: {
    fontSize: 14,
    color: colors.textMuted,
    marginBottom: 6,
    fontWeight: "500",
  },
  input: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  fieldError: {
    color: "#b91c1c",
    marginTop: 4,
    fontSize: 13,
  },
  info: {
    color: colors.success,
  },
  error: {
    color: colors.danger,
  },
  button: {
    backgroundColor: colors.primary,
    paddingVertical: 14,
    borderRadius: radii.md,
    alignItems: "center",
    marginTop: 8,
  },
  buttonText: {
    color: "#fff",
    fontWeight: "600",
    fontSize: 16,
  },
});
