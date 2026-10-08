import type { CrisisPayload, MemoryItem, Mood, MoodLog, MoodRecommendation, Pattern, Recommendation } from "../types/models";
import { apiDelete, apiGet, apiPost, apiPut } from "./api";

/* -------- memory: what the assistant knows about the user */

export async function getMemory(): Promise<{ memories: MemoryItem[]; patterns: Pattern[] }> {
  return apiGet("/memory");
}

export async function addMemory(content: string, kind: MemoryItem["kind"]): Promise<MemoryItem> {
  return (await apiPost<{ memory: MemoryItem }>("/memory", { content, kind })).memory;
}

export async function editMemory(id: string, content: string): Promise<MemoryItem> {
  return (await apiPut<{ memory: MemoryItem }>(`/memory/${id}`, { content })).memory;
}

export async function forgetMemory(id: string): Promise<void> {
  await apiDelete(`/memory/${id}`);
}

export async function forgetEverything(): Promise<void> {
  await apiDelete("/memory");
}

/* -------- pattern recommendations */

export async function getInsights(refresh = false): Promise<{ recommendations: Recommendation[]; patterns: Pattern[] }> {
  return apiGet(`/insights${refresh ? "?refresh=true" : ""}`);
}

export async function acceptInsight(id: string): Promise<string> {
  return (await apiPost<{ message: string }>(`/insights/${encodeURIComponent(id)}/accept`)).message;
}

export async function dismissInsight(id: string): Promise<void> {
  await apiPost(`/insights/${encodeURIComponent(id)}/dismiss`);
}

/* -------- mood */

export async function logMood(input: { mood: Mood; score?: number; note?: string; source?: "MANUAL" | "CHECKIN" }): Promise<{ log: MoodLog; recommendation: MoodRecommendation; crisis: CrisisPayload | null }> {
  return apiPost("/mood", input);
}

export async function getMoodHistory(days = 30): Promise<{ logs: MoodLog[]; byWeekday: Array<{ weekday: number; count: number; avgScore: number | null }> }> {
  return apiGet(`/mood?days=${days}`);
}

/* -------- analytics */

export type Analytics = {
  range: { key: string; label: string; from: string; to: string };
  totals: { created: number; completed: number; completionRate: number; onTimeRate: number | null; open: number; overdue: number };
  previous: { created: number; completed: number; completionRate: number; onTimeRate: number | null } | null;
  trend: Array<{ label: string; created: number; completed: number; rate: number }>;
  categories: Array<{ category: string; total: number; completed: number; rate: number; share: number }>;
  routines: Array<{ routineId: string; title: string; completed: number; total: number; adherence: number }>;
  heatmap: number[][];
  bestHour: number | null;
  bestDay: number | null;
  bestCategory: string | null;
  challengingCategory: string | null;
  avgDaysFromDue: number | null;
  avgMood: number | null;
  insights: Array<{ id: string; text: string; tone: "positive" | "warning" | "info" }>;
};

export async function getAnalytics(range: "week" | "month" | "3months" | "all"): Promise<Analytics> {
  return (await apiGet<{ analytics: Analytics }>(`/analytics?range=${range}`)).analytics;
}

export async function exportAnalyticsCsv(): Promise<{ filename: string; csv: string }> {
  return apiGet("/analytics/export");
}

/* -------- events */

export function trackAppOpen(): void {
  apiPost("/events", { type: "APP_OPEN" }).catch(() => undefined);
}
