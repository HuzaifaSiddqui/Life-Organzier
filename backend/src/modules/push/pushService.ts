import { getFirebaseMessaging } from "../../config/firebase.js";
import { fcmMessage, fcmTokenGone, isExpoToken } from "./pushRules.js";
import { prisma } from "../../config/db.js";
import { setBounded } from "../../lib/boundedMap.js";
import { background } from "../../lib/background.js";

/**
 * Push notifications to the user's phones (P2). Used so a task added on WhatsApp shows up on the phone
 * at once: the push tells the app to sync, and the sync schedules the local alarms. Tokens are never logged.
 */

/** `notify`: FCM only, shown by Android itself (reminders the phone missed; push/missedReminders.ts). */
export type PushMessage = { to: string; title: string; body: string; data?: Record<string, unknown>; notify?: { channelId: string; tag: string } };
/** One per message, in order: a ticket id to check later, or an error (e.g. DeviceNotRegistered). */
export type PushTicket = { id?: string; error?: string };

export interface PushProvider {
  send(messages: PushMessage[]): Promise<PushTicket[]>;
  /** Delivery receipts for earlier tickets: ticket id → error (absent or null = delivered). */
  receipts(ids: string[]): Promise<Record<string, string | null>>;
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const EXPO = "https://exp.host/--/api/v2/push";
const BATCH = 100;

/** Expo's push service (https://docs.expo.dev/push-notifications/sending-notifications/). */
export class ExpoPushProvider implements PushProvider {
  constructor(private readonly doFetch: Fetch = fetch as unknown as Fetch) {}

  private async post(path: string, body: unknown): Promise<unknown> {
    const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
    if (process.env.EXPO_ACCESS_TOKEN) headers.Authorization = `Bearer ${process.env.EXPO_ACCESS_TOKEN}`;
    const res = await this.doFetch(`${EXPO}/${path}`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`Expo push HTTP ${res.status}`);
    return res.json();
  }

  async send(messages: PushMessage[]): Promise<PushTicket[]> {
    const out: PushTicket[] = [];
    for (let i = 0; i < messages.length; i += BATCH) {
      const chunk = messages.slice(i, i + BATCH);
      const json = (await this.post("send", chunk.map(({ notify: _notify, ...m }) => ({ ...m, sound: "default", channelId: ANDROID_CHANNEL, priority: "high" })))) as {
        data?: Array<{ status: string; id?: string; details?: { error?: string } }>;
      };
      for (const t of json.data ?? []) out.push(t.status === "ok" ? { id: t.id } : { error: t.details?.error ?? "Unknown" });
    }
    return out;
  }

  async receipts(ids: string[]): Promise<Record<string, string | null>> {
    const out: Record<string, string | null> = {};
    for (let i = 0; i < ids.length; i += 1000) {
      const json = (await this.post("getReceipts", { ids: ids.slice(i, i + 1000) })) as { data?: Record<string, { status: string; details?: { error?: string } }> };
      for (const [id, r] of Object.entries(json.data ?? {})) out[id] = r.status === "ok" ? null : (r.details?.error ?? "Unknown");
    }
    return out;
  }
}

/** The app's existing Android channel (mobile/src/services/reminders.ts DEFAULT_CHANNEL_ID). */
const ANDROID_CHANNEL = "lo-sound-vibrate";

/**
 * Firebase Cloud Messaging through firebase-admin (the backend's existing service account; no Expo account needed).
 * Data-only, high priority: the phone's background task syncs, re-plans its alarms and shows a visible notification
 * itself when the message has a title (mobile/src/services/notificationActions.ts). Delivery is known at once, so
 * there are no receipts to check later.
 */
export class FcmPushProvider implements PushProvider {
  async send(messages: PushMessage[]): Promise<PushTicket[]> {
    const messaging = getFirebaseMessaging();
    return Promise.all(
      messages.map(async (m): Promise<PushTicket> => {
        try {
          const id = await messaging.send(fcmMessage(m));
          return { id: `fcm:${id}` };
        } catch (error) {
          const code = (error as { code?: string }).code;
          return { error: fcmTokenGone(code) ? "DeviceNotRegistered" : (code ?? "FcmError") };
        }
      }),
    );
  }

  async receipts(): Promise<Record<string, string | null>> {
    return {};
  }
}

/** Expo tokens through Expo, FCM device tokens through Firebase; results in the same order as `messages`. */
export class RoutingPushProvider implements PushProvider {
  constructor(
    private readonly expo: PushProvider = new ExpoPushProvider(),
    private readonly fcm: PushProvider = new FcmPushProvider(),
  ) {}

