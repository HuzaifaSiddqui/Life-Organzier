import {
  ConnectionStatus,
  Prisma,
  SharedMemberStatus,
  SharedTaskKind,
  TaskSource,
  TaskStatus,
  type Priority,
  type SharedTask,
  type SharedTaskMember,
  type Task,
  type TaskType,
  type User,
} from "@prisma/client";
import { prisma } from "../../config/db.js";
import { background } from "../../lib/background.js";
import { ensureSettings, HttpError } from "../../lib/http.js";
import { sendPushToUser } from "../push/pushService.js";
import { createTask, setSharedTaskHooks, softDeleteTask, updateTask, type CreateTaskInput, type TaskChanges } from "../tasks/taskService.js";
import { queueInviteEmail } from "./collabEmail.js";
import {
  AGREED_FIELDS,
  cleanReason,
  collabOn,
  changedAgreedFields,
  isUnsettled,
  MAX_MEMBERS,
  normalizeUsername,
  participantState,
  personLabel,
  proposedChange,
  pushText,
  SEARCH_LIMIT,
  searchTerm,
  type NoticeKind,
  type ParticipantState,
} from "./collabRules.js";

/** Task collaboration (COLLAB_TASKS). Every query is scoped by the caller's id; see collabRules.ts for the rules. */

type Person = { id: string; username: string | null; displayName: string | null; photoUrl: string | null };
const PERSON = { id: true, username: true, displayName: true, photoUrl: true } as const;
const person = (u: Person): Person => ({ id: u.id, username: u.username, displayName: u.displayName, photoUrl: u.photoUrl });
/** Someone not (yet) connected: name and username only, no photo. */
const stranger = (u: Person): Person => ({ ...person(u), photoUrl: null });

/* ------------------------------------------------------------------ notices */

/**
 * An in-app notice (Notifications screen, bell badge) and, unless `push` is false, a push. `extra` goes into the
 * notice's payload; `reason` / `progress` in it also go into the push text. `taskId`: the recipient's own copy, so
 * a tap can open it.
 */
async function notify(
  userId: string,
  actor: Pick<User, "id" | "username" | "displayName">,
  kind: NoticeKind,
  shared?: Pick<SharedTask, "id" | "title" | "dueDate" | "dueTime"> | null,
  extra: Record<string, unknown> = {},
  opts: { push?: boolean; taskId?: string | null } = {},
): Promise<void> {
  const payload = shared ? { title: shared.title, dueDate: shared.dueDate?.toISOString() ?? null, dueTime: shared.dueTime, ...extra } : extra;
  await prisma.collabNotice.create({
    data: { userId, actorId: actor.id, kind, sharedTaskId: shared?.id ?? null, payload: payload as Prisma.InputJsonValue },
  });
  if (opts.push === false) return;
  const text = pushText(kind, personLabel(actor), shared?.title, { reason: typeof extra.reason === "string" ? extra.reason : null, progress: typeof extra.progress === "number" ? extra.progress : null });
  // The phone pulls changes on any collab push; a tap opens the task (taskId), the card (TASK_INVITE) or Notifications.
  background(sendPushToUser(userId, { ...text, data: { type: "collab", kind, sharedTaskId: shared?.id ?? null, taskId: opts.taskId ?? null } }));
}

/**
 * The last 50 notices, each with where a tap should go: `taskId` (my live copy of that shared task) or `pending`
 * (a card still waiting for my answer, so the accept screen).
 */
export async function listNotices(userId: string) {
  const notices = await prisma.collabNotice.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { actor: { select: PERSON } },
  });
  const ids = [...new Set(notices.map((n) => n.sharedTaskId).filter((x): x is string => Boolean(x)))];
  const [copies, members] = ids.length
    ? await Promise.all([
        prisma.task.findMany({ where: { userId, sharedTaskId: { in: ids }, status: { not: TaskStatus.DELETED } }, select: { id: true, sharedTaskId: true } }),
        prisma.sharedTaskMember.findMany({ where: { userId, sharedTaskId: { in: ids }, status: SharedMemberStatus.PENDING, sharedTask: { cancelledAt: null } }, select: { sharedTaskId: true } }),
      ])
    : [[], []];
  const copyOf = new Map(copies.map((c) => [c.sharedTaskId, c.id]));
  const pending = new Set(members.map((m) => m.sharedTaskId));
  return notices.map((n) => ({
    id: n.id,
    kind: n.kind,
    sharedTaskId: n.sharedTaskId,
    taskId: n.sharedTaskId ? (copyOf.get(n.sharedTaskId) ?? null) : null,
    pending: Boolean(n.sharedTaskId && pending.has(n.sharedTaskId)),
    payload: n.payload,
    read: Boolean(n.readAt),
    createdAt: n.createdAt,
    actor: n.actor ? person(n.actor) : null,
  }));
}

export async function markNoticesRead(userId: string): Promise<number> {
  return (await prisma.collabNotice.updateMany({ where: { userId, readAt: null }, data: { readAt: new Date() } })).count;
}

