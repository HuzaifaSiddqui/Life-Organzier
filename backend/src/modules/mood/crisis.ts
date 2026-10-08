/**
 * Crisis detection (FR-MH safety). Deterministic on purpose — never route this through the LLM.
 *
 * Covers English, Roman Urdu and Urdu script. It deliberately errs towards catching more: a false
 * positive shows support resources once; a false negative can miss someone at risk. Obvious benign
 * uses (negated statements, "suicide squad", "my phone died", "jaan de dunga tere liye") are excluded.
 *
 * Every phrase below should be reviewed by a native Urdu speaker before release.
 */

type Phrase = {
  /** Written in natural spelling; repeated Latin letters are collapsed at load time (see `collapse`). */
  re: string;
  /** Where a negation word cancels the match: before it (English) or right after it (Urdu word order). */
  negation?: "before" | "after";
  /** Benign continuations, e.g. "suicide prevention". */
  unless?: RegExp;
};

/** "jeeeena" → "jena", "chahtaaa" → "chahta", "kill" → "kil": spelling variants converge. */
function collapse(s: string): string {
  return s.replace(/([a-z])\1+/g, "$1");
}

/** Lowercase, unify Urdu letter variants, drop diacritics/tatweel/ZWNJ, collapse repeats, keep word gaps. */
export function normalizeForCrisis(text: string): string {
  const t = text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[ً-ٰٟـ‌‍]/g, "") // harakat, superscript alef, tatweel, ZWNJ/ZWJ
    .replace(/[يى]/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[هۂۃة]/g, "ہ")
    .replace(/ئی/g, "ی") // کوئی → کوی
    .replace(/ئ/g, "ی")
    .replace(/ؤ/g, "و")
    .replace(/[آأإ]/g, "ا")
    .replace(/[’'`´]/g, "")
    .replace(/[^a-z0-9؀-ۿ]+/g, " ");
  return collapse(t).replace(/\s+/g, " ").trim();
}

// Shared Roman Urdu fragments (natural spelling; collapsed with the phrase).
const WANT = "cha?h?t(?:[aiey]|ay)"; // chahta / chahti / chahte / chahty / chahtay / chata
const NOT = "(?:nahi?n?|nai|nhi?n?|ni)"; // nahi / nahin / nai / nhi / ni
const LIFE = "z[iy]?nd[ae]?g[iye]"; // zindagi / zindgi / zndgi / zindagee
const END = "kh?a?t[ae]?m"; // khatam / khatm / khtm / khattam
const SELF = "(?:khu?d|apne? aap)"; // khud / apne aap / apna aap

const ROMAN: Phrase[] = [
  { re: `khu?d ?k[aeu]?h?[aeu]?sh[iy]`, negation: "after" }, // khudkushi, khud kushi, khudkashi, khudkhushi
  { re: `marn[ae] ${WANT}` }, // marna chahta/chahti
  { re: `mar jana ${WANT}` }, // mar jana chahta
  { re: `mar ja(?:un|on|na)(?:ga|gi)?` }, // mar jaun, mar jaon, mar jaana, mar jaunga
  { re: `marn[ae] (?:ka|ko) (?:dil|ma?n|je|ji)` }, // marne ka dil/man, marne ko jee chahta
  { re: `mu?j?h?e marna h(?:ai|y|e)` }, // mujhe marna hai
  { re: `j[ie]n[ae] ${NOT} ${WANT}` }, // jeena / jina nahi chahta/chahti
  { re: `j[ie]n[ae] (?:ka|ki) (?:koi )?(?:fa[iy]?da|fyda|maqsad|matlab|wajah) ${NOT}` }, // jeene ka koi faida nahi
  { re: `${LIFE} (?:ko )?${END}` }, // zindagi khatam, zindagi ko khatam
  { re: `${LIFE} se (?:bezar|bezaar)` }, // zindagi se bezaar
  { re: `${LIFE} (?:ka|ki) (?:koi )?(?:fa[iy]?da|maqsad|matlab) ${NOT}` }, // zindagi ka koi faida nahi
  { re: `apni jaa?n (?:le|lun|lon|lena|de|dena|de dun)` }, // apni jaan le lun (requires "apni")
  { re: `${SELF} ko (?:ma?r(?:na|ne|dun|don|du)?|${END}|nuq?k?sa?n|zakhmi|zakhm|hurt|kat)` }, // khud ko maar dun, apne aap ko nuqsan
  { re: `sab (?:kuch )?${END} kar (?:dun|don|du|dena|dunga|dungi)` }, // sab khatam kar dun
];

const URDU: Phrase[] = [
  { re: "خود ?کشی", negation: "after" }, // خودکشی / خود کشی
  { re: "مرنا ?چاہت[اےی]" }, // مرنا چاہتا/چاہتی/چاہتے
  { re: "مر ?جانا ?چاہت[اےی]" }, // مر جانا چاہتا
  { re: "مر ?جاوں" }, // مر جاؤں (ؤ normalised to و)
  { re: "مرنے (?:کو|کا) (?:دل|من|جی)" }, // مرنے کو دل / مرنے کا من
  { re: "جینا ?نہیں ?چاہت[اےی]" }, // جینا نہیں چاہتا/چاہتی
  { re: "جینے کا (?:کوی )?(?:فایدہ|فاہدہ|مقصد) نہیں" }, // جینے کا کوئی فائدہ نہیں
  { re: "زندگی (?:کو )?ختم" }, // زندگی ختم
  { re: "زندگی سے بیزار" }, // زندگی سے بیزار
  { re: "اپنی جان (?:لے|لوں|لینا|دے)" }, // اپنی جان لے لوں
  { re: "(?:خود|اپنے اپ) کو (?:مار(?:نا|وں|دوں)?|ختم|نقصان|زخمی)" }, // خود کو مار دوں / اپنے آپ کو نقصان
];

const ENGLISH: Phrase[] = [
  { re: "kill myself", negation: "before" },
  { re: "end (?:my|it) (?:own )?life|end it all|take my (?:own )?life", negation: "before" },
  { re: "suicidal" },
  { re: "suicide", negation: "before", unless: /^ ?(?:squad|prevention|awarenes|rates?|statistics|bomb\w*)\b/ },
  { re: "(?:want|wanna|wish) (?:to )?die|wish i (?:was|were) dead|better off dead", negation: "before" },
  { re: "dont want to (?:live|be alive|wake up)|no reason to live|not worth living|no point (?:in )?living|cant go on living" },
  { re: "self ?harm|hurt(?:ing)? myself|cut(?:ing)? myself|hang myself|overdose", negation: "before" },
  { re: "jump off (?:a |the )?(?:bridge|building|roof)" },
];

const NEGATION_BEFORE = /\b(?:not|never|dont|do not|didnt|wont|wouldnt|would never|no longer)(?: \w+){0,2} $/;
const NEGATION_AFTER = /^ (?:\S+ )?(?:nahi?n?|nai|nhi?n?|ni|نہیں|نہ)(?= |$)/u;

type Compiled = { re: RegExp; negation?: "before" | "after"; unless?: RegExp };

const compile = (list: Phrase[], latin: boolean): Compiled[] =>
  list.map((p) => ({ re: new RegExp(latin ? collapse(p.re) : p.re, "gu"), negation: p.negation, unless: p.unless }));

const PATTERNS: Compiled[] = [...compile(ENGLISH, true), ...compile(ROMAN, true), ...compile(URDU, false)];

/** Phrase list for human review (natural spelling). */
export const CRISIS_PHRASES = { english: ENGLISH.map((p) => p.re), romanUrdu: ROMAN.map((p) => p.re), urdu: URDU.map((p) => p.re) };

export function detectCrisis(text: string): boolean {
  const t = ` ${normalizeForCrisis(text)} `;
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    for (const m of t.matchAll(p.re)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      // Whole words only (normalised text is single-space separated; \b doesn't work for Urdu script).
      if (t[start - 1] !== " " || t[end] !== " ") continue;
      const after = t.slice(end);
      if (p.unless?.test(after)) continue;
      if (p.negation === "before" && NEGATION_BEFORE.test(t.slice(0, start))) continue;
      if (p.negation === "after" && NEGATION_AFTER.test(after)) continue;
      return true;
    }
  }
  return false;
}

