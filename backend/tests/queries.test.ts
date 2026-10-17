import test from "node:test";
import assert from "node:assert/strict";
import { Priority } from "@prisma/client";
import { parseQuery, type ParsedQuery } from "../src/modules/assistant/queries.js";
import { classesForDay, currentOrNextClass, mostUrgent, withRoom, type ClassSlot } from "../src/modules/assistant/queryAnswers.js";

type Row = [string, ParsedQuery | null];
type Lang = "en" | "ur" | "roman";

const due = (range: "today" | "tomorrow" | "week"): ParsedQuery => ({ kind: "due", range });
const whenDue = (ref: string): ParsedQuery => ({ kind: "when_due", ref });
const classes = (day: "today" | "tomorrow"): ParsedQuery => ({ kind: "classes", day });
const OVERDUE: ParsedQuery = { kind: "overdue" };
const URGENT: ParsedQuery = { kind: "urgent" };
const NEXT: ParsedQuery = { kind: "next_class" };
const WHERE: ParsedQuery = { kind: "where_class" };

const CASES: Record<string, Record<Lang, Row[]>> = {
  due: {
    en: [
      ["What's due today?", due("today")],
      ["what do I have tomorrow", due("tomorrow")],
      ["What do I have this week?", due("week")],
      ["anything due tomorrow?", due("tomorrow")],
      ["show me today's tasks", due("today")],
      ["which deadlines are this week", due("week")],
      ["What's on for tomorrow?", due("tomorrow")],
      ["list my assignments due this week", due("week")],
      ["today's deadlines", due("today")],
      ["What is due", due("today")],
    ],
    roman: [
      ["aaj kya due hai", due("today")],
      ["aaj kya hai?", due("today")],
      ["kal kya karna hai", due("tomorrow")],
      ["is hafte kya jama karna hai", due("week")],
      ["aj ka kaam kya hai", due("today")],
      ["kl kia due he", due("tomorrow")],
      ["iss hafte ke tasks batao", due("week")],
      ["kal ki deadlines", due("tomorrow")],
      ["aaj kya submit karna hai?", due("today")],
    ],
    ur: [
      ["اس ہفتے کیا جمع کرانا ہے", due("week")],
      ["آج کیا ہے", due("today")],
      ["کل کیا کرنا ہے؟", due("tomorrow")],
      ["آج کے کام بتائیں", due("today")],
      ["کل کیا جمع کرانا ہے", due("tomorrow")],
      ["اس ہفتے کے کام کون سے ہیں", due("week")],
      ["آج کون سا کام کرنا ہے", due("today")],
      ["کل کی ڈیڈ لائنز بتاؤ", due("tomorrow")],
    ],
  },
  when_due: {
    en: [
      ["When is the physics assignment due?", whenDue("physics assignment")],
      ["when's my essay due", whenDue("essay")],
      ["When are the lab reports due?", whenDue("lab reports")],
      ["what's the deadline for the calculus project", whenDue("calculus project")],
      ["When do I have to submit my history essay?", whenDue("history essay")],
      ["tell me the due date of the OOP assignment", whenDue("OOP assignment")],
      ["what is the database project deadline?", whenDue("database project")],
      ["when is chemistry quiz 2 due", whenDue("chemistry quiz 2")],
      ["When is the Software Engineering report due?", whenDue("Software Engineering report")],
    ],
    roman: [
      ["physics assignment kab due hai", whenDue("physics assignment")],
      ["physics assignment ki deadline kab hai", whenDue("physics assignment")],
      ["lab report kab jama karni hai?", whenDue("lab report")],
      ["meri essay kab tak submit karna hai", whenDue("essay")],
      ["OOP project ki last date kya hai", whenDue("OOP project")],
      ["maths ka assignment kab tak dena hai", whenDue("maths ka assignment")],
      ["english presentation ki deadline batao", whenDue("english presentation")],
      ["dbms quiz kb due he", whenDue("dbms quiz")],
    ],
    ur: [
      ["فزکس اسائنمنٹ کب جمع کرانی ہے", whenDue("فزکس اسائنمنٹ")],
      ["فزکس اسائنمنٹ کی ڈیڈ لائن کب ہے؟", whenDue("فزکس اسائنمنٹ")],
      ["میری لیب رپورٹ کب تک جمع کرنی ہے", whenDue("لیب رپورٹ")],
      ["انگلش مضمون کب جمع ہوگا", whenDue("انگلش مضمون")],
      ["پروجیکٹ کی ڈیڈلائن کیا ہے", whenDue("پروجیکٹ")],
      ["ریاضی کا ہوم ورک کب تک دینا ہے", whenDue("ریاضی کا ہوم ورک")],
      ["کیمسٹری رپورٹ کی ڈیڈ لائن بتائیں", whenDue("کیمسٹری رپورٹ")],
      ["اردو اسائنمنٹ کب جمع کروانی ہے", whenDue("اردو اسائنمنٹ")],
    ],
  },
  overdue: {
    en: [
      ["what's overdue", OVERDUE],
      ["What did I miss?", OVERDUE],
      ["show overdue tasks", OVERDUE],
      ["which tasks are late?", OVERDUE],
      ["Anything past due?", OVERDUE],
      ["what am I behind on", OVERDUE],
      ["list everything I missed", OVERDUE],
      ["Do I have any overdue assignments?", OVERDUE],
    ],
    roman: [
      ["kya reh gaya", OVERDUE],
      ["kya late ho gaya?", OVERDUE],
      ["konse kaam reh gaye", OVERDUE],
      ["kya kya miss ho gaya", OVERDUE],
      ["kaun se tasks late hain", OVERDUE],
      ["kuch reh gya kya?", OVERDUE],
      ["overdue kaam batao", OVERDUE],
      ["kya choot gaya mujhse", OVERDUE],
    ],
    ur: [
      ["کون سے کام لیٹ ہیں", OVERDUE],
      ["کیا رہ گیا؟", OVERDUE],
      ["کون سے کام رہ گئے", OVERDUE],
      ["کیا کچھ چھوٹ گیا", OVERDUE],
      ["لیٹ کام بتائیں", OVERDUE],
      ["کونسی اسائنمنٹ لیٹ ہے", OVERDUE],
      ["کس کام میں تاخیر ہے", OVERDUE],
      ["میرے کیا کام رہ گئے ہیں؟", OVERDUE],
    ],
  },
  urgent: {
    en: [
      ["What's my most urgent task?", URGENT],
      ["what is most important right now", URGENT],
      ["which task is top priority", URGENT],
      ["What should I do first?", URGENT],
      ["show my highest priority task", URGENT],
      ["anything urgent?", URGENT],
      ["tell me what's urgent", URGENT],
      ["what needs to be done urgently", URGENT],
    ],
    roman: [
      ["sab se zaroori kaam kya hai", URGENT],
      ["sabse zaruri task konsa hai?", URGENT],
      ["pehle kya karun", URGENT],
      ["sab se ahem kaam batao", URGENT],
      ["kya urgent hai", URGENT],
      ["sbse zarori kia he", URGENT],
      ["konsa kaam zaroori hai", URGENT],
      ["sab se pehle kya karna chahiye?", URGENT],
    ],
    ur: [
      ["سب سے ضروری کام کون سا ہے", URGENT],
      ["سب سے اہم کام کیا ہے؟", URGENT],
      ["پہلے کیا کروں", URGENT],
      ["کون سا کام فوری ہے", URGENT],
      ["ضروری کام بتائیں", URGENT],
      ["کیا کوئی ضروری کام ہے", URGENT],
      ["سب سے ضروری کیا ہے؟", URGENT],
      ["مجھے پہلے کیا کرنا چاہیے", URGENT],
    ],
  },
  classes: {
    en: [
      ["today's classes", classes("today")],
      ["What classes do I have tomorrow?", classes("tomorrow")],
      ["what lectures do I have today", classes("today")],
      ["Do I have class tomorrow?", classes("tomorrow")],
      ["show my classes for today", classes("today")],
      ["any classes tomorrow", classes("tomorrow")],
      ["which periods are today?", classes("today")],
      ["what classes do I have", classes("today")],
    ],
    roman: [
      ["kal ki classes", classes("tomorrow")],
      ["aaj konsi classes hain", classes("today")],
      ["kal kaun se lecture hain?", classes("tomorrow")],
      ["aj class hai kya", classes("today")],
      ["kl ki class batao", classes("tomorrow")],
      ["aaj ki classes", classes("today")],
      ["kya kal class hai?", classes("tomorrow")],
      ["aaj kitne lectures hain", classes("today")],
    ],
    ur: [
      ["آج کون سی کلاسیں ہیں", classes("today")],
      ["کل کی کلاسیں", classes("tomorrow")],
      ["کیا کل کلاس ہے؟", classes("tomorrow")],
      ["آج کی کلاسیں بتائیں", classes("today")],
      ["کل کون سا لیکچر ہے", classes("tomorrow")],
      ["آج کتنی کلاسز ہیں؟", classes("today")],
      ["کیا آج لیکچر ہے", classes("today")],
      ["کل کونسی کلاس ہے", classes("tomorrow")],
    ],
  },
  next_class: {
    en: [
      ["What's my next class?", NEXT],
      ["when is my next class", NEXT],
      ["next class?", NEXT],
      ["what is my upcoming lecture", NEXT],
      ["When's my next lecture?", NEXT],
      ["tell me my next class", NEXT],
      ["which class is next", NEXT],
      ["what time is my next class", NEXT],
    ],
    roman: [
      ["agli class kab hai", NEXT],
      ["agli class konsi hai?", NEXT],
      ["agla lecture kab he", NEXT],
      ["meri agli class kaun si hai", NEXT],
      ["agli class kitne baje hai", NEXT],
      ["class kab hai?", NEXT],
      ["next class konsi hai", NEXT],
      ["agle lecture ka batao", NEXT],
    ],
    ur: [
      ["اگلی کلاس کون سی ہے", NEXT],
      ["اگلی کلاس کب ہے؟", NEXT],
      ["میری اگلی کلاس کیا ہے", NEXT],
      ["اگلا لیکچر کب ہے", NEXT],
      ["اگلی کلاس کتنے بجے ہے", NEXT],
      ["کلاس کب ہے؟", NEXT],
      ["اگلی کلاس بتائیں", NEXT],
      ["اگلا لیکچر کون سا ہے؟", NEXT],
    ],
  },
  where_class: {
    en: [
      ["Where is my class?", WHERE],
      ["where is my class today", WHERE],
      ["Where's my next lecture?", WHERE],
      ["which room is my class in", WHERE],
      ["where is physics class tomorrow?", WHERE],
      ["what room is the lecture in", WHERE],
      ["where do I have class", WHERE],
      ["tell me where my class is", WHERE],
    ],
    roman: [
      ["class kahan hai", WHERE],
      ["meri class kahaan hai?", WHERE],
      ["agli class kidhar hai", WHERE],
      ["aaj lecture kahan he", WHERE],
      ["physics ki class kis room mein hai", WHERE],
      ["kal class kahan hogi", WHERE],
      ["lecture kidhr h", WHERE],
      ["class kahn hai?", WHERE],
    ],
    ur: [
      ["میری کلاس کہاں ہے", WHERE],
      ["کلاس کہاں ہے؟", WHERE],
      ["آج لیکچر کہاں ہے", WHERE],
      ["اگلی کلاس کہاں ہوگی", WHERE],
      ["کل کی کلاس کہاں ہے", WHERE],
      ["فزکس کی کلاس کس کمرے میں ہے", WHERE],
      ["کلاس کدھر ہے", WHERE],
      ["لیکچر کہاں ہوگا؟", WHERE],
    ],
  },
  negatives: {
    en: [
      ["Submit assignment due tomorrow", null],
      ["add physics class every Monday 9am", null],
      ["remind me about my class tomorrow", null],
      ["done", null],
      ["Physics assignment due Friday", null],
      ["I finished the lab report", null],
      ["schedule a study session tomorrow at 5", null],
      ["Can you add my calculus class on Tuesday?", null],
      ["mark the essay as completed", null],
      ["what's the weather today?", null],
      ["Call mom tomorrow", null],
      ["what's due next week", null],
    ],
    roman: [
      ["kal assignment jama karni hai", null],
      ["mujhe kal class ke liye yaad dilana", null],
      ["physics assignment ho gaya", null],
      ["aaj 5 baje gym jana hai", null],
      ["har peer ko physics class add karo", null],
      ["kal lecture hai 9 baje", null],
      ["essay submit kar diya", null],
      ["mujhe kal subah yaad dila dena", null],
      ["kal ammi ko call karna hai", null],
      ["assignment done", null],
      ["agle hafte kya due hai", null],
    ],
    ur: [
      ["کل اسائنمنٹ جمع کرانی ہے", null],
      ["مجھے کل کلاس کے لیے یاد دلا دیں", null],
      ["فزکس اسائنمنٹ مکمل ہو گئی", null],
      ["آج شام پانچ بجے میٹنگ ہے", null],
      ["ہر پیر کو کلاس شامل کریں", null],
      ["کل صبح لیکچر ہے", null],
      ["رپورٹ جمع کر دی", null],
      ["امی کو کل فون کرنا ہے", null],
      ["پیر کو ٹیسٹ ہے", null],
      ["یہ کام ہٹا دو", null],
    ],
  },
};