/** One notice of mine; someone else's id marks nothing. */
export async function markNoticeRead(userId: string, id: string): Promise<boolean> {
  return (await prisma.collabNotice.updateMany({ where: { id, userId, readAt: null }, data: { readAt: new Date() } })).count > 0;
}

/* ------------------------------------------------------------------ profile, username, search */

export async function collabSummary(user: User) {
  const [requests, cards, unread] = await Promise.all([
    prisma.connection.count({ where: { addresseeId: user.id, status: ConnectionStatus.PENDING } }),
    prisma.sharedTaskMember.count({ where: { userId: user.id, status: SharedMemberStatus.PENDING, sharedTask: { cancelledAt: null } } }),
    prisma.collabNotice.count({ where: { userId: user.id, readAt: null } }),
  ]);
  return { username: user.username, requests, cards, unread };
}

export async function setUsername(userId: string, raw: string): Promise<string> {
  const username = normalizeUsername(raw);
  if (!username) throw new HttpError(400, "INVALID_USERNAME", "Use 3–20 letters, numbers or _.");
  const taken = await prisma.user.findFirst({ where: { username, id: { not: userId } }, select: { id: true } });
  if (taken) throw new HttpError(409, "USERNAME_TAKEN", "That username is taken.");
  try {
    await prisma.user.update({ where: { id: userId }, data: { username } });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new HttpError(409, "USERNAME_TAKEN", "That username is taken.");
    throw error;
  }
  return username;
}

type ConnectionState = "none" | "requested" | "incoming" | "connected";

async function connectionsOf(userId: string) {
  return prisma.connection.findMany({ where: { OR: [{ requesterId: userId }, { addresseeId: userId }] } });
}

function stateWith(userId: string, otherId: string, rows: Awaited<ReturnType<typeof connectionsOf>>): { state: ConnectionState; connectionId: string | null } {
  const row = rows.find((c) => (c.requesterId === userId && c.addresseeId === otherId) || (c.addresseeId === userId && c.requesterId === otherId));
  if (!row) return { state: "none", connectionId: null };
  if (row.status === ConnectionStatus.ACCEPTED) return { state: "connected", connectionId: row.id };
  return { state: row.requesterId === userId ? "requested" : "incoming", connectionId: row.id };
}

/**
 * Search: a username prefix of at least 3 characters, or a whole email address (exact, any case). Display names and
 * partial emails are never matched, so typing letters can't list people. Results show username and display name;
 * the photo only for people already connected, the email only when that exact address was typed. Accounts being
 * deleted are left out. Rate-limited per user in the route.
 */
export async function searchUsers(userId: string, raw: string) {
  const term = searchTerm(raw);
  if (!term) return [];
  const match: Prisma.UserWhereInput =
    term.kind === "email" ? { email: { equals: term.email, mode: Prisma.QueryMode.insensitive } } : { username: { startsWith: term.prefix } };
  const users = await prisma.user.findMany({
    where: { id: { not: userId }, deletionRequestedAt: null, ...match },
    select: { ...PERSON, email: true },
    orderBy: { username: "asc" },
    take: SEARCH_LIMIT,
  });
  const rows = await connectionsOf(userId);
  return users.map((u) => {
    const state = stateWith(userId, u.id, rows);
    return { ...(state.state === "connected" ? person(u) : stranger(u)), email: term.kind === "email" ? u.email : null, ...state };
  });
}

/* ------------------------------------------------------------------ connections */

export async function listConnections(userId: string) {
  const rows = await prisma.connection.findMany({
    where: { OR: [{ requesterId: userId }, { addresseeId: userId }] },
    include: { requester: { select: PERSON }, addressee: { select: PERSON } },
    orderBy: { createdAt: "desc" },
  });
  const out = { connected: [] as Array<{ connectionId: string; user: Person; since: Date | null }>, incoming: [] as Array<{ connectionId: string; user: Person; at: Date }>, outgoing: [] as Array<{ connectionId: string; user: Person; at: Date }> };
  for (const c of rows) {
    const raw = c.requesterId === userId ? c.addressee : c.requester;
    const other = c.status === ConnectionStatus.ACCEPTED ? person(raw) : stranger(raw);
    if (c.status === ConnectionStatus.ACCEPTED) out.connected.push({ connectionId: c.id, user: other, since: c.respondedAt });
    else if (c.addresseeId === userId) out.incoming.push({ connectionId: c.id, user: other, at: c.createdAt });
    else out.outgoing.push({ connectionId: c.id, user: other, at: c.createdAt });
  }
  out.connected.sort((a, b) => personLabel(a.user).localeCompare(personLabel(b.user)));
  return out;
}

/** The account asked to be deleted (30 days to recover): nothing new is shared with it. */
async function deleting(userId: string): Promise<boolean> {
  return !(await prisma.user.findFirst({ where: { id: userId, deletionRequestedAt: null }, select: { id: true } }));
}

export async function areConnected(a: string, b: string): Promise<boolean> {
  const row = await prisma.connection.findFirst({
    where: { status: ConnectionStatus.ACCEPTED, OR: [{ requesterId: a, addresseeId: b }, { requesterId: b, addresseeId: a }] },
    select: { id: true },
  });
  return Boolean(row);
}

