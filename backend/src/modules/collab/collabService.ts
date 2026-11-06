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
import { createTask, setSharedTaskHooks, softDeleteTask, updateTask, type TaskChanges } from "../tasks/taskService.js";
import {
  AGREED_FIELDS,
  changedAgreedFields,
  isUnsettled,
  maskEmail,
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

/* ------------------------------------------------------------------ notices */

async function notify(
  userId: string,
  actor: Pick<User, "id" | "username" | "displayName">,
  kind: NoticeKind,
  shared?: Pick<SharedTask, "id" | "title" | "dueDate" | "dueTime"> | null,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const payload = shared ? { title: shared.title, dueDate: shared.dueDate?.toISOString() ?? null, dueTime: shared.dueTime, ...extra } : extra;
  await prisma.collabNotice.create({
    data: { userId, actorId: actor.id, kind, sharedTaskId: shared?.id ?? null, payload: payload as Prisma.InputJsonValue },
  });
  const text = pushText(kind, personLabel(actor), shared?.title);
  // "sync": the phone pulls changes (a new copy, a cancelled card); "collab": a tap opens People & sharing.
  background(sendPushToUser(userId, { ...text, data: { type: "collab", kind, sharedTaskId: shared?.id ?? null } }));
}

export async function listNotices(userId: string) {
  const notices = await prisma.collabNotice.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { actor: { select: PERSON } },
  });
  return notices.map((n) => ({
    id: n.id,
    kind: n.kind,
    sharedTaskId: n.sharedTaskId,
    payload: n.payload,
    read: Boolean(n.readAt),
    createdAt: n.createdAt,
    actor: n.actor ? person(n.actor) : null,
  }));
}

export async function markNoticesRead(userId: string): Promise<number> {
  return (await prisma.collabNotice.updateMany({ where: { userId, readAt: null }, data: { readAt: new Date() } })).count;
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
 * Live search from the first letter: usernames, names (any word) and emails that start with the text. An email is
 * shown masked unless the whole address was typed. "@ali" searches usernames only. Accounts being deleted are left out.
 */
export async function searchUsers(userId: string, raw: string) {
  const term = searchTerm(raw);
  if (!term) return [];
  const { text, usernameOnly } = term;
  const mode = Prisma.QueryMode.insensitive;
  const or: Prisma.UserWhereInput[] = [{ username: { startsWith: text } }];
  if (!usernameOnly) {
    or.push({ displayName: { startsWith: text, mode } }, { displayName: { contains: ` ${text}`, mode } }, { email: { startsWith: text, mode } });
  }
  const users = await prisma.user.findMany({
    where: { id: { not: userId }, deletionRequestedAt: null, OR: or },
    select: { ...PERSON, email: true },
    orderBy: [{ username: "asc" }, { displayName: "asc" }],
    take: SEARCH_LIMIT,
  });
  const rows = await connectionsOf(userId);
  return users.map((u) => ({
    ...person(u),
    email: u.email.toLowerCase() === text ? u.email : maskEmail(u.email),
    ...stateWith(userId, u.id, rows),
  }));
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
    const other = person(c.requesterId === userId ? c.addressee : c.requester);
    if (c.status === ConnectionStatus.ACCEPTED) out.connected.push({ connectionId: c.id, user: other, since: c.respondedAt });
    else if (c.addresseeId === userId) out.incoming.push({ connectionId: c.id, user: other, at: c.createdAt });
    else out.outgoing.push({ connectionId: c.id, user: other, at: c.createdAt });
  }
  out.connected.sort((a, b) => personLabel(a.user).localeCompare(personLabel(b.user)));
  return out;
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
    })),
  ];
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

/** The owner, or someone it was shared with (any answer), may see it. */
export async function getSharedTask(userId: string, id: string): Promise<SharedTaskView> {
  const s = await loadShared(id);
  if (!s || (s.ownerId !== userId && !s.members.some((m) => m.userId === userId))) throw new HttpError(404, "SHARED_TASK_NOT_FOUND", "Shared task not found.");
  return viewOf(s, userId);
}

/**
 * Shares a task with connected people. ASSIGN: only theirs (the owner tracks it, nothing on the owner's timeline).
 * COLLAB: the owner's copy is created now; everyone else gets a card and nothing until they accept.
 */
