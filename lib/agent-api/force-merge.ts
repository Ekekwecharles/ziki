import type { Status } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { issueIdFor } from "@/lib/issue-ref";
import { audit } from "@/lib/agents/audit";
import type { AgentContext } from "@/lib/agents/require-agent";
import { publish } from "@/lib/agent-api/events";
import { statusChangedSummary } from "@/lib/activity-log";
import { parsePullRequestUrl } from "@/lib/github/pull-request-url";
import { moveTo } from "@/lib/issue-substatus";
import { PRODUCT_STEP_ONLY_MESSAGE, trackRules } from "@/lib/marketing/track";
import { closeSupportThreadsForIssue } from "@/lib/support-threads";
import { countedReviewers, creditedDeliveryUsers, finalizeResolved, mergeBugSelect } from "@/lib/agent-api/merge";
import { deliveredClaim } from "@/lib/agent-api/merge-verdicts";
import { countedJudgements } from "@/lib/agent-api/tested-status";

/**
 * Force-merge (#force-merge). A person working locally with their own LLM may
 * merge their own pull request themself, without waiting for Ziki's steps: they
 * have full power over their code, so nothing here is gated on confirmations,
 * judgements, reviews, pull request reports or a merger. Their agent records it
 * so the work is still on Ziki: `POST /api/v1/issues/{id}/force-merge` moves
 * the issue straight to Live · Force-merged.
 *
 * Other agents then judge the merged work afterwards (test-results, counted as
 * on any delivery): enough good judgements move it On dev and pay the points
 * (`settleForceMerged`), enough not-good ones mark it Live · Broken, where it
 * takes bids for a fix like an Open issue.
 *
 * Only the agent holding the issue's claim may force-merge it: the agent of
 * the person whose work it is (the one that fast-tracked it with alreadyVetted).
 */

/** The steps a force-merge can come from: the work is held, and not yet Live. */
export const FORCE_MERGEABLE_STATUSES = ["in_progress", "done", "merge"] as const satisfies readonly Status[];

/** The body of `POST /issues/{id}/force-merge`. */
export const forceMergeBodySchema = z
  .object({
    pullRequestUrl: z.string().trim().min(1).max(2048).optional(),
    summary: z.string().trim().min(1).max(500),
    projectId: z.string().optional(),
  })
  .strict();

/** `via` on the activity and audit row a force-merge writes. */
export const FORCE_MERGE_VIA = "force_merge";

export type ForceMergeResult =
  | {
      status: 200;
      body: {
        forceMerged: true;
        issueId: string;
        previousStatus: string;
        previousSubstatus: string;
        status: "resolved";
        substatus: "force_merged";
        pullRequestUrl: string;
      };
    }
  | { status: 403 | 404 | 409 | 422; body: { error: string; message: string } };

const fail = (status: 403 | 404 | 409 | 422, error: string, message: string): ForceMergeResult => ({ status, body: { error, message } });

export async function forceMerge(
  agent: AgentContext,
  scope: { organisationId: string; projectId: string },
  issueRef: string,
  input: { pullRequestUrl?: string; summary: string },
): Promise<ForceMergeResult> {
  if (input.pullRequestUrl !== undefined && !parsePullRequestUrl(input.pullRequestUrl)) {
    return fail(422, "invalid_url", "That is not a GitHub pull request URL.");
  }

  // #457: the path may be the readable number (`123`, `ZE-123`) or the id.
  const bugId = await issueIdFor(prisma, issueRef, scope.organisationId);
  if (!bugId) return fail(404, "not_found", "No such issue in this project.");
  const bug = await prisma.bug.findFirst({
    where: { id: bugId, ...scope, isDeleted: false },
    select: {
      id: true, status: true, substatus: true, track: true, pullRequestUrl: true, isBoosted: true,
      claims: { where: { status: "active", releasedAt: null }, select: { id: true, agentId: true, beneficiaryUserId: true } },
    },
  });
  if (!bug) return fail(404, "not_found", "No such issue in this project.");
  if (!trackRules(bug.track).hasProductSteps) return fail(409, "wrong_track", PRODUCT_STEP_ONLY_MESSAGE);

  const claim = bug.claims.find((c) => c.agentId === agent.agentId);
  if (!claim) {
    return fail(403, "not_holder", "Only the agent holding this issue can force-merge it. File the local change with alreadyVetted first, so you hold it.");
  }
  if (!(FORCE_MERGEABLE_STATUSES as readonly Status[]).includes(bug.status)) {
    return fail(409, "not_force_mergeable", `This issue is ${bug.status}; only work in progress, done or in merge can be force-merged.`);
  }

  // The merged pull request: the linked one, or linked now when the work was never delivered.
  if (bug.pullRequestUrl && input.pullRequestUrl !== undefined && input.pullRequestUrl !== bug.pullRequestUrl) {
    return fail(409, "pr_mismatch", "This issue is linked to a different pull request. Force-merge it with that one.");
  }
  const pullRequestUrl = bug.pullRequestUrl ?? input.pullRequestUrl;
  if (!pullRequestUrl) return fail(409, "no_pull_request", "Send the merged pull request's URL (pullRequestUrl): this issue has none linked.");

  const moved = await prisma.$transaction(async (tx) => {
    const changed = await tx.bug.updateMany({
      where: { id: bug.id, substatus: bug.substatus, pullRequestUrl: bug.pullRequestUrl },
      data: {
        ...moveTo("force_merged"),
        pullRequestUrl,
        ...(bug.isBoosted ? { isBoosted: false, boostedAt: null } : {}),
      },
    });
    if (changed.count !== 1) return false;

    await tx.bugActivity.create({
      data: {
        bugId: bug.id,
        actorId: agent.ownerId,
        type: "status_changed",
        summary: `${statusChangedSummary(bug.substatus, "force_merged")}: merged by its author without Ziki's checks. ${input.summary}`,
        metadata: {
          field: "status", from: bug.substatus, to: "force_merged",
          via: FORCE_MERGE_VIA, agentId: agent.agentId, agentName: agent.name, pullRequestUrl, summary: input.summary,
        },
      },
    });
    // The claim the work was done under stays on record (`deliveredClaim`), so
    // the agent that did it can't judge it afterwards.
    await tx.issueClaim.update({
      where: { id: claim.id },
      data: { status: "released", releasedAt: new Date(), releaseReason: FORCE_MERGE_VIA },
    });
    await publish(tx, {
      organisationId: scope.organisationId, type: "claim.released", actorAgentId: agent.agentId, bugId: bug.id,
      payload: { claimId: claim.id, issueId: bug.id, beneficiaryUserId: claim.beneficiaryUserId, reason: FORCE_MERGE_VIA },
    });
    await closeSupportThreadsForIssue(tx, { bugId: bug.id, reason: "fix_live" });
    await audit(agent, "issue.force_merged", `bug:${bug.id}`, { from: bug.substatus, pullRequestUrl, summary: input.summary }, { bugId: bug.id, db: tx });
    await publish(tx, {
      organisationId: scope.organisationId, type: "issue.updated", actorAgentId: agent.agentId, bugId: bug.id,
      payload: {
        issueId: bug.id, projectId: scope.projectId, changed: ["status", "substatus"], values: moveTo("force_merged"),
        source: "agent", agentId: agent.agentId, via: FORCE_MERGE_VIA, pullRequestUrl,
      },
    });
    return true;
  });
  if (!moved) return fail(409, "status_changed", "This issue's status or linked pull request changed while the request ran. Read it again and retry.");

  return {
    status: 200,
    body: { forceMerged: true, issueId: bug.id, previousStatus: bug.status, previousSubstatus: bug.substatus, ...moveTo("force_merged"), pullRequestUrl },
  };
}

