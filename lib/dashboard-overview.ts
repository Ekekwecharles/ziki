import { PRODUCT_TRACK } from "@/lib/marketing/track";
import "server-only";
import { Prisma, type Status } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { missingProfileFields } from "@/lib/agents/work-gate";
import { bugInOrganisation } from "@/lib/organisation-context";
import { issueHref } from "@/lib/issue-ref";
import { isDeliveryOverdue } from "@/lib/claim-deadline";
import { pointTotals, organisationRankFor, type PointTotals } from "@/lib/points/leaderboard";
import { activeIn, activeLevels, levelIn } from "@/lib/agents/active-in";

/**
 * The Overview dashboard's data (#dashboard): every number is counted live in
 * Postgres, organisation-wide. Nothing here is cached or hard-coded — the
 * screenshots' sample figures are design references, not data.
 */

/**
 * Status partition. "Unresolved" is work still waiting on someone; "resolved"
 * is the app's existing finished convention (lib/issue-state.ts's isDone()).
 * The two sets are disjoint and together cover every issue, which the unit
 * tests pin down.
 */
export const UNRESOLVED_STATUSES = ["open", "in_progress", "done", "merge"] as const;
export const RESOLVED_STATUSES = ["resolved", "closed"] as const;

export type UnresolvedStatus = (typeof UNRESOLVED_STATUSES)[number];
export type ResolvedStatus = (typeof RESOLVED_STATUSES)[number];

export function isUnresolvedStatus(status: string): status is UnresolvedStatus {
  return (UNRESOLVED_STATUSES as readonly string[]).includes(status);
}

export function isResolvedStatus(status: string): status is ResolvedStatus {
  return (RESOLVED_STATUSES as readonly string[]).includes(status);
}

/** Preview rows: exactly the three the design places under each card. */
export const PREVIEW_LIMIT = 3;

export type OverviewIssue = {
  id: string;
  number: number;
  title: string;
  status: Status;
  /** When it first reached resolved/closed, from the activity log. */
  resolvedAt: Date | null;
};

export type OrganisationOverview = {
  unresolvedCount: number;
  resolvedCount: number;
  recentUnresolved: OverviewIssue[];
  recentResolved: OverviewIssue[];
  /** Sidebar queue counts — same semantics as the Issues page sidebar. */
  assignedToMe: number;
  reportedByMe: number;
  points: PointTotals;
  rank: { rank: number; total: number } | null;
};

/** Shown if the queries fail, so the shell still renders (all zeros). */
export const EMPTY_OVERVIEW: OrganisationOverview = {
  unresolvedCount: 0,
  resolvedCount: 0,
  recentUnresolved: [],
  recentResolved: [],
  assignedToMe: 0,
  reportedByMe: 0,
  points: { points: 0, solvedTasks: 0 },
  rank: null,
};

/**
 * The moment each issue first reached resolved/closed, from the activity log.
 * There is no resolvedAt column, and updatedAt moves on every later edit, so
 * it cannot stand in for one — same derivation the admin dashboard uses
 * (lib/dashboard-queries.ts). The join is inside the aggregate so Postgres
 * does not scan every organisation's activity before applying the organisation.
 */
export function firstCloseForOrganisation(organisationId: string): Prisma.Sql {
  return Prisma.sql`
    SELECT a."bugId" AS bug_id, MIN(a."createdAt") AS closed_at
    FROM "BugActivity" a
    INNER JOIN "Bug" bug ON bug."id" = a."bugId"
    WHERE a.type = 'status_changed'
      AND a.metadata ->> 'to' IN ('resolved', 'on_dev', 'on_staging', 'on_prod', 'published', 'force_merged', 'closed')
      AND bug."organisationId" = ${organisationId}
      AND bug."isDeleted" = false
      AND bug."track" = 'product'
    GROUP BY a."bugId"
  `;
}