// VERIFY BEFORE RELEASE: confirm every number against an official source before shipping.
// 1122 and 115 were already used in the app (also in mobile AssistantCards "resources" card).
export const CRISIS_RESOURCES = {
  /** Rescue 1122 — Pakistan emergency services. */
  emergency: "1122",
  /** Edhi Foundation helpline. */
  edhi: "115",
  /** PLACEHOLDER: a verified Pakistani mental-health helpline. Leave null until a team member verifies one. */
  mentalHealthHelpline: null as string | null,
};

export function crisisResponse(language = "en"): string {
  const r = CRISIS_RESOURCES;
  if (language === "ur") {
    return [
      "مجھے بہت افسوس ہے کہ آپ اس سے گزر رہے ہیں۔ آپ کو یہ اکیلے نہیں سہنا۔",
      "میں ایک پروڈکٹیویٹی اسسٹنٹ ہوں، کاؤنسلر نہیں، اس لیے براہِ کرم ابھی کسی ایسے شخص سے رابطہ کریں جو مدد کر سکے:",
      `• اگر آپ فوری خطرے میں ہیں تو ایمرجنسی نمبر پر کال کریں (${r.emergency} یا ${r.edhi})۔`,
      ...(r.mentalHealthHelpline ? [`• ذہنی صحت ہیلپ لائن: ${r.mentalHealthHelpline}`] : []),
      "• کسی ایسے شخص سے بات کریں جس پر آپ بھروسہ کرتے ہیں — دوست، گھر والے یا استاد۔",
      "• کوئی مستند ماہرِ نفسیات یا آپ کی یونیورسٹی کا کاؤنسلنگ سینٹر آپ کی مدد کر سکتا ہے۔",
      "کیا میں آج کے غیر ضروری کام ہٹا دوں تاکہ آپ اپنا خیال رکھ سکیں؟",
    ].join("\n");
  }
  return [
    "I'm really sorry you're going through this. You don't have to handle it alone.",
    "I'm a productivity assistant, not a counsellor, so please reach out to someone who can help right now:",
    `• If you're in immediate danger, call your local emergency number (${r.emergency} or ${r.edhi} in Pakistan).`,
    ...(r.mentalHealthHelpline ? [`• Mental-health helpline: ${r.mentalHealthHelpline}`] : []),
    "• Talk to someone you trust — a friend, family member, or teacher.",
    "• A licensed mental-health professional or your university counselling centre can support you.",
    "I'm here to keep things light for you — want me to clear today's non-urgent tasks so you can take care of yourself?",
  ].join("\n");
}
