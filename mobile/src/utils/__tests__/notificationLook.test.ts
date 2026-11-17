import { describe, expect, it } from "vitest";
import { notificationLook } from "../notificationLook";

describe("notification look", () => {
  it("urgent and due-now task reminders are red with their own label", () => {
    expect(notificationLook("task", "critical")).toEqual({ label: "notif.dueNow", tone: "danger" });
    expect(notificationLook("task", "urgent")).toEqual({ label: "notif.dueSoon", tone: "danger" });
  });

  it("other task reminders, routines, check-ins and places use the accent", () => {
    expect(notificationLook("task", "normal")).toEqual({ label: "notif.task", tone: "accent" });
    expect(notificationLook("task", null).tone).toBe("accent");
    expect(notificationLook("routine", "critical")).toEqual({ label: "notif.routine", tone: "accent" });
    expect(notificationLook("checkin").label).toBe("notif.checkin");
    expect(notificationLook("location").label).toBe("notif.place");
  });
});
