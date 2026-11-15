import type { Prisma, PrismaClient, Status } from "@prisma/client";
import { award, type PointAward } from "./award";
import { getProjectRewardConfig } from "./platform-rewards";
import {
  calculateReporterPoints,
  solverReward,
  type ProjectRewardConfig,
} from "./project-rewards";
import { pointSourceKey } from "./rules";
import { isConfirmed, standingConfirmationAwards } from "@/lib/agent-api/confirmations";

/**
 * Points for tickets that existed before the ledger (#435), by the same
 * rules as new work (#428). Operator-run through `scripts/backfill-points.ts`.
 *
 * Every entry uses the key `award()` uses, so running this twice, or after a
 * real award for the same ticket, pays once. There were no test verdicts
 * before the platform, so no reviewer points are invented.
 */

type Db = PrismaClient | Prisma.TransactionClient;

/** Date the agent platform and contributor ledger were introduced. */
export const PLATFORM_CUTOFF_DATE = new Date("2026-10-21T00:00:00.000Z");

export type HistoricalBug = {
  /** Imported work skips reporting/confirmation rewards; its solver is still paid normally. */
  outsideWork?: { id: string } | null;
  id: string;
  organisationId: string;
  status: Status;
  assigneeId: string | null;
  reporterId: string;
  beneficiaryUserId?: string | null;
  duplicateOfId: string | null;
  isDeleted: boolean;
  createdByAgentId?: string | null;
  createdAt?: Date;
  isConfirmed?: boolean;
  projectId?: string | null;
  /** #rewards: what solving it pays. */
  reward?: number | { toNumber(): number } | null;
  /** #live-payout: a resolution still waiting for its deployment reports pays nothing yet. */
  heldPayout?: unknown;
  payoutReleasedAt?: Date | null;
  /** Public intake uses a synthetic reporter that must never receive points. */
  idea?: { source: string } | null;
};

/** Solver points are earned on `resolved` only — the same eligibility the
 * live award path (app/actions/issues.ts) and the bulk edit path
 * (lib/points/bulk-award.ts) use. A `closed` issue may still be a duplicate,
 * cancellation or won't-fix outcome, which must never pay a solver (#656);
 * a genuinely completed closed ticket can be credited through a missing-award
 * dispute, which is the audited path for that case.
 */
const SOLVER_ELIGIBLE: ReadonlySet<Status> = new Set<Status>(["resolved"]);

export function isModernBug(bug: HistoricalBug, cutoffDate?: Date): boolean {
  if (bug.createdByAgentId) return true;
  if (cutoffDate && bug.createdAt && bug.createdAt >= cutoffDate) return true;
  return false;
}

/** The awards a ticket earns: solver for its assignee once resolved (never for
 * a duplicate, and not from a mere `closed` status), reporter unless it's a
 * duplicate. For modern/agent-platform issues (#715), reporter points require
 * independent confirmation.
 */
export function backfillEntries(
  bug: HistoricalBug,
  options?: { cutoffDate?: Date; rewardConfig?: ProjectRewardConfig | null },
): PointAward[] {
  // A deleted ticket was taken back; it earns nothing.
  if (bug.isDeleted) return [];
  const rewardConfig = options?.rewardConfig;
  const entries: PointAward[] = [];
  const payoutHeld = Array.isArray(bug.heldPayout) && bug.heldPayout.length > 0 && !bug.payoutReleasedAt;
  if (SOLVER_ELIGIBLE.has(bug.status) && bug.assigneeId && !bug.duplicateOfId && !payoutHeld) {
    entries.push({
      organisationId: bug.organisationId,
      userId: bug.assigneeId,
      bugId: bug.id,
      role: "solver",
      points: solverReward(bug.reward),
      sourceKey: pointSourceKey("solver", bug.id, bug.assigneeId),
    });
  }
  if (!bug.outsideWork && !bug.duplicateOfId && bug.idea?.source !== "public") {
    const modern = isModernBug(bug, options?.cutoffDate);
    // Modern agent-platform issues require confirmation (#715)
    if (!modern || bug.isConfirmed) {
      const recipientId = (modern ? bug.beneficiaryUserId : null) ?? bug.reporterId;
      entries.push({
        organisationId: bug.organisationId,
        userId: recipientId,
        bugId: bug.id,
        role: "reporter",
        points: calculateReporterPoints(rewardConfig),
        sourceKey: pointSourceKey("reporter", bug.id, recipientId),
      });
    }
  }
  return entries;
}

export type BackfillLine = PointAward & { alreadyAwarded: boolean };

export type BackfillResult = {
  bugs: number;
  /** Entries the rules give, including ones already in the ledger. */
  planned: number;
  /** Rows actually inserted (always 0 for a dry run). */
  written: number;
  /** Planned entries already in the ledger, skipped. */
  existing: number;
};

export type BackfillOptions = {
  /** Print what would be awarded and write nothing. */
  dryRun?: boolean;
  /** Called once per planned entry, e.g. to print it. */
  onLine?: (line: BackfillLine) => void;
  batchSize?: number;
  /** Issues created at or after this date use modern confirmation rules (#715). */
  cutoffDate?: Date;
};

