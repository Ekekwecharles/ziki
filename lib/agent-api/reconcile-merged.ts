import type { Status } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { AgentContext } from "@/lib/agents/require-agent";
import { hasLevel } from "@/lib/agents/levels";
import { reviewerConflict, ReviewerNotIndependentError } from "@/lib/agents/independence";
import { deliveredClaim } from "@/lib/agent-api/merge-verdicts";
import {
  countedReviewers,
  creditedDeliveryUsers,
  finalizeResolved,
  mergeBugSelect,
} from "@/lib/agent-api/merge";
import { parsePullRequestUrl } from "@/lib/github/pull-request-url";
import { repoForPullRequest } from "@/lib/github/project-repositories";
import { prGate } from "@/lib/agent-api/pr-gate";
import { gateReport, latestPullRequestReport, pullRequestStateView, type PullRequestStateView } from "@/lib/agent-api/pull-request-report";

/**
 * A manager resolves merged work (#reconcile-merged, #pr-reports).
 *
 * The merger agent merges an accepted fix on GitHub itself, and fixes are
 * sometimes merged on GitHub outside Ziki's steps; either way the issue stays
 * where it was (In progress, Delivered, Done or Ready to Merge) until someone
 * moves it Live. An independent manager or merger agent does that through
 * `POST /issues/{id}/resolve`, once the latest report on the issue's linked
 * pull request (lib/agent-api/pull-request-report.ts, filed by an agent
 * independent of the issue) says it is merged and the default branch contains
 * it. Ziki never asks GitHub itself.
 *
 * - No report yet, or one that doesn't say whether the default branch contains
 *   it: 409 `needs_pr_report`.
 * - Merged into another branch (such as `staging`) not released yet: 409
 *   `awaiting_release`.
 * - Missing, closed or linked outside the project's repository: 409 `pr_broken`.
 * - Open: 409 `not_merged`.
 *
 * It then finishes with `finalizeResolved`: the status and its activity, the
 * claim released, solver, dispatcher and reviewer points, the `issue.accepted`
 * audit row and event. The activity and the audit row carry the pull request,
 * the merge commit, the branch and the report it relied on.
 */

/**
 * The steps where merged work can be left behind: in progress (merged before
 * it was delivered) and every step after delivery.
 */
export const RECONCILABLE_STATUSES = ["in_progress", "done", "merge"] as const satisfies readonly Status[];

/** `via` on the activity and audit row a reconcile writes. */
export const RECONCILE_VIA = "reconcile_merged";

export type ReconcileError =
  | "insufficient_level"
  | "invalid_url"
  | "not_found"
  | "already_resolved"
  | "not_independent"
  | "not_in_review"
  | "no_pull_request"
  | "pr_mismatch"
  | "needs_pr_report"
  | "awaiting_release"
  | "pr_broken"
  | "not_merged"
  | "status_changed";

export type ReconcileResult =
  | {
      status: 200;
      body: {
        resolved: true;
        reconciled: true;
        issueId: string;
        previousStatus: string;
        pullRequestUrl: string;
        mergeCommitSha: string | null;
        /** The branch the report says it was merged into. */
        mergedInto: string | null;
        /** The report the resolve relied on, with who filed it. */
        pullRequestState: PullRequestStateView;
        solverUserId: string | null;
        rewardedReviewerUserIds: string[];
      };
    }
  | { status: 403 | 404 | 409 | 422; body: { error: ReconcileError; message: string } };

const fail = (status: 403 | 404 | 409 | 422, error: ReconcileError, message: string): ReconcileResult =>
  ({ status, body: { error, message } });

