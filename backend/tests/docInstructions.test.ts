import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { AiService, setAi } from "../src/ai/llm.js";
import { prisma } from "../src/config/db.js";
import { processDocument, withInstruction } from "../src/modules/documents/documentProcessing.js";
import { matchPerson, nameMatches, peopleIn, personIn, readInstruction, withModel } from "../src/modules/documents/instructions.js";
import { dbAvailable } from "./fixtures.js";

// DOC_INSTRUCTIONS (default off). Synthetic documents with made-up names (tests/eval/doc-instructions).
const skip = !dbAvailable && "no database";
const TABLES = readFileSync(new URL("./eval/doc-instructions/per-teacher-tables.txt", import.meta.url), "utf8");

function withFlag<T>(run: () => Promise<T>): Promise<T> {
  const keep = process.env.DOC_INSTRUCTIONS;
  process.env.DOC_INSTRUCTIONS = "on";
  return run().finally(() => {
    if (keep === undefined) delete process.env.DOC_INSTRUCTIONS;
    else process.env.DOC_INSTRUCTIONS = keep;
  });
}

test("names: titles and labels found; OCR variants are one person; a shared first name is never merged", () => {
  assert.equal(personIn("Instructor: Dr. Ahmed Khan"), "Dr. Ahmed Khan");
  assert.equal(personIn("Monday 9:00 Data Structures - Prof Bilal Hussain - Room 3"), "Prof Bilal Hussain");
  assert.equal(personIn("Teacher - Sara Ma1ik"), "Sara Ma1ik", "a digit inside a name is kept for matching");
  assert.equal(personIn("Monday 9:00 Data Structures Room 12"), null);
  assert.deepEqual(peopleIn(["Dr. Ahmed Khan", "Dr. Ahrned Khan", "Dr Ahmad Khan", "Ms. Sara Ma1ik", "Ms. Sara Malik", "Dr. Ahmed Raza"]), ["Dr. Ahmed Khan", "Ms. Sara Malik", "Dr. Ahmed Raza"], "the clean spelling is shown");
  assert.ok(nameMatches("A. Khan", "Dr. Ahmed Khan"), "an initial matches");
  assert.ok(!nameMatches("Ahmed Raza", "Dr. Ahmed Khan"));
  assert.deepEqual(matchPerson("Dr. Ahmed", ["Dr. Ahmed Khan", "Dr. Ahmed Raza", "Ms. Sara Malik"]).matches, ["Dr. Ahmed Khan", "Dr. Ahmed Raza"], "two people: ask");
  const none = matchPerson("Dr. Imran", ["Dr. Ahmed Khan", "Ms. Sara Malik"]);
  assert.deepEqual(none.matches, []);
  assert.equal(none.nearest.length, 2, "the nearest names are offered");
});

test("the instruction: kinds, days, codes, rooms and people by rules; leftover words are reported, not ignored", () => {
  const people = ["Dr. Ahmed Khan", "Dr. Ahmed Raza", "Ms. Sara Malik"];
  const courses = ["Data Structures (CS-201)", "Operating Systems (CS-301)"];
  const r = readInstruction("only Dr. Ahmed Khan's exams on Mondays and Wednesdays", people, courses, "2026-10-05");
  assert.equal(r.filter.person, "Dr. Ahmed Khan");
  assert.deepEqual(r.filter.kind, ["exam"]);
  assert.deepEqual(r.filter.days, [1, 3]);
  assert.deepEqual(r.leftover, []);
  assert.equal(readInstruction("only CS-301", people, courses, "2026-10-05").filter.course, "CS-301");
  assert.equal(readInstruction("only Sara Malik", people, courses, "2026-10-05").filter.person, "sara malik");
  assert.deepEqual(readInstruction("whatever Raza teaches", people, courses, "2026-10-05").leftover, ["whatever", "teaches"]);
  // The model is taken only when it agrees with the rules.
  const read = readInstruction("whatever Raza teaches", people, courses, "2026-10-05");
  const base = { course: null, days: [], kind: [], dateRange: null, roomOrPlace: null, asRoutines: false };
  assert.deepEqual(withModel(read, { ...base, person: "Raza" }).leftover, [], "agrees: the extra words were phrasing");
  assert.deepEqual(withModel(read, { ...base, person: "Sara Malik" }).leftover, ["whatever", "teaches"], "contradicts: still asked");
});