/**
 * After a judgement on a force-merged issue: enough good judgements (the
 * Delivered step's count, `verdictsNeeded`) move it On dev and pay the points
 * as a reviewed merge does (`finalizeResolved`); enough not-good ones mark it
 * Live · Broken, where it takes bids for a fix. Acts only on Live ·
 * Force-merged; Broken stays Broken until a fix is merged. Returns the new
 * substatus, or null when nothing changed.
 */
export async function settleForceMerged(agent: AgentContext, bugId: string): Promise<"on_dev" | "merged_broken" | null> {
  const bug = await prisma.bug.findUnique({ where: { id: bugId }, select: mergeBugSelect });
  if (!bug || bug.substatus !== "force_merged" || !bug.pullRequestUrl) return null;
  const count = await countedJudgements(prisma, bugId);
  if (!count) return null;
  const next = count.good >= count.needed ? "on_dev" : count.notGood >= count.needed ? "merged_broken" : null;
  if (!next) return null;

  if (next === "merged_broken") {
    const moved = await prisma.$transaction(async (tx) => {
      const changed = await tx.bug.updateMany({ where: { id: bug.id, substatus: "force_merged" }, data: { ...moveTo("merged_broken"), assigneeId: null } });
      if (changed.count !== 1) return false;
      await tx.bugActivity.create({
        data: {
          bugId: bug.id,
          actorId: agent.ownerId,
          type: "status_changed",
          summary: `Judgements weighing ${count.notGood} say the force-merged work is not good: marked Live · Broken, open for bids to fix it`,
          metadata: { field: "status", from: "force_merged", to: "merged_broken", via: FORCE_MERGE_VIA, good: count.good, notGood: count.notGood, needed: count.needed },
        },
      });
      await publish(tx, {
        organisationId: bug.organisationId, type: "issue.updated", actorAgentId: agent.agentId, bugId: bug.id,
        payload: { issueId: bug.id, projectId: bug.projectId, changed: ["status", "substatus"], values: moveTo("merged_broken"), via: FORCE_MERGE_VIA },
      });
      return true;
    });
    return moved ? "merged_broken" : null;
  }

  // Who is credited and paid: the same rules as an accept, on the claim the work was done under.
  const claim = deliveredClaim(bug);
  const credited = await creditedDeliveryUsers(bug, claim);
  const { reviewers, acceptedHeadSha } = await countedReviewers(bug, claim, credited);
  const solverUserId = claim?.beneficiaryUserId ?? credited[0] ?? bug.assigneeId ?? null;
  const moved = await prisma.$transaction(async (tx) => {
    const current = await tx.bug.findUnique({ where: { id: bug.id }, select: { substatus: true, pullRequestUrl: true } });
    if (!current || current.substatus !== "force_merged" || current.pullRequestUrl !== bug.pullRequestUrl) return false;
    await finalizeResolved(tx, {
      agent,
      bug,
      claim,
      solverUserId,
      rewardedReviewerUserIds: reviewers,
      acceptedHeadSha,
      mergeCommitSha: null,
      record: { via: FORCE_MERGE_VIA, judgedAfterMerge: true, good: count.good, needed: count.needed },
      eventRecord: { via: FORCE_MERGE_VIA, judgedAfterMerge: true },
    });
    return true;
  });
  return moved ? "on_dev" : null;
}
