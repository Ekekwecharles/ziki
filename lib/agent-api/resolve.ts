import { prisma } from "@/lib/prisma";
import { PRODUCT_STEP_ONLY_MESSAGE, trackRules } from "@/lib/marketing/track";
import { issueIdFor } from "@/lib/issue-ref";
import { audit } from "@/lib/agents/audit";
import type { AgentContext } from "@/lib/agents/require-agent";
import { publish } from "@/lib/agent-api/events";
import { statusChangedSummary, unboostedSummary } from "@/lib/activity-log";
import { AGENT_RESOLVE_VIA } from "@/lib/agent-resolution";
import { hasLevel } from "@/lib/agents/levels";
import { mergedRefusal, reconcileMergedWork, type ReconcileResult } from "@/lib/agent-api/reconcile-merged";
import { parsePullRequestUrl } from "@/lib/github/pull-request-url";
import { PROJECT_REPOSITORIES_SELECT, repoForPullRequest } from "@/lib/github/project-repositories";
import { prGate } from "@/lib/agent-api/pr-gate";
import { gateReport, latestPullRequestReport } from "@/lib/agent-api/pull-request-report";
import { moveTo } from "@/lib/issue-substatus";
import { reopenOriginalAfterRevert } from "@/lib/take-it-back-server";
import { closeSupportThreadsForIssue } from "@/lib/support-threads";
import { countedReviewers, creditedDeliveryUsers, finalizeResolved, mergeBugSelect } from "@/lib/agent-api/merge";
import { deliveredClaim } from "@/lib/agent-api/merge-verdicts";

/**
 * Ziki #515: any agent may resolve an issue whose fix is already merged, so a
 * fixed issue doesn't wait for a person or a merger. It covers issues such as
 * one assigned to a person, where no agent can hold a claim (#494).
 *
 * Guards: the agent's owner must be connected to the issue, and the latest
 * independent report on the linked pull request (#pr-reports: Ziki never asks
 * GitHub) must say it is merged and the default branch contains it. No points
 * are written: they still follow the review gates or a person resolving the
 * issue.
 *
 * One route, two ways in (#reconcile-merged): an agent whose owner is not
 * connected to the issue may still resolve it if it is a manager or merger
 * agent independent of the issue. That is a manager resolving merged work
 * (lib/agent-api/reconcile-merged.ts): the same report rule, more statuses
 * checked, and it pays the points.
 */

export type ResolveResult =
  | { status: 200; body: { resolved: true; issueId: string; previousStatus: string; previousSubstatus: string; status: "resolved"; substatus: "on_dev"; pullRequestUrl: string } }
  | { status: 403 | 404 | 409 | 422; body: { error: string; message: string } }
  | ReconcileResult;

const fail = (status: 403 | 404 | 409 | 422, error: string, message: string): ResolveResult =>
  ({ status, body: { error, message } });

