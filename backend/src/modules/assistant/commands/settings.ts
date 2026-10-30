import type { Prisma } from "@prisma/client";
import { sayAction } from "../actions.js";
import { chatFixesOn } from "../chatFixes.js";
import { z } from "zod";
import { prisma } from "../../../config/db.js";
import { addDaysYmd, formatClock, localParts, localYmd, parseClock, relativeDayLabel, zonedTimeToUtc } from "../../../lib/time.js";
import { formatDuration } from "../../../lib/text.js";
import { logEvent } from "../../events/eventService.js";
import { STYLE_NAMES } from "../../checkins/templates.js";
import { isPro, type Turn } from "../dialogue.js";
import { extractEntities, extractTimeRange } from "../entities.js";
import { ASK, has, norm } from "./lexicon.js";
import { commandText, dayLabelFor } from "./copy.js";
import { recordUndo, undoAction } from "./runtime.js";
import type { Command, ParseCtx } from "./types.js";

/** Settings changed from chat: the phone reloads its preferences when a reply's intent starts with "settings_". */
async function save(turn: Turn, data: Prisma.UserSettingsUpdateInput, before: Record<string, unknown>, label: string): Promise<void> {
  turn.settings = await prisma.userSettings.update({ where: { userId: turn.user.id }, data });
  recordUndo(turn, { kind: "settings", before, label });
  logEvent(turn.user.id, "SETTINGS_CHANGED", null, { fields: Object.keys(data), via: "chat" });
}

const clock = (hhmm: string) => {
  const c = parseClock(hhmm);
  return c ? formatClock(c.h, c.m) : hhmm;
};
const hhmm = (text: string) => {
  const c = parseClock(text);
  return c ? `${String(c.h).padStart(2, "0")}:${String(c.m).padStart(2, "0")}` : null;
};

function whenLabel(turn: Turn, at: Date): string {
  const p = localParts(at, turn.tz);
  const day = localYmd(at, turn.tz);
  return `${day === turn.todayYmd ? "" : `${dayLabelFor(turn.settings.language, relativeDayLabel(day, turn.todayYmd))} `}${formatClock(p.h, p.mi)}`.trim();
}

function dndLine(turn: Turn): string {
  const until = turn.settings.dndUntil;
  const c = commandText(turn.settings.language);
  return until && until > turn.now ? c.dndOnUntil(whenLabel(turn, until)) : c.dndOff;
}


/* ------------------------------------------------------------------ quiet hours */

const QUIET = "quiet hours|quiet hour|quiet time|silent hours|sleep hours|quiet|khamoshi ke auqat|khamoshi|khamosh|خاموشی کے اوقات|خاموش اوقات|خاموشی";
const DND = "do not disturb|dont disturb|dnd|disturb na|disturb mat|tang na|tang mat|ڈسٹرب|ڈو ناٹ ڈسٹرب|پریشان نہ";

const quietHours: Command = {
  name: "settings_quiet_hours",
  category: "settings",
  summary: "See or change your quiet hours (no reminders then)",
  examples: ["Set quiet hours from 11 PM to 7 AM", "What are my quiet hours?"],
  schema: z.object({ start: z.string().max(20).optional(), end: z.string().max(20).optional() }).passthrough(),
  undoable: true,
  parse(text, ctx) {
    const t = norm(text);
    if (!has(t, QUIET) || has(t, DND)) return null;
    const range = extractTimeRange(text);
    if (range) return { start: range.start, end: range.end };
    const e = extractEntities(text, ctx.opts);
    if (e.time && e.timeExplicit) {
      if (has(t, "end|ends|until|till|stop|khatam|ختم")) return { end: e.time };
      if (has(t, "start|starts|begin|from|shuru|شروع")) return { start: e.time };
    }
    return {};
  },
  async execute(turn, args) {
    const s = turn.settings;
    const c = commandText(s.language);
    const start = typeof args.start === "string" ? hhmm(args.start) : null;
    const end = typeof args.end === "string" ? hhmm(args.end) : null;
    if (!start && !end) {
      return { content: c.quietRead(clock(s.quietStart), clock(s.quietEnd), !s.criticalOverridesDnd), actions: [sayAction(c.quietChange, "settings_quiet_hours", "Set quiet hours from 11 PM to 7 AM")], intent: "settings_quiet_hours" };
    }
    const data = { quietStart: start ?? s.quietStart, quietEnd: end ?? s.quietEnd };
    if (data.quietStart === data.quietEnd) return { content: c.quietSame, intent: "settings_invalid" };
    await save(turn, data, { quietStart: s.quietStart, quietEnd: s.quietEnd }, "quiet hours change");
    return { content: c.quietSet(clock(data.quietStart), clock(data.quietEnd)), actions: [undoAction(s.language)], intent: "settings_quiet_hours_set" };
  },
};

