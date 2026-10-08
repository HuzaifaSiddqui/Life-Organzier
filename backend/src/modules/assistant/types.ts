import type { Priority, RoutineFrequency, RoutinePriority, TaskType } from "@prisma/client";
import type { CrisisPayload, MoodRecommendation, Suggestion } from "../mood/moodService.js";
import type { DayPlan } from "../scheduling/schedulingService.js";
import type { SerializedTask } from "../tasks/taskService.js";

export type TaskDraft = {
  title: string | null;
  description: string | null;
  dueYmd: string | null;
  dueTime: string | null;
  dateText: string | null;
  dateFuzzy: boolean;
  durationMinutes: number | null;
  priority: Priority;
  priorityExplicit: boolean;
  category: string | null;
  taskType: TaskType;
  difficulty: number | null;
  tags: string[];
  context: string | null;
  /** User explicitly accepted an end-of-day deadline / no time. */
  allowNoTime?: boolean;
  allowNoDuration?: boolean;
  allowNoDate?: boolean;
  overrideCapacity?: boolean;
  overrideConflict?: boolean;
  prereqChecked?: boolean;
  scheduledStart?: string | null;
  scheduledEnd?: string | null;
};

export type RoutineDraft = {
  title: string | null;
  frequency: RoutineFrequency | null;
  daysOfWeek: number[] | null;
  dayOfMonth: number | null;
  dueTime: string | null;
  flexibleTime: boolean;
  durationMinutes: number | null;
  priority: RoutinePriority;
  category: string | null;
  timeLocked: boolean;
  context: string | null;
};

export type TaskSlot = "title" | "date" | "time" | "duration";
export type RoutineSlot = "title" | "frequency" | "time";

export type Pending =
  | { kind: "task_draft"; draft: TaskDraft; awaiting: TaskSlot[]; source: "CHAT" | "VOICE" | "WHATSAPP"; clarity: number; reasks?: number }
  | { kind: "task_review"; draft: TaskDraft; source: "CHAT" | "VOICE" | "WHATSAPP"; clarity: number }
  | { kind: "routine_draft"; draft: RoutineDraft; awaiting: RoutineSlot[]; reasks?: number }
  | { kind: "mood_confirm"; mood: string; confidence: number; text: string }
  | { kind: "confirm_update"; taskId: string; changes: Record<string, unknown>; summary: string }
  | { kind: "confirm_delete"; taskId: string; title: string }
  | { kind: "choose_task"; purpose: "update" | "complete" | "delete" | "progress" | "split" | "query_progress"; candidates: string[]; data: Record<string, unknown> }
  | { kind: "clarify_intent"; text: string }
  | { kind: "prereq"; draft: TaskDraft; course: string; prereq: string; source: "CHAT" | "VOICE" | "WHATSAPP" }
  | { kind: "past_date"; draft: TaskDraft; source: "CHAT" | "VOICE" | "WHATSAPP" }
  | { kind: "typo"; draft: TaskDraft; source: "CHAT" | "VOICE" | "WHATSAPP"; corrected: string }
  | { kind: "capacity"; draft: TaskDraft; source: "CHAT" | "VOICE" | "WHATSAPP"; ymd: string }
  | { kind: "conflict"; draft: TaskDraft; source: "CHAT" | "VOICE" | "WHATSAPP"; routine: string };

export type DialogueState = {
  pending: Pending | null;
  /** Most recently discussed tasks first — resolves "it", "this", "that". */
  focus: string[];
  prereqAsked: string[];
  turn: number;
};

export type ActionPayload =
  | { type: "confirm_pending" }
  | { type: "cancel_pending" }
  | { type: "complete_task"; taskId: string }
  | { type: "undo_task"; taskId: string }
  | { type: "restore_task"; taskId: string }
  | { type: "accept_slot"; taskId: string; start: string; end: string }
  | { type: "suggest_slot"; taskId: string }
  | { type: "chunk_task"; taskId: string }
  | { type: "postpone_task"; taskId: string; days: number }
  | { type: "postpone_nonurgent"; taskIds?: string[] }
  | { type: "log_mood"; mood: string; score?: number }
  | { type: "overdue_action"; taskId: string; choice: "complete_now" | "couldnt" | "extension" | "plan" }
  | { type: "routine_occurrence"; occurrenceId: string; status: "COMPLETED" | "SKIPPED"; confirmMandatory?: boolean }
  | { type: "reschedule_occurrence"; occurrenceId: string; ymd: string; time: string | null }
  | { type: "accept_recommendation"; id: string }
  | { type: "dismiss_recommendation"; id: string }
  | { type: "show_top3" }
  | { type: "plan_day"; ymd?: string }
  | { type: "start_task"; taskId: string }
  | { type: "break_down"; taskId: string }
  | { type: "set_context"; context: string }
  | { type: "open_task"; taskId: string }
  | { type: "navigate"; screen: string }
  | { type: "breathing"; minutes: number };

export type QuickAction = {
  label: string;
  /** Text sent as the user's message when tapped (keeps one conversation pipeline). */
  text?: string;
  payload?: ActionPayload;
  style?: "primary" | "default" | "danger";
};

export type Card =
  | { type: "task"; task: SerializedTask; note?: string; undoable?: boolean }
  | { type: "task_list"; title: string; tasks: SerializedTask[]; emptyText?: string }
  | { type: "draft"; draft: TaskDraft; clarity: number; missing: string[] }
  | { type: "routine"; routine: Record<string, unknown> }
  | { type: "suggestions"; title: string; items: Suggestion[] }
  | { type: "mood_support"; recommendation: MoodRecommendation }
  | { type: "plan"; plan: DayPlan }
  | { type: "breathing"; minutes: number }
  | { type: "insight"; text: string; confidence: number }
  | { type: "resources"; resources: CrisisPayload["resources"] }
  | { type: "progress"; task: SerializedTask };

export type AssistantMessageMeta = {
  cards?: Card[];
  actions?: QuickAction[];
  intent?: string;
  speak?: string;
  mood?: string | null;
  memoriesUsed?: number;
  learned?: string[];
};

export type AssistantReply = {
  conversationId: string;
  userMessage: { id: string; content: string; createdAt: string } | null;
  message: { id: string; role: "ASSISTANT"; content: string; createdAt: string } & AssistantMessageMeta;
};

export function emptyState(): DialogueState {
  return { pending: null, focus: [], prereqAsked: [], turn: 0 };
}