  async send(messages: PushMessage[]): Promise<PushTicket[]> {
    const expoIdx = messages.map((m, i) => (isExpoToken(m.to) ? i : -1)).filter((i) => i >= 0);
    const fcmIdx = messages.map((m, i) => (isExpoToken(m.to) ? -1 : i)).filter((i) => i >= 0);
    const [e, f] = await Promise.all([
      expoIdx.length ? this.expo.send(expoIdx.map((i) => messages[i])) : Promise.resolve([] as PushTicket[]),
      fcmIdx.length ? this.fcm.send(fcmIdx.map((i) => messages[i])) : Promise.resolve([] as PushTicket[]),
    ]);
    const out: PushTicket[] = new Array(messages.length);
    expoIdx.forEach((i, k) => (out[i] = e[k] ?? { error: "Unknown" }));
    fcmIdx.forEach((i, k) => (out[i] = f[k] ?? { error: "Unknown" }));
    return out;
  }

  async receipts(ids: string[]): Promise<Record<string, string | null>> {
    const expoIds = ids.filter((id) => !id.startsWith("fcm:"));
    return expoIds.length ? this.expo.receipts(expoIds) : {};
  }
}

let provider: PushProvider = new RoutingPushProvider();
/** Test hook. */
export function setPushProvider(p: PushProvider): void {
  provider = p;
}

// ponytail: tickets waiting for a receipt live in memory; a restart drops them (their tokens get cleaned up
// the next time a push to them fails). Fine for one backend instance.
const pendingReceipts = new Map<string, { token: string; at: number }>();
/** Tickets waiting for a receipt, at most; the oldest are dropped first. */
const MAX_PENDING_RECEIPTS = 10000;

/** Test hook. */
export function resetPushState(): void {
  pendingReceipts.clear();
}

export async function registerPushToken(userId: string, input: { token: string; platform: string; deviceId?: string | null }): Promise<void> {
  // A token belongs to one device; signing in with another account on that phone moves it.
  await prisma.pushToken.upsert({
    where: { token: input.token },
    create: { token: input.token, userId, platform: input.platform, deviceId: input.deviceId ?? null },
    update: { userId, platform: input.platform, deviceId: input.deviceId ?? null },
  });
}

/** Only the owner's token is removed; returns whether one was. */
export async function unregisterPushToken(userId: string, token: string): Promise<boolean> {
  return (await prisma.pushToken.deleteMany({ where: { token, userId } })).count > 0;
}

/**
 * Sign-out from a phone that may be offline: the queued retry has no login any more, so it proves the
 * device instead. Deletes only when both the token and the device's random install id match.
 */
export async function unregisterDeviceToken(token: string, deviceId: string): Promise<boolean> {
  return (await prisma.pushToken.deleteMany({ where: { token, deviceId } })).count > 0;
}

/**
 * A silent "sync" push to the user's phones that registered an FCM token, except the device that made the change:
 * the phone's background task syncs and re-plans its reminders without opening the app. Expo tokens are skipped (Expo
 * pushes are always visible). Coalesced per user for a few seconds so a burst of changes sends one push.
 */
const syncTimers = new Map<string, { timer: NodeJS.Timeout; except: Set<string | null> }>();
const SYNC_PUSH_DELAY_MS = 2500;

export function scheduleSyncPush(userId: string, exceptDeviceId: string | null): void {
  const pending = syncTimers.get(userId);
  if (pending) {
    // Two devices changed things: neither is excluded any more (each needs the other's change).
    if (!pending.except.has(exceptDeviceId)) pending.except = new Set([null]);
    return;
  }
  const entry = {
    except: new Set([exceptDeviceId]),
    timer: setTimeout(() => {
      syncTimers.delete(userId);
      background(sendSyncPush(userId, [...entry.except].filter((d): d is string => Boolean(d))));
    }, SYNC_PUSH_DELAY_MS),
  };
  entry.timer.unref?.();
  syncTimers.set(userId, entry);
}

async function sendSyncPush(userId: string, exceptDeviceIds: string[]): Promise<void> {
  try {
    const rows = await prisma.pushToken.findMany({ where: { userId, ...(exceptDeviceIds.length ? { OR: [{ deviceId: null }, { deviceId: { notIn: exceptDeviceIds } }] } : {}) }, select: { token: true } });
    const tokens = rows.map((r) => r.token).filter((t) => !isExpoToken(t));
    if (!tokens.length) return;
    const tickets = await provider.send(tokens.map((to) => ({ to, title: "", body: "", data: { type: "sync" } })));
    const dead = tokens.filter((_t, i) => tickets[i]?.error === "DeviceNotRegistered");
    if (dead.length) await prisma.pushToken.deleteMany({ where: { token: { in: dead } } });
  } catch (error) {
    console.warn("Sync push failed:", error instanceof Error ? error.message : error);
  }
}

/** Sends prepared messages (each to one token); dead tokens are removed. Returns how many were accepted. Never throws. */
export async function sendPushMessages(messages: PushMessage[]): Promise<number> {
  try {
    const tickets = await provider.send(messages);
    const dead = messages.filter((_m, i) => tickets[i]?.error === "DeviceNotRegistered").map((m) => m.to);
    if (dead.length) await prisma.pushToken.deleteMany({ where: { token: { in: dead } } });
    const failed = tickets.filter((t) => t.error && t.error !== "DeviceNotRegistered");
    if (failed.length) console.warn(`Push: ${failed.length} of ${tickets.length} not accepted (${failed[0].error})`);
    return tickets.filter((t) => t.id).length;
  } catch (error) {
    console.warn("Push failed:", error instanceof Error ? error.message : error);
    return 0;
  }
}

/** Sends to every phone of the user. Never throws (a push must not break the caller). */
export async function sendPushToUser(userId: string, msg: Omit<PushMessage, "to">): Promise<number> {
  try {
    const tokens = (await prisma.pushToken.findMany({ where: { userId }, select: { token: true } })).map((t) => t.token);
    if (!tokens.length) return 0;
    const tickets = await provider.send(tokens.map((to) => ({ ...msg, to })));
    const dead: string[] = [];
    tickets.forEach((t, i) => {
      if (t.id) setBounded(pendingReceipts, t.id, { token: tokens[i], at: Date.now() }, MAX_PENDING_RECEIPTS);
      else if (t.error === "DeviceNotRegistered") dead.push(tokens[i]);
    });
    if (dead.length) await prisma.pushToken.deleteMany({ where: { token: { in: dead } } });
    if (tickets.some((t) => t.error && t.error !== "DeviceNotRegistered")) console.warn(`Push: ${tickets.filter((t) => t.error).length} of ${tickets.length} not accepted`);
    return tickets.filter((t) => t.id).length;
  } catch (error) {
    console.warn("Push failed:", error instanceof Error ? error.message : error);
    return 0;
  }
}

/** Expo recommends checking receipts ~15 min later; tokens whose device is gone are deleted. Never throws. */
export async function checkPushReceipts(now = Date.now(), minAgeMs = 15 * 60000): Promise<number> {
  const due = [...pendingReceipts].filter(([, v]) => now - v.at >= minAgeMs);
  if (!due.length) return 0;
  try {
    const receipts = await provider.receipts(due.map(([id]) => id));
    const dead = due.filter(([id]) => receipts[id] === "DeviceNotRegistered").map(([, v]) => v.token);
    for (const [id] of due) if (id in receipts) pendingReceipts.delete(id);
    if (dead.length) await prisma.pushToken.deleteMany({ where: { token: { in: dead } } });
    return dead.length;
  } catch (error) {
    console.warn("Push receipts failed:", error instanceof Error ? error.message : error);
    return 0;
  }
}

/**
 * "Added from WhatsApp": a visible push per thing created on WhatsApp (chat or a document sent there),
 * with data {type: "sync"} so the app pulls the new task and schedules its alarms. Fire-and-forget.
 */
export function notifyAddedFromWhatsapp(userId: string, titles: string[]): void {
  if (!titles.length) return;
  const body = titles.length === 1 ? titles[0] : `${titles.length} items: ${titles.slice(0, 3).join(", ")}${titles.length > 3 ? "…" : ""}`;
  background(sendPushToUser(userId, { title: "Added from WhatsApp", body: body.slice(0, 180), data: { type: "sync" } }));
}

/**
 * A routine marked done or skipped on WhatsApp: the same {type: "sync"} push, so the phone re-plans and drops that
 * occurrence's remaining alarms (they are local notifications the server can't cancel). Fire-and-forget.
 */
export function notifyRoutineFromWhatsapp(userId: string, title: string, status: "done" | "skipped"): void {
  background(sendPushToUser(userId, { title: "Updated from WhatsApp", body: `${title}: ${status} for today`.slice(0, 180), data: { type: "sync" } }));
}
