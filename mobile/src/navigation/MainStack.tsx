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
  TaskList: { toast?: string; toastTone?: "success" | "warning"; /** A share just made from the task form: the toast offers Undo. */ undoShare?: { id: string; taskId: string | null }; filter?: "overdue" | "today"; /** Only these tasks (e.g. from a location reminder). */ ids?: string[] } | undefined;
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

export function MainStack() {
  return (
    <Stack.Navigator
      screenOptions={{
        headerShown: false,
        animation: "slide_from_right",
        contentStyle: { backgroundColor: colors.bg },
      }}
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
