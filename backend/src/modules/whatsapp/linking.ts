import crypto from "node:crypto";
import { prisma } from "../../config/db.js";
import { setBounded } from "../../lib/boundedMap.js";

/**
 * FR-WA-001 verified linking. The app shows an 8-character code; the user sends "LINK <code>" from
 * WhatsApp, which proves they own the number. Only a hash of the code is stored, it expires after
 * 10 minutes, and a sending number gets 5 failed attempts per hour. Every failure gets the same reply,
 * so a sender learns nothing about why (wrong code, expired, number taken, not Pro).
 */

/** No 0/O or 1/I, so a code read off the screen can't be mistyped. */
export const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const CODE_LENGTH = 8;
export const CODE_TTL_MS = 10 * 60000;
export const MAX_FAILURES_PER_HOUR = 5;

export const LINK_FAILED_REPLY = "That code didn't work. Open the app → Settings → WhatsApp to get a new code, then send LINK followed by the code.";
export const LINKED_REPLY = "Linked! You can now message me here: add tasks, ask what's due, or send a photo of your timetable.";

export function generateCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i += 1) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return code;
}

export function hashCode(code: string): string {
  return crypto.createHash("sha256").update(code).digest("hex");
}

/** "whatsapp:+92 300-1234567" → "+923001234567"; null when it isn't an E.164 number. */
export function normalizeNumber(raw: string): string | null {
  const n = raw.replace(/^whatsapp:/i, "").replace(/[\s()-]/g, "");
  return /^\+[1-9]\d{7,14}$/.test(n) ? n : null;
}

/** "+923001234567" → "••••••567" (settings screen shows only the last 3 digits). */
export function maskNumber(n: string | null): string | null {
  return n ? `••••••${n.slice(-3)}` : null;
}

/** "LINK 7KQ9-MX2P" → "7KQ9MX2P"; null when the message isn't a LINK command. */
export function parseLinkCommand(text: string): string | null {
  const m = /^\s*link\s+([a-z0-9\s-]{8,12})\s*$/i.exec(text);
  if (!m) return null;
  const code = m[1].replace(/[\s-]/g, "").toUpperCase();
  return code.length === CODE_LENGTH ? code : "";
}

// ponytail: in-memory per server process; a restart forgets recent failures. Move to the database if the
// backend ever runs as several instances.
const failures = new Map<string, number[]>();
/** Sending numbers remembered at most; the oldest are forgotten first. */
export const MAX_FAILURE_ENTRIES = 10000;

function recentFailures(number: string, now: number): number[] {
  return (failures.get(number) ?? []).filter((t) => now - t < 3600000);
}

/** Test hook. */
export function resetLinkFailures(): void {
  failures.clear();
}

/** New code for the user (replaces any earlier one). */
export async function startLink(userId: string, now = new Date()): Promise<{ code: string; expiresAt: Date }> {
  const code = generateCode();
  const expiresAt = new Date(now.getTime() + CODE_TTL_MS);
  await prisma.whatsappLinkCode.upsert({
    where: { userId },
    create: { userId, codeHash: hashCode(code), expiresAt },
    update: { codeHash: hashCode(code), expiresAt, createdAt: now },
  });
  return { code, expiresAt };
}

export async function unlink(userId: string): Promise<void> {
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { phoneNumber: null, phoneVerifiedAt: null } }),
    prisma.whatsappLinkCode.deleteMany({ where: { userId } }),
  ]);
}

export type LinkOutcome = { kind: "linked"; userId: string } | { kind: "failed" } | { kind: "locked" };

/**
 * Handles "LINK <code>" from `fromNumber` (already E.164). The code decides the account, never the
 * sender. "locked": too many failures from this number this hour; say nothing.
 */
export async function tryLink(fromNumber: string, code: string, now = new Date()): Promise<LinkOutcome> {
  const t = now.getTime();
  if (recentFailures(fromNumber, t).length >= MAX_FAILURES_PER_HOUR) return { kind: "locked" };
  const fail = (): LinkOutcome => {
    setBounded(failures, fromNumber, [...recentFailures(fromNumber, t), t], MAX_FAILURE_ENTRIES);
    return { kind: "failed" };
  };
  if (code.length !== CODE_LENGTH) return fail();
  const row = await prisma.whatsappLinkCode.findUnique({ where: { codeHash: hashCode(code) }, include: { user: { include: { settings: true } } } });
  if (!row || row.expiresAt <= now || row.user.settings?.tier !== "PRO") return fail();
  const owner = await prisma.user.findUnique({ where: { phoneNumber: fromNumber } });
  if (owner && owner.id !== row.userId) return fail(); // already linked to another account
  await prisma.$transaction([
    prisma.user.update({ where: { id: row.userId }, data: { phoneNumber: fromNumber, phoneVerifiedAt: now } }),
    prisma.whatsappLinkCode.delete({ where: { userId: row.userId } }),
  ]);
  return { kind: "linked", userId: row.userId };
}
