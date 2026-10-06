import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { colors } from "../constants/theme";
import { AssistantScreen } from "../screens/assistant/AssistantScreen";
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
  TaskList: { toast?: string; toastTone?: "success" | "warning"; filter?: "overdue" | "today" } | undefined;
  TaskDetail: { taskId: string };
  AddTask: { prefill?: TaskFormPrefill } | undefined;
  EditTask: { taskId: string };
  Routines: undefined;
  Insights: undefined;
  Memory: undefined;
  Mood: undefined;
  Documents: undefined;
  Settings: undefined;
  Onboarding: undefined;
  Profile: undefined;
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
      <Stack.Screen name="Onboarding" component={OnboardingScreen} options={{ gestureEnabled: false }} />
      <Stack.Screen name="Profile" component={ProfileScreen} />
    </Stack.Navigator>
  );
}