/* ------------------------------------------------------------------ Do Not Disturb */

const MAX_DND_MINUTES = 24 * 60;

const MUTE = /\b(?:mute|silence|turn\s+off|switch\s+off|shut\s+off|pause|stop|disable|block|hold|no\s+more)\b/i;
const NOTIFY_WORD = /\b(?:notifications?|alerts?|reminders?|pings?)\b/i;
const NOTHING_NAMED = /\b(?:mute|silence|turn|switch|shut|off|pause|stop|disable|block|hold|no|more|notifications?|alerts?|reminders?|pings?|all|my|the|any|every|everything|please|can|could|you|u|for|me|a|while|now|until|till|right|just|from|of|today|tonight|this|morning|afternoon|evening)\b/gi;

/**
 * "mute notifications for 2 hours", "turn off all alerts until 5": muting with no task named. Any clause may say it
 * ("I'm in class, turn off notifications for 2 hours"): a status clause names no task either.
 */
function muteEverything(text: string, ctx: ParseCtx): boolean {
  return text.split(/\s*[,;]\s*|\.\s+/).some((clause) => {
    if (!MUTE.test(clause) || !NOTIFY_WORD.test(clause)) return false;
    const rest = extractEntities(clause, ctx.opts).residual.replace(NOTHING_NAMED, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    return rest === "";
  });
}

const dnd: Command = {
  name: "settings_dnd",
  category: "settings",
  summary: "Do Not Disturb on (for a while or until a time), off, or check it",
  examples: ["Do not disturb for 2 hours", "DND until 5 PM", "Turn off DND"],
  schema: z.object({ action: z.enum(["on", "off", "status"]), minutes: z.number().int().min(1).max(MAX_DND_MINUTES).optional(), until: z.string().max(20).optional() }).passthrough(),
  undoable: true,
  parse(text, ctx) {
    const t = norm(text);
    if (!has(t, DND)) {
      // CHAT_FIXES_V2: "mute notifications for 90 minutes" names no task, so it is Do Not Disturb (on), not a
      // task's reminder mode; "turn off reminders for the essay" names one and is left to task_reminder_mode.
      if (!chatFixesOn() || !muteEverything(text, ctx)) return null;
      const e = extractEntities(text, ctx.opts);
      if (e.time && e.timeExplicit) return { action: "on", until: e.time };
      return e.durationMinutes ? { action: "on", minutes: Math.min(e.durationMinutes, MAX_DND_MINUTES) } : { action: "on" };
    }
    if (has(t, "off|stop|end|disable|cancel|band|khatam|hata|hatao|بند|ختم|ہٹا")) return { action: "off" };
    // "is DND on?" asks; "turn on DND" / "can you turn on DND?" instructs.
    if (!has(t, "turn on|switch on|enable|start|set|put|laga|lagao|aan kar|آن کر|لگا") && (/^(?:is|am|are|kya)\b/.test(t) || /[?؟]\s*$/.test(text) || has(t, "status|still"))) return { action: "status" };
    const e = extractEntities(text, ctx.opts);
    if (e.time && e.timeExplicit && has(t, "until|till|tak|تک|upto|up to")) return { action: "on", until: e.time };
    if (e.durationMinutes) return { action: "on", minutes: Math.min(e.durationMinutes, MAX_DND_MINUTES) };
    if (e.time && e.timeExplicit) return { action: "on", until: e.time };
    return { action: "on" };
  },
  async execute(turn, args) {
    const tx = commandText(turn.settings.language);
    if (args.action === "status") return { content: dndLine(turn), intent: "settings_dnd" };
    const before = { dndUntil: turn.settings.dndUntil?.toISOString() ?? null };
    if (args.action === "off") {
      if (!turn.settings.dndUntil || turn.settings.dndUntil <= turn.now) return { content: tx.dndAlreadyOff, intent: "settings_dnd" };
      await save(turn, { dndUntil: null }, before, "Do Not Disturb turned off");
      return { content: tx.dndTurnedOff, actions: [undoAction(turn.settings.language)], intent: "settings_dnd_off" };
    }
    let until: Date;
    const c = typeof args.until === "string" ? parseClock(args.until) : null;
    if (c) {
      until = zonedTimeToUtc(turn.todayYmd, c.h, c.m, turn.tz);
      if (until <= turn.now) until = zonedTimeToUtc(addDaysYmd(turn.todayYmd, 1), c.h, c.m, turn.tz);
    } else {
      until = new Date(turn.now.getTime() + Number(args.minutes ?? 60) * 60000);
    }
    const minutes = Math.round((until.getTime() - turn.now.getTime()) / 60000);
    if (minutes > MAX_DND_MINUTES) until = new Date(turn.now.getTime() + MAX_DND_MINUTES * 60000);
    await save(turn, { dndUntil: until }, before, "Do Not Disturb");
    return {
      content: tx.dndOn(whenLabel(turn, until), formatDuration(Math.min(minutes, MAX_DND_MINUTES)), !(args.minutes || args.until), turn.settings.criticalOverridesDnd),
      actions: [undoAction(turn.settings.language), sayAction(tx.turnOff, "settings_dnd", "Turn off DND")],
      intent: "settings_dnd_on",
    };
  },
};

/* ------------------------------------------------------------------ where reminders go */

const NOTIFY = "remind|reminders|reminder|notifications|notification|notify|alerts|alert|messages|yaad dihani|ریمائنڈر|ریمائنڈرز|نوٹیفکیشن|یاد دہانی|اطلاع";
const WA = "whatsapp|whats app|wa|واٹس ایپ|واٹس اپ";
const PHONE = "phone|mobile|app|push|فون|موبائل";
const BOTH = "both|everywhere|dono|donon|دونوں|ہر جگہ";

const notifyDevices: Command = {
  name: "settings_notify_devices",
  category: "settings",
  summary: "Where reminders go: phone, WhatsApp (Pro) or both",
  examples: ["Send my reminders to WhatsApp only", "Remind me on both phone and WhatsApp"],
  schema: z.object({ devices: z.enum(["ALL", "PHONE", "WHATSAPP"]).optional() }).passthrough(),
  undoable: true,
  parse(text, ctx) {
    const t = norm(text);
    if (!has(t, NOTIFY)) return null;
    const wa = has(t, WA);
    const phone = has(t, PHONE);
    const both = has(t, BOTH);
    if (!wa && !phone && !both) return has(t, "where|kahan|kahaan|کہاں") ? {} : null;
    const e = extractEntities(text, ctx.opts);
    if (e.date || e.timeExplicit) return null; // "remind me on WhatsApp tomorrow to …" is a new task
    const off = has(t, "off|stop|band|no|dont|بند|نہیں");
    if (both || (wa && phone && !off)) return { devices: "ALL" };
    if (wa) return { devices: off ? "PHONE" : "WHATSAPP" };
    return { devices: off ? "WHATSAPP" : "PHONE" };
  },
  async execute(turn, args) {
    const c = commandText(turn.settings.language);
    const where = (d: string) => c.devices[d] ?? d;
    const current = turn.settings.notificationDevices;
    if (!args.devices) return { content: c.devicesRead(where(current)), intent: "settings_notify_devices" };
    const devices = String(args.devices);
    if (devices !== "PHONE" && !isPro(turn.settings)) return { content: c.devicesPro, intent: "settings_pro_only" };
    if (devices !== "PHONE" && !(turn.user.phoneNumber && turn.user.phoneVerifiedAt)) {
      return { content: c.devicesUnlinked, actions: [{ label: c.openSettings, payload: { type: "navigate", screen: "Settings" } }], intent: "settings_whatsapp_unlinked" };
    }
    if (devices === current) return { content: c.devicesAlready(where(devices)), intent: "settings_notify_devices" };
    await save(turn, { notificationDevices: devices }, { notificationDevices: current }, "reminder devices change");
    return { content: c.devicesSet(where(devices), devices !== "PHONE"), actions: [undoAction(turn.settings.language)], intent: "settings_notify_devices_set" };
  },
};

/* ------------------------------------------------------------------ language */

const LANG_PATTERNS: RegExp[] = [
  /\b(?:switch|change|set)\s+(?:the\s+)?(?:app\s+)?(?:language\s+)?(?:to|into)\s+(english|urdu)\b/i,
  /\b(?:reply|talk|speak|answer|respond|write)\s+(?:to\s+me\s+)?in\s+(english|urdu)\b/i,
  /^(?:in\s+)?(english|urdu)\s+(?:please|plz|pls)\b/i,
  /\blanguage\s+(?:to\s+)?(english|urdu)\b/i,
  /\b(english|urdu|angrezi|angraizi)\s+(?:mein|me|main)\s+(?:baat|bat|jawab|likho|bolo|likhein)/i,
  /\bzaba?a?n\s+(english|urdu|angrezi)\b/i,
  /زبان\s+(اردو|انگریزی|انگلش)/,
  /(اردو|انگریزی|انگلش)\s+میں\s+(?:بات|جواب|لکھو|لکھیں|بولو)/,
];

const language: Command = {
  name: "settings_language",
  category: "settings",
  summary: "Switch the assistant between English and Urdu",
  examples: ["Switch to Urdu", "Change the language to English"],
  schema: z.object({ language: z.enum(["en", "ur"]).optional() }).passthrough(),
  undoable: true,
  parse(text) {
    for (const re of LANG_PATTERNS) {
      const m = re.exec(text.trim());
      if (m) return { language: /urdu|اردو/i.test(m[1]) ? "ur" : "en" };
    }
    return /\b(?:what|which)\s+language\b|kaunsi zaban|konsi zaban|کونسی زبان/i.test(text) ? {} : null;
  },
  async execute(turn, args) {
    const current = turn.settings.language === "ur" ? "ur" : "en";
    const c = commandText(turn.settings.language);
    if (!args.language) return { content: c.languageRead(c.languageNames[current], current === "ur" ? "English" : "Urdu"), intent: "settings_language" };
    const next = args.language as "en" | "ur";
    if (next === current) return { content: next === "ur" ? "میں پہلے ہی اردو میں جواب دے رہا ہوں۔" : "I'm already replying in English.", intent: "settings_language" };
    await save(turn, { language: next }, { language: turn.settings.language }, "language change");
    return { content: next === "ur" ? "زبان اردو کر دی گئی ہے۔ اب میں اردو میں جواب دوں گا۔" : "Language set to English. I'll reply in English now.", actions: [undoAction(next)], intent: "settings_language_set" };
  },
};

/* ------------------------------------------------------------------ summary */

const settingsShow: Command = {
  name: "settings_show",
  category: "settings",
  summary: "Show your current settings",
  examples: ["Show my settings"],
  schema: z.object({}).passthrough(),
  undoable: false,
  parse(text) {
    const t = norm(text);
    if (!has(t, "settings|setting|preferences|سیٹنگز|سیٹنگ|ترتیبات") || t.split(" ").length > 6) return null;
    return has(t, ASK) || /^(?:my |meri |میری )?(?:settings|سیٹنگز)$/.test(t) ? {} : null;
  },
  async execute(turn) {
    const s = turn.settings;
    const lang = s.language === "ur" ? "ur" : "en";
    const c = commandText(lang);
    const L = c.settingsLines;
    const style = STYLE_NAMES[lang][s.checkinTone as "FUNNY" | "SERIOUS" | "GENTLE"] ?? s.checkinTone;
    const lines = [
      `${L.language}: ${c.languageNames[lang]}`,
      `${L.quiet}: ${clock(s.quietStart)} ${c.to} ${clock(s.quietEnd)}`,
      dndLine(turn),
      `${L.devices}: ${c.devices[s.notificationDevices] ?? s.notificationDevices}`,
      `${L.checkins}: ${s.checkinsEnabled ? `${L.on}, ${style}` : L.off}`,
      `${L.capacity}: ${formatDuration(s.dailyCapacityMinutes)} (${L.work} ${clock(s.workStart)} ${c.to} ${clock(s.workEnd)})`,
      `${L.plan}: ${isPro(s) ? "Pro" : "Free"}`,
    ];
    return { content: [c.settingsTitle, ...lines].join("\n"), actions: [{ label: c.openSettings, payload: { type: "navigate", screen: "Settings" } }], intent: "settings_show" };
  },
};

export const settingsCommands: Command[] = [dnd, quietHours, notifyDevices, language, settingsShow];