/** Sends a request; if they already asked me, this accepts theirs. */
export async function requestConnection(me: User, targetId: string): Promise<{ state: ConnectionState; connectionId: string }> {
  if (targetId === me.id) throw new HttpError(400, "SELF", "You can't connect with yourself.");
  const target = await prisma.user.findFirst({ where: { id: targetId, deletionRequestedAt: null }, select: { id: true } });
  if (!target) throw new HttpError(404, "USER_NOT_FOUND", "User not found.");
  const mine = await prisma.connection.findUnique({ where: { requesterId_addresseeId: { requesterId: me.id, addresseeId: targetId } } });
  if (mine) return { state: mine.status === ConnectionStatus.ACCEPTED ? "connected" : "requested", connectionId: mine.id };
  const theirs = await prisma.connection.findUnique({ where: { requesterId_addresseeId: { requesterId: targetId, addresseeId: me.id } } });
  if (theirs) {
    if (theirs.status !== ConnectionStatus.ACCEPTED) await respondConnection(me, theirs.id, true);
    return { state: "connected", connectionId: theirs.id };
  }
  try {
    const row = await prisma.connection.create({ data: { requesterId: me.id, addresseeId: targetId } });
    await notify(targetId, me, "CONNECTION_REQUEST");
    return { state: "requested", connectionId: row.id };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const row = await prisma.connection.findUniqueOrThrow({ where: { requesterId_addresseeId: { requesterId: me.id, addresseeId: targetId } } });
      return { state: "requested", connectionId: row.id };
    }
    throw error;
  }
}

/** Accept or decline a request sent to me. A declined request is deleted (it can be sent again). */
export async function respondConnection(me: User, connectionId: string, accept: boolean): Promise<void> {
  const row = await prisma.connection.findFirst({ where: { id: connectionId, addresseeId: me.id, status: ConnectionStatus.PENDING } });
  if (!row) throw new HttpError(404, "REQUEST_NOT_FOUND", "Request not found.");
  if (!accept) {
    await prisma.connection.delete({ where: { id: row.id } });
    return;
  }
  await prisma.connection.update({ where: { id: row.id }, data: { status: ConnectionStatus.ACCEPTED, respondedAt: new Date() } });
  await notify(row.requesterId, me, "CONNECTION_ACCEPTED");
}

export type OpenTask = { sharedTaskId: string; title: string; kind: SharedTaskKind; ownerIsMe: boolean };

/**
 * Shared tasks between two people that are not settled yet: a card one of them hasn't answered, or a copy (the
 * member's, or for a task done together the owner's) not finished. A connection can't be removed while any is left.
 */
export async function openTasksBetween(a: string, b: string): Promise<OpenTask[]> {
  const shared = await prisma.sharedTask.findMany({
    where: { cancelledAt: null, OR: [{ ownerId: a, members: { some: { userId: b } } }, { ownerId: b, members: { some: { userId: a } } }] },
    include: { members: true, tasks: { select: { userId: true, status: true } } },
  });
  const open: OpenTask[] = [];
  for (const s of shared) {
    const memberId = s.ownerId === a ? b : a;
    const member = s.members.find((m) => m.userId === memberId) ?? null;
    const memberState = participantState(member, copyStatus(s.tasks, memberId));
    const states: ParticipantState[] = [memberState];
    if (s.kind === SharedTaskKind.COLLAB && memberState !== "declined" && memberState !== "removed") states.push(participantState(null, copyStatus(s.tasks, s.ownerId)));
    if (isUnsettled(states)) open.push({ sharedTaskId: s.id, title: s.title, kind: s.kind, ownerIsMe: s.ownerId === a });
  }
  return open;
}

/** Cancel my request, decline theirs, or remove a connection (only when no shared task between us is left open). */
export async function removeConnection(me: User, connectionId: string): Promise<{ removed: true } | { removed: false; openTasks: OpenTask[] }> {
  const row = await prisma.connection.findFirst({ where: { id: connectionId, OR: [{ requesterId: me.id }, { addresseeId: me.id }] } });
  if (!row) throw new HttpError(404, "CONNECTION_NOT_FOUND", "Connection not found.");
  if (row.status === ConnectionStatus.ACCEPTED) {
    const other = row.requesterId === me.id ? row.addresseeId : row.requesterId;
    const openTasks = await openTasksBetween(me.id, other);
    if (openTasks.length) return { removed: false, openTasks };
  }
  await prisma.connection.delete({ where: { id: row.id } });
  return { removed: true };
}

/* ------------------------------------------------------------------ shared tasks */

export type SharedTaskInput = {
  title: string;
  description?: string | null;
  dueDate?: Date | null;
  dueTime?: string | null;
  priority: Priority;
  category?: string | null;
  durationMinutes?: number | null;
  taskType?: TaskType;
};

