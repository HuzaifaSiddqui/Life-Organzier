import { z } from "zod";
import { getAi } from "../../ai/llm.js";
import { collabOn } from "../collab/collabRules.js";
import { listConnections } from "../collab/collabService.js";
import type { Turn } from "./dialogue.js";
import type { DraftShare } from "./types.js";
import { findMentions, shareCue } from "./shareRules.js";
export { findMentions, shareAnswer, shareCue, titleForShare, type Connected, type Mention, type ShareCue } from "./shareRules.js";

/**
 * Task collaboration in chat, voice and WhatsApp (COLLAB_TASKS). A name in a task is not a request to share it:
 * "call Ali", "Ali's birthday", "buy a gift for Ali" are the user's own tasks. Only people the user is connected to
 * are candidates (anyone else is just a name). Clear wording is decided by rules: "ask Ali to …", "assign it to Ali"
 * (only for them), "with Ali", "Ali and I" (together), a call/visit/gift/possessive (just a name). Anything else goes
 * to the model as a narrow, schema-checked choice. Whatever rules or model propose, a share is only made after the
 * user confirms the preview.
 */

const modelSchema = z.object({ decision: z.enum(["none", "together", "assign"]), confidence: z.number().min(0).max(1) });

/** The model's narrow job: is the named person part of the task? Null when it can't answer. */
export async function modelShareDecision(text: string, people: string[]): Promise<z.infer<typeof modelSchema> | null> {
  return getAi().json(
    [
      {
        role: "system",
        content:
          'The user is adding a task to their own to-do list and named people they know. Decide what they want: "none" = the task is only the user\'s own and the person is just mentioned (calling, meeting, visiting, buying for, or something about them); "together" = the user and the named person(s) will both do this task, so it should be added for each of them; "assign" = the named person should do it instead of the user. An "@name" is a strong sign the user wants to involve them. Return JSON {"decision": "none"|"together"|"assign", "confidence": 0..1}.',
      },
      { role: "user", content: "People: @ali. Task: call Ali about the notes tomorrow" },
      { role: "assistant", content: '{"decision":"none","confidence":0.95}' },
      { role: "user", content: "People: @sana. Task: finish the group slides with @sana by friday" },
      { role: "assistant", content: '{"decision":"together","confidence":0.95}' },
      { role: "user", content: "People: @bilal. Task: bilal print the handouts before class" },
      { role: "assistant", content: '{"decision":"assign","confidence":0.8}' },
      { role: "user", content: `People: ${people.join(", ")}. Task: ${text.slice(0, 400)}` },
    ],
    modelSchema,
    {
      json: { type: "object", properties: { decision: { type: "string", enum: ["none", "together", "assign"] }, confidence: { type: "number" } }, required: ["decision", "confidence"] },
      maxTokens: 40,
      timeoutMs: 20000,
    },
  );
}

/** A "none" from the model is trusted (nothing is shared, the task is just the user's); anything else is a proposal. */
const MODEL_NONE_OK = 0.7;

/**
 * What a new task message means for sharing. Null: nobody the user is connected to is named (or the feature is off),
 * so it is an ordinary task. Rules and the model only ever propose: a share always waits for the user's answer to the
 * preview ("Share '…' with @x? Together / Only for them / Just me"), so nothing reaches anyone before that.
 */
export async function detectShare(turn: Turn, text: string): Promise<DraftShare | null> {
  if (!collabOn()) return null;
  const connected = (await listConnections(turn.user.id)).connected.map((c) => c.user);
  if (!connected.length) return null;
  const mentions = findMentions(text, connected);
  if (!mentions.length) return null;
  const people = mentions.map((m) => ({ id: m.person.id, label: m.label }));
  const names = mentions.flatMap((m) => m.said);
  // One name word for two connections ("Ali"): ask which one, whatever the wording says.
  const ambiguous = mentions.some((m, i) => mentions.some((o, j) => j !== i && o.said.some((w) => m.said.includes(w))));
  const cue = shareCue(text, names);
  if (cue === "none") return { people, names, kind: null, decided: "none", via: "rules" };
  const proposal = (k: "together" | "assign" | null) => (k === "together" ? "COLLAB" : k === "assign" ? "ASSIGN" : null);
  if (cue === "together" || cue === "assign" || ambiguous) return { people, names, kind: proposal(cue === "unsure" ? null : cue), decided: null, via: "rules", ...(ambiguous ? { ambiguous: true } : {}) };
  const m = await modelShareDecision(text, people.map((p) => p.label)).catch(() => null);
  if (m?.decision === "none" && m.confidence >= MODEL_NONE_OK) return { people, names, kind: null, decided: "none", via: "model" };
  return { people, names, kind: m && m.decision !== "none" ? proposal(m.decision) : null, decided: null, via: "model" };
}
