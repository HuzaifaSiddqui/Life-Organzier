export type Priority = "LOW" | "MEDIUM" | "HIGH" | "URGENT";
export type TaskStatus = "PENDING" | "IN_PROGRESS" | "COMPLETED" | "SKIPPED" | "DELETED";
export type TaskSource = "MANUAL" | "CHAT" | "VOICE" | "DOCUMENT" | "WHATSAPP" | "ASSISTANT";
export type TaskType = "DEADLINE" | "FLEXIBLE" | "DURATION" | "FIXED" | "ROUTINE";
export type ReminderMode = "NONE" | "SINGLE" | "MULTIPLE" | "ESCALATING" | "ADAPTIVE";
export type RoutineFrequency = "DAILY" | "WEEKLY" | "MONTHLY" | "CUSTOM";
export type RoutinePriority = "MANDATORY" | "IMPORTANT" | "NORMAL";
export type RoutineOccurrenceStatus = "PENDING" | "COMPLETED" | "SKIPPED" | "MISSED";
export type Mood = "stressed" | "anxious" | "happy" | "tired" | "motivated" | "sad" | "overwhelmed" | "focused" | "calm";

export type Task = {
  id: string;
  userId: string;
  title: string;
  description: string | null;
  dueDate: string | null;
  dueTime: string | null;
  dueAt?: string | null;
  priority: Priority;
  category: string | null;
  status: TaskStatus;
  source: TaskSource;
  confidence: number | null;
  createdAt: string;
  updatedAt: string;
  parentTaskId?: string | null;
  progress?: number;
  durationMinutes?: number | null;
  difficulty?: number | null;
  taskType?: TaskType;
  archived?: boolean;
  deletedAt?: string | null;
  completedAt?: string | null;
  scheduledStart?: string | null;
  scheduledEnd?: string | null;
  tags?: string[] | null;
  locationContext?: string | null;
  reminderMinutes?: number | null;
  reminderMode?: ReminderMode;
  version?: number;
  isOverdue?: boolean;
  /** Client-only: change not yet confirmed by the server. */
  pendingSync?: boolean;
};

export type RoutineOccurrence = {
  id: string;
  routineId: string;
  occurrenceDate: string;
  dueTime: string | null;
  status: RoutineOccurrenceStatus;
  routine?: Routine;
};

export type Routine = {
  id: string;
  title: string;
  description: string | null;
  frequency: RoutineFrequency;
  daysOfWeek: number[] | null;
  dayOfMonth: number | null;
  dueTime: string | null;
  durationMinutes: number | null;
  category: string | null;
  priority: RoutinePriority;
  timeLocked: boolean;
  locationContext: string | null;
  wellnessType?: string | null;
  active: boolean;
  occurrences: RoutineOccurrence[];
};

