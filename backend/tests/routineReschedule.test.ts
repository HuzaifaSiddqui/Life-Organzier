import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { prisma } from "../src/config/db.js";
import { startOfLocalDay } from "../src/lib/time.js";
import { rescheduleOccurrence } from "../src/modules/routines/routineService.js";
import { dbAvailable } from "./fixtures.js";

const TZ = "Asia/Karachi";

test("a time-locked routine's occurrence moves only when the user confirms (Plan drag: 'move just this one')", { skip: !dbAvailable && "no database" }, async () => {
  const user = await prisma.user.create({ data: { firebaseUid: `resched-${randomUUID()}`, email: `resched-${randomUUID().slice(0, 8)}@example.test` } });
  try {
    const routine = await prisma.routine.create({ data: { userId: user.id, title: "DevOps", frequency: "WEEKLY", dueTime: "11:30", timeLocked: true } });
    const occ = await prisma.routineOccurrence.create({ data: { routineId: routine.id, userId: user.id, occurrenceDate: startOfLocalDay("2026-11-17", TZ), dueTime: "11:30" } });

    await assert.rejects(() => rescheduleOccurrence(user.id, TZ, occ.id, "2026-11-17", "14:00"), (e: { code?: string }) => e.code === "ROUTINE_TIME_LOCKED");

    const moved = await rescheduleOccurrence(user.id, TZ, occ.id, "2026-11-18", "14:00", true);
    assert.equal(moved?.dueTime, "14:00");
    assert.equal(moved?.occurrenceDate.getTime(), startOfLocalDay("2026-11-18", TZ).getTime());
    // The routine itself keeps its fixed time.
    assert.equal((await prisma.routine.findUnique({ where: { id: routine.id } }))?.dueTime, "11:30");
  } finally {
    await prisma.user.deleteMany({ where: { id: user.id } });
  }
});
