import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { calculatePagination } from "@/lib/pagination";
import { ON_CALL_QUIET_AFTER_MS, isQuiet } from "@/lib/security-checks";

/**
 * On-call people (#on-call, 14 Nov plan): a person goes on call, not an agent.
 * Staff invite someone by email; they accept once signed in with that email.
 * Accepting sets `User.onCallAt` (and `User.securityClearedAt` when the invite
 * clears them). Every working agent they own then gets priority work.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export class OnCallError extends Error {
  constructor(
    readonly code: "invalid_email" | "not_found" | "ambiguous" | "already_on_call" | "already_invited" | "not_yours" | "not_pending",
    message: string,
  ) {
    super(message);
    this.name = "OnCallError";
  }
}

function normaliseEmail(value: string): string {
  return value.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Invites

/**
 * Staff invite a person by email. Refused for a bad address, a person already
 * on call (and already cleared when the invite would clear them), or one with a
 * pending invite. A person with an account gets an inbox note; one without
 * finds the invite when they sign up with that email.
 */
export async function inviteToOnCall(
  db: Db,
  input: { email: string; invitedById: string; clearForSecurity: boolean },
): Promise<{ inviteId: string }> {
  const email = normaliseEmail(input.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new OnCallError("invalid_email", "That doesn't look like an email address.");
  const person = await db.user.findUnique({ where: { email }, select: { id: true, onCallAt: true, securityClearedAt: true } });
  if (person?.onCallAt && (!input.clearForSecurity || person.securityClearedAt)) {
    throw new OnCallError("already_on_call", "That person is already on call.");
  }
  const pending = await db.onCallInvite.findFirst({ where: { email, status: "pending" }, select: { id: true } });
  if (pending) throw new OnCallError("already_invited", "That person already has a pending invite.");
  const invite = await db.onCallInvite.create({
    data: { email, invitedById: input.invitedById, clearForSecurity: input.clearForSecurity },
    select: { id: true },
  });
  if (person) {
    await db.notification.create({
      data: {
        userId: person.id,
        kind: "on_call_invite",
        title: `You're invited to go on call${input.clearForSecurity ? " and do security checks" : ""}`,
        url: "/agents/mine#on-call-invites",
      },
    });
  }
  return { inviteId: invite.id };
}

/** Search starts at this many characters, and shows at most this many people. */
export const PEOPLE_SEARCH_MIN_CHARS = 2;
export const PEOPLE_SEARCH_LIMIT = 8;

export type PersonMatch = {
  id: string;
  name: string;
  email: string;
  /** Already on call, or with an invite waiting; null when they can be invited. */
  state: "on_call" | "invited" | null;
};

/**
 * People whose display name or email contains what staff typed (case-insensitive),
 * for the invite box's search-as-you-type. Needs PEOPLE_SEARCH_MIN_CHARS characters.
 * Says who is already on call or already invited, so staff don't send a second invite.
 */
export async function searchPeopleForOnCall(query: string, db: Db = prisma): Promise<PersonMatch[]> {
  const q = query.trim();
  if (q.length < PEOPLE_SEARCH_MIN_CHARS) return [];
  const people = await db.user.findMany({
    where: { OR: [{ name: { contains: q, mode: "insensitive" } }, { email: { contains: q, mode: "insensitive" } }] },
    orderBy: [{ name: "asc" }, { email: "asc" }],
    take: PEOPLE_SEARCH_LIMIT,
    select: { id: true, name: true, email: true, onCallAt: true },
  });
  if (people.length === 0) return [];
  const pending = await db.onCallInvite.findMany({
    where: { status: "pending", email: { in: people.map((person) => normaliseEmail(person.email)) } },
    select: { email: true },
  });
  const invited = new Set(pending.map((invite) => invite.email));
  return people.map((person) => ({
    id: person.id,
    name: person.name,
    email: person.email,
    state: person.onCallAt ? "on_call" : invited.has(normaliseEmail(person.email)) ? "invited" : null,
  }));
}

/**
 * What staff typed into the invite box, as an email: an email stays as it is; a
 * display name must match exactly one person. Throws `not_found` or `ambiguous`
 * otherwise, so the box asks them to pick from the list.
 */
export async function resolveInviteEmail(input: string, db: Db = prisma): Promise<string> {
  const value = input.trim();
  if (value.includes("@")) return value;
  const matches = await db.user.findMany({ where: { name: { equals: value, mode: "insensitive" } }, select: { email: true }, take: 2 });
  if (matches.length === 1) return matches[0]!.email;
  if (matches.length > 1) throw new OnCallError("ambiguous", "More than one person has that name. Pick one from the list, or type their email.");
  throw new OnCallError("not_found", "No one has that name. Pick someone from the list, or type an email.");
}

/** Staff withdraw a pending invite. */
export async function cancelOnCallInvite(db: Db, inviteId: string, now = new Date()): Promise<void> {
  const { count } = await db.onCallInvite.updateMany({
    where: { id: inviteId, status: "pending" },
    data: { status: "cancelled", respondedAt: now },
  });
  if (count !== 1) throw new OnCallError("not_pending", "That invite isn't pending any more.");
}

/**
 * The invited person accepts or declines, once. Accepting puts them on call, and
 * clears them for security checks when the invite says so. Only a signed-in
 * person whose account email is the invite's may answer.
 */
export async function respondToOnCallInvite(
  db: Db & Pick<PrismaClient, "$transaction">,
  input: { inviteId: string; userId: string; accept: boolean },
  now = new Date(),
): Promise<void> {
  await db.$transaction(async (tx) => {
    const [invite, person] = await Promise.all([
      tx.onCallInvite.findUnique({ where: { id: input.inviteId }, select: { id: true, email: true, clearForSecurity: true } }),
      tx.user.findUnique({ where: { id: input.userId }, select: { email: true } }),
    ]);
    if (!invite || !person || normaliseEmail(person.email) !== invite.email) throw new OnCallError("not_yours", "That invite isn't for you.");
    const { count } = await tx.onCallInvite.updateMany({
      where: { id: invite.id, status: "pending" },
      data: { status: input.accept ? "accepted" : "declined", respondedAt: now },
    });
    if (count !== 1) throw new OnCallError("not_pending", "That invite was already answered or withdrawn.");
    if (!input.accept) return;
    await tx.user.update({
      where: { id: input.userId },
      data: { onCallAt: now, ...(invite.clearForSecurity ? { securityClearedAt: now } : {}) },
    });
  });
}

/** Pending invites for one person, by their account email, newest first, for My agents. */
export async function pendingInvitesFor(userId: string, db: Db = prisma) {
  const person = await db.user.findUnique({ where: { id: userId }, select: { email: true } });
  if (!person) return [];
  return db.onCallInvite.findMany({
    where: { status: "pending", email: normaliseEmail(person.email) },
    orderBy: { createdAt: "desc" },
    select: { id: true, clearForSecurity: true, createdAt: true },
  });
}

/** Pending invites across the site, for the staff page. */
export async function pendingInvites(db: Db = prisma) {
  return db.onCallInvite.findMany({
    where: { status: "pending" },
    orderBy: { createdAt: "desc" },
    select: { id: true, email: true, clearForSecurity: true, createdAt: true, invitedBy: { select: { name: true } } },
  });
}

/** Staff take a person off call. Their security clearance is separate and stays. */
export async function removeFromOnCall(db: Db, userId: string): Promise<void> {
  await db.user.updateMany({ where: { id: userId }, data: { onCallAt: null } });
}

/** Staff grant or take away a person's site-wide security clearance. */
export async function setSecurityClearance(db: Db, userId: string, cleared: boolean, now = new Date()): Promise<void> {
  await db.user.updateMany({ where: { id: userId }, data: { securityClearedAt: cleared ? now : null } });
}

// ---------------------------------------------------------------------------
// The on-call list

export type OnCallState = "Online" | "Quiet" | "Paused" | "No agents";

/** People on a page of the staff list. */
export const ON_CALL_PEOPLE_PER_PAGE = 10;

type SeenAgent = { pausedAt: Date | null; apiKeys: { lastUsedAt: Date | null }[] };

/** The latest time any of these agents' keys was used; null when none was. */
function latestSeen(agents: readonly SeenAgent[]): Date | null {
  return agents
    .flatMap((agent) => agent.apiKeys.map((key) => key.lastUsedAt))
    .reduce<Date | null>((latest, seen) => (seen && (!latest || seen > latest) ? seen : latest), null);
}

/** One agent's state: paused, quiet (not seen for ON_CALL_QUIET_AFTER_MS) or online. */
export function agentState(agent: SeenAgent, now = new Date()): Exclude<OnCallState, "No agents"> {
  if (agent.pausedAt !== null) return "Paused";
  return isQuiet(latestSeen([agent]), now) ? "Quiet" : "Online";
}

/** A person's state is that of their best agent: online if any is, else quiet, else paused; "No agents" with none. */
export function personState(agents: readonly SeenAgent[], now = new Date()): OnCallState {
  if (agents.length === 0) return "No agents";
  const working = agents.filter((agent) => agent.pausedAt === null);
  if (working.length === 0) return "Paused";
  return isQuiet(latestSeen(working), now) ? "Quiet" : "Online";
}

/**
 * The people on call for the staff list: just who they are and how they are doing
 * (name, email, state, cleared). `q` matches a name or an email; `skip` and `take`
 * page it. The detail (agents, open work, guest stays) is on the person's own page.
 */
export async function listOnCallPeople(
  { q = "", skip = 0, take = ON_CALL_PEOPLE_PER_PAGE }: { q?: string; skip?: number; take?: number } = {},
  now = new Date(),
  db: Db = prisma,
) {
  const term = q.trim();
  const where: Prisma.UserWhereInput = {
    onCallAt: { not: null },
    ...(term ? { OR: [{ name: { contains: term, mode: "insensitive" } }, { email: { contains: term, mode: "insensitive" } }] } : {}),
  };
  const [total, people] = await Promise.all([
    db.user.count({ where }),
    db.user.findMany({
      where,
      orderBy: [{ onCallAt: "asc" }, { id: "asc" }],
      skip,
      take,
      select: {
        id: true,
        name: true,
        email: true,
        securityClearedAt: true,
        agents: { where: { revokedAt: null }, select: { pausedAt: true, apiKeys: { where: { revokedAt: null }, select: { lastUsedAt: true } } } },
      },
    }),
  ]);
  return {
    total,
    people: people.map((person) => ({
      id: person.id,
      name: person.name,
      email: person.email,
      state: personState(person.agents, now),
      cleared: person.securityClearedAt !== null,
    })),
  };
}

/** Everyone on call, whatever the search: the page's heading count. */
export async function countOnCallPeople(db: Db = prisma): Promise<number> {
  return db.user.count({ where: { onCallAt: { not: null } } });
}

/**
 * One person's full page: their agents (state, last seen, parts being checked now)
 * and the workspaces they are a guest in. Null for someone who doesn't exist.
 */
export async function getOnCallPerson(userId: string, now = new Date(), db: Db = prisma) {
  const person = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      email: true,
      onCallAt: true,
      securityClearedAt: true,
      agents: {
        where: { revokedAt: null },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
          id: true,
          name: true,
          username: true,
          pausedAt: true,
          apiKeys: { where: { revokedAt: null }, select: { lastUsedAt: true } },
          activations: { where: { guest: true, guestEndedAt: null, deactivatedAt: null }, select: { organisation: { select: { id: true, name: true } } } },
          _count: { select: { securityCheckItems: { where: { status: "checking" } } } },
        },
      },
    },
  });
  if (!person) return null;
  const guests = new Map<string, string>();
  for (const agent of person.agents) for (const activation of agent.activations) guests.set(activation.organisation.id, activation.organisation.name);
  return {
    id: person.id,
    name: person.name,
    email: person.email,
    onCallSince: person.onCallAt,
    cleared: person.securityClearedAt !== null,
    state: personState(person.agents, now),
    openParts: person.agents.reduce((sum, agent) => sum + agent._count.securityCheckItems, 0),
    agents: person.agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      username: agent.username,
      state: agentState(agent, now),
      lastSeen: latestSeen([agent]),
      openParts: agent._count.securityCheckItems,
    })),
    guestWorkspaces: [...guests].map(([id, name]) => ({ id, name })),
  };
}

