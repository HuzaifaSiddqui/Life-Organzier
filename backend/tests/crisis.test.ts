import assert from "node:assert/strict";
import test from "node:test";
import type { Conversation, User, UserSettings } from "@prisma/client";
import { handleText, type Turn } from "../src/modules/assistant/dialogue.js";
import { emptyState } from "../src/modules/assistant/types.js";
import { crisisForText, crisisPayload, crisisResponse, CRISIS_RESOURCES, detectCrisis, normalizeForCrisis } from "../src/modules/mood/crisis.js";

const POSITIVE: Record<string, string[]> = {
  english: [
    "I want to kill myself",
    "i wanna die",
    "I've been having suicidal thoughts",
    "thinking about suicide again",
    "I don't want to live anymore",
    "I want to end my life",
    "everyone would be better off dead without me",
    "I keep hurting myself",
    "I've been cutting myself",
    "there's no reason to live",
    "I just want to end it all",
    "I'm going to kill myself if I fail",
  ],
  romanUrdu: [
    "main khudkushi kar lunga",
    "khud kushi ka soch raha hun",
    "khudkashi karna chahti hun",
    "mujhe marna hai",
    "main marna chahta hun",
    "marna chahti hoon",
    "maaarna chahtaaa hun yaar",
    "mar jana chahta hun",
    "dil karta hai mar jaun",
    "marne ko dil karta hai",
    "jeena nahi chahta",
    "jina nahi chahti ab",
    "jeene ka koi faida nahi",
    "meri zindagi khatam",
    "zindagi ko khatam kar dun",
    "zindagi se bezaar ho gaya hun",
    "apni jaan le lun ga",
    "khud ko maar dun",
    "apne aap ko nuqsan pohanchana chahta hun",
  ],
  urdu: [
    "میں خودکشی کرنا چاہتا ہوں",
    "خود کشی کا سوچ رہا ہوں",
    "میں مرنا چاہتی ہوں",
    "دل کرتا ہے مر جاؤں",
    "مرنے کو دل کرتا ہے",
    "اب جینا نہیں چاہتا",
    "جینے کا کوئی فائدہ نہیں",
    "میری زندگی ختم ہو گئی",
    "اپنی جان لے لوں گا",
    "خود کو مار دوں",
    "اپنے آپ کو نقصان پہنچانا چاہتا ہوں",
  ],
};

const BENIGN = [
  // negated
  "I don't want to die",
  "I would never kill myself",
  "main kabhi khudkushi nahi karunga",
  "marna nahi chahta, bas thak gaya hun",
  "میں خودکشی نہیں کروں گا",
  // everyday uses of the same words
  "my phone died",
  "this exam is killing me",
  "I'm dying to see the new movie",
  "watching Suicide Squad tonight",
  "write an essay on suicide prevention",
  "mera phone mar gaya",
  "jaan de dunga tere liye",
  "ye kaam khatam karna hai",
  "zindagi bohat achi hai",
  "jeena seekh raha hun",
  "زندگی بہت اچھی ہے",
  "kaam khatam kar ke marna hai sone",
  "Remind me to call Ali tomorrow at 5 PM",
];

for (const [form, phrases] of Object.entries(POSITIVE)) {
  test(`crisis: detects ${form} phrasing`, () => {
    for (const p of phrases) assert.equal(detectCrisis(p), true, `missed: ${p}`);
  });
}

test("crisis: negated and everyday phrasing is not flagged", () => {
  for (const p of BENIGN) assert.equal(detectCrisis(p), false, `false positive: ${p}`);
});

