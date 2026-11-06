import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { SharedMemberStatus, TaskStatus, type User } from "@prisma/client";
import { AiService, setAi } from "../src/ai/llm.js";
import { prisma } from "../src/config/db.js";
import { handleAssistantMessage, type Channel } from "../src/modules/assistant/dialogue.js";
import { isPlausibleAnswer } from "../src/modules/assistant/commands/pendingAnswer.js";
import { parseCtx } from "../src/modules/assistant/commands/registry.js";
import { findMentions, shareAnswer, shareCue, titleForShare } from "../src/modules/assistant/shareRules.js";
import type { ActionPayload, Pending, TaskDraft } from "../src/modules/assistant/types.js";
import { requestConnection, respondConnection } from "../src/modules/collab/collabService.js";
import { formatReply } from "../src/modules/whatsapp/inbound.js";
import { dbAvailable, TZ } from "./fixtures.js";

const skip = !dbAvailable && "no database";

/* ------------------------------------------------------------------ pure */

const people = [
  { id: "a", username: "ali_khan", displayName: "Ali Khan" },
  { id: "s", username: "sana_z", displayName: "Sana Zaidi" },
  { id: "w", username: "wbrown", displayName: "Will Brown" },
];

test("share rules: only connected people count, as @username or a whole name word; common words need a capital", () => {
  const ids = (t: string) => findMentions(t, people).map((m) => m.person.id);
  assert.deepEqual(ids("call Ali tomorrow"), ["a"]);
  assert.deepEqual(ids("finish slides with @sana_z"), ["s"]);
  assert.deepEqual(ids("revise with sana and ali"), ["a", "s"]);
  assert.deepEqual(ids("Alina's party"), [], "a longer name is someone else");
  assert.deepEqual(ids("I will finish it later"), [], "'will' in lower case is the word, not Will");
  assert.deepEqual(ids("Will and I study for the quiz"), ["w"]);
  assert.deepEqual(ids("email bilal the notes"), [], "not a connection: just a name");
});

test("share rules: a name alone is not a request to share; the wording decides, the rest goes to the model", () => {
  const cue = (t: string) => shareCue(t, ["Ali", "ali_khan"]);
  // only for them
  assert.equal(cue("ask Ali to print the handouts tomorrow"), "assign");
  assert.equal(cue("tell @ali_khan to book the lab"), "assign");
  assert.equal(cue("assign the poster to Ali"), "assign");
  assert.equal(cue("Ali should submit the form by Friday"), "assign");
  // together
  assert.equal(cue("finish the group slides with Ali by Friday"), "together");
  assert.equal(cue("Ali and I need to revise chapter 3"), "together");
  assert.equal(cue("we have to submit the lab report, Ali"), "together");
  // just a name: the user's own task
  assert.equal(cue("call Ali tomorrow at 5"), "none");
  assert.equal(cue("Ali's birthday on Friday"), "none");
  assert.equal(cue("buy a gift for Ali"), "none");
  assert.equal(cue("return the book to Ali"), "unsure", "not a pattern the rules know: the model decides");
  assert.equal(cue("pay Ali back 500"), "none");
  assert.equal(cue("lunch with Ali on Sunday"), "none");
  assert.equal(cue("get notes from Ali"), "none");
  // unclear
  assert.equal(cue("meeting with Ali at 3"), "unsure");
  assert.equal(cue("Ali presentation slides"), "unsure");
});

test("share rules: answers to the question, and the title once shared", () => {
  assert.equal(shareAnswer("together"), "together");
  assert.equal(shareAnswer("yes"), "together");
  assert.equal(shareAnswer("only for them"), "assign");
  assert.equal(shareAnswer("only for me"), "none");
  assert.equal(shareAnswer("just me"), "none");
  assert.equal(shareAnswer("tomorrow"), null);
  assert.equal(titleForShare("Ask Ali to print the handouts", ["Ali"], "ASSIGN"), "Print the handouts");
  assert.equal(titleForShare("Ali should submit the form", ["Ali"], "ASSIGN"), "Submit the form");
  assert.equal(titleForShare("Finish slides with @ali_khan", ["ali_khan"], "COLLAB"), "Finish slides with ali_khan");
  assert.equal(titleForShare("Poster, assign it to Ali", ["Ali"], "ASSIGN"), "Poster");

  const p: Pending = { kind: "share_choice", draft: { title: "Meeting", share: { people: [{ id: "a", label: "@ali_khan" }], names: ["Ali"], kind: null, decided: null, via: "model" } } as TaskDraft, source: "CHAT" };
  const ctx = parseCtx({ now: new Date(), tz: TZ, contexts: [] });
  assert.equal(isPlausibleAnswer(p, "just for me", ctx), true);
  assert.equal(isPlausibleAnswer(p, "ali_khan", ctx), true);
  assert.equal(isPlausibleAnswer(p, "show my tasks for this week please now", ctx), false);
});