const copyStatus = (tasks: Array<{ userId: string; status: TaskStatus }>, userId: string): TaskStatus | null => {
  // A person may have deleted a copy and been asked again: the live copy wins.
  const mine = tasks.filter((t) => t.userId === userId);
  return mine.find((t) => t.status !== TaskStatus.DELETED)?.status ?? mine[0]?.status ?? null;
};

/** The card's details as a task for one person (their own copy). */
function copyInput(s: SharedTask): Omit<SharedTaskInput, "priority"> & { priority: Priority } {
  return {
    title: s.title,
    description: s.description,
    dueDate: s.dueDate,
    dueTime: s.dueTime,
    priority: s.priority,
    category: s.category,
    durationMinutes: s.durationMinutes,
    taskType: s.taskType,
  };
}

async function liveCopy(sharedTaskId: string, userId: string): Promise<Task | null> {
  return prisma.task.findFirst({ where: { sharedTaskId, userId, status: { not: TaskStatus.DELETED } }, orderBy: { createdAt: "desc" } });
}

const loadShared = (id: string) =>
  prisma.sharedTask.findUnique({
    where: { id },
    include: {
      owner: { select: PERSON },
      members: { include: { user: { select: PERSON } }, orderBy: { createdAt: "asc" } },
      tasks: { select: { id: true, userId: true, status: true, completedAt: true, dueDate: true, dueTime: true } },
    },
  });
type LoadedShared = NonNullable<Awaited<ReturnType<typeof loadShared>>>;

/** What one person sees: the card, their own answer and copy, and every participant's state. */
function viewOf(s: LoadedShared, userId: string) {
  const live = (uid: string) => s.tasks.find((t) => t.userId === uid && t.status !== TaskStatus.DELETED) ?? null;
  const me = s.members.find((m) => m.userId === userId) ?? null;
  const participants = [
    ...(s.kind === SharedTaskKind.COLLAB
      ? [{ user: person(s.owner), role: "owner" as const, state: participantState(null, copyStatus(s.tasks, s.ownerId)), proposedChange: null, completedAt: live(s.ownerId)?.completedAt ?? null }]
      : []),
    ...s.members.map((m) => ({
      user: person(m.user),
      role: "member" as const,
      state: participantState(m, copyStatus(s.tasks, m.userId)),
      proposedChange: m.status === SharedMemberStatus.ACCEPTED ? m.proposedChange : null,
      completedAt: live(m.userId)?.completedAt ?? null,
      // Why they declined: the owner sees it, and the member sees their own.
      declineReason: m.status === SharedMemberStatus.REJECTED && (s.ownerId === userId || m.userId === userId) ? (m.declineReason ?? null) : null,
    })),
  ];
  const progressBy = s.progressById ? [s.owner, ...s.members.map((m) => m.user)].find((u) => u.id === s.progressById) : null;
  return {
    id: s.id,
    kind: s.kind,
    title: s.title,
    description: s.description,
    dueDate: s.dueDate,
    dueTime: s.dueTime,
    priority: s.priority,
    category: s.category,
    durationMinutes: s.durationMinutes,
    taskType: s.taskType,
    revision: s.revision,
    cancelled: Boolean(s.cancelledAt),
    /** Done together: the shared progress and who set it (null before anyone did). */
    progress: s.kind === SharedTaskKind.COLLAB ? s.progress : null,
    progressBy: progressBy ? personLabel(progressBy) : null,
    progressAt: s.progressAt,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    owner: person(s.owner),
    isOwner: s.ownerId === userId,
    myStatus: s.ownerId === userId ? null : (me?.status ?? null),
    reapproval: me?.reapproval ?? false,
    myTaskId: live(userId)?.id ?? null,
    participants,
  };
}
export type SharedTaskView = ReturnType<typeof viewOf>;

async function viewFor(id: string, userId: string): Promise<SharedTaskView> {
  const s = await loadShared(id);
  if (!s) throw new HttpError(404, "SHARED_TASK_NOT_FOUND", "Shared task not found.");
  return viewOf(s, userId);
}

/** Members with access: a card to answer (pending) or a task they accepted. Declined, removed or left: none. */
const WITH_ACCESS: SharedMemberStatus[] = [SharedMemberStatus.PENDING, SharedMemberStatus.ACCEPTED];

/** The owner always; a member only while the task isn't cancelled and their answer is pending or accepted. */
function canSee(s: Pick<SharedTask, "ownerId" | "cancelledAt"> & { members: Array<Pick<SharedTaskMember, "userId" | "status">> }, userId: string): boolean {
  if (s.ownerId === userId) return true;
  return !s.cancelledAt && s.members.some((m) => m.userId === userId && WITH_ACCESS.includes(m.status));
}

export async function getSharedTask(userId: string, id: string): Promise<SharedTaskView> {
  const s = await loadShared(id);
  if (!s || !canSee(s, userId)) throw new HttpError(404, "SHARED_TASK_NOT_FOUND", "Shared task not found.");
  return viewOf(s, userId);
}

/**
 * Shares a task with connected people. ASSIGN: only theirs (the owner tracks it, nothing on the owner's timeline).
 * COLLAB: the owner's copy is created now; everyone else gets a card and nothing until they accept.
 */