export async function createSharedTask(
  me: User,
  tz: string,
  input: SharedTaskInput & { kind: SharedTaskKind; memberIds: string[]; deviceId?: string | null },
): Promise<{ shared: SharedTaskView; ownerTask: Task | null }> {
  const memberIds = [...new Set(input.memberIds)].filter((id) => id !== me.id);
  if (!memberIds.length) throw new HttpError(400, "NO_MEMBERS", "Mention at least one person.");
  if (memberIds.length > MAX_MEMBERS) throw new HttpError(400, "TOO_MANY_MEMBERS", `Share with at most ${MAX_MEMBERS} people.`);
  for (const id of memberIds) {
    if (!(await areConnected(me.id, id))) throw new HttpError(403, "NOT_CONNECTED", "You can only share tasks with people who accepted your request.");
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
  const ownerTask =
    input.kind === SharedTaskKind.COLLAB
      ? await createTask({ userId: me.id, tz, deviceId: input.deviceId }, { ...copyInput(shared), source: TaskSource.MANUAL, sharedTaskId: shared.id })
      : null;
  for (const id of memberIds) await notify(id, me, "TASK_INVITE", shared, { kind: input.kind });
  return { shared: await viewFor(shared.id, me.id), ownerTask };
}

/** Cards waiting for my answer, and the shared tasks I own or accepted (newest first). */
export async function listSharedTasks(userId: string) {
  const rows = await prisma.sharedTask.findMany({
    where: { OR: [{ ownerId: userId }, { members: { some: { userId } } }] },
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

async function memberRow(sharedTaskId: string, userId: string): Promise<{ s: SharedTask; m: SharedTaskMember }> {
  const m = await prisma.sharedTaskMember.findUnique({ where: { sharedTaskId_userId: { sharedTaskId, userId } }, include: { sharedTask: true } });
  if (!m) throw new HttpError(404, "SHARED_TASK_NOT_FOUND", "Shared task not found.");
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
  if (s.cancelledAt) throw new HttpError(409, "SHARED_TASK_CANCELLED", "This task was cancelled.");
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
    data: { status: SharedMemberStatus.ACCEPTED, reapproval: false, respondedAt: new Date(), proposedChange: change ?? Prisma.JsonNull },
  });
  await notify(s.ownerId, me, change ? "TASK_TIME_CHANGED" : "TASK_ACCEPTED", s, change ? { proposed: change } : {});
  return { shared: await viewFor(s.id, me.id), task };
}

/** Decline a card. Declining a change to a task I had accepted removes my copy (24 h to restore, as any delete). */
export async function rejectSharedTask(me: User, tz: string, id: string, deviceId?: string | null): Promise<SharedTaskView> {
  const { s, m } = await memberRow(id, me.id);
  if (m.status !== SharedMemberStatus.PENDING) throw new HttpError(409, "ALREADY_ANSWERED", "You already answered this.");
  await prisma.sharedTaskMember.update({ where: { id: m.id }, data: { status: SharedMemberStatus.REJECTED, respondedAt: new Date() } });
  const copy = await liveCopy(s.id, me.id);
  if (copy) await softDeleteTask({ userId: me.id, tz, deviceId }, copy.id);
  if (!s.cancelledAt) await notify(s.ownerId, me, "TASK_REJECTED", s);
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
  if (!(await areConnected(owner.id, memberUserId))) throw new HttpError(403, "NOT_CONNECTED", "You can only share tasks with people who accepted your request.");
  await prisma.sharedTaskMember.update({ where: { id: m.id }, data: { status: SharedMemberStatus.PENDING, reapproval: false, respondedAt: null, proposedChange: Prisma.JsonNull } });
  await notify(memberUserId, owner, "TASK_INVITE", s, { kind: s.kind });
  return viewFor(s.id, owner.id);
}

/** Cancel for everyone: unanswered cards are withdrawn; copies already accepted stay with their owners (they're told). */
export async function cancelSharedTask(owner: User, id: string): Promise<SharedTaskView> {
  const s = await ownedShared(owner.id, id);
  await prisma.sharedTask.update({ where: { id: s.id }, data: { cancelledAt: new Date() } });
  const members = await prisma.sharedTaskMember.findMany({ where: { sharedTaskId: s.id, status: { not: SharedMemberStatus.REJECTED } } });
  for (const m of members) await notify(m.userId, owner, "TASK_CANCELLED", s);
  return viewFor(s.id, owner.id);
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

/** The owner edited an agreed detail on their own copy of a task done together: the same as editing the shared task. */
async function onCopyEdited(task: Task, prev: Task): Promise<void> {
  try {
    if (!task.sharedTaskId) return;
    const s = await prisma.sharedTask.findUnique({ where: { id: task.sharedTaskId } });
    if (!s || s.ownerId !== task.userId || s.cancelledAt) return;
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