export async function loadOrganisationOverview({
  userId,
  organisationId,
}: {
  userId: string;
  organisationId: string | null;
}): Promise<OrganisationOverview> {
  if (!organisationId) return EMPTY_OVERVIEW;

  const base: Prisma.BugWhereInput = { ...bugInOrganisation(organisationId), ...PRODUCT_TRACK, isDeleted: false };

  const [
    unresolvedCount,
    resolvedCount,
    recentUnresolved,
    resolvedRows,
    assignedToMe,
    reportedByMe,
    points,
    rank,
  ] = await Promise.all([
      prisma.bug.count({ where: { ...base, status: { in: [...UNRESOLVED_STATUSES] } } }),
      prisma.bug.count({ where: { ...base, status: { in: [...RESOLVED_STATUSES] } } }),
      prisma.bug.findMany({
        where: { ...base, status: { in: [...UNRESOLVED_STATUSES] } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: PREVIEW_LIMIT,
        select: { id: true, number: true, title: true, status: true },
      }),
      prisma.$queryRaw<
        { id: string; number: number; title: string; status: string; resolved_at: Date }[]
      >`
        SELECT b."id", b."number", b."title", b."status"::text AS status,
               fc.closed_at AS resolved_at
        FROM (${firstCloseForOrganisation(organisationId)}) fc
        JOIN "Bug" b ON b."id" = fc.bug_id
        WHERE b."organisationId" = ${organisationId}
          AND b."isDeleted" = false
          AND b."status"::text IN ('resolved', 'closed')
        ORDER BY fc.closed_at DESC, b."number" DESC
        LIMIT ${PREVIEW_LIMIT}
      `,
      prisma.bug.count({ where: { ...base, assigneeId: userId } }),
      prisma.bug.count({ where: { ...base, reporterId: userId } }),
      pointTotals(prisma, organisationId, userId),
      organisationRankFor(prisma, organisationId, userId),
    ]);

  return {
    unresolvedCount,
    resolvedCount,
    recentUnresolved: recentUnresolved.map((bug) => ({
      ...bug,
      resolvedAt: null,
    })),
    recentResolved: resolvedRows.map((row) => ({
      id: row.id,
      number: row.number,
      title: row.title,
      status: row.status as Status,
      resolvedAt: row.resolved_at,
    })),
    assignedToMe,
    reportedByMe,
    points,
    rank,
  };
}

/**
 * The three live badges in the persistent sidebar. Kept separate from
 * `loadOrganisationOverview` so pages that only need the sidebar (the issue list)
 * do not pay for previews, points or the rank query.
 */
export type SidebarCounts = {
  unresolved: number;
  assigned: number;
  reported: number;
};

export async function loadSidebarCounts({
  userId,
  organisationId,
}: {
  userId: string;
  organisationId: string | null;
}): Promise<SidebarCounts> {
  if (!organisationId) return { unresolved: 0, assigned: 0, reported: 0 };

  const base: Prisma.BugWhereInput = { ...bugInOrganisation(organisationId), ...PRODUCT_TRACK, isDeleted: false };
  const [unresolved, assigned, reported] = await Promise.all([
    prisma.bug.count({ where: { ...base, status: { in: [...UNRESOLVED_STATUSES] } } }),
    prisma.bug.count({ where: { ...base, assigneeId: userId } }),
    prisma.bug.count({ where: { ...base, reporterId: userId } }),
  ]);
  return { unresolved, assigned, reported };
}

/* ------------------------------------------------------------------ */
/* Your agents                                                         */
/* ------------------------------------------------------------------ */

/** A claim older than this with no heartbeat is not "working" any more: it is stuck. */
export const AGENT_WORKING_WINDOW_MS = 15 * 60 * 1000;
/** Seen this recently without active work: idle, not offline. */
export const AGENT_IDLE_WINDOW_MS = 24 * 60 * 60 * 1000;

export type AgentStatus = "waiting" | "stuck" | "working" | "idle" | "offline";

export type DashboardAgent = {
  id: string;
  name: string;
  /** Its slug: the address of its page. */
  username: string;
  /** The owner's avatar pick; null wears the automatic robot. */
  avatar: string | null;
  model: string | null;
  level: string;
  status: AgentStatus;
  /** What the table's "Current activity" column says. Never invented. */
  activity: string;
  lastSeenAt: Date | null;
  /** The issue it is working on, or the one its unanswered question is about (#agents-dock). */
  issue: { number: number; href: string } | null;
  /** Its unanswered question to its owner, word for word. */
  question: string | null;
  /** Its profile isn't set up, so it can't work yet (#agent-work-gate): the agents bar says so. */
  needsSetup: boolean;
};

/**
 * Status from real signals only: an unanswered question means the agent is
 * waiting on its owner; a claim it holds but has gone quiet on, or let run
 * past its deadline, means stuck; a live claim with a recent heartbeat means
 * working; otherwise a recent event or key use means idle; anything else is
 * offline. Pure so the precedence is unit-tested without a database.
 */
export function classifyAgentStatus({
  hasUnansweredQuestion,
  hasStalledClaim = false,
  hasActiveClaim,
  lastSeenAt,
  now = new Date(),
}: {
  hasUnansweredQuestion: boolean;
  hasStalledClaim?: boolean;
  hasActiveClaim: boolean;
  lastSeenAt: Date | null;
  now?: Date;
}): AgentStatus {
  if (hasUnansweredQuestion) return "waiting";
  if (hasStalledClaim) return "stuck";
  if (hasActiveClaim) return "working";
  if (lastSeenAt && now.getTime() - lastSeenAt.getTime() <= AGENT_IDLE_WINDOW_MS) {
    return "idle";
  }
  return "offline";
}

/**
 * Stuck, as the stale-claim sweep reads it (lib/agent-api/availability.ts):
 * quiet for the working window, or past its deadline, with no pull request
 * linked yet and no question to its owner pausing the clocks.
 */
export function isClaimStalled({
  quiet,
  deliverBy,
  waitingOnOwnerSince,
  pullRequestUrl,
  now,
}: {
  quiet: boolean;
  deliverBy: Date | null | undefined;
  waitingOnOwnerSince: Date | null;
  pullRequestUrl: string | null;
  now: Date;
}): boolean {
  if (waitingOnOwnerSince || pullRequestUrl) return false;
  return quiet || isDeliveryOverdue(deliverBy, now);
}

/** How long an agent has been quiet, in the largest unit that fits: "20 min", "3 h", "2 days". */
function quietFor(since: Date | null, now: Date): string {
  if (!since) return "a while";
  const minutes = Math.max(1, Math.floor((now.getTime() - since.getTime()) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} days`;
}

const latest = (...dates: (Date | null | undefined)[]): Date | null => {
  let newest: Date | null = null;
  for (const date of dates) {
    if (date && (!newest || date.getTime() > newest.getTime())) newest = date;
  }
  return newest;
};

/**
 * The signed-in person's own non-revoked agents in this organisation, with the
 * table's four columns. Only reads: no agent row is created here.
 */
export async function loadOwnAgents({
  userId,
  organisationId,
  now = new Date(),
}: {
  userId: string;
  organisationId: string | null;
  now?: Date;
}): Promise<DashboardAgent[]> {
  if (!organisationId) return [];

  const agents = await prisma.agent.findMany({
    where: { ownerUserId: userId, ...activeIn(organisationId), revokedAt: null },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      name: true,
      username: true,
      avatar: true,
      model: true,
      tagline: true,
      about: true,
      _count: { select: { skills: true } },
      activations: activeLevels,
      apiKeys: { where: { revokedAt: null, organisationId }, select: { lastUsedAt: true } },
      questions: {
        where: { answeredAt: null },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 1,
        select: { createdAt: true, body: true, bug: { select: { number: true, isDeleted: true, project: { select: { slug: true, organisation: { select: { slug: true } } } } } } },
      },
      claims: {
        where: { releasedAt: null, status: "active" },
        orderBy: [{ claimedAt: "desc" }, { id: "desc" }],
        take: 1,
        select: {
          claimedAt: true,
          lastHeartbeatAt: true,
          deliverBy: true,
          waitingOnOwnerSince: true,
          bug: { select: { number: true, title: true, status: true, isDeleted: true, pullRequestUrl: true, project: { select: { slug: true, organisation: { select: { slug: true } } } } } },
        },
      },
    },
  });
  if (agents.length === 0) return [];

  // Latest event per agent, one cheap grouped read.
  const latestEvents = await prisma.agentEvent.groupBy({
    by: ["actorAgentId"],
    where: { actorAgentId: { in: agents.map((agent) => agent.id) } },
    _max: { createdAt: true },
  });
  const eventById = new Map(
    latestEvents.map((row) => [row.actorAgentId, row._max.createdAt ?? null]),
  );

  const workingCutoff = now.getTime() - AGENT_WORKING_WINDOW_MS;

  return agents.map((agent) => {
    const unanswered = agent.questions.length > 0;
    const claim = agent.claims[0] ?? null;
    const claimedBug = claim?.bug ?? null;
    const heartbeat = claim?.lastHeartbeatAt ?? claim?.claimedAt ?? null;
    const claimHeld = claim !== null && claimedBug !== null && !claimedBug.isDeleted && claimedBug.status === "in_progress";
    const quiet = heartbeat === null || heartbeat.getTime() < workingCutoff;
    const claimStalled =
      claimHeld &&
      isClaimStalled({ quiet, deliverBy: claim.deliverBy, waitingOnOwnerSince: claim.waitingOnOwnerSince, pullRequestUrl: claimedBug.pullRequestUrl, now });
    const claimIsLive = claimHeld && !quiet;

    const lastSeenAt = latest(
      heartbeat,
      eventById.get(agent.id) ?? null,
      ...agent.apiKeys.map((key) => key.lastUsedAt),
    );

    const status = classifyAgentStatus({
      hasUnansweredQuestion: unanswered,
      hasStalledClaim: claimStalled,
      hasActiveClaim: claimIsLive,
      lastSeenAt,
      now,
    });

    let activity: string;
    if (status === "waiting") {
      activity = "Waiting for your answer";
    } else if (status === "stuck" && claimedBug) {
      activity = isDeliveryOverdue(claim?.deliverBy, now)
        ? `Past its deadline on #${claimedBug.number} ${claimedBug.title}`
        : `No word on #${claimedBug.number} for ${quietFor(heartbeat, now)}`;
    } else if (status === "working" && claimedBug) {
      activity = `Working on #${claimedBug.number} ${claimedBug.title}`;
    } else if (status === "idle") {
      activity = "Standing by";
    } else {
      activity = "No recent activity";
    }

    const asked = agent.questions[0]?.bug ?? null;
    const about = status === "waiting" ? (asked && !asked.isDeleted ? asked : null) : status === "working" || status === "stuck" ? claimedBug : null;

    return {
      id: agent.id,
      name: agent.name,
      username: agent.username,
      avatar: agent.avatar,
      model: agent.model,
      needsSetup: missingProfileFields({ tagline: agent.tagline, about: agent.about, skillCount: agent._count.skills }).length > 0,
      level: levelIn(agent, organisationId),
      status,
      activity,
      lastSeenAt,
      issue: about ? { number: about.number, href: issueHref(about) } : null,
      question: agent.questions[0]?.body ?? null,
    };
  });
}
