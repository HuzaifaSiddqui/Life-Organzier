import type { User, UserSettings } from "@prisma/client";
import { prisma } from "../../config/db.js";
import { instantLabel } from "../../lib/time.js";
import { logEvent } from "../events/eventService.js";
import { processDocument } from "../documents/documentProcessing.js";

function twilioConfigured(): boolean {
  return Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_WHATSAPP_FROM);
}

function authHeader(): string {
  return `Basic ${Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64")}`;
}

export async function sendWhatsapp(to: string, body: string): Promise<boolean> {
  if (!twilioConfigured()) return false;
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: "POST",
    headers: { Authorization: authHeader(), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ From: `whatsapp:${process.env.TWILIO_WHATSAPP_FROM}`, To: `whatsapp:${to}`, Body: body }).toString(),
  });
  return response.ok;
}

/** Image/PDF sent on WhatsApp → OCR + extraction, summarised as a reply (FR-WA-001 §1). */
export async function processDocumentForWhatsapp(user: User, settings: UserSettings, mediaUrl: string, mediaType: string): Promise<string> {
  if (!twilioConfigured()) return "I can't download media yet — Twilio credentials aren't configured on the server.";
  const response = await fetch(mediaUrl, { headers: { Authorization: authHeader() } });
  if (!response.ok) return "I couldn't download that file. Please try again.";
  const buffer = Buffer.from(await response.arrayBuffer());
  const result = await processDocument(user, settings, {
    buffer,
    fileName: mediaType === "application/pdf" ? "whatsapp.pdf" : "whatsapp.jpg",
    mimeType: mediaType,
    docType: "OTHER",
    language: "eng",
    autoCreate: true,
  });
  const created = result.createdTasks.length + result.createdRoutines.length;
  const pending = result.extracted.deadlines.filter((d) => !d.created).length + result.extracted.schedules.filter((s) => !s.created).length;
  if (result.extracted.warning && !created) return result.extracted.warning;
  return `✓ Read your document. Created ${created} item${created === 1 ? "" : "s"}${pending ? `; ${pending} more need your review in the app (Documents).` : "."}`;
}

let pausedUntil = 0;

/**
 * Pro-only WhatsApp reminders (FR-WA-002): only within the 24h customer-service window,
 * otherwise the app's local notification covers it. A global rate guard pauses sending if a
 * burst is detected, protecting the business account from suspension.
 */
export async function sendDueWhatsappReminders(now = new Date()): Promise<number> {
  if (!twilioConfigured() || pausedUntil > now.getTime()) return 0;
  const recentSends = await prisma.activityEvent.count({ where: { type: "WHATSAPP_SENT", createdAt: { gte: new Date(now.getTime() - 10 * 60000) } } });
  if (recentSends > 50) {
    pausedUntil = now.getTime() + 3600000;
    console.warn("WhatsApp reminders paused for 1h: bulk sending detected");
    return 0;
  }
  const due = await prisma.reminderLog.findMany({
    where: { status: "SCHEDULED", fireAt: { lte: now, gte: new Date(now.getTime() - 6 * 60000) }, taskId: { not: null } },
    include: { user: { include: { settings: true } } },
    take: 100,
  });
  let sent = 0;
  for (const r of due) {
    const s = r.user.settings;
    if (!s || s.tier !== "PRO" || !r.user.phoneNumber) continue;
    if (!["ALL", "WHATSAPP"].includes(s.notificationDevices)) continue;
    if (!s.lastWhatsappMessageAt || s.lastWhatsappMessageAt < new Date(now.getTime() - 24 * 3600000)) continue;
    const task = await prisma.task.findUnique({ where: { id: r.taskId as string } });
    if (!task || !task.dueAt || task.status === "COMPLETED" || task.status === "DELETED") continue;
    const ok = await sendWhatsapp(r.user.phoneNumber, `⏰ Remember: ${task.title} due ${instantLabel(task.dueAt, s.timezone, now)}. Reply "done" when finished.`);
    if (!ok) continue;
    await prisma.reminderLog.update({ where: { id: r.id }, data: { status: "SENT_WHATSAPP" } });
    logEvent(r.userId, "WHATSAPP_SENT", task.id, { level: r.level });
    sent += 1;
  }
  return sent;
}
