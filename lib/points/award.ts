import type { Prisma, PrismaClient } from "@prisma/client";
import { pointSourceKey, type PointRole } from "./rules";
import { solverReward } from "./project-rewards";
import { pointsMultiplierFor, scaledPoints } from "./multiplier";
import { getPlatformRewardConfig } from "./platform-rewards";
import { reportedClosedUnmerged } from "@/lib/agent-api/pull-request-report";
import { guestHomeFor } from "@/lib/agents/guest-access";

/**
 * Writes points to the ledger (#428). The backfill (#435), the merge gate
 * (#434) and validations (#433) call `award()`; they must not edit this file.
 *
 * Every award has a `sourceKey`, and `PointEntry.sourceKey` is unique, so the
 * same award written twice adds one row. A correction is a new row with
 * negative points (#436, #450); rows are never deleted.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export type PointAward = {
  organisationId: string;
  userId: string;
  bugId: string | null;
  /** Set for an `idea` entry (#idea-table). */
  ideaId?: string | null;
  role: PointRole;
  points: number;
  sourceKey: string;
  /** The agent whose work earned it (#710); omit for a person's own action. */
  agentId?: string | null;
  /**
   * When it was earned, for an award written later than the action that earned
   * it (the startup backfill); omit to stamp it now.
   */
  createdAt?: Date;
  /**
   * Store `points` as given, without the organisation's multiplier. Only for an
   * amount already read from the ledger (a correction, a penalty), which was
   * multiplied when it was first written.
   */
  exact?: boolean;
};

/**
 * Writes `entry` unless an entry with its `sourceKey` exists. True if it was written.
 *
 * On-call guests (12 Nov plan, D2): points a guest earns in a workspace it is
 * (or was) visiting land in its home workspace instead, where its owner is a
 * member and can see and withdraw them. They are scaled by the home
 * workspace's multiplier, since that is where they're paid.
 */
export async function award(db: Db, entry: PointAward): Promise<boolean> {
  const home = await guestHomeFor(db, entry);
  const { exact, ...row } = home ? { ...entry, organisationId: home } : entry;
  const multiplier = exact ? 1 : await pointsMultiplierFor(db, row.organisationId);
  const { count } = await db.pointEntry.createMany({
    data: [{ ...row, points: scaledPoints(entry.points, multiplier) }],
    skipDuplicates: true,
  });
  return count > 0;
}

export async function awardDispatcher(
  db: Db,
  issue: { id: string; organisationId: string },
  dispatcherUserId: string | null | undefined,
): Promise<boolean> {
  if (!dispatcherUserId) return false;
  const platform = await getPlatformRewardConfig(db);
  return award(db, {
    organisationId: issue.organisationId,
    bugId: issue.id,
    userId: dispatcherUserId,
    role: "dispatcher",
    points: platform.dispatcher,
    sourceKey: `dispatcher:${issue.id}`,
  });
}

export type ResolvedIssue = {
  id: string;
  organisationId: string;
  /** Who it was assigned to at resolution time; nobody earns the reward without one. */
  assigneeId: string | null;
  /** The issue's reward, in $ (#rewards). */
  reward?: number | { toNumber(): number } | null;
  pullRequestUrl?: string | null;
};

/** The solver award for resolving `issue`, its reward, or null when nobody is assigned. */
export function solverAward(issue: ResolvedIssue): PointAward | null {
  if (!issue.assigneeId) return null;
  return {
    organisationId: issue.organisationId,
    userId: issue.assigneeId,
    bugId: issue.id,
    role: "solver",
    points: solverReward(issue.reward),
    sourceKey: pointSourceKey("solver", issue.id, issue.assigneeId),
  };
}

/**
 * The solver award a resolved issue earns, read from the issue (its reward
 * and pull request), or null: nobody assigned, or the pull request was
 * reported closed without merging (#642). The caller holds it until the work
 * is reported deployed (lib/points/payout.ts).
 */
export async function solverAwardFor(db: Db, issue: { id: string; organisationId: string; assigneeId: string | null }): Promise<PointAward | null> {
  if (!issue.assigneeId) return null;
  const bug = await db.bug.findUnique({ where: { id: issue.id }, select: { reward: true, pullRequestUrl: true } });
  if (bug?.pullRequestUrl && (await reportedClosedUnmerged(issue.id, bug.pullRequestUrl, db))) return null;
  return solverAward({ ...issue, reward: bug?.reward ?? null });
}
