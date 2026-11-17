import { useLegacy, useLegacyStyles, type Legacy } from "../theme/legacy";
import { DocumentReviewScreen } from "../screens/documents/DocumentReviewScreen";
import { CreateAccountScreen } from "../screens/auth/CreateAccountScreen";
import { StyleSheet, View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { Sidebar } from "../components/Sidebar";
import { layout, motion } from "../theme/tokens";
import { useLayout } from "../theme/useLayout";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import type { NavigatorScreenParams } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { TabBar } from "../components/TabBar";
import { PlanScreen } from "../screens/plan/PlanScreen";
import { colors } from "../constants/theme";
import { AssistantScreen } from "../screens/assistant/AssistantScreen";
import { CollabScreen } from "../screens/collab/CollabScreen";
import { SharedTaskEditScreen } from "../screens/collab/SharedTaskEditScreen";
import { DashboardScreen } from "../screens/dashboard/DashboardScreen";
import { DocumentsScreen } from "../screens/documents/DocumentsScreen";
import { InsightsScreen } from "../screens/insights/InsightsScreen";
import { MemoryScreen } from "../screens/insights/MemoryScreen";
import { MoodScreen } from "../screens/mood/MoodScreen";
import { OnboardingScreen } from "../screens/onboarding/OnboardingScreen";
import { ProfileScreen } from "../screens/profile/ProfileScreen";
import { SettingsScreen } from "../screens/profile/SettingsScreen";
import { RoutineScreen } from "../screens/routines/RoutineScreen";
import { AddTaskScreen } from "../screens/tasks/AddTaskScreen";
import { EditTaskScreen } from "../screens/tasks/EditTaskScreen";
import { NotificationsScreen } from "../screens/collab/NotificationsScreen";
import { SavedPlacesScreen } from "../screens/places/SavedPlacesScreen";
import { TaskDetailScreen } from "../screens/tasks/TaskDetailScreen";
import { TaskListScreen } from "../screens/tasks/TaskListScreen";
import { CatchUpScreen } from "../screens/tasks/CatchUpScreen";
import type { ActionPayload, Priority, TaskType } from "../types/models";

export type TaskFormPrefill = {
  title?: string;
  dueYmd?: string | null;
  dueTime?: string | null;
  durationMinutes?: number | null;
  priority?: Priority;
  category?: string | null;
  taskType?: TaskType;
  tags?: string[];
};

/**
 * UI v3 tabs (docs/design.md "Navigation"): Today, Plan, (assistant button), Tasks, Me. Tasks is a tab because Plan
 * only shows dated items; Insights (a weekly look-back) lives in Me.
 */
export type TabParamList = {
  Dashboard: undefined;
  Plan: undefined;
  TaskList: MainStackParamList["TaskList"];
  Profile: undefined;
};

export const TAB_ROUTES: ReadonlyArray<keyof TabParamList> = ["Dashboard", "Plan", "TaskList", "Profile"];

export type MainStackParamList = {
  /** The tab screens. Their names are also listed below so screens can still be typed by name. */
  Tabs: NavigatorScreenParams<TabParamList> | undefined;
  Dashboard: undefined;
  Plan: undefined;
  /** attach: open the file picker (send a document in chat). */
  Assistant: { voice?: boolean; prefill?: string; autoSend?: boolean; payload?: ActionPayload; label?: string; nonce?: number; attach?: boolean } | undefined;
  TaskList: { toast?: string; toastTone?: "success" | "warning"; /** A share just made from the task form: the toast offers Undo. */ undoShare?: { id: string; taskId: string | null }; filter?: "overdue" | "today" | "tomorrow"; /** Only these tasks (e.g. from a location reminder). */ ids?: string[] } | undefined;
  TaskDetail: { taskId: string };
  AddTask: { prefill?: TaskFormPrefill } | undefined;
  EditTask: { taskId: string };
  /** routineId: open that routine (e.g. tapped in chat). */
  Routines: { routineId?: string } | undefined;
  Insights: undefined;
  Memory: undefined;
  Mood: undefined;
  Documents: undefined;
  /** No section: the hub; a section: that group of settings on its own page. */
  Settings: { section?: "account" | "reminders" | "connected" | "day" | "labels" | "language" } | undefined;
  SavedPlaces: undefined;
  Onboarding: undefined;
  Profile: undefined;
  /** Task collaboration (COLLAB_TASKS): requests, people, shared tasks. */
  Collab: { tab?: "requests" | "people" | "shared" } | undefined;
  /** edit: the owner changes a shared task; accept: a member accepts it for their own date/time. */
  SharedTaskEdit: { id: string; mode: "edit" | "accept" | "decline" };
  Notifications: undefined;
  /** Guest mode (FR-OB-003): a guest creates an account (keep the data or start fresh). */
  CreateAccount: undefined;
  /** The review of one document's reading (from its chat card or My documents). */
  DocumentReview: { documentId: string };
  /** UI v3: sort overdue tasks one by one. */
  CatchUp: undefined;
};

const Stack = createNativeStackNavigator<MainStackParamList>();
const Tab = createBottomTabNavigator<TabParamList>();

/**
 * UI v3 motion (docs/design.md "Motion"): tabs keep their screens alive and cross-fade; detail screens slide in from the
 * right; the assistant and Add task slide up (they are things you do, not places you go). Reduce motion: no transition.
 */
const RISE = new Set(["AddTask", "Assistant", "CatchUp"]);

function MainTabs() {
  const { colors } = useLegacy();
  const reduceMotion = useReducedMotion();
  return (
    <Tab.Navigator
      screenOptions={{ headerShown: false, animation: reduceMotion ? "none" : "fade", sceneStyle: { backgroundColor: colors.bg } }}
      tabBar={(props) => (
        <TabBar
          {...props}
          onAssistant={(voice) => (props.navigation as unknown as { navigate: (n: string, p?: object) => void }).navigate("Assistant", voice ? { voice: true } : undefined)}
        />
      )}
    >
      <Tab.Screen name="Dashboard" component={DashboardScreen} />
      <Tab.Screen name="Plan" component={PlanScreen} />
      <Tab.Screen name="TaskList" component={TaskListScreen} />
      <Tab.Screen name="Profile" component={ProfileScreen} />
    </Tab.Navigator>
  );
}

export function MainStack() {
  const { colors } = useLegacy();
  const styles = useLegacyStyles(make_styles);
  const { isWide } = useLayout();
  // Desktop layout (docs/design.md): the same stack beside a start-side Sidebar, reading width capped. The tree has the
  // same shape either way, so resizing a window across `layout.wideMin` keeps the navigation state.
  return (
    <View style={[styles.row, { backgroundColor: colors.bg }]}>
      {isWide ? <Sidebar /> : null}
      <View style={styles.flex}>
        <View style={[styles.flex, isWide && styles.capped]}>
          <Screens />
        </View>
      </View>
    </View>
  );
}

const make_styles = ({ colors, palette, p }: Legacy) => StyleSheet.create({
  row: { flex: 1, flexDirection: "row" },
  flex: { flex: 1 },
  capped: { width: "100%", maxWidth: layout.contentMax, alignSelf: "center" },
});

function Screens() {
  const { colors } = useLegacy();
  const reduceMotion = useReducedMotion();
  return (
    <Stack.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        animation: reduceMotion ? "none" : RISE.has(route.name) ? "slide_from_bottom" : "slide_from_right",
        animationDuration: motion.duration.slow,
        contentStyle: { backgroundColor: colors.bg },
      })}
    >
      <Stack.Screen name="Tabs" component={MainTabs} />
      <Stack.Screen name="Assistant" component={AssistantScreen} />
      <Stack.Screen name="TaskDetail" component={TaskDetailScreen} />
      <Stack.Screen name="AddTask" component={AddTaskScreen} />
      <Stack.Screen name="EditTask" component={EditTaskScreen} />
      <Stack.Screen name="Routines" component={RoutineScreen} />
      <Stack.Screen name="Insights" component={InsightsScreen} />
      <Stack.Screen name="Memory" component={MemoryScreen} />
      <Stack.Screen name="Mood" component={MoodScreen} />
      <Stack.Screen name="Documents" component={DocumentsScreen} />
      <Stack.Screen name="Settings" component={SettingsScreen} />
      <Stack.Screen name="SavedPlaces" component={SavedPlacesScreen} />
      <Stack.Screen name="Onboarding" component={OnboardingScreen} options={{ gestureEnabled: false }} />
      <Stack.Screen name="Collab" component={CollabScreen} />
      <Stack.Screen name="SharedTaskEdit" component={SharedTaskEditScreen} />
      <Stack.Screen name="Notifications" component={NotificationsScreen} />
      <Stack.Screen name="CreateAccount" component={CreateAccountScreen} />
      <Stack.Screen name="DocumentReview" component={DocumentReviewScreen} />
      <Stack.Screen name="CatchUp" component={CatchUpScreen} />
    </Stack.Navigator>
  );
}
