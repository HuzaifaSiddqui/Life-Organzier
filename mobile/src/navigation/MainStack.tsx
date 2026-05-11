import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { colors } from "../constants/theme";
import { AddTaskScreen } from "../screens/tasks/AddTaskScreen";
import { ChatTaskScreen } from "../screens/chat/ChatTaskScreen";
import { DashboardScreen } from "../screens/dashboard/DashboardScreen";
import { EditTaskScreen } from "../screens/tasks/EditTaskScreen";
import { FuturePreviewScreen } from "../screens/future/FuturePreviewScreen";
import { ProfileScreen } from "../screens/profile/ProfileScreen";
import { TaskDetailScreen } from "../screens/tasks/TaskDetailScreen";
import { TaskListScreen } from "../screens/tasks/TaskListScreen";
import { VoiceTaskScreen } from "../screens/voice/VoiceTaskScreen";

export type MainStackParamList = {
  Dashboard: undefined;
  TaskList: { toast?: string; toastTone?: "success" | "warning" } | undefined;
  TaskDetail: { taskId: string };
  AddTask: undefined;
  EditTask: { taskId: string };
  ChatTask: undefined;
  VoiceTask: undefined;
  Profile: undefined;
  FuturePreview: { title: string };
};

const Stack = createNativeStackNavigator<MainStackParamList>();

export function MainStack() {
  return (
    <Stack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: colors.surface },
        headerShadowVisible: false,
        headerTintColor: colors.text,
        headerTitleStyle: { fontWeight: "700" },
        animation: "slide_from_right",
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <Stack.Screen name="Dashboard" component={DashboardScreen} options={{ headerShown: false }} />
      <Stack.Screen name="TaskList" component={TaskListScreen} options={{ headerShown: false }} />
      <Stack.Screen name="TaskDetail" component={TaskDetailScreen} options={{ headerShown: false }} />
      <Stack.Screen name="AddTask" component={AddTaskScreen} options={{ headerShown: false }} />
      <Stack.Screen name="EditTask" component={EditTaskScreen} options={{ headerShown: false }} />
      <Stack.Screen name="ChatTask" component={ChatTaskScreen} options={{ headerShown: false }} />
      <Stack.Screen name="VoiceTask" component={VoiceTaskScreen} options={{ headerShown: false }} />
      <Stack.Screen name="Profile" component={ProfileScreen} options={{ headerShown: false }} />
      <Stack.Screen name="FuturePreview" component={FuturePreviewScreen} options={{ headerShown: false }} />
    </Stack.Navigator>
  );
}
