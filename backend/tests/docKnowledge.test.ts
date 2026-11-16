import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { AiService, setAi, type ChatMessage, type CompletionOptions, type LlmProvider } from "../src/ai/llm.js";
import { prisma } from "../src/config/db.js";
import { answerFromDocuments, keepFacts, learnFromDocument } from "../src/modules/documents/knowledge.js";
import { answerGrounded, chunkText, isQuestion } from "../src/modules/documents/knowledgeRules.js";
import { dbAvailable, TZ } from "./fixtures.js";

/** DOC_KNOWLEDGE: documents teach the assistant (pieces for search, proposed facts the user ticks, answers from them). */

test("knowledge rules: pieces overlap, stop at the limit and keep short documents whole", () => {
  const text = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} about the internship at Systems Ltd in Lahore.`).join(" ");
  const pieces = chunkText(text, 300, 60, 50);
  assert.ok(pieces.length > 3);
  assert.ok(pieces.every((p) => p.length <= 300));
  // Overlap: each piece starts with words the previous one ended with.
  assert.ok(pieces[1].slice(0, 20).split(" ").some((w) => w.length > 3 && pieces[0].includes(w)));
  assert.equal(chunkText(text, 300, 60, 2).length, 2);
  assert.deepEqual(chunkText("Short note about my CV and skills."), ["Short note about my CV and skills."]);
  assert.deepEqual(chunkText("   "), []);
});

test("knowledge rules: questions vs commands", () => {
  assert.equal(isQuestion("When does my internship start?"), true);
  assert.equal(isQuestion("what is my supervisor's name"), true);
  assert.equal(isQuestion("internship kab shuru hogi"), true);
  assert.equal(isQuestion("Remind me to call Ali at 5"), false);
  assert.equal(isQuestion("Add gym every day"), false);
  assert.equal(isQuestion("hi?"), false);
});

test("knowledge rules: an answer must be backed by its piece (numbers and words)", () => {
  const piece = "Your internship at Systems Ltd starts on 1 December 2026 in Lahore. Supervisor: Ms. Ayesha Khan.";
  assert.equal(answerGrounded("Your internship starts on 1 December 2026.", piece), true);
  assert.equal(answerGrounded("It starts on 3 December 2026.", piece), false, "an invented date fails");
  assert.equal(answerGrounded("Your supervisor is Ms. Ayesha Khan.", piece), true);
  assert.equal(answerGrounded("Your manager is Bilal Ahmed.", piece), false, "an invented name fails");
});

/** A fake model: facts for the facts job, the given answer for the question job. */
function fakeAi(answer: { found: boolean; answer: string; excerpt: number }) {
  const provider: LlmProvider = {
    name: "fake",
    chat: async (_m: ChatMessage[], options: CompletionOptions) => {
      const props = (options.json as { properties?: Record<string, unknown> })?.properties ?? {};
      if ("facts" in props) {
        return JSON.stringify({
          facts: [
            { type: "FACT", content: "User is doing an internship at Systems Ltd in Lahore." },
            { type: "GOAL", content: "User wants to become a backend developer." },
            // Not in the document: must be dropped.
            { type: "FACT", content: "User plays cricket every weekend with friends." },
          ],
        });
      }
      return JSON.stringify(answer);
    },
  };
  setAi(new AiService([provider]));
}

const DOC = `Offer letter. Dear Ahmed, we are pleased to offer you an internship at Systems Ltd in Lahore.
Your internship starts on 1 December 2026. Your supervisor is Ms. Ayesha Khan. In your interview you said you want to
become a backend developer, and this internship focuses on backend development with Node.js and PostgreSQL.`;

test("knowledge: learning adds search pieces and a facts card; ticked facts go into memory; questions are answered from the document", { skip: !dbAvailable && "no database" }, async () => {
  const user = await prisma.user.create({ data: { firebaseUid: `kn-${randomUUID()}`, email: `kn-${randomUUID().slice(0, 8)}@example.test` } });
  await prisma.userSettings.create({ data: { userId: user.id, timezone: TZ } });
  const conversation = await prisma.conversation.create({ data: { userId: user.id, channel: "APP" } });
  const doc = await prisma.document.create({ data: { userId: user.id, fileName: "offer.pdf", mimeType: "application/pdf", sizeBytes: 1000, docType: "OTHER", text: DOC.repeat(2) } });
  try {
    fakeAi({ found: true, answer: "Your internship starts on 1 December 2026.", excerpt: 1 });
    await learnFromDocument(user.id, doc.id, conversation.id, "en");

    assert.ok((await prisma.documentChunk.count({ where: { documentId: doc.id } })) >= 1, "search pieces stored");
    const message = await prisma.conversationMessage.findFirstOrThrow({ where: { conversationId: conversation.id } });
    const card = (message.metadata as { cards: Array<{ type: string; facts: Array<{ id: string; content: string }> }> }).cards[0];
    assert.equal(card.type, "document_facts");
    assert.deepEqual(card.facts.map((f) => f.content), ["User is doing an internship at Systems Ltd in Lahore.", "User wants to become a backend developer."], "the ungrounded fact was dropped");

    // Nothing is in memory until the user ticks; then only the ticked fact, and the card shows the choice.
    assert.equal(await prisma.memoryItem.count({ where: { userId: user.id } }), 0);
    assert.deepEqual(await keepFacts(user.id, doc.id, [card.facts[0].id]), { kept: 1 });
    const memories = await prisma.memoryItem.findMany({ where: { userId: user.id } });
    assert.equal(memories.length, 1);
    assert.equal(memories[0].source, `document:${doc.id}`);
    const after = await prisma.conversationMessage.findUniqueOrThrow({ where: { id: message.id } });
    assert.deepEqual((after.metadata as { cards: Array<{ kept?: string[] }> }).cards[0].kept, [card.facts[0].id]);

    // Learning the same document again does nothing new.
    await learnFromDocument(user.id, doc.id, conversation.id, "en");
    assert.equal(await prisma.conversationMessage.count({ where: { conversationId: conversation.id } }), 1);

    const found = await answerFromDocuments(user.id, "When does my internship start?", "en");
    assert.deepEqual(found, { answer: "Your internship starts on 1 December 2026.", fileName: "offer.pdf" });

    fakeAi({ found: true, answer: "It starts on 9 January 2027.", excerpt: 1 });
    assert.equal(await answerFromDocuments(user.id, "When does my internship start?", "en"), null, "an answer the document doesn't back is dropped");
    fakeAi({ found: false, answer: "", excerpt: 1 });
    assert.equal(await answerFromDocuments(user.id, "When does my internship start?", "en"), null);
  } finally {
    setAi(new AiService([]));
    await prisma.user.deleteMany({ where: { id: user.id } });
  }
});
