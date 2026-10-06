import { useEffect, useState } from "react";
import { Text, TextInput, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AnimatedSplashOverlay } from "./src/components/branding/AnimatedSplashOverlay";
import { AuthProvider } from "./src/context/AuthContext";
import { PreferencesProvider } from "./src/context/PreferencesContext";
import { RootNavigator } from "./src/navigation/RootNavigator";
import { configureReminders } from "./src/services/reminders";

const TextAny = Text as unknown as { defaultProps?: { style?: unknown } };
TextAny.defaultProps = TextAny.defaultProps ?? {};
TextAny.defaultProps.style = [{ fontFamily: "Inter" }, TextAny.defaultProps.style];

const TextInputAny = TextInput as unknown as { defaultProps?: { style?: unknown } };
TextInputAny.defaultProps = TextInputAny.defaultProps ?? {};
TextInputAny.defaultProps.style = [{ fontFamily: "Inter" }, TextInputAny.defaultProps.style];

export default function App() {
  const [splashFinished, setSplashFinished] = useState(false);

  useEffect(() => {
    void configureReminders();
  }, []);

  return (
    <View style={{ flex: 1, backgroundColor: "#F8FAFC" }}>
      <SafeAreaProvider style={{ flex: 1, backgroundColor: "#F8FAFC" }}>
        <AuthProvider>
          <PreferencesProvider>{splashFinished ? <RootNavigator /> : null}</PreferencesProvider>
        </AuthProvider>
      </SafeAreaProvider>
      {!splashFinished && (
        <AnimatedSplashOverlay onFinished={() => setSplashFinished(true)} />
      )}
    </View>
  );
}