test("whole flow: no instruction = today; an instruction filters and only matching items may be created; a question creates nothing; a change re-filters without reading the file", { skip }, async () => {
  setAi(new AiService([]));
  const user = await prisma.user.create({ data: { firebaseUid: `test-${randomUUID()}`, email: `ci-${randomUUID()}@example.test` } });
  const settings = await prisma.userSettings.create({ data: { userId: user.id, timezone: "Asia/Karachi" } });
  const upload = (text: string, instruction?: string) => ({ text, fileName: "timetable.txt", mimeType: "text/plain", docType: "SCHEDULE" as const, language: "eng", autoCreate: true, ...(instruction ? { instruction } : {}) });
  try {
    // Flag off and no instruction: exactly today's result (the gate compares whole runs; here one document).
    const off = await processDocument(user, settings, upload(`${TABLES}\n(off)`));
    const offItems = JSON.stringify([...off.extracted.deadlines, ...off.extracted.schedules].map((i) => [i.title, i.created ?? false]));
    await withFlag(async () => {
      const on = await processDocument(user, settings, upload(`${TABLES}\n(on)`));
      assert.equal(JSON.stringify([...on.extracted.deadlines, ...on.extracted.schedules].map((i) => [i.title, i.created ?? false])), offItems, "no instruction: same items, same created");
      assert.equal(on.extracted.instruction, undefined);

      // A question pending ("Dr. Ahmed": two people): nothing is created, nothing hidden yet.
      const before = await prisma.task.count({ where: { userId: user.id } });
      const ask = await processDocument(user, settings, upload(`${TABLES}\n(ask)`, "Dr. Ahmed"));
      assert.equal(ask.extracted.instruction?.status, "ask_person");
      assert.deepEqual(ask.extracted.instruction?.options, ["Dr. Ahmed Khan", "Dr. Ahmed Raza"]);
      assert.equal(await prisma.task.count({ where: { userId: user.id } }), before, "nothing created while asking");
      assert.ok([...ask.extracted.deadlines, ...ask.extracted.schedules].every((i) => !i.filteredOut));

      // Applied: only Raza's items are shown, and nothing of anyone else is created.
      const raza = await processDocument(user, settings, upload(`${TABLES}\n(raza)`, "only Dr. Ahmed Raza"));
      const shown = [...raza.extracted.deadlines, ...raza.extracted.schedules].filter((i) => !i.filteredOut);
      assert.equal(raza.extracted.instruction?.status, "applied");
      assert.deepEqual(shown.map((i) => i.title).sort(), ["Final exam Operating Systems", "Operating Systems (CS-301)", "Quiz 2 Operating Systems"]);
      assert.ok([...raza.extracted.deadlines, ...raza.extracted.schedules].filter((i) => i.filteredOut).every((i) => !i.created), "nothing filtered out is created");

      // A change request on the stored document: same items, new filter, no OCR (the stored text is all it reads).
      const doc = await prisma.document.findUniqueOrThrow({ where: { id: raza.document.id } });
      const changed = await withInstruction(doc.text, structuredClone(doc.extracted) as never, "just the exams", null, "2026-10-05");
      assert.equal(changed.instruction?.status, "applied");
      assert.deepEqual([...changed.deadlines, ...changed.schedules].filter((i) => !i.filteredOut).map((i) => i.title).sort(), ["Final exam Operating Systems", "Midterm exam Data Structures"]);
      // Answering "which one?" with a person.
      const picked = await withInstruction(doc.text, structuredClone(doc.extracted) as never, "Dr. Ahmed", "Dr. Ahmed Khan", "2026-10-05");
      assert.equal(picked.instruction?.status, "applied");
      assert.ok([...picked.deadlines, ...picked.schedules].filter((i) => !i.filteredOut).every((i) => i.meta?.person === "Dr. Ahmed Khan"));
    });
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
});
