import type { StringKey } from "../i18n/strings";
import { layout } from "../theme/tokens";

/** Desktop layout (docs/design.md "Desktop layout"): from `layout.wideMin` the sidebar replaces the bottom nav. */
export function isWideWidth(width: number): boolean {
  return width >= layout.wideMin;
}

export type SidebarRoute = "Dashboard" | "Assistant" | "TaskList" | "Routines" | "Documents" | "Insights" | "Mood" | "Collab" | "Profile";
export type SidebarIcon = "home" | "assistant" | "tasks" | "repeat" | "doc" | "insights" | "pulse" | "people" | "user";

export const SIDEBAR_ITEMS: ReadonlyArray<{ route: SidebarRoute; icon: SidebarIcon; label: StringKey }> = [
  { route: "Dashboard", icon: "home", label: "nav.home" },
  { route: "Assistant", icon: "assistant", label: "nav.assistant" },
  { route: "TaskList", icon: "tasks", label: "nav.tasks" },
  { route: "Routines", icon: "repeat", label: "nav.routines" },
  { route: "Documents", icon: "doc", label: "nav.documents" },
  { route: "Insights", icon: "insights", label: "nav.insights" },
  { route: "Mood", icon: "pulse", label: "nav.mood" },
  { route: "Collab", icon: "people", label: "nav.people" },
  { route: "Profile", icon: "user", label: "nav.me" },
];

/** Screens without their own sidebar entry highlight the entry they belong to (a task's detail → Tasks). */
const PARENT: Record<string, SidebarRoute> = {
  TaskDetail: "TaskList",
  AddTask: "TaskList",
  EditTask: "TaskList",
  SharedTaskEdit: "Collab",
  Memory: "Insights",
  Settings: "Profile",
  SavedPlaces: "Profile",
  Notifications: "Profile",
  Onboarding: "Dashboard",
};

export function activeSidebarRoute(routeName: string | undefined): SidebarRoute {
  if (!routeName) return "Dashboard";
  if (SIDEBAR_ITEMS.some((i) => i.route === routeName)) return routeName as SidebarRoute;
  return PARENT[routeName] ?? "Dashboard";
}

/** Desktop shortcuts: Ctrl/⌘+N new task, Ctrl/⌘+K assistant. Null for any other key. */
export function shortcutFor(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }): "AddTask" | "Assistant" | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return null;
  const k = e.key.toLowerCase();
  return k === "n" ? "AddTask" : k === "k" ? "Assistant" : null;
}