export async function resolveMergedFix(
  agent: AgentContext,
  scope: { organisationId: string; projectId: string },
  issueRef: string,
  /** The merged pull request: must be the linked one when given. */
  requestedUrl?: string,
): Promise<ResolveResult> {
  if (requestedUrl !== undefined && !parsePullRequestUrl(requestedUrl)) {
    return fail(422, "invalid_url", "That is not a GitHub pull request URL.");
  }

  // #457: the path may be the readable number (`123`, `ZE-123`) or the id.
  const bugId = await issueIdFor(prisma, issueRef, scope.organisationId);
  if (!bugId) return fail(404, "not_found", "No such issue in this project.");
  const bug = await prisma.bug.findFirst({
    where: { id: bugId, ...scope, isDeleted: false },
    select: {
      outsideWork: { select: { agentId: true } },
      id: true, status: true, substatus: true, track: true, assigneeId: true, reporterId: true, pullRequestUrl: true, pullRequestHeadSha: true, isBoosted: true,
      project: { select: { repoUrl: true, ...PROJECT_REPOSITORIES_SELECT } },
      claims: {
        where: { status: "active", releasedAt: null },
        select: { id: true, agentId: true, beneficiaryUserId: true },
      },
    },
  });
  if (!bug) return fail(404, "not_found", "No such issue in this project.");
  if (!trackRules(bug.track).hasProductSteps) return fail(409, "wrong_track", PRODUCT_STEP_ONLY_MESSAGE);
  if (bug.status === "resolved" || bug.status === "closed") {
    return fail(409, "already_resolved", `This issue is already ${bug.status}.`);
  }

  const connected =
    bug.assigneeId === agent.ownerId ||
    bug.reporterId === agent.ownerId ||
    bug.claims.some((claim) => claim.beneficiaryUserId === agent.ownerId);
  if (!connected) {
    // A manager independent of the issue reconciles merged work instead.
    if (hasLevel(agent.level, "manager")) {
      return reconcileMergedWork(agent, scope, bugId, requestedUrl);
    }
    return fail(403, "not_connected", "Only an agent whose owner is this issue's assignee, reporter or claim holder, or an independent manager agent, can resolve it.");
  }

  // Reports are on the linked pull request, so resolving needs one: another
  // merged PR would close the issue on code nobody tied to it.
  const pullRequestUrl = bug.pullRequestUrl;
  if (!pullRequestUrl) return fail(409, "no_pull_request", "This issue has no linked pull request, so nothing can be reported merged.");
  if (requestedUrl !== undefined && requestedUrl !== pullRequestUrl) {
    return fail(409, "pr_mismatch", "This issue is linked to a different pull request. Resolve it with that one.");
  }

  const report = await latestPullRequestReport(bug.id, pullRequestUrl);
  const refusal = mergedRefusal(prGate(gateReport(report), {
    pullRequestUrl,
    pullRequestHeadSha: bug.pullRequestHeadSha,
    repo: repoForPullRequest(bug.project, pullRequestUrl),
  }));
  if (refusal || !report) return fail(409, refusal?.error ?? "needs_pr_report", refusal?.message ?? "Nobody has reported the pull request yet.");

  // An imported delivery has no claim, but resolving it must still hold the
  // ordinary solver/reviewer awards. The legacy connected-owner path below
  // deliberately pays nothing and must not swallow this delivery's payout.
  const importedBug = bug.outsideWork ? await prisma.bug.findUnique({ where: { id: bug.id }, select: mergeBugSelect }) : null;
  const importedClaim = importedBug ? deliveredClaim(importedBug) : null;
  const credited = importedBug ? await creditedDeliveryUsers(importedBug, importedClaim) : [];
  const reviewers = importedBug ? await countedReviewers(importedBug, importedClaim, credited) : null;

  const resolved = await prisma.$transaction(async (tx) => {
    // Only from the status and linked PR read above: someone may have changed
    // the status (the activity records `from`) or linked another PR since,
    // and the pr_mismatch check above only saw the old link.
    const changed = await tx.bug.updateMany({
      where: { id: bug.id, substatus: bug.substatus, pullRequestUrl: bug.pullRequestUrl },
      data: {
        // Live starts On dev; agents report where it is deployed (POST /issues/{id}/deployment).
        ...moveTo("on_dev"),
        // #256: a finished issue shouldn't stay pinned above open work.
        ...(bug.isBoosted ? { isBoosted: false, boostedAt: null } : {}),
      },
    });
    if (changed.count !== 1) return false;

    if (importedBug && reviewers) {
      await finalizeResolved(tx, {
        agent, bug: importedBug, claim: importedClaim,
        solverUserId: importedClaim?.beneficiaryUserId ?? credited[0] ?? bug.assigneeId,
        solverAgentId: bug.outsideWork?.agentId,
        rewardedReviewerUserIds: reviewers.reviewers, acceptedHeadSha: reviewers.acceptedHeadSha,
        mergeCommitSha: report.mergeCommitSha,
        record: { via: "outside_work_resolved", pullRequestReportId: report.id },
        eventRecord: { via: "outside_work_resolved" },
      });
      return true;
    }

    await closeSupportThreadsForIssue(tx, { bugId: bug.id, reason: "fix_live" });

    await tx.bugActivity.create({
      data: {
        bugId: bug.id,
        actorId: agent.ownerId,
        type: "status_changed",
        summary: statusChangedSummary(bug.substatus, "on_dev"),
        metadata: {
          field: "status", from: bug.substatus, to: "on_dev",
          via: AGENT_RESOLVE_VIA, agentId: agent.agentId, agentName: agent.name, pullRequestUrl, pullRequestReportId: report.id,
        },
      },
    });
    if (bug.isBoosted) {
      await tx.bugActivity.create({
        data: {
          bugId: bug.id, actorId: agent.ownerId, type: "unboosted",
          summary: unboostedSummary(), metadata: { field: "isBoosted", to: "false" },
        },
      });
    }
    await tx.issueClaim.updateMany({
      where: { bugId: bug.id, status: "active", releasedAt: null },
      data: { status: "released", releasedAt: new Date(), releaseReason: "resolved" },
    });
    for (const claim of bug.claims) {
      await publish(tx, {
        organisationId: scope.organisationId, type: "claim.released", actorAgentId: claim.agentId, bugId: bug.id,
        payload: { claimId: claim.id, issueId: bug.id, beneficiaryUserId: claim.beneficiaryUserId, reason: "resolved" },
      });
    }
    await audit(agent, "issue.resolved", `bug:${bug.id}`, { from: bug.substatus, pullRequestUrl, pullRequestReportId: report.id }, { bugId: bug.id, db: tx });
    await publish(tx, {
      organisationId: scope.organisationId, type: "issue.updated", actorAgentId: agent.agentId, bugId: bug.id,
      payload: {
        issueId: bug.id, projectId: scope.projectId, changed: ["status", "substatus"], values: moveTo("on_dev"),
        source: "agent", agentId: agent.agentId, pullRequestUrl,
      },
    });
    // #851: when this is a revert, the original issue returns to Open.
    await reopenOriginalAfterRevert(tx, bug.id);
    return true;
  });
  if (!resolved) return fail(409, "status_changed", "This issue's status or linked pull request changed while the request ran. Read it again and retry.");

  return { status: 200, body: { resolved: true, issueId: bug.id, previousStatus: bug.status, previousSubstatus: bug.substatus, ...moveTo("on_dev"), pullRequestUrl } };
}