async function checkConfirmed(db: Db, bug: HistoricalBug): Promise<boolean> {
  if (bug.isConfirmed !== undefined) return bug.isConfirmed;
  const anyDb = db as unknown as { issueConfirmation?: unknown; bug?: { findUnique?: unknown } };
  if (!anyDb.issueConfirmation || !anyDb.bug?.findUnique) return false;
  return isConfirmed(bug.id, db);
}

/** Walks every ticket in id order and awards what it earns. */
export async function backfillPoints(db: Db, options: BackfillOptions = {}): Promise<BackfillResult> {
  const { dryRun = false, onLine, batchSize = 500, cutoffDate = PLATFORM_CUTOFF_DATE } = options;
  if (cutoffDate && Number.isNaN(cutoffDate.getTime())) {
    throw new Error("Invalid cutoffDate provided to backfillPoints");
  }
  const result: BackfillResult = { bugs: 0, planned: 0, written: 0, existing: 0 };
  let cursor: string | undefined;

  for (;;) {
    const bugs: HistoricalBug[] = await db.bug.findMany({
      orderBy: { id: "asc" },
      take: batchSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        organisationId: true,
        status: true,
        assigneeId: true,
        reporterId: true,
        beneficiaryUserId: true,
        duplicateOfId: true,
        isDeleted: true,
        createdByAgentId: true,
        outsideWork: { select: { id: true } },
        createdAt: true,
        projectId: true,
        reward: true,
        heldPayout: true,
        payoutReleasedAt: true,
        idea: { select: { source: true } },
      },
    });
    if (bugs.length === 0) break;
    result.bugs += bugs.length;
    cursor = bugs[bugs.length - 1].id;

    for (const b of bugs) {
      if (isModernBug(b, cutoffDate) && b.isConfirmed === undefined) {
        b.isConfirmed = await checkConfirmed(db, b);
      }
    }

    const rewardByProject = new Map<string | null, ProjectRewardConfig>();
    // #539: confirmations pay when given, so any that landed before
    // the award code are missed unless the backfill recomputes them. The
    // sourceKey makes re-running safe.
    const entries = (
      await Promise.all(
        bugs.map(async (b) => {
          const projectKey = b.projectId ?? null;
          let rewardConfig = rewardByProject.get(projectKey);
          if (!rewardConfig) {
            rewardConfig = await getProjectRewardConfig(db, projectKey);
            rewardByProject.set(projectKey, rewardConfig);
          }
          return [
            ...backfillEntries(b, { cutoffDate, rewardConfig }),
            ...(b.isDeleted ? [] : await standingConfirmationAwards(db, b.id)),
          ];
        }),
      )
    ).flat();
    if (entries.length > 0) {
      const present = await db.pointEntry.findMany({
        where: { sourceKey: { in: entries.map((e) => e.sourceKey) } },
        select: { sourceKey: true },
      });
      const already = new Set(present.map((p) => p.sourceKey));

      for (const entry of entries) {
        result.planned++;
        let alreadyAwarded = already.has(entry.sourceKey);
        // award() skips an existing key, so if a real award wins the race
        // after the lookup above, the entry counts as existing, not lost.
        if (!dryRun && !alreadyAwarded) {
          if (await award(db, entry)) result.written++;
          else alreadyAwarded = true;
        }
        if (alreadyAwarded) result.existing++;
        onLine?.({ ...entry, alreadyAwarded });
      }
    }
    if (bugs.length < batchSize) break;
  }
  return result;
}

export const BACKFILL_USAGE = "Usage: pnpm tsx scripts/backfill-points.ts [--dry-run] [--verbose] [--cutoff=<ISO date>]";

/**
 * The script's flags. Anything else is an error, checked before connecting:
 * a mistyped `--dryrun` must never fall through to a real run that writes.
 */
export function parseBackfillArgs(
  args: ReadonlyArray<string>,
): { ok: true; dryRun: boolean; verbose: boolean; cutoffDate?: Date } | { ok: false; error: string } {
  let cutoffDate: Date | undefined;
  const unknown: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--dry-run" || arg === "--verbose") {
      continue;
    }
    if (arg.startsWith("--cutoff=")) {
      const raw = arg.slice("--cutoff=".length);
      const parsed = new Date(raw);
      if (Number.isNaN(parsed.getTime())) {
        return { ok: false, error: `Invalid date for --cutoff: ${raw}\n${BACKFILL_USAGE}` };
      }
      cutoffDate = parsed;
      continue;
    }
    if (arg === "--cutoff") {
      const next = args[i + 1];
      if (!next || next.startsWith("-")) {
        return { ok: false, error: `Missing date argument for --cutoff\n${BACKFILL_USAGE}` };
      }
      const parsed = new Date(next);
      if (Number.isNaN(parsed.getTime())) {
        return { ok: false, error: `Invalid date for --cutoff: ${next}\n${BACKFILL_USAGE}` };
      }
      cutoffDate = parsed;
      i++;
      continue;
    }
    unknown.push(arg);
  }

  if (unknown.length > 0) {
    return { ok: false, error: `Unknown argument${unknown.length > 1 ? "s" : ""}: ${unknown.join(" ")}\n${BACKFILL_USAGE}` };
  }
  const dryRun = args.includes("--dry-run");
  return { ok: true, dryRun, verbose: dryRun || args.includes("--verbose"), cutoffDate };
}
