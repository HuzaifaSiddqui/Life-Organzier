import { describe, expect, it } from "vitest";
import { dialogButtons, dismissAction } from "../alertButtons";
import { desktopNotifies, desktopReminderItems, MAX_DESKTOP_REMINDERS, type DesktopPlan } from "../desktopReminders";
import { fromInputValue, toInputValue } from "../pickerInput";
import { uploadPart } from "../uploadPart";

const NOW = new Date("2026-11-12T10:00:00Z").getTime();
const at = (min: number) => new Date(NOW + min * 60000).toISOString();

const plan = (devices: string, extra: Partial<DesktopPlan> = {}): DesktopPlan => ({
  reminders: [
    { id: "r2", taskId: "t2", routineOccurrenceId: null, fireAt: at(30), title: "Later", body: "b" },
    { id: "r1", taskId: "t1", routineOccurrenceId: null, fireAt: at(10), title: "Soon", body: "b" },
    { id: "old", taskId: "t3", routineOccurrenceId: null, fireAt: at(-5), title: "Past", body: "b" },
  ],
  checkins: [{ id: "c1", taskId: "t1", fireAt: at(20), title: "Started?", body: "b", category: "START" }],
  settings: { devices },
  ...extra,
});

describe("desktop reminders (FR-RN-002, FR-AP-002)", () => {
  it("notifies only for All devices and Desktop only", () => {
    expect(desktopNotifies("ALL")).toBe(true);
    expect(desktopNotifies("DESKTOP")).toBe(true);
    expect(desktopNotifies("PHONE")).toBe(false);
    expect(desktopNotifies("WHATSAPP")).toBe(false);
    expect(desktopReminderItems(plan("PHONE"), NOW)).toEqual([]);
  });

  it("keeps future reminders and check-ins, soonest first", () => {
    const items = desktopReminderItems(plan("ALL"), NOW);
    expect(items.map((i) => i.id)).toEqual(["r1", "c:c1", "r2"]);
    expect(items[1]).toMatchObject({ kind: "checkin", checkinId: "c1", category: "START", taskId: "t1" });
  });

  it("WhatsApp Agent users keep only check-ins (task reminders go to WhatsApp)", () => {
    const items = desktopReminderItems(plan("DESKTOP", { settings: { devices: "DESKTOP", viaWhatsappAgent: true } }), NOW);
    expect(items.map((i) => i.id)).toEqual(["c:c1"]);
  });

  it("is capped", () => {
    const many = Array.from({ length: MAX_DESKTOP_REMINDERS + 20 }, (_, i) => ({ id: `r${i}`, taskId: null, routineOccurrenceId: `o${i}`, fireAt: at(i + 1), title: "x", body: "y" }));
    expect(desktopReminderItems({ reminders: many, settings: { devices: "ALL" } }, NOW)).toHaveLength(MAX_DESKTOP_REMINDERS);
  });
});

describe("in-app dialog buttons (Alert.alert on web)", () => {
  it("no buttons → one OK", () => {
    expect(dialogButtons(undefined, "OK")).toEqual([{ label: "OK", kind: "primary", onPress: undefined, cancel: false }]);
  });

  it("cancel first, destructive is danger, one primary", () => {
    const b = dialogButtons(
      [
        { text: "Edit" },
        { text: "Delete", style: "destructive" },
        { text: "Cancel", style: "cancel" },
        { text: "Move" },
      ],
      "OK",
    );
    expect(b.map((x) => [x.label, x.kind])).toEqual([
      ["Cancel", "secondary"],
      ["Edit", "tonal"],
      ["Delete", "danger"],
      ["Move", "primary"],
    ]);
    expect(b.filter((x) => x.kind === "primary")).toHaveLength(1);
  });

  it("closing runs the cancel action, else onDismiss", () => {
    const cancel = () => undefined;
    const dismiss = () => undefined;
    expect(dismissAction([{ text: "No", style: "cancel", onPress: cancel }], dismiss)).toBe(cancel);
    expect(dismissAction([{ text: "Yes" }], dismiss)).toBe(dismiss);
    expect(dismissAction(undefined)).toBeUndefined();
  });
});

describe("web date / time picker values", () => {
  const base = new Date(2026, 10, 12, 14, 5);

  it("formats in local time", () => {
    expect(toInputValue(base, "date")).toBe("2026-11-12");
    expect(toInputValue(base, "time")).toBe("14:05");
  });

  it("a picked date keeps the time; a picked time keeps the day", () => {
    const d = fromInputValue("2026-12-01", "date", base)!;
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()]).toEqual([2026, 11, 1, 14, 5]);
    const t = fromInputValue("09:30", "time", base)!;
    expect([t.getDate(), t.getHours(), t.getMinutes()]).toEqual([12, 9, 30]);
  });

  it("rejects malformed values", () => {
    expect(fromInputValue("", "date", base)).toBeNull();
    expect(fromInputValue("25:00", "time", base)).toBeNull();
  });
});

describe("document upload part", () => {
  it("phone sends the { uri, name, type } part; web sends the File", () => {
    expect(uploadPart({ uri: "file:///a.pdf", name: "a.pdf", mimeType: "application/pdf" })).toEqual({ uri: "file:///a.pdf", name: "a.pdf", type: "application/pdf" });
    const file = new Blob(["x"], { type: "application/pdf" });
    expect(uploadPart({ uri: "blob:1", name: "a.pdf", mimeType: "application/pdf", file })).toBe(file);
  });
});