/* ------------------------------------------------------------------ conversations */

type Say = (text: string, channel?: Channel) => ReturnType<typeof handleAssistantMessage>;
type Tap = (payload: ActionPayload) => ReturnType<typeof handleAssistantMessage>;

async function chatUser(name: string, displayName: string) {
  const tag = randomUUID().slice(0, 6);
  const user = await prisma.user.create({ data: { firebaseUid: `test-${randomUUID()}`, email: `${name}-${tag}@example.test`, displayName, username: `${name}_${tag}` } });
  await prisma.userSettings.create({ data: { userId: user.id, timezone: TZ } });
  const say: Say = async (text, channel = "APP") =>
    handleAssistantMessage({ user: await prisma.user.findUniqueOrThrow({ where: { id: user.id } }), settings: await prisma.userSettings.findUniqueOrThrow({ where: { userId: user.id } }), deviceId: null, text, channel });
  const tap: Tap = async (payload) =>
    handleAssistantMessage({ user: await prisma.user.findUniqueOrThrow({ where: { id: user.id } }), settings: await prisma.userSettings.findUniqueOrThrow({ where: { userId: user.id } }), deviceId: null, payload, channel: "APP" });
  return { user, say, tap };
}

async function pair() {
  const me = await chatUser("own", "Huzaifa Siddiqui");
  const ali = await chatUser("ali", "Ali Raza");
  const r = await requestConnection(me.user, ali.user.id);
  await respondConnection(ali.user, r.connectionId, true);
  return { me, ali };
}

const tasksOf = (u: User) => prisma.task.findMany({ where: { userId: u.id, status: { not: TaskStatus.DELETED } } });
const cardsFor = (u: User) => prisma.sharedTaskMember.findMany({ where: { userId: u.id, status: SharedMemberStatus.PENDING } });

function withFlag(fn: () => Promise<void>) {
  return async () => {
    const before = process.env.COLLAB_TASKS;
    process.env.COLLAB_TASKS = "on";
    setAi(new AiService([]));
    try {
      await fn();
    } finally {
      process.env.COLLAB_TASKS = before;
      setAi(new AiService([]));
    }
  };
}

