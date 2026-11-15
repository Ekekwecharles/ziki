import type { Prisma, PrismaClient } from "@prisma/client";
import { audit } from "@/lib/agents/audit";
import { LIVE_GUEST } from "@/lib/agents/guest-access";
import { ON_CALL_GUESTS_PER_NEW_WORKSPACE, ON_CALL_QUIET_AFTER_MS } from "@/lib/security-checks";

/**
 * On-call guests (14 Nov security and on-call plan, part D2).
 *
 * On call is a person (14 Nov plan, H0b). When a workspace is created, up to
 * ON_CALL_GUESTS_PER_NEW_WORKSPACE free on-call people join it as guests with
 * all their agents, to give the new client a quick win. Each agent is a
 * working agent there: it sees the work feed and issues, bids, takes work and
 * delivers, with no admin powers. The person does not become a member and
 * can't open the workspace in the app. The agents use their own keys from home
 * (see lib/agents/guest-access.ts) and stay until the workspace's owner or a
 * super admin removes them from the Agents page.
 */

type Db = PrismaClient | Prisma.TransactionClient;

/** A free on-call person is a guest in at most this many workspaces at once, so one person isn't spread thin. */
export const GUEST_WORKSPACES_PER_PERSON = 3;

export type OnCallPerson = { userId: string; agentIds: string[] };

/**
 * Up to `n` free on-call people, at random, each with every agent of theirs
 * that isn't revoked. Free means on call, with at least one agent that isn't
 * paused and was seen in the last ON_CALL_QUIET_AFTER_MS (not quiet), and a
 * guest in fewer than GUEST_WORKSPACES_PER_PERSON workspaces. `excludeUserIds`
 * keeps, for example, the workspace's own creator out.
 */
export async function pickFreeOnCallPeople(
  db: Db,
  n: number,
  { excludeUserIds = [], now = new Date(), random = Math.random }: { excludeUserIds?: string[]; now?: Date; random?: () => number } = {},
): Promise<OnCallPerson[]> {
  if (n <= 0) return [];
  const since = new Date(now.getTime() - ON_CALL_QUIET_AFTER_MS);
  const people = await db.user.findMany({
    where: {
      onCallAt: { not: null },
      id: { notIn: excludeUserIds },
      agents: { some: { revokedAt: null, pausedAt: null, apiKeys: { some: { revokedAt: null, lastUsedAt: { gte: since } } } } },
    },
    select: {
      id: true,
      agents: {
        where: { revokedAt: null },
        orderBy: { createdAt: "asc" },
        select: { id: true, activations: { where: LIVE_GUEST, select: { organisationId: true } } },
      },
    },
  });
  const free = people.filter((person) => {
    const guestIn = new Set(person.agents.flatMap((agent) => agent.activations.map((stay) => stay.organisationId)));
    return guestIn.size < GUEST_WORKSPACES_PER_PERSON;
  });
  // Shuffle (Fisher-Yates), then keep the first n.
  for (let i = free.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [free[i], free[j]] = [free[j]!, free[i]!];
  }
  return free.slice(0, n).map((person) => ({ userId: person.id, agentIds: person.agents.map((agent) => agent.id) }));
}

/**
 * Adds free on-call people to a new workspace as guests, with all their
 * agents. Returns the agent ids added; none when nobody is free. Never throws:
 * a workspace is never held up or lost because guests couldn't be added.
 */
export async function addOnCallGuests(
  db: Db,
  workspace: { organisationId: string; creatorId: string },
  options: { now?: Date; random?: () => number } = {},
): Promise<string[]> {
  try {
    const people = await pickFreeOnCallPeople(db, ON_CALL_GUESTS_PER_NEW_WORKSPACE, { excludeUserIds: [workspace.creatorId], ...options });
    const agentIds = people.flatMap((person) => person.agentIds);
    if (agentIds.length === 0) return [];
    await db.agentActivation.createMany({
      data: agentIds.map((agentId) => ({ agentId, organisationId: workspace.organisationId, level: "working" as const, guest: true })),
      skipDuplicates: true,
    });
    for (const agentId of agentIds) {
      await audit({ agentId, organisationId: workspace.organisationId }, "agent.on_call_guest_added", `agent:${agentId}`, {}, { actorUserId: workspace.creatorId, db });
    }
    return agentIds;
  } catch (error) {
    console.error("[on-call-guests] couldn't add guests to a new workspace", error);
    return [];
  }
}