for (const [kind, langs] of Object.entries(CASES)) {
  for (const [lang, rows] of Object.entries(langs)) {
    test(`queries: ${lang} ${kind}`, () => {
      for (const [text, expected] of rows) assert.deepEqual(parseQuery(text), expected, text);
    });
  }
}

test("queries: every question above reaches query_tasks through the NLU rules (no earlier rule steals it, no LLM)", async () => {
  const { understand } = await import("../src/modules/assistant/nlu.js");
  const { opts } = await import("./fixtures.js");
  const misrouted: string[] = [];
  for (const byLang of Object.values(CASES)) {
    for (const rows of Object.values(byLang)) {
      for (const [text, expected] of rows) {
        if (!expected) continue;
        const u = await understand(text, { ...opts, history: [], allowLlm: false });
        if (u.intent !== "query_tasks") misrouted.push(`${text} → ${u.intent}`);
      }
    }
  }
  assert.deepEqual(misrouted, []);
});

test("queries: most urgent = overdue, then due within 24 h, then priority; top 3", () => {
  const now = new Date("2026-10-05T05:00:00Z");
  const h = (n: number) => new Date(now.getTime() + n * 3600000);
  const tasks = [
    { id: "low-later", dueAt: h(72), priority: Priority.LOW },
    { id: "urgent-later", dueAt: h(48), priority: Priority.URGENT },
    { id: "soon", dueAt: h(5), priority: Priority.LOW },
    { id: "overdue", dueAt: h(-2), priority: Priority.LOW },
    { id: "no-date-high", dueAt: null, priority: Priority.HIGH },
  ];
  assert.deepEqual(mostUrgent(tasks, now).map((t) => t.id), ["overdue", "soon", "urgent-later"]);
  assert.deepEqual(mostUrgent([], now), []);
});

