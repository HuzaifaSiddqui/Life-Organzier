import assert from "node:assert/strict";
import test from "node:test";
import { AiService, setAi } from "../src/ai/llm.js";
import { analyzeDocument } from "../src/modules/documents/documentProcessing.js";
import { AI_ONLY_MAX, aiDeadlines, chunkText, mergeDeadlines, type ExtractedDeadline } from "../src/modules/documents/extraction.js";
import { NOW, TZ } from "./fixtures.js";

const item = (o: Partial<ExtractedDeadline>): ExtractedDeadline => ({ index: 0, title: "X", activity: "deadline", date: "2026-11-01", time: "9 AM", assumedTime: false, confidence: 88, source: "", ...o });

/** A model that answers every chunk with `items` and records what it was sent. */
function scripted(items: Array<{ title: string; date: string; time?: string }>) {
  const seen: string[] = [];
  setAi(new AiService([{ name: "scripted", chat: async (messages) => {
    seen.push(messages[messages.length - 1].content);
    return JSON.stringify({ items: items.map((i) => ({ kind: "deadline", title: i.title, date: i.date, time: i.time ?? "", evidence: i.date })) });
  } }]));
  return seen;
}

test.afterEach(() => setAi(new AiService([])));

test("chunks: at most 2500 characters on line boundaries, small overlap, capped", () => {
  const text = Array.from({ length: 400 }, (_, i) => `Line ${i} of the course outline with some words`).join("\n");
  const chunks = chunkText(text, 2500, 200, 6);
  assert.equal(chunks.length, 6);
  assert.ok(chunks.every((c) => c.length <= 2500));
  const lastLine = chunks[0].split("\n").pop() as string;
  assert.ok(chunks[1].startsWith(lastLine.slice(0, 10)) || chunks[1].includes(lastLine), "next chunk repeats the end of the previous one");
});

test("merge: agreement raises confidence (reviewed items stay at most 90); AI-only items are review-only; duplicates dropped", () => {
  const rules = [item({ title: "Midterm Exam", confidence: 88 }), item({ title: "Departure: Train 1-UP", date: "2026-11-07", confidence: 90, review: true })];
  const ai = [item({ title: "Midterm exam", confidence: 85 }), item({ title: "Train to Lahore departure", date: "2026-11-07" }), item({ title: "Library book return", date: "2026-11-20" }), item({ title: "Return library book", date: "2026-11-20" })];
  const merged = mergeDeadlines(rules, ai);
  assert.equal(merged.length, 3);
  assert.equal(merged[0].confidence, 93);
  assert.equal(merged[0].aiAgrees, true);
  assert.equal(merged[1].confidence, 90, "a ticket stays reviewed");
  assert.equal(merged[2].aiOnly, true);
  assert.ok(merged[2].confidence <= AI_ONLY_MAX && merged[2].confidence < 95);
});

test("AI pass: every chunk is read, invented dates are dropped, AI off returns nothing", async () => {
  const text = "Course notes\nLibrary book return by 20 November 2026.";
  const seen = scripted([{ title: "Return library book", date: "2026-11-20" }, { title: "Made-up exam", date: "2026-12-25" }]);
  const found = await aiDeadlines(text, "2026-10-05", TZ);
  assert.equal(seen.length, 1);
  assert.deepEqual(found.map((f) => f.date), ["2026-11-20"]);
  setAi(new AiService([]));
  assert.deepEqual(await aiDeadlines(text, "2026-10-05", TZ), []);
});

test("analyzeDocument runs the AI pass on documents the rules already understand; only masked text is sent", async () => {
  const seen = scripted([{ title: "Midterm exam", date: "2026-11-15", time: "10:00" }, { title: "Pay hostel fee", date: "2026-10-30" }]);
  const a = await analyzeDocument({ text: "Midterm Exam\nDate: 15 Nov 2026\nTime: 10 AM\nHostel fee due 30 October 2026. Call 0300-1234567", fileName: "n.txt", mimeType: "text/plain", docType: "SYLLABUS", language: "eng", tz: TZ, now: NOW });
  assert.equal(seen.length, 1);
  assert.doesNotMatch(seen[0], /0300-1234567/);
  const mid = a.deadlines.find((d) => /midterm/i.test(d.title));
  assert.equal(mid?.aiAgrees, true);
  assert.ok(a.deadlines.every((d) => !d.aiOnly || d.confidence < 95));
});

test("merge: the model reading a line the rules already read differently adds nothing", () => {
  const line = "Viva: Nov 23 - Nov 25, 2026";
  const rules = [item({ title: "Viva", date: "2026-11-25", source: line, rangeStart: "Nov 23, 2026" })];
  const merged = mergeDeadlines(rules, [item({ title: "Viva", date: "2026-11-23", source: line })]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].date, "2026-11-25");
  const flight = mergeDeadlines(
    [item({ title: "Departure: BOARDING PASS", date: "2026-10-14", time: "6:45 AM", source: "Date: 14 Oct 2026   Boarding: 06:15   Departure: 06:45", review: true, confidence: 90 })],
    [item({ title: "Flight Karachi → Islamabad (PK-301)", date: "2026-10-14", time: "6:15 AM", source: "Date: 14 Oct 2026   Boarding: 06:15" })],
  );
  assert.equal(flight.length, 1);
  assert.equal(flight[0].aiAgrees, true);
  assert.equal(flight[0].time, "6:45 AM");
});