/** Reconcile issue `bugId` (by id) in `scope`. `pullRequestUrl`, when given, must be the linked one. */
export async function reconcileMergedWork(
  agent: AgentContext,
  scope: { organisationId: string; projectId: string },
  bugId: string,
  pullRequestUrl?: string,
): Promise<ReconcileResult> {
  if (!hasLevel(agent.level, "manager")) {
    return fail(403, "insufficient_level", "Only a manager or merger agent can resolve merged work it isn't connected to.");
  }
  if (pullRequestUrl !== undefined && !parsePullRequestUrl(pullRequestUrl)) {
    return fail(422, "invalid_url", "That is not a GitHub pull request URL.");
  }

  const bug = await prisma.bug.findFirst({
    where: { id: bugId, organisationId: scope.organisationId, projectId: scope.projectId, isDeleted: false },
    select: mergeBugSelect,
  });
  if (!bug) return fail(404, "not_found", "No such issue in this project.");
  if (bug.status === "resolved" || bug.status === "closed") {
    return fail(409, "already_resolved", `This issue is already ${bug.status}.`);
  }

  // The same independence rule as a manager's accept (#493).
  const conflict = reviewerConflict({ id: agent.agentId, ownerUserId: agent.ownerId }, bug);
  if (conflict) return fail(403, "not_independent", new ReviewerNotIndependentError(conflict).message);

  const previousStatus = bug.status;
  if (!(RECONCILABLE_STATUSES as readonly Status[]).includes(previousStatus)) {
    return fail(409, "not_in_review", "Only in-progress, delivered, done or ready-to-merge work can be resolved with a merged pull request.");
  }
  if (!bug.pullRequestUrl) return fail(409, "no_pull_request", "This issue has no linked pull request.");
  if (pullRequestUrl !== undefined && pullRequestUrl !== bug.pullRequestUrl) {
    return fail(409, "pr_mismatch", "This issue is linked to a different pull request. Resolve it with that one.");
  }

  const report = await latestPullRequestReport(bug.id, bug.pullRequestUrl);
  const gate = prGate(gateReport(report), {
    pullRequestUrl: bug.pullRequestUrl,
    pullRequestHeadSha: bug.pullRequestHeadSha,
    repo: repoForPullRequest(bug.project, bug.pullRequestUrl),
  });
  const refusal = mergedRefusal(gate);
  if (refusal) return fail(409, refusal.error, refusal.message);
  const merged = report!;

  // Who is credited and paid: the same rules as an accept.
  const claim = deliveredClaim(bug);
  const credited = await creditedDeliveryUsers(bug, claim);
  const { reviewers, acceptedHeadSha } = await countedReviewers(bug, claim, credited);
  const solverUserId = claim?.beneficiaryUserId ?? credited[0] ?? bug.assigneeId ?? null;
  const linkedPullRequest = bug.pullRequestUrl;

  const done = await prisma.$transaction(async (tx) => {
    // Re-read inside the transaction: a reject or another resolve may have
    // moved the issue, or someone relinked it, since the read above.
    const current = await tx.bug.findUnique({ where: { id: bug.id }, select: { status: true, pullRequestUrl: true } });
    if (!current || current.status !== previousStatus || current.pullRequestUrl !== linkedPullRequest) return false;
    await finalizeResolved(tx, {
      agent,
      bug,
      claim,
      solverUserId,
      solverAgentId: bug.outsideWork?.agentId,
      rewardedReviewerUserIds: reviewers,
      acceptedHeadSha,
      mergeCommitSha: merged.mergeCommitSha,
      record: { via: RECONCILE_VIA, reconciled: true, mergedInto: merged.mergedInto, pullRequestReportId: merged.id, reportedByAgentId: merged.agentId },
      eventRecord: { via: RECONCILE_VIA, reconciled: true, mergedInto: merged.mergedInto, pullRequestReportId: merged.id },
    });
    return true;
  });
  if (!done) {
    return fail(409, "status_changed", "This issue's status or linked pull request changed while the request ran. Read it again and retry.");
  }

  return {
    status: 200,
    body: {
      resolved: true,
      reconciled: true,
      issueId: bug.id,
      previousStatus,
      pullRequestUrl: linkedPullRequest,
      mergeCommitSha: merged.mergeCommitSha,
      mergedInto: merged.mergedInto,
      pullRequestState: pullRequestStateView(merged)!,
      solverUserId,
      rewardedReviewerUserIds: reviewers,
    },
  };
}

/** Why the gate doesn't let merged work be resolved, or null when it does. */
export function mergedRefusal(gate: ReturnType<typeof prGate>): { error: "needs_pr_report" | "awaiting_release" | "pr_broken" | "not_merged"; message: string } | null {
  if (gate.canReconcile) return null;
  const reason = gate.reason ?? "The pull request isn't reported merged.";
  if (gate.awaitingRelease) return { error: "awaiting_release", message: reason };
  if (gate.broken) return { error: "pr_broken", message: reason };
  if (gate.needsReport) return { error: "needs_pr_report", message: reason };
  return { error: "not_merged", message: "The latest report says the pull request is open, not merged. Once it is merged, report it again." };
}
