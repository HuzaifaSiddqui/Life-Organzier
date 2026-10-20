import { localYmd } from "../../../lib/time.js";
import type { ExtractOptions } from "../entities.js";
import { rulesUnderstand } from "../nlu.js";
import type { Command, CommandArgs, ParseCtx } from "./types.js";
import { bulkCommands } from "./bulk.js";
import { insightCommands } from "./insights.js";
import { routineCommands } from "./routines.js";
import { settingsCommands } from "./settings.js";
import { taskCommands } from "./tasks.js";
import { wrappedCommands } from "./wrapped.js";

/**
 * Chat command registry. New commands are listed first, in match order (more specific first); a message
 * goes to the first whose rule parse accepts it. Wrapped existing intents come last and are matched by
 * nlu.ts. Everything here works with AI off; the LLM router (router.ts) only picks from this list.
 */
export const COMMANDS: Command[] = [...bulkCommands, ...settingsCommands, ...insightCommands, ...routineCommands, ...taskCommands, ...wrappedCommands];

const byName = new Map(COMMANDS.map((c) => [c.name, c]));

export function getCommand(name: string): Command | undefined {
  return byName.get(name);
}

export function parseCtx(opts: ExtractOptions): ParseCtx {
  return { opts, todayYmd: localYmd(opts.now, opts.tz) };
}

/** First new (non-wrapped) command whose rules accept the text. */
export function matchCommand(text: string, ctx: ParseCtx): { command: Command; args: CommandArgs } | null {
  for (const command of COMMANDS) {
    if (command.wrapped) continue;
    const args = command.parse(text, ctx);
    if (args) return { command, args };
  }
  return null;
}

export type Classification = { command: string; args: CommandArgs };

/**
 * Rules-only classification for the eval script (`npm run eval:assistant`): a registry command with its
 * arguments, else the nlu.ts intent ("smalltalk", "unclear", …). `baseline` skips the registry and
 * reports what the rules did before it existed.
 */
export function classify(text: string, ctx: ParseCtx, opts: { baseline?: boolean } = {}): Classification {
  if (!opts.baseline) {
    const hit = matchCommand(text, ctx);
    if (hit) return { command: hit.command.name, args: hit.args };
  }
  return { command: rulesUnderstand(text, ctx.opts).intent, args: {} };
}