export async function createSharedTask(
  me: User,
  tz: string,
  input: SharedTaskInput & {
    kind: SharedTaskKind;
    memberIds: string[];
    deviceId?: string | null;
    /** COLLAB from chat: the owner's copy as the assistant built it (planned slot, tags, source, confidence). */
    ownerCopy?: Partial<CreateTaskInput>;
  },
): Promise<{ shared: SharedTaskView; ownerTask: Task | null }> {
  const memberIds = [...new Set(input.memberIds)].filter((id) => id !== me.id);
  if (!memberIds.length) throw new HttpError(400, "NO_MEMBERS", "Mention at least one person.");
  if (memberIds.length > MAX_MEMBERS) throw new HttpError(400, "TOO_MANY_MEMBERS", `Share with at most ${MAX_MEMBERS} people.`);
  for (const id of memberIds) {
    if (!(await areConnected(me.id, id))) throw new HttpError(403, "NOT_CONNECTED", "You can only share tasks with people who accepted your request.");
    if (await deleting(id)) throw new HttpError(403, "NOT_CONNECTED", "That account is being deleted.");
  }
  const shared = await prisma.sharedTask.create({
    data: {
      ownerId: me.id,
      kind: input.kind,
      title: input.title.trim().slice(0, 300),
      description: input.description ?? null,
      dueDate: input.dueDate ?? null,
      dueTime: input.dueTime ?? null,
      priority: input.priority,
      category: input.category ?? null,
      durationMinutes: input.durationMinutes ?? null,
      taskType: input.taskType ?? "FLEXIBLE",
      members: { create: memberIds.map((userId) => ({ userId })) },
    },
  });
  for (const id of memberIds) queueInviteEmail(id, me, { title: shared.title, kind: input.kind });
  const ownerTask =
    input.kind === SharedTaskKind.COLLAB
      ? await createTask({ userId: me.id, tz, deviceId: input.deviceId }, { source: TaskSource.MANUAL, ...input.ownerCopy, ...copyInput(shared), sharedTaskId: shared.id })
      : null;
  for (const id of memberIds) await notify(id, me, "TASK_INVITE", shared, { kind: input.kind });
  return { shared: await viewFor(shared.id, me.id), ownerTask };
}

/** Cards waiting for my answer, and the shared tasks I own or accepted (newest first). */
export async function listSharedTasks(userId: string) {
  const rows = await prisma.sharedTask.findMany({
    where: { OR: [{ ownerId: userId }, { cancelledAt: null, members: { some: { userId, status: { in: WITH_ACCESS } } } }] },
    orderBy: { updatedAt: "desc" },
    take: 100,
    select: { id: true },
  });
  const views: SharedTaskView[] = [];
  for (const r of rows) {
    const s = await loadShared(r.id);
    if (s) views.push(viewOf(s, userId));
  }
  const cards = views.filter((v) => !v.isOwner && !v.cancelled && v.myStatus === SharedMemberStatus.PENDING);
  const shared = views.filter((v) => v.isOwner || v.myStatus === SharedMemberStatus.ACCEPTED);
  return { cards, shared };
}

/** My membership, only while I still have access (see canSee): otherwise the task is "not found" for me. */
async function memberRow(sharedTaskId: string, userId: string): Promise<{ s: SharedTask; m: SharedTaskMember }> {
  const m = await prisma.sharedTaskMember.findUnique({ where: { sharedTaskId_userId: { sharedTaskId, userId } }, include: { sharedTask: true } });
  if (!m || m.sharedTask.cancelledAt || !WITH_ACCESS.includes(m.status)) throw new HttpError(404, "SHARED_TASK_NOT_FOUND", "Shared task not found.");
  const { sharedTask, ...member } = m;
  return { s: sharedTask, m: member };
}

/**
 * Accept a card: my copy is created (or, after the owner changed it, updated) with the card's details or my own
 * date/time. A different date/time is kept on my answer and the owner is told.
 */
export async function acceptSharedTask(
  me: User,
  tz: string,
  id: string,
  mine: { dueDate?: Date | null; dueTime?: string | null } = {},
  deviceId?: string | null,
): Promise<{ shared: SharedTaskView; task: Task }> {
  const { s, m } = await memberRow(id, me.id);
  if (m.status !== SharedMemberStatus.PENDING) throw new HttpError(409, "ALREADY_ANSWERED", "You already answered this.");
  const change = proposedChange(s, mine);
  const details = { ...copyInput(s), ...(change ? { dueDate: change.dueDate ? new Date(change.dueDate) : null, dueTime: change.dueTime } : {}) };
  const ctx = { userId: me.id, tz, deviceId };
  const existing = await liveCopy(s.id, me.id);
  const task = existing
    ? ((await updateTask(ctx, existing.id, details as TaskChanges, { fromSharedTask: true })) ?? existing)
    : await createTask(ctx, { ...details, source: TaskSource.MANUAL, sharedTaskId: s.id });
  await prisma.sharedTaskMember.update({
    where: { id: m.id },
    data: { status: SharedMemberStatus.ACCEPTED, reapproval: false, respondedAt: new Date(), proposedChange: change ?? Prisma.JsonNull, declineReason: null },
  });
  const ownerCopy = s.kind === SharedTaskKind.COLLAB ? await liveCopy(s.id, s.ownerId) : null;
  await notify(s.ownerId, me, change ? "TASK_TIME_CHANGED" : "TASK_ACCEPTED", s, change ? { proposed: change } : {}, { taskId: ownerCopy?.id ?? null });
  // The member's own confirmation: a row under Notifications, no push (they just tapped Accept).
  const owner = await prisma.user.findUnique({ where: { id: s.ownerId }, select: { id: true, username: true, displayName: true } });
  if (owner) await notify(me.id, owner, "TASK_JOINED", s, {}, { push: false, taskId: task.id });
  return { shared: await viewFor(s.id, me.id), task };
}

