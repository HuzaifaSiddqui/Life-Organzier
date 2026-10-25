import { HASH_EMBED_MODEL } from "../../../ai/embeddings.js";
import { nearest, vote, type BankIndex, type Neighbour } from "./neighbours.js";
import { getCommand } from "./registry.js";
import { routeWithLlm } from "./router.js";
import type { CommandArgs, ParseCtx } from "./types.js";

/**
 * Meaning-based routing (docs/AI_ASSISTANT_ARCHITECTURE.md → "Meaning-based router"). The rules decide when they
 * are highly sure; otherwise the nearest bank examples guide the LLM router (AI on) and give a second opinion, or
 * decide alone (AI off) when they clearly agree. Code validates the result and runs it; crisis detection runs
 * before all of this and is never routed. The same function runs the live chat and the gate
 * (scripts/eval-router.ts), so what is measured is what runs.
 */

/** Rules at or above this are "highly sure": only a strong disagreement makes the assistant ask. */
export const RULES_SURE = 0.85;
/** Below this the rules are unsure and the model is asked (the same point as before this router, so no new model calls). */
export const RULES_UNSURE = 0.75;
/**
 * Neighbours deciding alone (AI off): off. The gate (25 Oct 2026, 259 bank rows) gave hashed-vector neighbours
 * 42.8% (English) and 29.3% (Roman Urdu) alone, and the combined path never beat the rules with AI off.
 */
export const NEIGHBOURS_ALONE = false;

/**
 * Similarity levels per kind of vector, set before the gate was run (never from chat-holdout.json). Hashed
 * bag-of-words scores are lower and only count shared words.
 */
const LEVELS = {
  hash: { strong: 0.75, min: 0.45, unknown: 0.2 },
  model: { strong: 0.88, min: 0.72, unknown: 0.55 },
};

/** Languages the new path runs for; the gate (scripts/eval-router.ts) decides, see the architecture doc. */
export const MEANING_LANGS = new Set(["en", "ru"]);

export type Decision =
  | { kind: "rules" }
  | { kind: "route"; command: string; args: CommandArgs; via: "model" | "neighbours" }
  | { kind: "ask"; options: [string, string] }
  | { kind: "unknown" };

export type MeaningResult = {
  decision: Decision;
  neighbours: Neighbour[];
  vote: ReturnType<typeof vote>;
  lang: string | null;
  ms: { neighbours: number; model: number };
};

/** Arguments for running `command` on this text, read by that command's own parser; null when it can't run. */
export function argsFor(command: string, text: string, ctx: ParseCtx): CommandArgs | null {
  const c = getCommand(command);
  if (!c) return null;
  if (c.wrapped) return { text };
  const parsed = c.parse(text, ctx);
  if (parsed) return parsed;
  // No arguments of its own in the text: only commands that ask for what is missing ("which routine?") can run.
  return c.schema.safeParse({}).success ? {} : null;
}

export async function meaningRoute(
  text: string,
  ctx: ParseCtx,
  rules: { command: string; confidence: number },
  /** `examples: false` = the LLM router as it was before (no bank examples): the gate's baseline. */
  opts: { index: BankIndex; model: boolean; exclude?: string; examples?: boolean },
): Promise<MeaningResult> {
  const t0 = performance.now();
  const list = await nearest(text, opts.index, { exclude: opts.exclude });
  const v = vote(list);
  const t1 = performance.now();
  let modelMs = 0;
  const lang = /[؀-ۿ]/.test(text) ? "ur" : v.lang;
  const done = (decision: Decision): MeaningResult => ({ decision, neighbours: list, vote: v, lang, ms: { neighbours: t1 - t0, model: modelMs } });
  if (!lang || !MEANING_LANGS.has(lang)) return done({ kind: "rules" });

  const level = opts.index.model === HASH_EMBED_MODEL ? LEVELS.hash : LEVELS.model;
  const strong = Boolean(v.command) && v.agreement >= 0.8 && v.top >= level.strong;
  const examples = opts.examples === false ? [] : list.map((n) => ({ text: n.row.text, command: n.row.command }));
  const askModel = async () => {
    if (!opts.model) return null;
    const m0 = performance.now();
    const r = await routeWithLlm(text, ctx, examples);
    modelMs += performance.now() - m0;
    return r;
  };

  if (rules.confidence >= RULES_SURE) {
    // Arbitration: sure rules against a strong, runnable disagreement (and the model too, when it is on).
    if ((opts.model || NEIGHBOURS_ALONE) && strong && v.command !== rules.command && getCommand(rules.command) && argsFor(v.command as string, text, ctx)) {
      const model = await askModel();
      if (!opts.model || model?.command === v.command) return done({ kind: "ask", options: [rules.command, v.command as string] });
    }
    return done({ kind: "rules" });
  }
  if (rules.confidence >= RULES_UNSURE) return done({ kind: "rules" });

  const model = await askModel();
  if (model) {
    // The model against both the rules and a strong neighbour vote: the neighbours win.
    const neighbourArgs = strong && v.command ? argsFor(v.command, text, ctx) : null;
    if (neighbourArgs && model.command !== v.command && model.command !== rules.command) return done({ kind: "route", command: v.command as string, args: neighbourArgs, via: "neighbours" });
    return done({ kind: "route", command: model.command, args: model.args, via: "model" });
  }
  if (NEIGHBOURS_ALONE && v.command && v.command !== rules.command && v.agreement >= 0.6 && v.top >= level.min) {
    const args = argsFor(v.command, text, ctx);
    if (args) return done({ kind: "route", command: v.command, args, via: "neighbours" });
  }
  if ((rules.command === "unclear" && v.top < level.unknown) || (strong && v.command === "unclear" && rules.confidence < 0.5)) return done({ kind: "unknown" });
  return done({ kind: "rules" });
}
