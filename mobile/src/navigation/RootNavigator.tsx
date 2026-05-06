import { NavigationContainer, DefaultTheme } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { ActivityIndicator, StyleSheet, Text, View, Pressable } from "react-native";
import { useAuth } from "../context/AuthContext";
import { AuthStack } from "./AuthStack";
import { MainStack } from "./MainStack";

const theme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    background: "#f7f8fb",
    primary: "#2563eb",
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
        <ActivityIndicator size="large" />
        <Text style={styles.loadingText}>Starting…</Text>
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
                <ActivityIndicator size="large" />
                <Text style={styles.loadingText}>Preparing your workspace…</Text>
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
    backgroundColor: "#f7f8fb",
  },
  loadingText: {
    marginTop: 12,
    color: "#475569",
  },
  title: {
    fontSize: 20,
    fontWeight: "600",
    marginBottom: 8,
    color: "#0f172a",
    textAlign: "center",
  },
  sub: {
    fontSize: 15,
    color: "#475569",
    textAlign: "center",
    marginBottom: 20,
  },
  button: {
    backgroundColor: "#2563eb",
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 10,
  },
  buttonText: {
    color: "#fff",
    fontWeight: "600",
  },
});