export type User = {
  id: string;
  firebaseUid: string;
  email: string;
  displayName: string | null;
  photoUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

export type UserSettings = {
  userId: string;
  timezone: string;
  language: string;
  quietStart: string;
  quietEnd: string;
  workStart: string;
  workEnd: string;
  dailyCapacityMinutes: number;
  notificationFrequency: "ADAPTIVE" | "FREQUENT" | "MINIMAL" | "NONE";
  notificationMethod: "APP" | "SOUND" | "VIBRATION" | "SOUND_VIBRATION";
  notificationDevices: "ALL" | "PHONE" | "DESKTOP" | "WHATSAPP";
  criticalOverridesDnd: boolean;
  dndUntil: string | null;
  currentContext: string | null;
  contexts: string[];
  tier: "FREE" | "PRO";
  onboardingCompleted: boolean;
  tutorialsEnabled: boolean;
  tutorialsSeen: string[];
  dismissedInsights: string[];
  ttsEnabled: boolean;
  ttsRate: number;
  lastWhatsappMessageAt: string | null;
};

export type Category = { id: string; name: string; color: string; predefined: boolean };

/* ---------------------------------------------------------------- assistant */

export type ActionPayload = { type: string; [key: string]: unknown };

export type QuickAction = { label: string; text?: string; payload?: ActionPayload; style?: "primary" | "default" | "danger" };

export type Suggestion = { id: string; label: string; detail?: string; action: ActionPayload };

/** Crisis reply from the server: localised text and call buttons (single source: backend CRISIS_RESOURCES). */
export type CrisisPayload = { message: string; resources: Array<{ label: string; phone: string }> };

export type MoodRecommendation = {
  mood: Mood;
  message: string;
  primary: Suggestion | null;
  suggestions: Suggestion[];
  avoid: string[];
};

export type TaskDraft = {
  title: string | null;
  description: string | null;
  dueYmd: string | null;
  dueTime: string | null;
  durationMinutes: number | null;
  priority: Priority;
  category: string | null;
  taskType: TaskType;
  tags: string[];
};

export type PlanBlock = {
  start: string;
  end: string;
  kind: "task" | "routine" | "break" | "suggested" | "due";
  title: string;
  id: string;
  hard?: boolean;
  mandatory?: boolean;
  status?: string;
};

export type DayPlan = {
  ymd: string;
  label: string;
  load: { minutes: number; capacity: number; overloaded: boolean };
  blocks: PlanBlock[];
  unscheduled: Array<{ id: string; title: string; dueAt: string | null; durationMinutes: number | null; priority: Priority }>;
  notes: string[];
};

export type AssistantCard =
  | { type: "task"; task: Task; note?: string; undoable?: boolean }
  | { type: "task_list"; title: string; tasks: Task[]; emptyText?: string }
  | { type: "draft"; draft: TaskDraft; clarity: number; missing: string[] }
  | { type: "routine"; routine: Routine }
  | { type: "suggestions"; title: string; items: Suggestion[] }
  | { type: "mood_support"; recommendation: MoodRecommendation }
  | { type: "plan"; plan: DayPlan }
  | { type: "breathing"; minutes: number }
  | { type: "insight"; text: string; confidence: number }
  | { type: "resources"; resources?: CrisisPayload["resources"] }
  | { type: "progress"; task: Task };

export type ChatMessage = {
  id: string;
  role: "USER" | "ASSISTANT" | "SYSTEM";
  content: string;
  createdAt: string;
  cards?: AssistantCard[];
  actions?: QuickAction[];
  intent?: string;
  speak?: string;
  memoriesUsed?: number;
  learned?: string[];
  /** Client-only: optimistic message awaiting the server. */
  pending?: boolean;
};

export type AssistantReply = {
  conversationId: string;
  userMessage: { id: string; content: string; createdAt: string } | null;
  message: ChatMessage;
};

export type AttentionItem = {
  id: string;
  kind: string;
  severity: "info" | "warning" | "critical";
  title: string;
  message: string;
  actions: QuickAction[];
  taskId?: string;
  occurrenceId?: string;
};

export type Recommendation = {
  id: string;
  patternKey: string;
  text: string;
  confidence: number;
  confidenceText: string;
  acceptLabel: string;
};

export type Briefing = {
  greeting: string;
  headline: string;
  context: string | null;
  contexts: string[];
  mood: { latest: { mood: Mood; score: number | null; at: string } | null; checkinDue: boolean };
  today: {
    tasks: Task[];
    routines: Array<{ id: string; routineId: string; title: string; time: string | null; status: RoutineOccurrenceStatus; priority: RoutinePriority; timeLocked: boolean }>;
    loadMinutes: number;
    capacityMinutes: number;
  };
  nextUp: Task | null;
  attention: AttentionItem[];
  recommendations: Recommendation[];
  peak: { label: string; learned: boolean; confidence: number };
  stats: { open: number; overdue: number; completedToday: number; dueToday: number };
};

/* ---------------------------------------------------------------- memory & patterns */

export type MemoryItem = {
  id: string;
  kind: "FACT" | "PREFERENCE" | "COPING" | "GOAL" | "EPISODE" | "COURSE" | "CORRECTION";
  content: string;
  importance: number;
  reinforcedCount: number;
  source: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Pattern = {
  key: string;
  description: string;
  value: Record<string, unknown>;
  confidence: number;
  sampleSize: number;
  active?: boolean;
};

export type MoodLog = { id: string; mood: Mood; score: number | null; source: string; note: string | null; createdAt: string };

export type ApiSuccess<T> = { success: true; message: string; data: T };
export type ApiError = { success: false; message: string; error: string };