test("chat: 'with Ali' shares it together; 'call Ali' stays mine; 'ask Ali to' is only for Ali", { skip }, withFlag(async () => {
  const { me, ali } = await pair();

  const together = await me.say("finish the group slides with Ali tomorrow at 5 pm, takes 2 hours");
  assert.equal(together.message.intent, "task_shared", together.message.content);
  assert.match(together.message.content, /shared with @ali_/);
  const mine = await tasksOf(me.user);
  assert.equal(mine.length, 1);
  assert.ok(mine[0].sharedTaskId, "my copy is linked to the shared task");
  assert.equal((await tasksOf(ali.user)).length, 0, "nothing on Ali's timeline until Ali accepts");
  assert.equal((await cardsFor(ali.user)).length, 1);

  const call = await me.say("call Ali tomorrow at 6 pm");
  assert.equal(call.message.intent, "task_created", "a name alone is just a name");
  assert.equal((await cardsFor(ali.user)).length, 1, "no new card");

  const assign = await me.say("ask Ali to print the handouts tomorrow at 9 am");
  assert.equal(assign.message.intent, "task_shared", assign.message.content);
  assert.match(assign.message.content, /Sent to @ali_.*Print the handouts.*isn't on your timeline/s);
  assert.equal((await tasksOf(me.user)).filter((t) => /handouts/i.test(t.title)).length, 0, "not on my timeline");
  assert.equal((await cardsFor(ali.user)).length, 2);
}));

test("chat: unclear wording asks (AI off); the answer decides; Undo / Just for me after sharing", { skip }, withFlag(async () => {
  const { me, ali } = await pair();
  const asked = await me.say("meeting with Ali tomorrow at 3 pm for 1 hour");
  assert.equal(asked.message.intent, "share_choice", asked.message.content);
  assert.deepEqual(asked.message.actions?.map((a) => a.label), ["Together", `Only for @${ali.user.username}`, "Just for me"]);
  const own = await me.say("just for me");
  assert.equal(own.message.intent, "task_created");
  assert.equal((await cardsFor(ali.user)).length, 0);

  const again = await me.say("meeting with Ali on monday at 11 am for 1 hour");
  assert.equal(again.message.intent, "share_choice", again.message.content);
  const shared = await me.say("together");
  assert.equal(shared.message.intent, "task_shared", shared.message.content);
  assert.equal((await cardsFor(ali.user)).length, 1);
  // "Just for me": the card is withdrawn, my copy stays (and is no longer shared).
  const justMe = shared.message.actions!.find((a) => a.label === "Just for me")!;
  const unshared = await me.tap(justMe.payload);
  assert.equal(unshared.message.intent, "shared_unshared");
  assert.equal((await prisma.sharedTaskMember.findMany({ where: { userId: ali.user.id, status: SharedMemberStatus.PENDING, sharedTask: { cancelledAt: null } } })).length, 0);
  const kept = (await tasksOf(me.user)).find((t) => /meeting/i.test(t.title) && t.dueTime === "11 AM");
  assert.ok(kept && !kept.sharedTaskId);
}));

test("chat: the model decides unclear wording when it is sure; unsure → ask", { skip }, withFlag(async () => {
  const { me, ali } = await pair();
  let answer = { decision: "together", confidence: 0.95 };
  setAi(new AiService([{ name: "fake", chat: async (messages) => (messages[0].content.includes("named people they know") ? JSON.stringify(answer) : "{}") }]));
  const decided = await me.say("Ali presentation slides tomorrow at 4 pm, 1 hour");
  assert.equal(decided.message.intent, "task_shared", decided.message.content);
  answer = { decision: "none", confidence: 0.9 };
  const mine = await me.say("return the book to Ali tomorrow at 1 pm");
  assert.equal(mine.message.intent, "task_created");
  answer = { decision: "assign", confidence: 0.6 };
  const asked = await me.say("Ali lab manual tomorrow at 2 pm, 30 minutes");
  assert.equal(asked.message.intent, "share_choice");
  assert.equal(asked.message.actions?.[0].label, `Only for @${ali.user.username}`, "the model's guess is offered first");
}));

test("WhatsApp: the receiver lists, accepts and declines shared tasks by chat", { skip }, withFlag(async () => {
  const { me, ali } = await pair();
  await me.say("finish the group slides with Ali tomorrow at 5 pm, takes 2 hours");
  await me.say("ask Ali to book the lab tomorrow at 9 am");

  // WhatsApp has no push: the next reply there mentions what arrived, once.
  const first = await ali.say("show my tasks for today", "WHATSAPP");
  assert.match(first.message.content, /Also: 2 tasks were shared with you\. Say "show shared tasks"/);
  assert.doesNotMatch((await ali.say("show my tasks for today", "WHATSAPP")).message.content, /Also:/);

  const list = await ali.say("what did people share with me", "WHATSAPP");
  assert.equal(list.message.intent, "shared_requests", list.message.content);
  assert.match(list.message.content, /2 tasks shared with you/);
  const text = formatReply(list.message.content, list.message.actions ?? []);
  assert.match(text, /1\. Accept/, "numbered on WhatsApp");

  const accepted = await ali.say("accept the group slides task", "WHATSAPP");
  assert.equal(accepted.message.intent, "shared_accepted", accepted.message.content);
  assert.equal((await tasksOf(ali.user)).length, 1, "now on Ali's timeline");
  const declined = await ali.say("decline the book the lab task", "WHATSAPP");
  assert.equal(declined.message.intent, "shared_declined", declined.message.content);
  assert.equal((await cardsFor(ali.user)).length, 0);
}));

test("chat: without COLLAB_TASKS a name never shares anything", { skip }, async () => {
  const { me, ali } = await pair();
  setAi(new AiService([]));
  const before = process.env.COLLAB_TASKS;
  process.env.COLLAB_TASKS = "off";
  const out = await me.say("finish the group slides with Ali tomorrow at 5 pm, takes 2 hours");
  process.env.COLLAB_TASKS = before;
  assert.equal(out.message.intent, "task_created");
  assert.equal((await cardsFor(ali.user)).length, 0);
});
