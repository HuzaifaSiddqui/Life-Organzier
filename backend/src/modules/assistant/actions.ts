import type { Pending, QuickAction } from "./types.js";

/**
 * Buttons carry what runs when tapped (the contract in docs/chat-failures.md): a command id with arguments, or an
 * answer to one open question. `text` is only what a WhatsApp user can type instead.
 */
type Style = QuickAction["style"];

/** Run a registry command with these arguments. */
export function commandAction(label: string, command: string, args: Record<string, unknown> = {}, opts: { text?: string; style?: Style } = {}): QuickAction {
  return { label, ...(opts.text ? { text: opts.text } : {}), payload: { type: "command", command, args }, ...(opts.style ? { style: opts.style } : {}) };
}

/** A wrapped intent (create_task, read_back, …): its arguments are read from this text, the intent is fixed. */
export function sayAction(label: string, command: string, text: string, style?: Style): QuickAction {
  return commandAction(label, command, { text }, { text, style });
}

/** An answer to the open question of this kind ("Tomorrow", "2", "yes"). */
export function answerAction(label: string, pending: Pending["kind"], text: string, style?: Style): QuickAction {
  return { label, text, payload: { type: "answer", pending, text }, ...(style ? { style } : {}) };
}