// Hopelessness wording (English only): each phrase needs its object.
const HOPELESS = [
  "I feel like giving up on everything",
  "honestly I'm giving up on life",
  "I just want to give up on it all",
  "I gave up on myself",
  "givin up on everything",
  "Giving Up On Everything.",
  "I can't go on anymore",
  "cant go on anymore",
  "I can’t go on anymore",
  "I CAN'T GO ON ANYMORE!!!",
  "i cant go on like this",
  "I cannot go on any longer",
  "there's no point in anything",
  "no point anymore...",
  "everyone would be better off without me",
  "they'd be happier without me",
  "I don't want to be here anymore",
  "I just want to disappear",
  "i wanna disappear",
  "I wish I could disappear",
  "I'm tired of living",
  "so tired of life",
  "I'm tired of being alive",
  "I wish I was gone",
  "I wish I were never born",
  "I wish I had never been born",
  "I'm a burden",
  "I am such a burden to everyone",
];
const NOT_HOPELESS = [
  "I'm giving up on this bug",
  "giving up sugar this month",
  "giving up on the diet",
  "I give up",
  "I give up, this puzzle is too hard",
  "I can't go on the trip tomorrow",
  "can't go on Friday, move it",
  "no point in rushing the report",
  "there's no point arguing",
  "the team is better off without the old process",
  "the song sounds better without me singing",
  "I don't want to be here when the guests arrive",
  "I'm not giving up on life",
  "never give up on everything",
  "I want the stain to disappear",
  "make the bug disappear",
  "I'm tired of living on instant noodles",
  "tired of living in this city",
  "I'm tired of my life admin, help me plan",
  "I'm not a burden",
  // Deliberately not covered: too common about homework and tasks.
  "can't take it anymore",
  "I can't do this anymore",
  "what's the point",
];

test("crisis: hopelessness wording with an object is detected (English)", () => {
  for (const p of HOPELESS) assert.equal(detectCrisis(p), true, `missed: ${p}`);
});

test("crisis: hopelessness words without their object, negated, or about tasks are not flagged", () => {
  for (const p of NOT_HOPELESS) assert.equal(detectCrisis(p), false, `false positive: ${p}`);
});

test("crisis: behaviour kept as before", () => {
  assert.equal(detectCrisis("I'm not suicidal"), true, "unchanged: 'suicidal' has no negation guard");
  assert.equal(detectCrisis("I can't go on like this without coffee, haha"), true, "accepted false positive: resources shown once");
});

test("crisis: normalisation collapses spelling variants and Urdu letter forms", () => {
  assert.equal(normalizeForCrisis("JEEEENA   Nahiii"), "jena nahi");
  assert.equal(normalizeForCrisis("مر جاؤں"), "مر جاوں");
  assert.equal(normalizeForCrisis("زِندگی"), "زندگی");
});

test("crisis: response follows the language setting and only lists configured resources", () => {
  const en = crisisResponse("en");
  const ur = crisisResponse("ur");
  assert.match(en, /emergency number/);
  assert.match(ur, /[؀-ۿ]/);
  for (const r of [en, ur]) {
    assert.ok(r.includes(CRISIS_RESOURCES.emergency) && r.includes(CRISIS_RESOURCES.edhi));
  }
  assert.equal(crisisResponse("fr"), en);
});

test("crisis: checked before any open question, NLU or handler in the dialogue", async () => {
  // A pending clarification would normally capture the next message; the crisis check must win and
  // return without touching the database or the model.
  const turn: Turn = {
    user: { id: "u1" } as User,
    settings: { language: "ur", tier: "FREE", contexts: [], timezone: "Asia/Karachi" } as unknown as UserSettings,
    tz: "Asia/Karachi",
    now: new Date(),
    todayYmd: "2026-10-08",
    channel: "APP",
    source: "CHAT",
    conversation: { id: "c1" } as Conversation,
    state: { ...emptyState(), pending: { kind: "clarify_intent", text: "x" } },
    history: [],
    task: { userId: "u1", tz: "Asia/Karachi" },
    learned: [],
    memoriesUsed: 0,
  };
  const out = await handleText(turn, "remind me tomorrow, main marna chahta hun");
  assert.equal(out.intent, "crisis");
  assert.equal(turn.state.pending, null);
  assert.equal(out.content, crisisResponse("ur"));
  assert.deepEqual(out.cards, [{ type: "resources", resources: crisisPayload("ur").resources }]);
  assert.match(out.actions?.[0]?.label ?? "", /[\u0600-\u06FF]/);
});

test("crisis: mood-log notes get the same check and a localised payload", () => {
  assert.equal(crisisForText(undefined), null);
  assert.equal(crisisForText("tired after exams, need sleep"), null);
  const en = crisisForText("feeling calm but honestly I want to end my life", "en");
  assert.ok(en);
  assert.equal(en.message, crisisResponse("en"));
  assert.deepEqual(en.resources.map((r) => r.phone), [CRISIS_RESOURCES.emergency, CRISIS_RESOURCES.edhi]);
  const ur = crisisForText("jeena nahi chahti", "ur");
  assert.ok(ur && /[؀-ۿ]/.test(ur.message) && /[؀-ۿ]/.test(ur.resources[0].label));
});
