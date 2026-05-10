import { Text, TextInput } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AuthProvider } from "./src/context/AuthContext";
import { RootNavigator } from "./src/navigation/RootNavigator";

const TextAny = Text as unknown as { defaultProps?: { style?: unknown } };
TextAny.defaultProps = TextAny.defaultProps ?? {};
TextAny.defaultProps.style = [{ fontFamily: "Inter" }, TextAny.defaultProps.style];

const TextInputAny = TextInput as unknown as { defaultProps?: { style?: unknown } };
TextInputAny.defaultProps = TextInputAny.defaultProps ?? {};
TextInputAny.defaultProps.style = [{ fontFamily: "Inter" }, TextInputAny.defaultProps.style];

export default function App() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <RootNavigator />
      </AuthProvider>
    </SafeAreaProvider>
  );
}
