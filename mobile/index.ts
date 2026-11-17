import * as SplashScreen from "expo-splash-screen";
import * as SystemUI from "expo-system-ui";
import { registerRootComponent } from "expo";

import App from "./App";
// Notification buttons answered without opening the app: the task must be defined at module scope, before the app.
import { registerNotificationActions } from "./src/services/notificationActions";

void SplashScreen.preventAutoHideAsync().catch(() => {});
void SystemUI.setBackgroundColorAsync("#F8FAFC").catch(() => {});

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerNotificationActions();
registerRootComponent(App);
