import { StyleSheet, View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { Sidebar } from "../components/Sidebar";
import { layout, motion } from "../theme/tokens";
import { useLayout } from "../theme/useLayout";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
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

export type MainStackParamList = {
  Dashboard: undefined;
  Assistant: { voice?: boolean; prefill?: string; autoSend?: boolean; payload?: ActionPayload; label?: string; nonce?: number } | undefined;
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
  Settings: undefined;
  SavedPlaces: undefined;
  Onboarding: undefined;
  Profile: undefined;
  /** Task collaboration (COLLAB_TASKS): requests, people, shared tasks. */
  Collab: { tab?: "requests" | "people" | "shared" } | undefined;
  /** edit: the owner changes a shared task; accept: a member accepts it for their own date/time. */
  SharedTaskEdit: { id: string; mode: "edit" | "accept" | "decline" };
  Notifications: undefined;
};

const Stack = createNativeStackNavigator<MainStackParamList>();

/**
 * UI v2 motion (docs/ux-audit.md §8): the five bottom-nav screens fade into each other (switching tabs isn't moving
 * deeper); detail screens slide in from the right; Add task slides up. Reduce motion: no transition.
 */
const TAB_SCREENS = new Set(["Dashboard", "TaskList", "Assistant", "Insights", "Profile"]);

export function MainStack() {
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

const styles = StyleSheet.create({
  row: { flex: 1, flexDirection: "row" },
  flex: { flex: 1 },
  capped: { width: "100%", maxWidth: layout.contentMax, alignSelf: "center" },
});

function Screens() {
  const reduceMotion = useReducedMotion();
  return (
    <Stack.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        animation: reduceMotion ? "none" : TAB_SCREENS.has(route.name) ? "fade" : route.name === "AddTask" ? "slide_from_bottom" : "slide_from_right",
        animationDuration: motion.duration.slow,
        contentStyle: { backgroundColor: colors.bg },
      })}
    >
      <Stack.Screen name="Dashboard" component={DashboardScreen} />
      <Stack.Screen name="Assistant" component={AssistantScreen} />
      <Stack.Screen name="TaskList" component={TaskListScreen} />
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
      <Stack.Screen name="Profile" component={ProfileScreen} />
      <Stack.Screen name="Collab" component={CollabScreen} />
      <Stack.Screen name="SharedTaskEdit" component={SharedTaskEditScreen} />
      <Stack.Screen name="Notifications" component={NotificationsScreen} />
    </Stack.Navigator>
  );
}
