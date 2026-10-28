import { z } from "zod";
import { prisma } from "../../../config/db.js";
import { applyDocumentItems } from "../../documents/applyItems.js";
import { notifyAddedFromWhatsapp } from "../../push/pushService.js";
import type { Out, Turn } from "../dialogue.js";
import type { Command, CommandArgs } from "./types.js";

/**
 * Internal commands for a document sent on WhatsApp (the user's own agent). Not in COMMANDS: they never match
 * a sentence, never show up in help or suggestions and the LLM router can't pick them; only the agent's
 * document reply starts them (a "command" payload). Nothing is created until the user answers "1" / "yes":
 * the preview is a confirm_command, so the usual 10-minute expiry applies and "Show again" re-reads the document.
 */

type Saved = {
  deadlines?: Array<{ title: string; date: string | null; time: string | null; created?: boolean; existing?: boolean; needsSemesterStart?: boolean }>;
  schedules?: Array<{ title: string; daysOfWeek: number[]; time: string | null; durationMinutes: number | null; room: string | null; created?: boolean; existing?: boolean }>;
  warning?: string | null;
};

const schema = z.object({ documentId: z.string().uuid() }).passthrough();
const LIST_CAP = 8;

const COPY = {
  en: {
    gone: "That document is no longer there.",
    nothing: (undated: number) => (undated ? `Nothing here has a date I can use. Review the ${undated} item${undated === 1 ? "" : "s"} in the app (Documents).` : "I didn't find any deadlines or classes to add."),
    found: (n: number) => `I found ${n} item${n === 1 ? "" : "s"} with dates:`,
    more: (n: number) => `…and ${n} more`,
    undated: (n: number) => `${n} more need${n === 1 ? "s" : ""} a date: review ${n === 1 ? "it" : "them"} in the app (Documents).`,
    addAll: "Add all",
    review: "Review in app",
    ignore: "Ignore",
    added: (t: number, r: number) => `Added ${t} task${t === 1 ? "" : "s"}${r ? ` and ${r} class${r === 1 ? "" : "es"}` : ""}.`,
    skipped: (n: number) => `${n} already existed.`,
    reviewReply: "Okay. Open the app → Documents to review them; nothing was added.",
  },
  // Roman Urdu (the WhatsApp Agent replies in English or Roman Urdu only).
  ur: {
    gone: "Woh document ab mojood nahin.",
    nothing: (undated: number) => (undated ? `Is mein koi kaam ki date nahin mili. ${undated} item app mein (Documents) dekh lein.` : "Is mein koi deadline ya class nahin mili."),
    found: (n: number) => `${n} item mile jin ki date hai:`,
    more: (n: number) => `…aur ${n}`,
    undated: (n: number) => `${n} ki date nahin: app mein (Documents) dekh lein.`,
    addAll: "Sab add karein",
    review: "App mein dekhein",
    ignore: "Rehne dein",
    added: (t: number, r: number) => `${t} task${r ? ` aur ${r} class` : ""} add ho gaye.`,
    skipped: (n: number) => `${n} pehle se mojood the.`,
    reviewReply: "Theek hai. App mein Documents khol kar dekh lein; kuch add nahin hua.",
  },
};
const copyFor = (language: string) => (language === "ur" ? COPY.ur : COPY.en);

async function readyItems(turn: Turn, documentId: string) {
  const doc = await prisma.document.findFirst({ where: { id: documentId, userId: turn.user.id }, select: { id: true, extracted: true } });
  if (!doc) return null;
  const saved = (doc.extracted ?? {}) as Saved;
  const open = <T extends { created?: boolean; existing?: boolean }>(x: T) => !x.created && !x.existing;
  const deadlines = (saved.deadlines ?? []).filter(open);
  const schedules = (saved.schedules ?? []).filter(open);
  const dated = deadlines.filter((d): d is typeof d & { date: string } => Boolean(d.date) && !d.needsSemesterStart);
  const weekly = schedules.filter((s) => s.daysOfWeek.length > 0);
  return { doc, dated, weekly, undated: deadlines.length - dated.length + schedules.length - weekly.length };
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const documentAddItems: Command = {
  name: "document_add_items",
  category: "general",
  summary: "Add the dated items found in a document sent on WhatsApp",
  examples: [],
  schema: schema as z.ZodType<CommandArgs>,
  parse: () => null,
  undoable: false,
  async prepare(turn, args) {
    const c = copyFor(turn.settings.language);
    const items = await readyItems(turn, String(args.documentId));
    if (!items) return { out: { content: c.gone, intent: "document_gone" } };
    const total = items.dated.length + items.weekly.length;
    if (!total) return { out: { content: c.nothing(items.undated), intent: "document_nothing" } };
    const lines = [
      ...items.dated.map((d) => `• ${d.title}: ${d.date}${d.time ? ` ${d.time}` : ""}`),
      ...items.weekly.map((s) => `• ${s.title}: ${s.daysOfWeek.map((d) => DAYS[d]).join(", ")}${s.time ? ` ${s.time}` : ""}`),
    ];
    const shown = lines.slice(0, LIST_CAP);
    const question = [c.found(total), ...shown, ...(lines.length > shown.length ? [c.more(lines.length - shown.length)] : []), ...(items.undated ? [c.undated(items.undated)] : [])].join("\n");
    return {
      args,
      confirm: {
        question,
        actions: [
          { label: c.addAll, payload: { type: "confirm_pending" }, style: "primary" },
          { label: c.review, payload: { type: "command", command: "document_review", args: { documentId: String(args.documentId) } } },
          { label: c.ignore, payload: { type: "cancel_pending" } },
        ],
      },
    };
  },
  async execute(turn, args): Promise<Out> {
    const c = copyFor(turn.settings.language);
    const items = await readyItems(turn, String(args.documentId));
    if (!items) return { content: c.gone, intent: "document_gone" };
    const r = await applyDocumentItems({ userId: turn.user.id, tz: turn.tz, deviceId: turn.task.deviceId ?? null }, items.doc.id, {
      deadlines: items.dated.map((d) => ({ title: d.title, date: d.date, time: d.time })),
      schedules: items.weekly.map((s) => ({ title: s.title, daysOfWeek: s.daysOfWeek, time: s.time, durationMinutes: s.durationMinutes, location: s.room })),
    });
    notifyAddedFromWhatsapp(turn.user.id, [...r.tasks.map((t) => t.title), ...r.routines.map((x) => x.title)]);
    const parts = [c.added(r.tasks.length, r.routines.length), ...(r.skipped ? [c.skipped(r.skipped)] : []), ...(items.undated ? [c.undated(items.undated)] : [])];
    return { content: parts.join(" "), intent: "document_added" };
  },
};

export const documentReview: Command = {
  name: "document_review",
  category: "general",
  summary: "Leave a WhatsApp document for review in the app",
  examples: [],
  schema: schema as z.ZodType<CommandArgs>,
  parse: () => null,
  undoable: false,
  async execute(turn): Promise<Out> {
    turn.state.pending = null;
    return { content: copyFor(turn.settings.language).reviewReply, intent: "document_review" };
  },
};

export const internalCommands: Command[] = [documentAddItems, documentReview];