test("queries: classes show time and room; the room is never printed twice; none or no room", () => {
  const at = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 5, h, m));
  const clock = (d: Date) => `${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  const slots: ClassSlot[] = [
    { title: "Physics", location: "B-12", start: at(9), end: at(10) },
    { title: "Maths (Room C-2)", location: "C-2", start: at(11), end: at(12) }, // old title style + backfilled location
    { title: "English", location: null, start: at(14), end: at(15) },
  ];
  assert.equal(withRoom("Physics", "B-12"), "Physics, Room B-12");
  assert.equal(withRoom("Maths (Room C-2)", "C-2"), "Maths (Room C-2)");
  assert.equal(withRoom("Lab work", "Lab 3"), "Lab work, Lab 3");
  assert.equal(withRoom("English", null), "English");
  assert.equal(classesForDay(slots, "today", clock), "Classes today:\n• 9:00 Physics, Room B-12\n• 11:00 Maths (Room C-2)\n• 14:00 English");
  assert.equal(classesForDay([], "tomorrow", clock), "No classes tomorrow.");
  // in progress → "now, until"; the rest of today follows
  assert.equal(currentOrNextClass(slots, at(9, 30), clock, "next"), "Now: Physics now, until 10:00, Room B-12.\nLater today:\n• 11:00 Maths (Room C-2)\n• 14:00 English");
  assert.match(currentOrNextClass(slots, at(9, 30), clock, "where"), /^Physics: Room B-12, now, until 10:00\./);
  // between classes → the next one; the old-style title is not followed by the room again
  assert.match(currentOrNextClass(slots, at(10, 30), clock, "where"), /^Maths \(Room C-2\) at 11:00\.\n/);
  assert.match(currentOrNextClass(slots, at(13), clock, "where"), /^English at 14:00\. The room isn't in your timetable\.$/);
  assert.equal(currentOrNextClass(slots, at(16), clock, "next"), "No more classes today.");
  assert.equal(currentOrNextClass([], at(9), clock, "next"), "No classes today.");
});