// ---------------------------------------------------------------------------
// The call log

/** The log looks back this far, reads at most this many rows of each kind, and shows this many lines a page. */
export const CALL_LOG_WINDOW_MS = 48 * 60 * 60 * 1000;
export const CALL_LOG_FETCH = 200;
export const CALL_LOG_PER_PAGE = 10;

export type CallLogLine = {
  kind: "security_part" | "guest_request";
  at: Date;
  /** What was needed, in plain words. */
  what: string;
  /** The person who picked it up; null when nobody has. */
  pickedUpBy: string | null;
  /** How long it took, in ms; null when nobody has picked it up. */
  waitMs: number | null;
  /** Nobody picked it up within ON_CALL_QUIET_AFTER_MS. */
  missed: boolean;
};

/** Pure: turns the rows into log lines, newest first, all of them (the page shows them in pages). */
export function buildCallLog(
  parts: ReadonlyArray<{ createdAt: Date; assignedAt: Date | null; title: string; agent: { owner: { name: string | null; email: string } } | null }>,
  guests: ReadonlyArray<{ createdAt: Date; organisation: { name: string }; agent: { owner: { name: string | null; email: string } } }>,
  now = new Date(),
): CallLogLine[] {
  const lines: CallLogLine[] = [];
  for (const part of parts) {
    const picked = part.assignedAt !== null && part.agent !== null;
    lines.push({
      kind: "security_part",
      at: part.createdAt,
      what: `Security check part: ${part.title}`,
      pickedUpBy: picked ? (part.agent!.owner.name ?? part.agent!.owner.email) : null,
      waitMs: picked ? Math.max(0, part.assignedAt!.getTime() - part.createdAt.getTime()) : null,
      missed: !picked && now.getTime() - part.createdAt.getTime() >= ON_CALL_QUIET_AFTER_MS,
    });
  }
  for (const guest of guests) {
    lines.push({
      kind: "guest_request",
      at: guest.createdAt,
      what: `New workspace: ${guest.organisation.name}`,
      pickedUpBy: guest.agent.owner.name ?? guest.agent.owner.email,
      // A guest is added the moment the workspace is created.
      waitMs: 0,
      missed: false,
    });
  }
  return lines.sort((a, b) => b.at.getTime() - a.at.getTime());
}

