import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { sweepExpiredOffers } from "@/lib/agent-api/offer";
import { sweepPlanWindows } from "@/lib/agent-api/plan";
import { sweepStakes } from "@/lib/agent-api/stakes";
import { sweepJobReviewOffers } from "@/lib/jobs/review";
import { sweepReviewOffers } from "@/lib/agent-api/review-offer";
import { sweepStaleClaims } from "@/lib/agent-api/availability";
import { dispatchDueDeliveries } from "@/lib/webhooks/deliver";
import { pruneAgentRows, type AgentRetentionCounts } from "@/lib/agent-retention";
import { sweepOrphanedAttachments } from "@/lib/attachment-retention";
import { sweepOrphanedIssues } from "@/lib/orphaned-issues";
import { sweepUndraftedIdeas } from "@/lib/cron/draft-structuring";
import { processSearchOutbox, pruneProcessedSearchOutbox } from "@/lib/search-index";
import { refreshMergeQueue } from "@/lib/github/sync";
import { sweepSecurityChecks } from "@/lib/security-checks/engine";
import { retryPendingWithdrawals } from "@/lib/coins/withdraw";

export const FAILURE_ALERT_THRESHOLD = 3;
const consecutiveFailures = new Map<string, number>();

export function recordSweepFailure(sweepName: string, error: unknown): void {
  const count = (consecutiveFailures.get(sweepName) ?? 0) + 1;
  consecutiveFailures.set(sweepName, count);
  if (count >= FAILURE_ALERT_THRESHOLD) {
    logger.error(`[CRON_ALERT] Sweep '${sweepName}' failed ${count} consecutive times:`, error);
  } else {
    logger.error(`[cron] Sweep '${sweepName}' failed:`, error);
  }
}

export function recordSweepSuccess(sweepName: string): void {
  consecutiveFailures.set(sweepName, 0);
}

export function getConsecutiveFailures(sweepName: string): number {
  return consecutiveFailures.get(sweepName) ?? 0;
}

export function resetConsecutiveFailures(): void {
  consecutiveFailures.clear();
}

export type RetentionPruneCounts = AgentRetentionCounts & {
  unlinkedUploads: number;
  deletedParentAttachments: number;
};

export type PlatformSweepsResult = {
  timestamp: string;
  sweeps: {
    offers: { status: "ok" | "error"; expired?: number; error?: string };
    plans: { status: "ok" | "error"; expired?: number; error?: string };
    stakes: { status: "ok" | "error"; settled?: number; error?: string };
    jobReviewOffers: { status: "ok" | "error"; expired?: number; offered?: number; error?: string };
    reviewOffers: { status: "ok" | "error"; expired?: number; error?: string };
    claims: { status: "ok" | "error"; released?: number; error?: string };
    securityChecks: {
      status: "ok" | "error";
      started?: number;
      reclaimed?: number;
      skipped?: number;
      assigned?: number;
      posted?: number;
      paid?: number;
      error?: string;
    };
    orphanedIssues: { status: "ok" | "error"; reopened?: number; error?: string };
    draftStructuring: {
      status: "ok" | "error";
      structured?: number;
      flagged?: number;
      skipped?: number;
      failed?: number;
      error?: string;
    };
    githubStatus: { status: "ok" | "error"; checked?: number; moved?: number; failed?: number; error?: string };
    withdrawals: { status: "ok" | "error"; checked?: number; sent?: number; waiting?: number; returned?: number; error?: string };
    deliveries: { status: "ok" | "error"; processed?: number; error?: string };
    retention: {
      status: "ok" | "error";
      pruned?: RetentionPruneCounts;
      error?: string;
    };
    searchIndex: { status: "ok" | "error"; processed?: number; failed?: number; cleaned?: number; error?: string };
  };
};

let sweepInProgress = false;