/**
 * Decline a card, with a short reason (required; plain text, see cleanReason) that the owner sees in the notice and
 * on the task. Declining a change to a task I had accepted removes my copy (24 h to restore, as any delete).
 */
export async function rejectSharedTask(me: User, tz: string, id: string, deviceId: string | null | undefined, rawReason: unknown): Promise<SharedTaskView> {
  const { s, m } = await memberRow(id, me.id); // no access: 404 before anything else
  if (m.status !== SharedMemberStatus.PENDING) throw new HttpError(409, "ALREADY_ANSWERED", "You already answered this.");
  const reason = cleanReason(rawReason);
  if (!reason) throw new HttpError(400, "REASON_REQUIRED", "Give a short reason (up to 200 characters).");
  await prisma.sharedTaskMember.update({ where: { id: m.id }, data: { status: SharedMemberStatus.REJECTED, respondedAt: new Date(), declineReason: reason } });
  const copy = await liveCopy(s.id, me.id);
  if (copy) await softDeleteTask({ userId: me.id, tz, deviceId }, copy.id);
  if (!s.cancelledAt) {
    const ownerCopy = s.kind === SharedTaskKind.COLLAB ? await liveCopy(s.id, s.ownerId) : null;
    await notify(s.ownerId, me, "TASK_REJECTED", s, { reason }, { taskId: ownerCopy?.id ?? null });
  }
  return viewFor(s.id, me.id);
}

async function ownedShared(ownerId: string, id: string): Promise<SharedTask> {
  const s = await prisma.sharedTask.findFirst({ where: { id, ownerId } });
  if (!s) throw new HttpError(404, "SHARED_TASK_NOT_FOUND", "Shared task not found.");
  if (s.cancelledAt) throw new HttpError(409, "SHARED_TASK_CANCELLED", "This task was cancelled.");
  return s;
}

/**
 * The owner changes the task. A change to an agreed detail (title, description, due date/time, duration) asks
 * every member who had accepted again; their copy keeps the old details until they accept the change.
 */
async function applyOwnerChange(owner: User, s: SharedTask, changes: Partial<SharedTaskInput>, opts: { tz: string; deviceId?: string | null; skipOwnerCopy?: boolean }) {
  const agreed = changedAgreedFields(s, changes);
  const data: Prisma.SharedTaskUpdateInput = {};
  for (const [k, v] of Object.entries(changes)) if (v !== undefined) (data as Record<string, unknown>)[k] = v;
  if (agreed.length) data.revision = s.revision + 1;
  const updated = await prisma.sharedTask.update({ where: { id: s.id }, data });
  if (s.kind === SharedTaskKind.COLLAB && !opts.skipOwnerCopy) {
    const copy = await liveCopy(s.id, owner.id);
    if (copy) await updateTask({ userId: owner.id, tz: opts.tz, deviceId: opts.deviceId }, copy.id, changes as TaskChanges, { fromSharedTask: true });
  }
  if (agreed.length) {
    const accepted = await prisma.sharedTaskMember.findMany({ where: { sharedTaskId: s.id, status: SharedMemberStatus.ACCEPTED } });
    await prisma.sharedTaskMember.updateMany({
      where: { id: { in: accepted.map((m) => m.id) } },
      data: { status: SharedMemberStatus.PENDING, reapproval: true, proposedChange: Prisma.JsonNull },
    });
    for (const m of accepted) await notify(m.userId, owner, "TASK_CHANGED", updated, { fields: agreed });
  }
  return updated;
}

export async function updateSharedTask(owner: User, tz: string, id: string, changes: Partial<SharedTaskInput>, deviceId?: string | null): Promise<SharedTaskView> {
  const s = await ownedShared(owner.id, id);
  await applyOwnerChange(owner, s, changes, { tz, deviceId });
  return viewFor(s.id, owner.id);
}