/** The call log for the staff page: security parts and guest requests of the last 48 hours, newest first. */
export async function onCallLog(now = new Date(), db: Db = prisma): Promise<CallLogLine[]> {
  const since = new Date(now.getTime() - CALL_LOG_WINDOW_MS);
  const owner = { select: { owner: { select: { name: true, email: true } } } } as const;
  const [parts, guests] = await Promise.all([
    db.securityCheckItem.findMany({
      where: { kind: "check", createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: CALL_LOG_FETCH,
      select: { createdAt: true, assignedAt: true, title: true, agent: owner },
    }),
    db.agentActivation.findMany({
      where: { guest: true, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: CALL_LOG_FETCH,
      select: { createdAt: true, organisation: { select: { name: true } }, agent: owner },
    }),
  ]);
  return buildCallLog(parts, guests, now);
}

/** One page of the call log, optionally only the missed lines, with the numbers the page's summary shows. */
export function pageCallLog(
  lines: readonly CallLogLine[],
  { page = 1, missedOnly = false, perPage = CALL_LOG_PER_PAGE }: { page?: number; missedOnly?: boolean; perPage?: number } = {},
) {
  const shown = missedOnly ? lines.filter((line) => line.missed) : lines;
  const pagination = calculatePagination({ page, pageSize: perPage, totalCount: shown.length });
  return {
    lines: shown.slice(pagination.skip, pagination.skip + pagination.take),
    pagination,
    totalLines: lines.length,
    missed: lines.filter((line) => line.missed).length,
  };
}
