import type { Category, User, UserSettings } from "../types/models";
import { apiDelete, apiGet, apiPost, apiPut } from "./api";
import { scheduleReminderSync } from "./reminders";

export async function getSettings(): Promise<{ settings: UserSettings; phoneNumber: string | null }> {
  return apiGet("/settings");
}

export async function saveSettings(patch: Partial<UserSettings>): Promise<UserSettings> {
  const { settings } = await apiPut<{ settings: UserSettings }>("/settings", patch);
  scheduleReminderSync();
  return settings;
}

export async function setDnd(minutes: number): Promise<UserSettings> {
  const { settings } = await apiPost<{ settings: UserSettings }>("/settings/dnd", { minutes });
  scheduleReminderSync();
  return settings;
}

export async function savePhone(phoneNumber: string | null): Promise<string | null> {
  return (await apiPut<{ phoneNumber: string | null }>("/settings/phone", { phoneNumber })).phoneNumber;
}

export async function getCategories(): Promise<Category[]> {
  return (await apiGet<{ categories: Category[] }>("/categories")).categories;
}

export async function createCategory(name: string, color: string): Promise<Category> {
  return (await apiPost<{ category: Category }>("/categories", { name, color })).category;
}

export async function deleteCategory(id: string): Promise<void> {
  await apiDelete(`/categories/${id}`);
}

export async function getTags(): Promise<Array<{ tag: string; count: number }>> {
  return (await apiGet<{ tags: Array<{ tag: string; count: number }> }>("/tags")).tags;
}

export async function deleteTag(tag: string): Promise<void> {
  await apiDelete(`/tags/${encodeURIComponent(tag)}`);
}

export type AccountInfo = { user: User; tier: string; deletion: { requestedAt: string; permanentAt: string } | null };

export async function getAccount(): Promise<AccountInfo> {
  return apiGet("/account");
}

export async function updateProfile(displayName: string): Promise<User> {
  return (await apiPut<{ user: User }>("/account/profile", { displayName })).user;
}

export async function exportAllData(): Promise<{ filename: string; csv: string }> {
  return apiGet("/account/export");
}

export async function requestAccountDeletion(): Promise<string> {
  return (await apiPost<{ permanentAt: string }>("/account/delete")).permanentAt;
}

export async function recoverAccount(): Promise<void> {
  await apiPost("/account/recover");
}
