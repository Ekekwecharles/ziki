import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * How an on-call guest reaches the workspace it is a guest in (12 Nov plan,
 * part D2). Kept free of heavy imports: requireAgent() uses it on every call.
 */

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * What an on-call guest may not do in the workspace it is a guest in: anything
 * that would outlast its stay. A webhook made during the stay would keep sending
 * that client's activity after the guest has left; goals and research jobs are
 * the workspace's own planning, not a guest's to set.
 */
export const GUEST_BLOCKED_ACTIONS: ReadonlySet<string> = new Set([
  "webhooks.create",
  "webhooks.enable",
  "webhooks.rotateSecret",
  "webhooks.retryDelivery",
  "goals.create",
  "goals.update",
  "goals.split",
  "jobs.create",
]);

export const GUEST_BLOCKED_MESSAGE =
  "On-call guests can't set up webhooks, goals or research jobs in a workspace they're visiting.";

/** A live guest stay: added as a guest, not ended, not switched off. */
export const LIVE_GUEST = { guest: true, guestEndedAt: null, deactivatedAt: null } as const satisfies Prisma.AgentActivationWhereInput;

/**
 * The workspace a request is for, when it is one where this agent is a live
 * guest: from `?projectId=` or from a work feed path (`/<org>/<project>/work`).
 * Null for anything else, so the call stays in the key's own workspace.
 * `guestIn` are the agent's live guest stays, already loaded with its key.
 */
export async function guestOrganisationFor(
  db: Db,
  url: string | undefined,
  guestIn: readonly { organisationId: string }[],
): Promise<string | null> {
  if (!url || guestIn.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(url, "https://ziki.dev");
  } catch {
    return null;
  }
  const live = new Set(guestIn.map((stay) => stay.organisationId));
  const projectId = parsed.searchParams.get("projectId")?.trim();
  if (projectId) {
    const project = await db.project.findUnique({ where: { id: projectId }, select: { organisationId: true } });
    return project && live.has(project.organisationId) ? project.organisationId : null;
  }
  const feed = /^\/([^/]+)\/[^/]+\/work\/?$/.exec(parsed.pathname);
  if (feed && feed[1] !== "api") {
    const organisation = await db.organisation.findUnique({ where: { slug: decodeURIComponent(feed[1]) }, select: { id: true } });
    return organisation && live.has(organisation.id) ? organisation.id : null;
  }
  return null;
}

/**
 * An agent's home workspace: the earliest normal (non-guest) workspace it is
 * active in. Null when it has none. Guest earnings and security-check finder
 * pay land here, so its owner sees and withdraws them as usual.
 */
export async function homeWorkspaceFor(agentId: string, db: Db = prisma): Promise<string | null> {
  const home = await db.agentActivation.findFirst({
    where: { agentId, guest: false, deactivatedAt: null },
    orderBy: [{ activatedAt: "asc" }, { id: "asc" }],
    select: { organisationId: true },
  });
  return home?.organisationId ?? null;
}

/**
 * Where points earned in `organisationId` by `userId` (through `agentId`, when
 * known) should land instead: the earning agent's home workspace, when that
 * agent is or was an on-call guest there and its owner isn't a member. Checks
 * the activation, not only live stays, because points can arrive after the
 * guest has left (for example when the work is reported deployed). Null means
 * "leave them where they are".
 */
export async function guestHomeFor(
  db: Db,
  entry: { organisationId: string; userId: string; agentId?: string | null },
): Promise<string | null> {
  // Code and tests that stub only the ledger have no activations to read (same guard as requireAgent's lastUsedAt).
  if (typeof db.agentActivation?.findFirst !== "function") return null;
  const stay = await db.agentActivation.findFirst({
    where: {
      organisationId: entry.organisationId,
      guest: true,
      ...(entry.agentId ? { agentId: entry.agentId } : { agent: { ownerUserId: entry.userId } }),
      // A member earns here as usual, even if one of their agents once visited as a guest.
      organisation: { memberships: { none: { userId: entry.userId } } },
    },
    orderBy: [{ activatedAt: "asc" }, { id: "asc" }],
    select: { agentId: true },
  });
  if (!stay) return null;
  const home = await homeWorkspaceFor(stay.agentId, db);
  return home && home !== entry.organisationId ? home : null;
}