/** Ask someone who declined again. */
export async function resendSharedTask(owner: User, id: string, memberUserId: string): Promise<SharedTaskView> {
  const s = await ownedShared(owner.id, id);
  const m = await prisma.sharedTaskMember.findUnique({ where: { sharedTaskId_userId: { sharedTaskId: s.id, userId: memberUserId } } });
  if (!m) throw new HttpError(404, "MEMBER_NOT_FOUND", "That person isn't on this task.");
  if (m.status !== SharedMemberStatus.REJECTED) throw new HttpError(409, "NOT_DECLINED", "Only a declined task can be sent again.");
  if (!(await areConnected(owner.id, memberUserId)) || (await deleting(memberUserId))) throw new HttpError(403, "NOT_CONNECTED", "You can only share tasks with people who accepted your request.");
  await prisma.sharedTaskMember.update({ where: { id: m.id }, data: { status: SharedMemberStatus.PENDING, reapproval: false, respondedAt: null, proposedChange: Prisma.JsonNull, declineReason: null } });
  await notify(memberUserId, owner, "TASK_INVITE", s, { kind: s.kind });
  queueInviteEmail(memberUserId, owner, { title: s.title, kind: s.kind });
  return viewFor(s.id, owner.id);
}

/**
 * Cancel for everyone: unanswered cards are withdrawn and members lose access; copies already accepted stay with
 * their owners as ordinary tasks (unlinked; they're told).
 */
export async function cancelSharedTask(owner: User, id: string): Promise<SharedTaskView> {
  const s = await ownedShared(owner.id, id);
  await prisma.sharedTask.update({ where: { id: s.id }, data: { cancelledAt: new Date() } });
  const members = await prisma.sharedTaskMember.findMany({ where: { sharedTaskId: s.id, status: { not: SharedMemberStatus.REJECTED } } });
  await prisma.task.updateMany({ where: { sharedTaskId: s.id, userId: { not: owner.id } }, data: { sharedTaskId: null } });
  for (const m of members) await notify(m.userId, owner, "TASK_CANCELLED", s);
  return viewFor(s.id, owner.id);
}

/**
 * Undo of a share (the Undo button, or "undo" in chat): cancelled for everyone; the owner's copy is removed (24 h to
 * restore, as any delete) or, with `keepMine`, kept as an ordinary task.
 */
export async function unshareTask(owner: User, tz: string, id: string, keepMine: boolean, deviceId?: string | null): Promise<{ shared: SharedTaskView; kept: boolean }> {
  const shared = await cancelSharedTask(owner, id);
  const mine = await prisma.task.findFirst({ where: { sharedTaskId: id, userId: owner.id, status: { not: TaskStatus.DELETED } } });
  if (mine && keepMine) await prisma.task.update({ where: { id: mine.id }, data: { sharedTaskId: null } });
  else if (mine) await softDeleteTask({ userId: owner.id, tz, deviceId }, mine.id);
  return { shared, kept: Boolean(mine && keepMine) };
}

/** Their membership goes; a copy they accepted stays theirs as an ordinary task (unlinked). */
async function dropMember(s: SharedTask, m: SharedTaskMember): Promise<void> {
  await prisma.task.updateMany({ where: { sharedTaskId: s.id, userId: m.userId }, data: { sharedTaskId: null } });
  await prisma.sharedTaskMember.delete({ where: { id: m.id } });
}

/** The owner takes someone off the task: they lose access at once and are told. */
export async function removeMember(owner: User, id: string, memberUserId: string): Promise<SharedTaskView> {
  const s = await ownedShared(owner.id, id);
  const m = await prisma.sharedTaskMember.findUnique({ where: { sharedTaskId_userId: { sharedTaskId: s.id, userId: memberUserId } } });
  if (!m) throw new HttpError(404, "MEMBER_NOT_FOUND", "That person isn't on this task.");
  await dropMember(s, m);
  if (m.status !== SharedMemberStatus.REJECTED) await notify(m.userId, owner, "TASK_MEMBER_REMOVED", s);
  return viewFor(s.id, owner.id);
}

/** A member leaves (a card waiting for an answer, or a task they accepted). The owner is told. */
export async function leaveSharedTask(me: User, id: string): Promise<void> {
  const { s, m } = await memberRow(id, me.id);
  await dropMember(s, m);
  await notify(s.ownerId, me, "TASK_MEMBER_LEFT", s);
}

/* ------------------------------------------------------------------ hooks from the task module */

/** Someone finished their copy: everyone else on the task (the owner and accepted members) is told. */
async function onCopyCompleted(task: Task): Promise<void> {
  try {
    if (!task.sharedTaskId) return;
    const s = await prisma.sharedTask.findUnique({ where: { id: task.sharedTaskId }, include: { members: { where: { status: SharedMemberStatus.ACCEPTED } } } });
    if (!s || s.cancelledAt) return;
    const me = await prisma.user.findUnique({ where: { id: task.userId } });
    if (!me) return;
    const others = new Set([s.ownerId, ...s.members.map((m) => m.userId)]);
    others.delete(task.userId);
    for (const id of others) await notify(id, me, "TASK_COMPLETED", s);
  } catch (error) {
    console.warn("Shared task completion notice failed", error instanceof Error ? error.message : error);
  }
}

/**
 * Done together: a member (or the owner) set their copy's progress to a part-way value. The shared progress takes it
 * (server time: the last write wins) and every other open copy follows, marked "updated by X", with a notice. Done
 * (100 %) stays personal: each person finishes their own part. "Only for them" tasks are untouched.
 */
