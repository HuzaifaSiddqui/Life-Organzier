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

/** Task notices only (pair() sends a connection request first). Every push comes with a notice (collabService notify). */
const noticesFor = (u: User) => prisma.collabNotice.count({ where: { userId: u.id, kind: { startsWith: "TASK_" } } });
const sharedBy = (u: User) => prisma.sharedTask.count({ where: { ownerId: u.id } });

test("chat: clear wording only proposes — the preview comes first, nothing reaches Ali until 'Together' / 'Only for them'", { skip }, withFlag(async () => {
  const { me, ali } = await pair();

  const together = await me.say("finish the group slides with Ali tomorrow at 5 pm, takes 2 hours");
  assert.equal(together.message.intent, "share_choice", together.message.content);
  assert.match(together.message.content, /^Share "Finish the group slides with Ali" with @ali_\w+\?/);
  assert.deepEqual(together.message.actions?.map((a) => a.label), ["Together", "Only for them", "Just me"]);
  assert.equal(await sharedBy(me.user), 0, "nothing shared yet");
  assert.equal(await noticesFor(ali.user), 0, "no notice (so no push) for Ali before the answer");
  assert.equal((await tasksOf(me.user)).length, 0);

  const done = await me.tap(together.message.actions![0].payload);
  assert.equal(done.message.intent, "task_shared", done.message.content);
  const mine = await tasksOf(me.user);
  assert.equal(mine.length, 1);
  assert.ok(mine[0].sharedTaskId, "my copy is linked to the shared task");
  assert.equal((await tasksOf(ali.user)).length, 0, "nothing on Ali's timeline until Ali accepts");
  assert.equal((await cardsFor(ali.user)).length, 1);
  assert.equal(await noticesFor(ali.user), 1, "Ali hears about it only now");

  const assign = await me.say("ask Ali to print the handouts tomorrow at 9 am");
  assert.equal(assign.message.intent, "share_choice", assign.message.content);
  assert.equal(assign.message.actions?.[0].label, "Only for them", "the rules' proposal is offered first");
  assert.equal((await cardsFor(ali.user)).length, 1, "still only the first card");
  const sent = await me.say("only for them");
  assert.equal(sent.message.intent, "task_shared", sent.message.content);
  assert.match(sent.message.content, /Sent to @ali_.*Print the handouts.*isn't on your timeline/s);
  assert.equal((await tasksOf(me.user)).filter((t) => /handouts/i.test(t.title)).length, 0, "not on my timeline");
  assert.equal((await cardsFor(ali.user)).length, 2);
}));

test("chat: unclear wording asks too; 'Just me' shares nothing; typing 'undo' cancels a confirmed share, as the Undo button does", { skip }, withFlag(async () => {
  const { me, ali } = await pair();
  const asked = await me.say("meeting with Ali tomorrow at 3 pm for 1 hour");
  assert.equal(asked.message.intent, "share_choice", asked.message.content);
  const own = await me.say("just me");
  assert.equal(own.message.intent, "task_created");
  assert.equal((await cardsFor(ali.user)).length, 0);
  assert.equal(await noticesFor(ali.user), 0);

  // Confirmed, then undone by typing.
  await me.say("meeting with Ali on monday at 11 am for 1 hour");
  const shared = await me.say("together");
  assert.equal(shared.message.intent, "task_shared", shared.message.content);
  assert.equal((await cardsFor(ali.user)).length, 1);
  const undone = await me.say("undo");
  assert.equal(undone.message.intent, "undone", undone.message.content);
  assert.match(undone.message.content, /sharing "Meeting/);
  assert.equal((await prisma.sharedTaskMember.findMany({ where: { userId: ali.user.id, status: SharedMemberStatus.PENDING, sharedTask: { cancelledAt: null } } })).length, 0, "Ali's card is withdrawn");
  assert.ok(!(await tasksOf(me.user)).some((t) => t.dueTime === "11 AM"), "my copy is removed");

  // "Just for me" button after a share: the card is withdrawn, my copy stays (and is no longer shared).
  await me.say("meeting with Ali on tuesday at 10 am for 1 hour");
  const again = await me.say("together");
  const justMe = again.message.actions!.find((a) => a.label === "Just for me")!;
  const unshared = await me.tap(justMe.payload);
  assert.equal(unshared.message.intent, "shared_unshared");
  const kept = (await tasksOf(me.user)).find((t) => /meeting/i.test(t.title) && t.dueTime === "10 AM");
  assert.ok(kept && !kept.sharedTaskId);
  const liveCards = () => prisma.sharedTaskMember.count({ where: { userId: ali.user.id, status: SharedMemberStatus.PENDING, sharedTask: { cancelledAt: null } } });
  assert.equal(await liveCards(), 0);
  // The button used the share's undo step up: a later "undo" doesn't try to unshare it again.
  assert.doesNotMatch((await me.say("undo")).message.content, /sharing/);
}));

test("chat: the model only proposes — even at 99% nothing is shared before the preview's answer", { skip }, withFlag(async () => {
  const { me, ali } = await pair();
  let answer = { decision: "together", confidence: 0.99 };
  setAi(new AiService([{ name: "fake", chat: async (messages) => (messages[0].content.includes("named people they know") ? JSON.stringify(answer) : "{}") }]));
  const proposed = await me.say("Ali presentation slides tomorrow at 4 pm, 1 hour");
  assert.equal(proposed.message.intent, "share_choice", proposed.message.content);
  assert.equal(proposed.message.actions?.[0].label, "Together", "the model's proposal is offered first");
  assert.equal(await sharedBy(me.user), 0);
  assert.equal(await noticesFor(ali.user), 0);
  await me.say("just me");
  answer = { decision: "none", confidence: 0.9 };
  const mine = await me.say("return the book to Ali tomorrow at 1 pm");
  assert.equal(mine.message.intent, "task_created");
  answer = { decision: "assign", confidence: 0.6 };
  const asked = await me.say("Ali lab manual tomorrow at 2 pm, 30 minutes");
  assert.equal(asked.message.intent, "share_choice");
  assert.equal(asked.message.actions?.[0].label, "Only for them");
  assert.equal(await sharedBy(me.user), 0, "nothing was ever shared without an answer");
}));

test("chat: a connected person's name in a task ('gift for Ali', 'call Ali', 'Ali's birthday') is never shared without confirmation", { skip }, withFlag(async () => {
  const { me, ali } = await pair();
  const titles = ["buy a gift for Ali tomorrow at 5 pm", "call Ali tomorrow at 6 pm", "Ali's birthday on friday", "pick up Ali from the station tomorrow at 8 am"];
  for (const model of [null, { decision: "together", confidence: 0.99 }, { decision: "assign", confidence: 0.99 }]) {
    setAi(new AiService(model ? [{ name: "fake", chat: async (messages) => (messages[0].content.includes("named people they know") ? JSON.stringify(model) : "{}") }] : []));
    for (const text of titles) {
      const out = await me.say(text);
      assert.notEqual(out.message.intent, "task_shared", `${text} (${model?.decision ?? "AI off"})`);
      if (out.message.intent === "share_choice") await me.say("just me");
      assert.equal(await sharedBy(me.user), 0, `${text}: nothing shared`);
      assert.equal(await noticesFor(ali.user), 0, `${text}: Ali got nothing`);
    }
  }
}));

test("WhatsApp: the receiver lists, accepts and declines shared tasks by chat", { skip }, withFlag(async () => {
  const { me, ali } = await pair();
  await me.say("finish the group slides with Ali tomorrow at 5 pm, takes 2 hours");
  await me.say("together");
  await me.say("ask Ali to book the lab tomorrow at 9 am");
  await me.say("only for them");

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
