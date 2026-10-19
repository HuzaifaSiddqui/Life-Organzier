/**
 * Deterministic parser for deadline and class QUESTIONS (English, Urdu script, Roman Urdu).
 * Pure: no I/O, no LLM. Statements that create or change things return null so the normal
 * task/routine pipeline handles them.
 */

export type ParsedQuery =
  | { kind: "due"; range: "today" | "tomorrow" | "week" }
  | { kind: "when_due"; ref: string }
  | { kind: "overdue" }
  | { kind: "urgent" }
  | { kind: "classes"; day: "today" | "tomorrow" }
  | { kind: "next_class" }
  | { kind: "where_class" };

/**
 * Urdu letter variants and diacritics, same mapping as normalizeForCrisis (mood/crisis.ts).
 * Not reused directly: that one also collapses repeated Latin letters ("assignment" -> "asignment"),
 * which would corrupt the when_due ref. Letters only, so it is also safe on regex sources below.
 */
function unify(s: string): string {
  return s
    .normalize("NFC")
    .replace(/[ً-ٰٟـ‌‍]/g, "") // harakat, superscript alef, tatweel, ZWNJ/ZWJ
    .replace(/[يى]/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[هۂۃة]/g, "ہ")
    .replace(/ئی/g, "ی")
    .replace(/ئ/g, "ی")
    .replace(/ؤ/g, "و")
    .replace(/[آأإ]/g, "ا");
}