async function syncProgress(task: Task, prev: Task, s: SharedTask): Promise<void> {
  if (s.kind !== SharedTaskKind.COLLAB || task.progress === prev.progress || task.progress >= 100 || task.status === TaskStatus.COMPLETED) return;
  const me = await prisma.user.findUnique({ where: { id: task.userId }, select: { id: true, username: true, displayName: true } });
  if (!me) return;
  const now = new Date();
  await prisma.sharedTask.update({ where: { id: s.id }, data: { progress: task.progress, progressById: me.id, progressAt: now } });
  const members = await prisma.sharedTaskMember.findMany({ where: { sharedTaskId: s.id, status: SharedMemberStatus.ACCEPTED }, select: { userId: true } });
  const others = new Set([s.ownerId, ...members.map((m) => m.userId)]);
  others.delete(task.userId);
  const label = personLabel(me);
  for (const userId of others) {
    const copy = await liveCopy(s.id, userId);
    if (!copy || copy.status === TaskStatus.COMPLETED) continue;
    const tz = (await ensureSettings(userId)).timezone;
    await updateTask({ userId, tz, deviceId: null }, copy.id, { progress: task.progress, progressUpdatedBy: label }, { fromSharedTask: true });
    await notify(userId, me, "TASK_PROGRESS", s, { progress: task.progress }, { taskId: copy.id });
  }
}

/** The owner edited an agreed detail on their own copy of a task done together: the same as editing the shared task. */
async function onCopyEdited(task: Task, prev: Task): Promise<void> {
  try {
    if (!task.sharedTaskId) return;
    const s = await prisma.sharedTask.findUnique({ where: { id: task.sharedTaskId } });
    if (!s || s.cancelledAt) return;
    await syncProgress(task, prev, s);
    if (s.ownerId !== task.userId) return;
    const changes: Partial<SharedTaskInput> = {};
    for (const f of AGREED_FIELDS) {
      const now = task[f];
      const before = prev[f];
      const same = now instanceof Date || before instanceof Date ? (now as Date | null)?.getTime() === (before as Date | null)?.getTime() : now === before;
      if (!same) (changes as Record<string, unknown>)[f] = now;
    }
    if (!Object.keys(changes).length) return;
    const owner = await prisma.user.findUnique({ where: { id: task.userId } });
    if (!owner) return;
    const tz = (await ensureSettings(owner.id)).timezone;
    await applyOwnerChange(owner, s, changes, { tz, skipOwnerCopy: true });
  } catch (error) {
    console.warn("Shared task edit failed", error instanceof Error ? error.message : error);
  }
}

setSharedTaskHooks({ completed: onCopyCompleted, edited: onCopyEdited });

/**
 * WhatsApp has no push: the next WhatsApp reply (the 24-hour window is open then) mentions what arrived since,
 * once. Those notices count as seen. Empty when nothing is new or the feature is off.
 */
export async function whatsappCollabLine(userId: string): Promise<string> {
  if (!collabOn()) return "";
  const kinds = ["TASK_INVITE", "TASK_CHANGED", "CONNECTION_REQUEST"];
  const notices = await prisma.collabNotice.findMany({ where: { userId, readAt: null, kind: { in: kinds } }, include: { actor: { select: PERSON } }, orderBy: { createdAt: "asc" }, take: 20 });
  if (!notices.length) return "";
  await prisma.collabNotice.updateMany({ where: { id: { in: notices.map((n) => n.id) } }, data: { readAt: new Date() } });
  // Only what still waits for an answer (a request already accepted in the app isn't news).
  const [cards, incoming] = await Promise.all([
    prisma.sharedTaskMember.findMany({ where: { userId, status: SharedMemberStatus.PENDING, sharedTask: { cancelledAt: null } }, select: { sharedTaskId: true } }),
    prisma.connection.findMany({ where: { addresseeId: userId, status: ConnectionStatus.PENDING }, select: { requesterId: true } }),
  ]);
  const open = new Set(cards.map((c) => c.sharedTaskId));
  const askers = new Set(incoming.map((c) => c.requesterId));
  const tasks = notices.filter((n) => n.kind !== "CONNECTION_REQUEST" && n.sharedTaskId && open.has(n.sharedTaskId));
  const requests = notices.filter((n) => n.kind === "CONNECTION_REQUEST" && n.actorId && askers.has(n.actorId)).length;
  if (!tasks.length && !requests) return "";
  const parts: string[] = [];
  if (tasks.length === 1) parts.push(`${personLabel(tasks[0].actor)} shared "${(tasks[0].payload as { title?: string } | null)?.title ?? "a task"}" with you`);
  else if (tasks.length > 1) parts.push(`${tasks.length} tasks were shared with you`);
  if (requests) parts.push(`${requests === 1 ? "1 person wants" : `${requests} people want`} to connect`);
  return `\n\nAlso: ${parts.join(", and ")}. Say "show shared tasks" to answer.`;
}
