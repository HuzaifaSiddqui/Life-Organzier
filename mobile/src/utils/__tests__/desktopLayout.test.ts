import { describe, expect, it, vi } from "vitest";

// tokens.ts imports react-native (Platform) — same stub as motionTokens.test.ts.
vi.mock("react-native", () => ({ Platform: { select: (o: Record<string, unknown>) => o.default } }));
const { activeSidebarRoute, isWideWidth, shortcutFor, SIDEBAR_ITEMS } = await import("../layout");

const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe("desktop layout", () => {
  it("is wide from 960 px", () => {
    expect(isWideWidth(959)).toBe(false);
    expect(isWideWidth(960)).toBe(true);
    expect(isWideWidth(390)).toBe(false);
  });

  it("highlights a screen's own entry, else its parent's", () => {
    expect(activeSidebarRoute("Routines")).toBe("Routines");
    expect(activeSidebarRoute("TaskDetail")).toBe("TaskList");
    expect(activeSidebarRoute("SharedTaskEdit")).toBe("Collab");
    expect(activeSidebarRoute("Settings")).toBe("Profile");
    expect(activeSidebarRoute(undefined)).toBe("Dashboard");
    expect(activeSidebarRoute("Unknown")).toBe("Dashboard");
  });

  it("has one entry per main area, each with a label key", () => {
    expect(new Set(SIDEBAR_ITEMS.map((i) => i.route)).size).toBe(SIDEBAR_ITEMS.length);
    expect(SIDEBAR_ITEMS.every((i) => i.label.startsWith("nav."))).toBe(true);
  });

  it("shortcuts: Ctrl/⌘+N new task, Ctrl/⌘+K assistant, nothing else", () => {
    expect(shortcutFor(key("n", { ctrlKey: true }))).toBe("AddTask");
    expect(shortcutFor(key("K", { metaKey: true }))).toBe("Assistant");
    expect(shortcutFor(key("n"))).toBeNull();
    expect(shortcutFor(key("n", { ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(shortcutFor(key("x", { ctrlKey: true }))).toBeNull();
  });
});
