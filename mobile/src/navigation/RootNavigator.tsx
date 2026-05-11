import { NavigationContainer, DefaultTheme, type Theme } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { useCallback, useEffect, useState } from "react";
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
import { BrandedBootLoader } from "../components/BrandedBootLoader";
import { GradientPrimaryButton } from "../components/GradientPrimaryButton";
import { LogoMark } from "../components/branding/LogoMark";
import { useAuth } from "../context/AuthContext";
import { colors, radii, shadow } from "../constants/theme";
import { api } from "../services/api";
import {
  isValidLanIpv4,
  loadSavedHostIps,
  saveHostIp,
} from "../services/apiResolver";
import { AuthStack } from "./AuthStack";
import { MainStack } from "./MainStack";

/** Explicit `fonts` avoids incomplete theme objects that break navigation internals on some setups. */
const theme: Theme = {
  dark: DefaultTheme.dark,
  fonts: DefaultTheme.fonts,
  colors: {
    ...DefaultTheme.colors,
    background: colors.bg,
    primary: colors.primary,
    card: colors.surface,
    border: colors.border,
    text: colors.text,
  },
};

const Stack = createNativeStackNavigator();

function SyncErrorScreen() {
  const { refreshProfile, firebaseUser } = useAuth();
  const [ipDraft, setIpDraft] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const [savedIps, setSavedIps] = useState<string[]>([]);

  const reloadSaved = useCallback(() => {
    void loadSavedHostIps().then(setSavedIps);
  }, []);

  useEffect(() => {
    reloadSaved();
  }, [reloadSaved]);

  const onRetry = () => {
    setHint(null);
    void refreshProfile();
  };

  const onSaveIpAndRetry = async () => {
    const t = ipDraft.trim();
    if (!isValidLanIpv4(t)) {
      setHint("Enter your Mac’s LAN IPv4, e.g. 192.168.1.12 (same network as this phone).");
      return;
    }
    setHint(null);
    await saveHostIp(t);
    setIpDraft("");
    reloadSaved();
    await refreshProfile();
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.bg }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.syncScroll}
        keyboardShouldPersistTaps="handled"
      >
        <LogoMark size={48} />
        <View style={styles.errorCard}>
          <Text style={styles.errorTitle}>Could not reach the server</Text>
          <Text style={styles.errorSub}>
            Signed in as {firebaseUser?.email ?? "user"}. The app tries your saved URL, .env address,
            Expo’s QR host IP, and any IPs you store below (same Wi‑Fi as your computer).
          </Text>

          <Text style={styles.endpointLabel}>Active API base</Text>
          <Text style={styles.endpointValue}>{api.defaults.baseURL}</Text>

          {savedIps.length > 0 ? (
            <View style={styles.savedBox}>
              <Text style={styles.savedTitle}>Saved IPs (tried automatically)</Text>
              <Text style={styles.savedList}>{savedIps.join(", ")}</Text>
            </View>
          ) : null}

          <Text style={styles.fieldLabel}>Add LAN IP of your dev machine</Text>
          <TextInput
            style={styles.ipInput}
            placeholder="e.g. 192.168.1.12"
            placeholderTextColor="#94a3b8"
            keyboardType="numbers-and-punctuation"
            autoCapitalize="none"
            autoCorrect={false}
            value={ipDraft}
            onChangeText={(v) => {
              setIpDraft(v);
              setHint(null);
            }}
          />
          {hint ? <Text style={styles.hint}>{hint}</Text> : null}

          <GradientPrimaryButton title="Save IP & retry" onPress={() => void onSaveIpAndRetry()} />

          <Pressable style={({ pressed }) => [styles.secondaryBtn, pressed && { opacity: 0.92 }]} onPress={onRetry}>
            <Text style={styles.secondaryBtnText}>Retry sync only</Text>
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

export function RootNavigator() {
  const { firebaseUser, dbUser, bootstrapping, authReady, apiEndpointsReady } = useAuth();

  if (!apiEndpointsReady || !authReady) {
    return (
      <View style={styles.centered}>
        <BrandedBootLoader
          message={!apiEndpointsReady ? "Finding API server…" : "Starting…"}
        />
      </View>
    );
  }

  return (
    <NavigationContainer theme={theme}>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        {!firebaseUser ? (
          <Stack.Screen name="Auth" component={AuthStack} />
        ) : bootstrapping ? (
          <Stack.Screen name="Boot">
            {() => (
              <View style={styles.centered}>
                <BrandedBootLoader message="Preparing your workspace…" />
              </View>
            )}
          </Stack.Screen>
        ) : !dbUser ? (
          <Stack.Screen name="SyncError" component={SyncErrorScreen} />
        ) : (
          <Stack.Screen name="App" component={MainStack} />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    backgroundColor: colors.bg,
  },
  syncScroll: {
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    paddingVertical: 40,
    backgroundColor: colors.bg,
  },
  errorCard: {
    width: "100%",
    maxWidth: 340,
    marginTop: 8,
    borderRadius: radii.xl,
    backgroundColor: colors.surface,
    paddingVertical: 28,
    paddingHorizontal: 24,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadow,
    gap: 14,
  },
  errorTitle: {
    fontSize: 20,
    fontWeight: "600",
    color: colors.text,
    textAlign: "center",
    lineHeight: 26,
  },
  errorSub: {
    fontSize: 14,
    lineHeight: 21,
    color: colors.textMuted,
    textAlign: "center",
  },
  endpointLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  endpointValue: {
    fontSize: 13,
    color: colors.primaryDark,
    fontWeight: "500",
  },
  savedBox: {
    backgroundColor: colors.surfaceSoft,
    borderRadius: radii.md,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.border,
  },
  savedTitle: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.textMuted,
    marginBottom: 4,
  },
  savedList: {
    fontSize: 13,
    color: colors.text,
    lineHeight: 18,
  },
  fieldLabel: {
    fontSize: 14,
    fontWeight: "500",
    color: colors.text,
    marginTop: 4,
  },
  ipInput: {
    height: 52,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingHorizontal: 16,
    fontSize: 16,
    backgroundColor: colors.surface,
    color: colors.text,
  },
  hint: {
    fontSize: 13,
    color: "#b45309",
    lineHeight: 18,
  },
  secondaryBtn: {
    height: 52,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
  },
  secondaryBtnText: {
    fontSize: 16,
    fontWeight: "600",
    color: colors.text,
  },
});
