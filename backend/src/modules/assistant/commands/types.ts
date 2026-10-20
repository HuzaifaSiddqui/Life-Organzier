import type { z } from "zod";
import type { ExtractOptions } from "../entities.js";
import type { Out, Turn } from "../dialogue.js";
import type { Card } from "../types.js";

export type CommandCategory = "tasks" | "routines" | "settings" | "insights" | "bulk" | "general";

/** What a pure rules parser gets: the user's clock and calendar (dates come from entities.ts only). */
export type ParseCtx = { opts: ExtractOptions; todayYmd: string };

export type CommandArgs = Record<string, unknown>;

/**
 * After references are resolved and Pro rules checked: either ready (optionally with a question that the
 * user must confirm first, e.g. a bulk preview) or an immediate reply (not found, which one, not allowed).
 * The resolved args are what gets executed, so a confirmed preview runs on exactly the tasks it showed.
 */
export type Prepared = { args: CommandArgs; confirm?: { question: string; cards?: Card[] } } | { out: Out };

export type Command = {
  name: string;
  category: CommandCategory;
  /** One line for help, suggestions and the LLM router. */
  summary: string;
  /** Things the user can say; the first is shown in help. */
  examples: string[];
  /** Argument schema; the LLM router's output is validated against it. Dates and times are never taken from the model. */
  schema: z.ZodType<CommandArgs>;
  /** Rule patterns (English, Urdu script, Roman Urdu). Pure; null when the text isn't this command. */
  parse(text: string, ctx: ParseCtx): CommandArgs | null;
  /** Reference resolver + confirmation policy. Absent: execute directly. */
  prepare?(turn: Turn, args: CommandArgs): Promise<Prepared>;
  execute(turn: Turn, args: CommandArgs): Promise<Out>;
  /** Execute records an undo step (turn.state.undo), reverted by "undo" or the Undo button. */
  undoable: boolean;
  /** Wrapped existing intent: matched by nlu.ts rules, not by its own parse in the main pipeline. */
  wrapped?: boolean;
};
