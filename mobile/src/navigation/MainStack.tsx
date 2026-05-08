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
  TaskList: undefined;
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
      <Stack.Screen
        name="Dashboard"
        component={DashboardScreen}
        options={{ title: "Life Organizer" }}
      />
      <Stack.Screen name="TaskList" component={TaskListScreen} options={{ title: "Tasks" }} />
      <Stack.Screen name="TaskDetail" component={TaskDetailScreen} options={{ title: "Task" }} />
      <Stack.Screen name="AddTask" component={AddTaskScreen} options={{ title: "New task" }} />
      <Stack.Screen name="EditTask" component={EditTaskScreen} options={{ title: "Edit task" }} />
      <Stack.Screen name="ChatTask" component={ChatTaskScreen} options={{ title: "Chat task" }} />
      <Stack.Screen name="VoiceTask" component={VoiceTaskScreen} options={{ title: "Voice task" }} />
      <Stack.Screen name="Profile" component={ProfileScreen} options={{ title: "Profile" }} />
      <Stack.Screen
        name="FuturePreview"
        component={FuturePreviewScreen}
        options={({ route }) => ({ title: route.params.title })}
      />
    </Stack.Navigator>
  );
}
