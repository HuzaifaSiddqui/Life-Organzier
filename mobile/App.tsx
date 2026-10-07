import { Inter_400Regular } from "@expo-google-fonts/inter/400Regular";
import { Inter_500Medium } from "@expo-google-fonts/inter/500Medium";
import { Inter_600SemiBold } from "@expo-google-fonts/inter/600SemiBold";
import { Inter_700Bold } from "@expo-google-fonts/inter/700Bold";
import { NotoNastaliqUrdu_400Regular } from "@expo-google-fonts/noto-nastaliq-urdu/400Regular";
import { NotoNastaliqUrdu_700Bold } from "@expo-google-fonts/noto-nastaliq-urdu/700Bold";
import { useFonts } from "expo-font";
import { useEffect, useState } from "react";
import { StyleSheet } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AnimatedSplashOverlay } from "./src/components/branding/AnimatedSplashOverlay";
import { AuthProvider } from "./src/context/AuthContext";
import { PreferencesProvider } from "./src/context/PreferencesContext";
import { LocaleProvider } from "./src/i18n/LocaleProvider";
import { RootNavigator } from "./src/navigation/RootNavigator";
import { configureReminders } from "./src/services/reminders";
import { ThemeProvider, useTheme } from "./src/theme/ThemeProvider";

// Only the weights in theme/tokens `fonts` — importing the package root would bundle every weight.
const FONTS = {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  NotoNastaliqUrdu_400Regular,
  NotoNastaliqUrdu_700Bold,
};

function Shell() {
  const { colors } = useTheme();
  const [fontsLoaded, fontError] = useFonts(FONTS);
  const [splashFinished, setSplashFinished] = useState(false);
  // A font failure falls back to system fonts rather than blocking the app.
  const ready = splashFinished && (fontsLoaded || !!fontError);

  return (
    <GestureHandlerRootView style={[styles.flex, { backgroundColor: colors.canvas }]}>
      <SafeAreaProvider style={[styles.flex, { backgroundColor: colors.canvas }]}>
        <AuthProvider>
          <PreferencesProvider>
            <LocaleProvider>{ready ? <RootNavigator /> : null}</LocaleProvider>
          </PreferencesProvider>
        </AuthProvider>
      </SafeAreaProvider>
      {!splashFinished && <AnimatedSplashOverlay onFinished={() => setSplashFinished(true)} />}
    </GestureHandlerRootView>
  );
}

export default function App() {
  useEffect(() => {
    void configureReminders();
  }, []);

  return (
    <ThemeProvider>
      <Shell />
    </ThemeProvider>
  );
}

const styles = StyleSheet.create({ flex: { flex: 1 } });
