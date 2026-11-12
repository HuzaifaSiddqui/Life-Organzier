import type { User } from "@prisma/client";
import nodemailer from "nodemailer";
import { prisma } from "../../config/db.js";
import { createRateLimiter } from "../../lib/rateLimit.js";
import { personLabel } from "./collabRules.js";

/**
 * Task collaboration: an email to the person a task was shared with or assigned to (COLLAB_TASKS). The address is
 * the invited user's own account email, read here and never sent to any client. Sending is queued and never throws
 * into a share: a failure is counted, not surfaced. Addresses and credentials are never logged.
 *
 * SMTP comes from backend/.env (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, SMTP_SECURE); with no host
 * nothing is sent. Tests replace the transport with `setMailTransport`.
 */

export type MailTransport = { sendMail(msg: { from: string; to: string; subject: string; text: string }): Promise<unknown> };

let transport: MailTransport | null | undefined;
/** Per recipient: at most this many invitation emails an hour. */
export const INVITE_EMAILS_PER_HOUR = 10;
const limiter = createRateLimiter({ limit: INVITE_EMAILS_PER_HOUR, windowMs: 3_600_000 });
const stats = { sent: 0, skipped: 0, failed: 0 };
let queue: Promise<void> = Promise.resolve();

function fromEnv(): MailTransport | null {
  const host = process.env.SMTP_HOST?.trim();
  if (!host) return null;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  return nodemailer.createTransport({ host, port, secure: process.env.SMTP_SECURE === "true" || port === 465, ...(user && pass ? { auth: { user, pass } } : {}) });
}

/** Tests: a fake transport (null = sending off). Production reads the env the first time it sends. */
export function setMailTransport(t: MailTransport | null | undefined): void {
  transport = t;
  limiter.reset();
  stats.sent = stats.skipped = stats.failed = 0;
}

export function mailStats(): Readonly<typeof stats> {
  return stats;
}

/** Resolves when every queued email has been tried (tests). */
export function mailSettled(): Promise<void> {
  return queue;
}

export function inviteEmailText(inviter: string, title: string, kind: "ASSIGN" | "COLLAB", appName = "Life Organizer"): { subject: string; text: string } {
  const what = kind === "ASSIGN" ? "assigned a task to you" : "shared a task with you";
  return {
    subject: `${inviter} ${what}: ${title}`,
    text: [
      `${inviter} ${what} in ${appName}:`,
      "",
      `  ${title}`,
      "",
      `Open ${appName} on your phone and go to People & sharing to accept or decline it.`,
      "",
      `You get this email because someone you are connected with shared a task with you. Turn it off in ${appName}: Settings → Notifications → Email me about shared tasks.`,
    ].join("\n"),
  };
}

/**
 * Queues the invitation email for one user. Skipped (silently) when SMTP isn't configured, the user turned emails
 * off, the account is being deleted, or the recipient's hourly limit is reached.
 */
export function queueInviteEmail(toUserId: string, inviter: Pick<User, "username" | "displayName">, task: { title: string; kind: "ASSIGN" | "COLLAB" }): void {
  queue = queue.then(() => sendOne(toUserId, inviter, task)).catch(() => undefined);
}

async function sendOne(toUserId: string, inviter: Pick<User, "username" | "displayName">, task: { title: string; kind: "ASSIGN" | "COLLAB" }): Promise<void> {
  if (transport === undefined) transport = fromEnv();
  if (!transport) return void (stats.skipped += 1);
  const user = await prisma.user.findFirst({ where: { id: toUserId, deletionRequestedAt: null }, select: { email: true, settings: { select: { emailInvites: true } } } });
  if (!user?.email || user.settings?.emailInvites === false) return void (stats.skipped += 1);
  try {
    limiter.take(toUserId);
  } catch {
    return void (stats.skipped += 1);
  }
  const { subject, text } = inviteEmailText(personLabel(inviter), task.title, task.kind);
  try {
    await transport.sendMail({ from: process.env.SMTP_FROM?.trim() || process.env.SMTP_USER || "life-organizer@localhost", to: user.email, subject, text });
    stats.sent += 1;
  } catch {
    stats.failed += 1;
    console.warn("Invitation email failed (1 recipient)"); // never the address or the error body
  }
}