/** Lowercase, unify Urdu letters, drop "'s" ("what's" -> "what"), punctuation -> space. */
function normalize(text: string): string {
  return unify(text.toLowerCase())
    .replace(/['’`´]s\b/g, "")
    .replace(/['’`´]/g, "")
    .replace(/[؟۔،]/g, " ")
    .replace(/[^a-z0-9؀-ۿ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Same word splits as normalize() but keeps case and letters, so the when_due ref reads as written. */
function asWritten(text: string): string[] {
  return text
    .normalize("NFC")
    .replace(/[ً-ٰٟـ‌‍]/g, "")
    .replace(/['’`´]s\b/gi, "")
    .replace(/['’`´]/g, "")
    .replace(/[؟۔،]/g, " ")
    .replace(/[^A-Za-z0-9؀-ۿ]+/g, " ")
    .trim()
    .split(/\s+/);
}

/** True when any alternative appears as whole word(s) in normalised text. */
function has(t: string, alts: string): boolean {
  return new RegExp(`(?:^| )(?:${unify(alts)})(?= |$)`).test(t);
}

// --- Vocabulary (natural spelling; Urdu is unified before matching) ---
const TODAY = "today|tonight|aaj|aj|آج";
const TOMORROW = "tomorrow|tmrw|tmr|tomorow|kal|kl|کل";
const THIS_WEEK = "(?:this|the|is|iss) (?:week|hafte|haftay|hafta)|rest of the week|اس ہفتے|اس ہفتہ";
const NEXT_WEEK = "next week|agle (?:hafte|haftay)|agla hafta|اگلے ہفتے";
const CLASS = "class|classes|clas|lecture|lectures|lec|period|periods|کلاس|کلاسیں|کلاسز|لیکچر|لیکچرز|پیریڈ";
const WHERE = "where|wheres|kahan|kahaan|kahn|kidhar|kidhr|which room|what room|kis room|kis kamre|کہاں|کدھر|کس کمرے";
const NEXT = "next|upcoming|agli|agle|agla|اگلی|اگلا|اگلے";
const WHEN = "when|whens|what time|kab|kb|kitne baje|kis waqt|کب|کتنے بجے|کس وقت";
const DUE_WORD =
  "due|deadline|deadlines|due date|last date|submit|submission|submissions|jama|jamaa|جمع|ڈیو|ڈیڈ ?لائن|ڈیڈ ?لائنز|سبمٹ|آخری تاریخ";
/** Words that make a dated question about the user's own workload ("what do I have today"). */
const WORKLOAD =
  "have|got|on|planned|plan|schedule|agenda|pending|task|tasks|todo|to do|work|homework|assignment|assignments|" +
  "kaam|kam|karna|karni|krna|krni|kya (?:h|he|hai|hay|hy)|kia (?:h|he|hai|hay|hy)|" +
  "کام|کرنا|کرنی|کیا ہے|پلان";
const URGENT =
  "most urgent|most important|top priority|highest priority|urgent|urgently|priority|first|" +
  "(?:sab ?se|sb ?se) (?:zaroori|zaruri|zarori|zaroory|ahem|aham|important|urgent|pehle)|zaroori|zaruri|zarori|pehle kya|" +
  "سب سے ضروری|سب سے اہم|ضروری|فوری|پہلے کیا";
const OVERDUE =
  "overdue|over due|past due|late|missed|miss|behind|" +
  "(?:reh|rah|rh) (?:gaya|gaye|gayi|gai|gya|gye)|(?:choot|chhoot|chut|chhut) (?:gaya|gaye|gayi|gya)|miss ho|late ho|" +
  "لیٹ|رہ گیا|رہ گئے|رہ گئی|چھوٹ گیا|چھوٹ گئے|تاخیر|اوور ڈیو";

// --- Is this a request for information? ---
const QUESTION_WORDS =
  "what|whats|which|when|whens|where|wheres|show|list|tell|give|any|anything|do i|have i|is there|are there|how many|" +
  "kya|kia|kiya|kab|kb|kahan|kahaan|kahn|kidhar|kidhr|kis|kitne|kitni|kitna|kaun|kon|konsi|kaunsi|konsa|kaunsa|konse|kaunse|" +
  "batao|btao|bata|batain|bataen|batayen|dikhao|dikha|" +
  "کیا|کب|کہاں|کدھر|کون|کونسی|کونسا|کونسے|کس|کتنے|کتنی|کتنا|بتا\\S*|دکھا\\S*";
/** Bare noun phrases also ask: "today's classes", "kal ki classes", "deadlines this week". */
const BARE_DAY = `${TODAY}|${TOMORROW}|${THIS_WEEK}|next|agli|اگلی`;
const BARE_NOUN = `${CLASS}|deadlines|tasks|kaam|assignments|due|plan|schedule|کام|ڈیڈ ?لائنز`;
const BARE = [
  new RegExp(unify(`^(?:my |meri |mere |میری |میرے )?(?:${BARE_DAY})(?: ki| ke| ka| کی| کے| کا)? (?:${BARE_NOUN})$`)),
  new RegExp(unify(`^(?:my )?(?:${BARE_NOUN}) (?:for )?(?:${BARE_DAY})$`)),
];

// --- Statements that create or change things ---
const VETO_START = /^(?:please |pls |plz |can you |could you |hey )?(?:add|create|schedule|set|make|delete|remove|mark|cancel|move|reschedule|postpone|put|save|log|new)(?= |$)/;
const VETO_ANY =
  "remind(?! me (?:what|which|when|where))(?: me)?|reminder|(?<!be |get |got )(?:done|completed|finished)|i submitted|" +
  "yaa?d (?:dila|karwa|krwa)\\S*|add (?:kar|kr)\\S*|daal do|dal do|bana do|bana dein|set (?:kar|kr)\\S*|hata do|" +
  "delete (?:kar|kr)\\S*|cancel (?:kar|kr)\\S*|یاد دلا\\S*|شامل کر\\S*|بنا دو|ہٹا دو|مکمل";

// --- when_due: capture the task/course name (group 1) ---
const WHEN_DUE: RegExp[] = [
  // "when is the physics assignment due", "when's my essay due"
  /^(?:so |and |hey )?(?:when|whens)(?: is| are| s)? (.+?) due(?: date)?(?: again)?$/,
  // "when do I have to submit the lab report"
  /(?:when|what time) (?:do|should|must) i (?:have to |need to |got to )?(?:submit|hand in|turn in) (.+)$/,
  // "what's the deadline for the essay", "tell me the due date of my project"
  /(?:deadline|due date|last date) (?:for|of|on) (.+)$/,
  // "what is the physics project deadline"
  /^(?:what is|whats|what|when is|whens|when)(?: the)? (.+?) deadline$/,
  // "physics assignment ki deadline kab hai", "essay ki last date batao"
  /^(.+?) (?:ki|ka|ke) (?:deadline|due date|last date|aa?khri (?:tareekh|tarikh)) (?:kab|kb|kya|kia|batao|btao|bata do|bataen|batayen)(?: .*)?$/,
  // "physics assignment kab due hai", "lab report kab tak jama karni hai"
  /^(.+?) (?:kab|kb) (?:tak )?(?:due|jama|jamaa|submit|dena|deni|dene)(?: .*)?$/,
  // "فزکس اسائنمنٹ کی ڈیڈ لائن کب ہے"
  new RegExp(unify("^(.+?) (?:کی|کا|کے) (?:ڈیڈ ?لائن|آخری تاریخ|ڈیو ڈیٹ) (?:کب|کیا|بتا\\S*)(?: .*)?$")),
  // "فزکس اسائنمنٹ کب جمع کرانی ہے"
  new RegExp(unify("^(.+?) کب (?:تک )?(?:جمع|ڈیو|سبمٹ|دینی|دینا)(?: .*)?$")),
];
const REF_LEAD = new RegExp(unify("^(?:(?:the|my|meri|mera|mere|apni|apna|apne|میری|میرا|میرے|اپنی|اپنا|اپنے) )+"));
const REF_REJECT = "what|whats|which|when|where|kya|kia|kab|kahan|کیا|کب|کہاں";
const REF_TAIL =new RegExp(unify(" (?:ki|ka|ke|کی|کا|کے)$"));

function whenDueRef(t: string, text: string): string | null {
  for (const re of WHEN_DUE) {
    const m = re.exec(t);
    if (!m) continue;
    const ref = m[1].replace(REF_LEAD, "").replace(REF_TAIL, "").trim();
    // Map the matched words back onto the user's own spelling (same word positions).
    const start = ` ${t} `.indexOf(` ${ref} `);
    const from = start <= 0 ? 0 : t.slice(0, start - 1).split(" ").length;
    const written = asWritten(text).slice(from, from + ref.split(" ").length).join(" ");
    // A bare day or question word is not a task name ("kal kab due hai", "what is due").
    if (!ref || new RegExp(`^(?:${unify(`${TODAY}|${TOMORROW}`)})$`).test(ref) || has(ref, REF_REJECT)) continue;
    return written || ref;
  }
  return null;
}

export function parseQuery(text: string): ParsedQuery | null {
  const t = normalize(text);
  if (!t) return null;
  if (VETO_START.test(t) || has(t, VETO_ANY)) return null;
  const asks = /[?؟]/.test(text) || has(t, QUESTION_WORDS) || BARE.some((re) => re.test(t));
  if (!asks) return null;

  const isToday = has(t, TODAY);
  const isTomorrow = has(t, TOMORROW);
  const dueWord = has(t, DUE_WORD);

  if (has(t, CLASS) && !dueWord) {
    if (has(t, WHERE)) return { kind: "where_class" };
    // "agli class kab hai"; a plain "class kab hai" with no day also means the next one.
    if (has(t, NEXT) || (has(t, WHEN) && !isToday && !isTomorrow)) return { kind: "next_class" };
    return { kind: "classes", day: isTomorrow && !isToday ? "tomorrow" : "today" };
  }
  if (has(t, URGENT)) return { kind: "urgent" };
  if (has(t, OVERDUE)) return { kind: "overdue" };

  const ref = whenDueRef(t, text);
  if (ref) return { kind: "when_due", ref };

  // ponytail: "next week" has no range yet; return null rather than answer for the wrong week.
  if (has(t, NEXT_WEEK)) return null;
  const range = has(t, THIS_WEEK) ? "week" : isTomorrow ? "tomorrow" : isToday ? "today" : null;
  if (range && (dueWord || has(t, WORKLOAD))) return { kind: "due", range };
  if (!range && dueWord) return { kind: "due", range: "today" };
  return null;
}
