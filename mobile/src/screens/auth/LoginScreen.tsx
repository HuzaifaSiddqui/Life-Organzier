import { zodResolver } from "@hookform/resolvers/zod";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
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
import { signInWithEmailAndPassword } from "firebase/auth";
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
    <View style={styles.container}>
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
              {...field}
              onChangeText={field.onChange}
              secureTextEntry
              style={styles.input}
              placeholder="••••••••"
            />
            {fieldState.error ? (
              <Text style={styles.fieldError}>{fieldState.error.message}</Text>
            ) : null}
          </View>
        )}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Pressable style={styles.button} onPress={() => void onSubmit()} disabled={busy}>
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Log in</Text>}
      </Pressable>
      <Pressable onPress={() => navigation.navigate("ForgotPassword")}>
        <Text style={styles.link}>Forgot password?</Text>
      </Pressable>
      <Pressable onPress={() => navigation.navigate("Signup")}>
        <Text style={[styles.link, { marginTop: 8 }]}>Need an account? Sign up</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 20,
    backgroundColor: "#f7f8fb",
    gap: 12,
  },
  field: {
    marginBottom: 4,
  },
  label: {
    fontSize: 14,
    color: "#334155",
    marginBottom: 6,
    fontWeight: "500",
  },
  input: {
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#e2e8f0",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  fieldError: {
    color: "#b91c1c",
    marginTop: 4,
    fontSize: 13,
  },
  error: {
    color: "#b91c1c",
    textAlign: "center",
  },
  button: {
    backgroundColor: "#2563eb",
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
    marginTop: 8,
  },
  buttonText: {
    color: "#fff",
    fontWeight: "600",
    fontSize: 16,
  },
  link: {
    marginTop: 16,
    textAlign: "center",
    color: "#2563eb",
    fontWeight: "500",
  },
});
