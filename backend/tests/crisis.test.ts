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