/**
 * Runs the due sweeps on schedule (#647):
 * - Offer expiry (due-date sweep)
 * - Job-review offer expiry and recovery
 * - Stale claim release (inactivity & deadline)
 * - Reopen unassigned in-progress issues without live claims or linked fixes
 * - Webhook dispatch (lease-guarded)
 * - Retention prunes (agent rows & orphaned attachments)
 *
 * Each sweep is independent, idempotent, and lease-guarded so that a failure in one
 * does not abort the others and concurrent runs never double-process rows.
 */
export async function runPlatformSweeps(): Promise<PlatformSweepsResult | { skipped: true; reason: string }> {
  if (sweepInProgress) {
    return { skipped: true, reason: "A sweep run is already in progress on this instance." };
  }
  sweepInProgress = true;
  try {
    const timestamp = new Date().toISOString();
    const result: PlatformSweepsResult = {
      timestamp,
      sweeps: {
        offers: { status: "ok" },
        plans: { status: "ok" },
        stakes: { status: "ok" },
        jobReviewOffers: { status: "ok" },
        reviewOffers: { status: "ok" },
        claims: { status: "ok" },
        securityChecks: { status: "ok" },
        orphanedIssues: { status: "ok" },
        draftStructuring: { status: "ok" },
        githubStatus: { status: "ok" },
        withdrawals: { status: "ok" },
        deliveries: { status: "ok" },
        retention: { status: "ok" },
        searchIndex: { status: "ok" },
      },
    };

    // 1. Expired Offers
    try {
      const res = await sweepExpiredOffers();
      recordSweepSuccess("offers");
      result.sweeps.offers = { status: "ok", expired: res.expired };
    } catch (err) {
      recordSweepFailure("offers", err);
      result.sweeps.offers = { status: "error", error: err instanceof Error ? err.message : String(err) };
    }

    // 1p. Plan review windows (#plan-review): awards whose plan was never submitted or never decided in time.
    try {
      const res = await sweepPlanWindows();
      recordSweepSuccess("plans");
      result.sweeps.plans = { status: "ok", expired: res.expired };
    } catch (err) {
      recordSweepFailure("plans", err);
      result.sweeps.plans = { status: "error", error: err instanceof Error ? err.message : String(err) };
    }

    // 1a. Stakes (#stakes): drops, 10-minute wins and decided contests.
    try {
      const res = await sweepStakes();
      recordSweepSuccess("stakes");
      result.sweeps.stakes = { status: "ok", settled: res.settled };
    } catch (err) {
      recordSweepFailure("stakes", err);
      result.sweeps.stakes = { status: "error", error: err instanceof Error ? err.message : String(err) };
    }

    // 1b. Job Review Offers
    try {
      const res = await sweepJobReviewOffers();
      recordSweepSuccess("jobReviewOffers");
      result.sweeps.jobReviewOffers = { status: "ok", expired: res.expired, offered: res.offered };
    } catch (err) {
      recordSweepFailure("jobReviewOffers", err);
      result.sweeps.jobReviewOffers = {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // 1c. PR Review Offers (#592)
    try {
      const res = await sweepReviewOffers();
      recordSweepSuccess("reviewOffers");
      result.sweeps.reviewOffers = { status: "ok", expired: res.expired };
    } catch (err) {
      recordSweepFailure("reviewOffers", err);
      result.sweeps.reviewOffers = {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // 2. Stale Claims
    try {
      const res = await sweepStaleClaims();
      recordSweepSuccess("claims");
      result.sweeps.claims = { status: "ok", released: res.released };
    } catch (err) {
      recordSweepFailure("claims", err);
      result.sweeps.claims = { status: "error", error: err instanceof Error ? err.message : String(err) };
    }

    // 2a. Security checks (#security-checks): start proven checks (Ziki AI splits them),
    // take back stale parts, give waiting parts to cleared agents, post finished
    // reports (Ziki AI summary) and pay the finders of unlocked findings.
    try {
      const res = await sweepSecurityChecks(prisma);
      recordSweepSuccess("securityChecks");
      result.sweeps.securityChecks = { status: "ok", ...res };
    } catch (err) {
      recordSweepFailure("securityChecks", err);
      result.sweeps.securityChecks = { status: "error", error: err instanceof Error ? err.message : String(err) };
    }

    // 2b. Issues that have no claim for the stale-claim sweep to find (#623).
    try {
      const res = await sweepOrphanedIssues();
      recordSweepSuccess("orphanedIssues");
      result.sweeps.orphanedIssues = { status: "ok", reopened: res.reopened };
    } catch (err) {
      recordSweepFailure("orphanedIssues", err);
      result.sweeps.orphanedIssues = { status: "error", error: err instanceof Error ? err.message : String(err) };
    }

    // 2c. Draft Idea Auto-Structuring (#682, #685)
    try {
      const res = await sweepUndraftedIdeas();
      recordSweepSuccess("draftStructuring");
      result.sweeps.draftStructuring = {
        status: "ok",
        structured: res.structured,
        flagged: res.flagged,
        skipped: res.skipped,
        failed: res.failed,
      };
    } catch (err) {
      recordSweepFailure("draftStructuring", err);
      result.sweeps.draftStructuring = {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // 3. GitHub status (#github-status): re-read the pull requests waiting to merge.
    try {
      const res = await refreshMergeQueue();
      recordSweepSuccess("githubStatus");
      result.sweeps.githubStatus = { status: "ok", ...res };
    } catch (err) {
      recordSweepFailure("githubStatus", err);
      result.sweeps.githubStatus = { status: "error", error: err instanceof Error ? err.message : String(err) };
    }

    // 3b. Ziks withdrawals (#ziki-coins): send again the ones Stripe wasn't ready to pay yet.
    try {
      const res = await retryPendingWithdrawals();
      recordSweepSuccess("withdrawals");
      result.sweeps.withdrawals = { status: "ok", ...res };
    } catch (err) {
      recordSweepFailure("withdrawals", err);
      result.sweeps.withdrawals = { status: "error", error: err instanceof Error ? err.message : String(err) };
    }

    // 4. Webhook Deliveries
    try {
      const processed = await dispatchDueDeliveries();
      recordSweepSuccess("deliveries");
      result.sweeps.deliveries = { status: "ok", processed };
    } catch (err) {
      recordSweepFailure("deliveries", err);
      result.sweeps.deliveries = { status: "error", error: err instanceof Error ? err.message : String(err) };
    }

    // 5. Retention Prunes
    try {
      const agentPrune = await pruneAgentRows(prisma, { sweep: true });
      const attachmentPrune = await sweepOrphanedAttachments(prisma, { sweep: true });
      recordSweepSuccess("retention");
      result.sweeps.retention = {
        status: "ok",
        pruned: {
          ...agentPrune,
          unlinkedUploads: attachmentPrune.unlinked,
          deletedParentAttachments: attachmentPrune.deletedParents,
        },
      };
    } catch (err) {
      recordSweepFailure("retention", err);
      result.sweeps.retention = { status: "error", error: err instanceof Error ? err.message : String(err) };
    }

    // 6. Typesense indexing is asynchronous; PostgreSQL writes never wait on it.
    try {
      const indexed = await processSearchOutbox(100);
      const cleaned = await pruneProcessedSearchOutbox();
      recordSweepSuccess("searchIndex");
      result.sweeps.searchIndex = { status: "ok", ...indexed, cleaned };
    } catch (err) {
      recordSweepFailure("searchIndex", err);
      result.sweeps.searchIndex = { status: "error", error: err instanceof Error ? err.message : String(err) };
    }

    logger.info("[cron] Platform sweeps finished", {
      offers: result.sweeps.offers,
      jobReviewOffers: result.sweeps.jobReviewOffers,
      reviewOffers: result.sweeps.reviewOffers,
      claims: result.sweeps.claims,
      orphanedIssues: result.sweeps.orphanedIssues,
      draftStructuring: result.sweeps.draftStructuring,
      deliveries: result.sweeps.deliveries,
      retention: result.sweeps.retention,
      searchIndex: result.sweeps.searchIndex,
    });

    return result;
  } finally {
    sweepInProgress = false;
  }
}
