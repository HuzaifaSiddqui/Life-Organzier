import { NavigationContainer, DefaultTheme } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { ActivityIndicator, StyleSheet, Text, View, Pressable } from "react-native";
import { useAuth } from "../context/AuthContext";
import { colors, radii, shadow } from "../constants/theme";
import { AuthStack } from "./AuthStack";
import { MainStack } from "./MainStack";

const theme = {
  ...DefaultTheme,
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
  return (
    <View style={styles.centered}>
      <Text style={styles.title}>Could not reach the server</Text>
      <Text style={styles.sub}>
        Signed in as {firebaseUser?.email ?? "user"}. Check API URL, backend, and database, then
        retry.
      </Text>
      <Pressable style={styles.button} onPress={() => void refreshProfile()}>
        <Text style={styles.buttonText}>Retry sync</Text>
      </Pressable>
    </View>
  );
}

export function RootNavigator() {
  const { firebaseUser, dbUser, bootstrapping, authReady } = useAuth();

  if (!authReady) {
    return (
      <View style={styles.centered}>
        <View style={styles.loaderCard}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={styles.loadingText}>Starting…</Text>
        </View>
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
                <View style={styles.loaderCard}>
                  <ActivityIndicator size="large" color={colors.primary} />
                  <Text style={styles.loadingText}>Preparing your workspace…</Text>
                </View>
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
  loaderCard: {
    width: "100%",
    maxWidth: 340,
    borderRadius: radii.lg,
    backgroundColor: colors.surface,
    paddingVertical: 28,
    paddingHorizontal: 20,
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.border,
    ...shadow,
  },
  loadingText: {
    marginTop: 12,
    color: colors.textMuted,
    fontWeight: "500",
  },
  title: {
    fontSize: 20,
    fontWeight: "600",
    marginBottom: 8,
    color: colors.text,
    textAlign: "center",
  },
  sub: {
    fontSize: 15,
    color: colors.textMuted,
    textAlign: "center",
    marginBottom: 20,
  },
  button: {
    backgroundColor: colors.primary,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: radii.md,
    ...shadow,
  },
  buttonText: {
    color: "#fff",
    fontWeight: "600",
  },
});
