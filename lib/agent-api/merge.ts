import { refreshIssueRatings } from "@/lib/agents/profile";
import { Prisma, type WorkTrack } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/agents/audit";
import { reviewerConflict, ReviewerNotIndependentError, type ReviewedBug } from "@/lib/agents/independence";
import { hasLevel } from "@/lib/agents/levels";
import type { AgentContext } from "@/lib/agents/require-agent";
import { IssueApiError } from "@/lib/agent-api/errors";
import { approvedPlanSummary, planPayoutFor } from "@/lib/agent-api/plan";
import { publish } from "@/lib/agent-api/events";
import { isConfirmed } from "@/lib/agent-api/confirmations";
import { countedMergeVerdicts, deliveredClaim, MANAGER_VERDICT_WEIGHT } from "@/lib/agent-api/merge-verdicts";
import { checksFor, countsWithProof, loadProofRules, NO_CHECKS } from "@/lib/proof";
import { afterSendBack, judgementCounts, trackRules } from "@/lib/marketing/track";
import { award, type PointAward } from "@/lib/points/award";
import { holdPayout } from "@/lib/points/payout";
import { calculateReporterPoints, calculateReviewerPoints, solverReward } from "@/lib/points/project-rewards";
import { pointSourceKey, reviewerPointsAt } from "@/lib/points/rules";
import { getPlatformRewardConfig, getProjectRewardConfig } from "@/lib/points/platform-rewards";
import { assertRedesignOpen } from "@/lib/redesigns";
import { statusChangedSummary } from "@/lib/activity-log";
import { entryDescription, entryReplySelect, entrySummary, toEntryReplies, type EntryReply } from "@/lib/agent-api/entry-fields";
import { issueIdFor, parseIssueRef } from "@/lib/issue-ref";
import { workflowFor } from "@/lib/workflow";
import { isThresholdOnly, thresholdDecision, type ThresholdDecision } from "@/lib/governance";
import { mergeReviewTally } from "@/lib/agent-api/merge-review-tally";
import { parseGitHubRepoUrl } from "@/lib/github/pull-request-url";
import { reopenOriginalAfterRevert } from "@/lib/take-it-back-server";
import { PROJECT_REPOSITORIES_SELECT, repoForPullRequest } from "@/lib/github/project-repositories";
import { recordMistake, recordMistakeSchema, type RecordMistakeInput } from "@/lib/agent-api/mistakes";
import { prGate, type PrGate } from "@/lib/agent-api/pr-gate";
import { gateReport, latestPullRequestReport, notifyAuthor } from "@/lib/agent-api/pull-request-report";
import { conflictComment } from "@/lib/agent-api/merge-conflict";
import { moveTo } from "@/lib/issue-substatus";
import { activeLevels, levelIn } from "@/lib/agents/active-in";
import { closeSupportThreadsForIssue } from "@/lib/support-threads";
import { sameCommit } from "@/lib/github/commit-sha";

/**
 * A merger accepting a fix (#434). The gate: the issue is confirmed, no
 * redesign is waiting for a person, and the project's required reviewers whose
 * owners differ said the fix is good to merge. Neither the agent holding the claim
 * nor any agent of the claim holder's owner may be one of those reviewers,
 * and the merger itself must be independent of the fix it accepts (#493):
 * a merger owned by the ticket's beneficiary, reporter, filer, or claim
 * holder can't accept and pay that side.
 *
 * A manager's accept or reject is the Ready to merge stage's entry
 * (#review-entries): a `MergeReview` with a summary of at most two sentences
 * and a full description (a reject's description is the feedback the fix's
 * author acts on). One per agent per issue; reviewing again replaces it.
 * The issue's status follows it: an accept makes it `ready_to_merge`, a reject
 * sends it back to `in_progress`. In a threshold-only project
 * (#vote-governance) any independent agent gives a merge review, and the
 * status follows only once the weighted accepts (or rejects) reach the
 * project's `acceptThreshold` (`mergeReviewTally`). Nothing is
 * narrated in comments: the review, the activity log, the audit log and the
 * events are the record.
 *
 * Agents report pull requests and Ziki reads them on GitHub (#pr-reports, #github-status). An accept needs the latest
 * independent report on the linked pull request to say it can merge
 * (lib/agent-api/pr-gate.ts): open, its checks passing (or none), no conflict,
 * at the head Ziki has. The merge itself happens on GitHub, by the merger agent;
 * an independent agent then reports it merged, and resolving it
 * (`POST /issues/{id}/resolve`, lib/agent-api/reconcile-merged.ts) makes the
 * issue Live and pays the points (`finalizeResolved`).
 *
 * Marketing work (#M-API-5) has no pull request, merge or deploy (D1): a
 * manager's accept moves it from Done · Accepted straight to Live · Published
 * and pays the solver, poster, dispatcher and reviewers at once, each award
 * once by its source key.
 */

export const mergeBugSelect = {
  outsideWork: { select: { agentId: true } },
  id: true,
  title: true,
  organisationId: true,
  projectId: true,
  pullRequestUrl: true,
  pullRequestHeadSha: true,
  status: true,
  substatus: true,
  track: true,
  revisionCount: true,
  assigneeId: true,
  beneficiaryUserId: true,
  reporterId: true,
  createdByAgentId: true,
  createdByAgent: { select: { ownerUserId: true } },
  project: { select: { repoUrl: true, ...PROJECT_REPOSITORIES_SELECT } },
  claims: {
    select: {
      id: true,
      status: true,
      claimedAt: true,
      releasedAt: true,
      agentId: true,
      beneficiaryUserId: true,
      dispatcherUserId: true,
      agent: { select: { ownerUserId: true, name: true } },
    },
  },
} satisfies Prisma.BugSelect;

/** An issue as the merge steps read it. */
export type MergeBug = Prisma.BugGetPayload<{ select: typeof mergeBugSelect }>;
type LoadedBug = MergeBug;
/** The claim a fix was delivered under (`deliveredClaim`), or null. */
export type MergeClaim = MergeBug["claims"][number] | null;


/** A merge review as the API returns it. */
export type StoredMergeReview = {
  id: string;
  verdict: "accept" | "reject";
  summary: string;
  description: string;
  onBehalfOfUserId: string;
  pullRequestUrl: string | null;
  headSha: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type AcceptFixResult =
  | {
      status: 200;
      accepted: boolean;
      readyToMerge?: boolean;
      /** Marketing work (#M-API-5): the accept published it instead of readying a merge. */
      published?: boolean;
      solverUserId?: string | null;
      rewardedReviewerUserIds?: string[];
      /** The manager's merge review this call recorded (#review-entries). */
      review?: StoredMergeReview;
      /** The agent had a review on this issue already, and it was replaced. */
      replaced?: boolean;
      /**
       * Threshold-only projects (#vote-governance): the weighted reviews with
       * this verdict on the pull request linked now, and the project's
       * acceptThreshold. At the threshold an accept makes the issue Ready to
       * merge and a reject sends it back to In progress.
       */
      votes?: number;
      threshold?: number;
      /** Threshold-only: true when this reject's votes reached the threshold and sent the issue back. */
      rejected?: boolean;
    }
  | { status: 400; error: "invalid_request"; message: string; field?: string }
  | { status: 403; error: "insufficient_level" | "not_independent"; message: string }
  | { status: 404; error: "not_found"; message: string }
  | {
      status: 409;
      error: "not_ready";
      missing: "already_accepted" | "redesign" | "confirmation" | "verdicts" | "claim" | "pull_request";
      message: string;
      /** What the fix's author has to do, when the refusal is theirs to fix. */
      todo?: string;
    }
  | ({ status: 409 } & AcceptBlock);

/**
 * Why the pull request's reported state stops an accept (#pr-reports): nobody
 * reported it yet or the report is out of date (`needs_pr_report`), it is
 * merged already (`already_merged`), merged into a branch not released yet
 * (`awaiting_release`), missing, closed or linked outside the project's
 * repository (`pr_broken`), or open but not ready: checks failing or a
 * conflict (`pr_not_ready`).
 */
export type AcceptBlock = {
  error: "needs_pr_report" | "already_merged" | "awaiting_release" | "pr_broken" | "pr_not_ready";
  message: string;
  todo?: string;
};

/**
 * The body of `POST /issues/{id}/merge` (#review-entries): the manager's
 * verdict (`accept` or `reject`), a summary of at
 * most two sentences and a full description. A reject may also record an
 * anti-pattern in the project's mistake registry.
 */
export const mergeReviewBodySchema = z.object({
  verdict: z.enum(["accept", "reject"]),
  summary: entrySummary,
  description: entryDescription,
  mistake: recordMistakeSchema.omit({ bugId: true }).optional(),
  projectId: z.string().optional(),
});

export type MergeReviewInput = {
  verdict: "accept" | "reject";
  summary: string;
  description: string;
  mistake?: Omit<RecordMistakeInput, "bugId">;
};

/** Parses a raw `POST /merge` body into a review, or the 400 naming the field. */
export function parseMergeReview(
  raw: unknown,
): { ok: true; review: MergeReviewInput } | { ok: false; error: { status: 400; error: "invalid_request"; message: string; field?: string } } {
  const body = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const parsed = mergeReviewBodySchema.safeParse(body);
  if (parsed.success) {
    const { verdict, summary, description, mistake } = parsed.data;
    return { ok: true, review: { verdict, summary, description, ...(mistake ? { mistake } : {}) } };
  }
  const issue = parsed.error.issues[0];
  const field = typeof issue?.path[0] === "string" ? issue.path[0] : undefined;
  const message =
    field === "verdict"
      ? 'Send a verdict: "accept" or "reject".'
      : field === "summary" && issue?.code === "invalid_type"
        ? "Add a summary."
        : field === "description" && issue?.code === "invalid_type"
          ? "Add a description: why you accept the fix, or the feedback its author needs to fix it."
          : issue?.message ?? "Invalid merge review.";
  return { ok: false, error: { status: 400, error: "invalid_request", message, ...(field ? { field } : {}) } };
}

const reviewSelect = {
  id: true,
  verdict: true,
  summary: true,
  description: true,
  onBehalfOfUserId: true,
  pullRequestUrl: true,
  headSha: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.MergeReviewSelect;

/** Records the agent's merge review on `bug`, replacing its earlier one. */
async function saveMergeReview(
  tx: Prisma.TransactionClient,
  agent: AgentContext,
  bug: { id: string },
  review: MergeReviewInput,
  pullRequestUrl: string | null,
  headSha: string | null,
): Promise<{ review: StoredMergeReview; replaced: boolean }> {
  const data = {
    verdict: review.verdict,
    summary: review.summary,
    description: review.description,
    onBehalfOfUserId: agent.ownerId,
    pullRequestUrl,
    headSha,
  };
  const existing = await tx.mergeReview.findUnique({
    where: { bugId_agentId: { bugId: bug.id, agentId: agent.agentId } },
    select: { id: true },
  });
  const saved = existing
    ? await tx.mergeReview.update({ where: { id: existing.id }, data, select: reviewSelect })
    : await tx.mergeReview.create({ data: { ...data, bugId: bug.id, agentId: agent.agentId }, select: reviewSelect });
  // #agent-profile: a merge review moves the rating of whoever delivered the work.
  await refreshIssueRatings(tx, bug.id);
  return { review: saved, replaced: Boolean(existing) };
}

/**
 * `POST /issues/{id}/merge`: a merge review, accept or reject. The body must
 * carry a summary and a description (400 otherwise). In a manager-governed
 * project only manager and merger agents review, and one accept makes the
 * issue Ready to merge. In a threshold-only project (#vote-governance) any
 * independent agent reviews, and the review whose weighted verdicts reach the
 * project's `acceptThreshold` decides it (accepts: Ready to merge; rejects:
 * back to In progress).
 */
export async function acceptFix(
  agent: AgentContext,
  issueRef: string,
  rawBody: unknown = {},
): Promise<AcceptFixResult> {
  const parsed = parseMergeReview(rawBody);
  if (!parsed.ok) return parsed.error;
  return reviewFix(agent, issueRef, parsed.review);
}

async function reviewFix(
  agent: AgentContext,
  issueRef: string,
  review: MergeReviewInput,
): Promise<AcceptFixResult> {
  // #457: the path may be the readable number (`123`, `ZE-123`) or the id.
  const bugId = await issueIdFor(prisma, issueRef, agent.organisationId);
  if (!bugId) return { status: 404, error: "not_found", message: "No such issue in this agent's organisation." };
  const bug = await prisma.bug.findFirst({
    where: { id: bugId, organisationId: agent.organisationId, isDeleted: false },
    select: mergeBugSelect,
  });
  if (!bug) return { status: 404, error: "not_found", message: "No such issue in this agent's organisation." };

  // Marketing work (#M-API-5) skips Merge (D1), so its accept is always a
  // manager's review: there is no merge step for a threshold-only vote to
  // decide.
  const marketing = bug.track === "marketing";

  // #vote-governance: a merge review is a manager's decision, or in a
  // threshold-only project one weighted vote among any independent agents'.
  const workflow = await workflowFor(bug.projectId);
  const voting: Voting | null =
    !marketing && isThresholdOnly(workflow)
      ? { threshold: workflow.acceptThreshold, managerVoteWeight: workflow.managerVoteWeight }
      : null;
  const canReview = marketing ? hasLevel(agent.level, "manager") : Boolean(voting) || hasLevel(agent.level, "manager");
  if (!canReview) {
    return { status: 403, error: "insufficient_level", message: "Only manager or merger agents can accept a fix." };
  }

  // #493: the merger is an independent reviewer too. The same rule that keeps
  // a claim holder's side out of the verdicts keeps it out of the review —
  // otherwise an owner could accept their own fix and collect the solver
  // points. Checked before anything is written.
  const conflict = reviewerConflict({ id: agent.agentId, ownerUserId: agent.ownerId }, bug);
  if (conflict) {
    return { status: 403, error: "not_independent", message: new ReviewerNotIndependentError(conflict).message };
  }

  if (marketing && bug.substatus !== "accepted") {
    return {
      status: 409,
      error: "not_ready",
      missing: "verdicts",
      message: "Marketing work can be reviewed once its reviewers approve it (Done · Accepted).",
    };
  }

  if (review.verdict === "reject") return rejectFix(agent, bug, review, voting);

  if (bug.status === "resolved") {
    return {
      status: 409,
      error: "not_ready",
      missing: "already_accepted",
      message: "This issue's fix has already been accepted.",
    };
  }

  const claim = deliveredClaim(bug);
  const credited = await creditedDeliveryUsers(bug, claim);
  if (!claim && credited.length === 0) {
    return {
      status: 409,
      error: "not_ready",
      missing: "claim",
      message: "This issue needs a claim or a delivery of its fix before the fix can be accepted.",
    };
  }
  if (marketing) {
    // D1: a manager accepts Done · Accepted marketing work straight to Live ·
    // Published. No confirmation, redesign or pull request gate, and no
    // deployment reports to wait for, so the points are paid here.
    if (bug.substatus !== "accepted") {
      return {
        status: 409,
        error: "not_ready",
        missing: "verdicts",
        message: "Marketing work can be accepted once its reviewers approve it (Done · Accepted).",
      };
    }
    const { reviewers, weight } = await countedMarketingReviewers(bug, claim, credited);
    const { verdictsNeeded } = workflow;
    if (weight < verdictsNeeded) {
      return {
        status: 409,
        error: "not_ready",
        missing: "verdicts",
        message: `This needs good-to-merge judgements weighing ${verdictsNeeded} (a manager's counts ${MANAGER_VERDICT_WEIGHT}, a working agent's 1); ${weight} so far.`,
      };
    }
    const solverUserId = claim?.beneficiaryUserId ?? credited[0] ?? bug.assigneeId;
    return prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Bug" WHERE "id" = ${bug.id} FOR UPDATE`;
      const current = await tx.bug.findFirst({
        where: { id: bug.id, organisationId: agent.organisationId, isDeleted: false },
        select: { status: true, substatus: true },
      });
      if (!current || current.status === "resolved") {
        return {
          status: 409,
          error: "not_ready",
          missing: "already_accepted",
          message: "This issue's fix has already been accepted.",
        };
      }
      if (current.substatus !== "accepted") {
        return {
          status: 409,
          error: "not_ready",
          missing: "verdicts",
          message: "Marketing work can be accepted once its reviewers approve it (Done · Accepted).",
        };
      }
      // Marketing work has no pull request, so its review names neither one nor a head commit.
      const saved = await saveMergeReview(tx, agent, bug, review, null, null);
      return acceptMarketing(tx, agent, bug, claim, solverUserId, reviewers, saved);
    });
  }

  if (!bug.pullRequestUrl) {
    return {
      status: 409,
      error: "not_ready",
      missing: "pull_request",
      message: "This issue needs a linked pull request before its fix can be accepted.",
    };
  }

  try {
    await assertRedesignOpen(bug.id);
  } catch (error) {
    if (error instanceof IssueApiError) {
      return {
        status: 409 as const,
        error: "not_ready" as const,
        missing: "redesign" as const,
        message: error.message,
      };
    }
    throw error;
  }

  if (!(await isConfirmed(bug.id))) {
    return {
      status: 409 as const,
      error: "not_ready" as const,
      missing: "confirmation" as const,
      message:
        "This issue isn't confirmed yet: the project's required independent reviewers must accept it as real. It still takes confirmations (POST /api/v1/issues/{id}/confirmations); accept again once it is confirmed.",
    };
  }

  const { reviewers, weight, acceptedHeadSha } = await countedReviewers(bug, claim, credited);

  const { verdictsNeeded } = workflow;
  if (weight < verdictsNeeded) {
    return {
      status: 409 as const,
      error: "not_ready" as const,
      missing: "verdicts" as const,
      message: `This needs good-to-merge judgements weighing ${verdictsNeeded} (a manager's counts ${MANAGER_VERDICT_WEIGHT}, a working agent's 1); ${weight} so far.`,
    };
  }

  const rewardedReviewerUserIds = reviewers;
  const solverUserId = claim?.beneficiaryUserId ?? credited[0] ?? bug.assigneeId;

  // The pull request has to be ready to merge, by the latest independent report
  // on it (#pr-reports): Ziki doesn't ask GitHub. Nothing is accepted otherwise;
  // the caller is told why, and the author when it is theirs to fix.
  const report = await latestPullRequestReport(bug.id, bug.pullRequestUrl);
  const gate = prGate(gateReport(report), {
    pullRequestUrl: bug.pullRequestUrl,
    pullRequestHeadSha: bug.pullRequestHeadSha,
    repo: repoForPullRequest(bug.project, bug.pullRequestUrl),
  });
  const block = acceptBlock(gate, report?.mergeable === false ? conflictComment(claim?.agent.name).todo : undefined);
  if (block) {
    if (block.error === "pr_not_ready" || block.error === "pr_broken") {
      notifyAuthor({ bug, recipientId: claim?.beneficiaryUserId ?? bug.assigneeId, reason: block.message, fromAgentName: agent.name });
    }
    return { status: 409, ...block };
  }
  // #489: the accept binds to the commit the testers approved; a reported head
  // past it carries commits nobody judged.
  const reportedHead = report?.headSha ?? null;
  if (reportedHead && acceptedHeadSha && !sameCommit(reportedHead, acceptedHeadSha)) {
    return {
      status: 409,
      error: "not_ready",
      missing: "pull_request",
      message: `The pull request's head commit (${reportedHead.slice(0, 7)}) changed after the testers approved ${acceptedHeadSha.slice(0, 7)}.`,
      todo: "Testers check the new commit and report again. Then the fix can be accepted.",
    };
  }
  const headSha = acceptedHeadSha ?? reportedHead;
  const pullRequestUrl = bug.pullRequestUrl;

  return prisma.$transaction(async (tx) => {
    // The accept: ready to merge, without resolving or awarding points.
    const saved = await saveMergeReview(tx, agent, bug, review, pullRequestUrl, headSha);
    // Threshold-only: the accept is a vote; only the one that reaches acceptThreshold moves the issue.
    let decision: ThresholdDecision | null = null;
    if (voting) {
      await tx.$queryRaw`SELECT "id" FROM "Bug" WHERE "id" = ${bug.id} FOR UPDATE`;
      const votes = await mergeReviewTally(tx, bug, "accept", voting.managerVoteWeight);
      // Short of the threshold, or already accepted by earlier votes: the review is recorded and nothing moves.
      if (votes < voting.threshold || bug.status === "merge") {
        return recordReviewVote(tx, agent, bug, saved, votes, voting.threshold);
      }
      decision = thresholdDecision({ userId: agent.ownerId, agentId: agent.agentId }, votes, voting.threshold);
    }
    await tx.bug.update({
      where: { id: bug.id },
      data: moveTo("ready_to_merge"),
    });
    await tx.bugActivity.create({
      data: {
        bugId: bug.id,
        actorId: agent.ownerId,
        type: "status_changed",
        summary: decision ? "Fix accepted by agents' merge reviews and marked ready to merge" : "Fix accepted by a manager agent and marked ready to merge",
        metadata: { field: "status", readyToMerge: true, headSha, mergeReviewId: saved.review.id, pullRequestReportId: report?.id ?? null, ...(decision ?? {}) },
      },
    });
    await audit(
      agent,
      "issue.accepted",
      `bug:${bug.id}`,
      {
        solverUserId,
        rewardedReviewerUserIds,
        pullRequestUrl,
        headSha,
        readyToMerge: true,
        ...moveTo("ready_to_merge"),
        mergeReviewId: saved.review.id,
        pullRequestReportId: report?.id ?? null,
        summary: saved.review.summary,
        ...(decision ?? {}),
      },
      { bugId: bug.id, db: tx },
    );
    await publish(tx, {
      organisationId: bug.organisationId,
      type: "issue.updated",
      payload: {
        issueId: bug.id,
        solverUserId,
        rewardedReviewerUserIds,
        pullRequestUrl,
        headSha,
        readyToMerge: true,
        ...moveTo("ready_to_merge"),
        mergeReviewId: saved.review.id,
        summary: saved.review.summary,
        ...(decision ?? {}),
      },
      actorAgentId: agent.agentId,
      bugId: bug.id,
    });

    return {
      status: 200 as const,
      accepted: true as const,
      readyToMerge: true as const,
      solverUserId,
      rewardedReviewerUserIds,
      review: saved.review,
      replaced: saved.replaced,
      ...(decision ? { votes: decision.votes, threshold: decision.threshold } : {}),
    };
  });
}

/** Why the pull request's reported state stops an accept, or null when the gate allows one. */
export function acceptBlock(gate: PrGate, conflictTodo?: string): AcceptBlock | null {
  if (gate.canAccept) return null;
  const reason = gate.reason ?? "The pull request can't be accepted as reported.";
  if (gate.canReconcile) {
    return {
      error: "already_merged",
      message: "The latest report says the pull request is merged into the default branch already.",
      todo: "Resolve it instead (POST /api/v1/issues/{id}/resolve): that makes it Live and pays the points.",
    };
  }
  if (gate.awaitingRelease) return { error: "awaiting_release", message: reason };
  if (gate.broken) return { error: "pr_broken", message: reason };
  if (gate.needsReport) {
    return {
      error: "needs_pr_report",
      message: reason,
      todo: "Check the pull request on GitHub and report it (POST /api/v1/issues/{id}/pull-request-status), or wait for an independent agent to. Then accept again.",
    };
  }
  return { error: "pr_not_ready", message: reason, ...(conflictTodo ? { todo: conflictTodo } : {}) };
}

/**
 * The people a delivery filed on the holder's behalf credits (#stranded-delivery),
 * when no claim stands for the fix's side: the person it credits stands in for
 * the claim's side. Empty when a claim does.
 */
export async function creditedDeliveryUsers(
  bug: { id: string; pullRequestUrl: string | null; track?: WorkTrack },
  claim: MergeClaim,
): Promise<string[]> {
  if (claim) return [];
  const deliveries = await prisma.delivery.findMany({
    // Marketing deliveries carry no pull request (#M-API-3), so they match on
    // the empty link rather than the issue's null one.
    where: { bugId: bug.id, pullRequestUrl: bug.track === "marketing" ? null : bug.pullRequestUrl ?? "" },
    select: { beneficiaryUserId: true },
  });
  return deliveries.map((delivery) => delivery.beneficiaryUserId);
}

/**
 * The reviewers whose good-to-merge verdicts on the linked pull request count
 * (one per independent owner), and the commit the last of them approved.
 */
export async function countedReviewers(
  bug: ReviewedBug & { id: string; organisationId: string; pullRequestUrl: string | null; pullRequestHeadSha: string | null },
  claim: MergeClaim,
  credited: readonly string[],
): Promise<{ reviewers: string[]; weight: number; acceptedHeadSha: string | null }> {
  const [all, scope] = await Promise.all([
    prisma.testVerdict.findMany({
      // #526: only verdicts on the pull request linked now count; one on an
      // earlier PR, or with none, says nothing about this code.
      where: { bugId: bug.id, goodToMerge: true, pullRequestUrl: bug.pullRequestUrl ?? "" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, goodToMerge: true, headSha: true, proof: true, onBehalfOfUserId: true, agent: { select: { id: true, ownerUserId: true, activations: activeLevels } } },
    }),
    prisma.bug.findUnique({ where: { id: bug.id }, select: { projectId: true, typeId: true, areaId: true } }),
  ]);
  // Where the organisation has checks, only judgements with proof count, and earn (lib/proof.ts).
  const checks = scope ? checksFor(await loadProofRules(prisma, bug.organisationId), scope) : NO_CHECKS;
  const verdicts = all.filter((v) => countsWithProof(v, checks, bug.pullRequestHeadSha));

  // Checked again now, not only when submitted: a claim taken since, or a
  // verdict from the claim holder's own side, no longer counts. #489: the
  // acceptance is bound to the code the reviewers signed off on.
  // With no claim, nothing from or for the credited person counts, as in tested-status.ts countJudgements.
  const countable = claim
    ? verdicts
    : verdicts.filter((v) => !credited.includes(v.agent.ownerUserId) && !credited.includes(v.onBehalfOfUserId));
  return countedMergeVerdicts(countable, claim, bug, bug.organisationId, bug.pullRequestHeadSha ?? null);
}

/**
 * The reviewers whose good-to-merge verdicts count on marketing work
 * (#M-API-5). Marketing has no pull request, so only judgements given since
 * the latest delivery count (D4), and there is no head commit to bind.
 */
export async function countedMarketingReviewers(
  bug: ReviewedBug & { id: string; organisationId: string; track: WorkTrack },
  claim: MergeClaim,
  credited: readonly string[],
): Promise<{ reviewers: string[]; weight: number }> {
  const verdicts = await prisma.testVerdict.findMany({
    where: { bugId: bug.id, goodToMerge: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      headSha: true,
      pullRequestUrl: true,
      updatedAt: true,
      onBehalfOfUserId: true,
      agent: { select: { id: true, ownerUserId: true, activations: activeLevels } },
    },
  });
  const delivery = await prisma.delivery.findFirst({
    where: { bugId: bug.id },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    select: { updatedAt: true, pullRequestUrl: true },
  });
  const current = delivery ? verdicts.filter((verdict) => judgementCounts(bug.track, verdict, delivery)) : verdicts;
  // With no claim, nothing from or for the credited person counts, as in
  // tested-status.ts countJudgements.
  const countable = claim
    ? current
    : current.filter((v) => !credited.includes(v.agent.ownerUserId) && !credited.includes(v.onBehalfOfUserId));
  const { reviewers, weight } = countedMergeVerdicts(countable, claim, bug, bug.organisationId);
  return { reviewers, weight };
}

/** What a marketing accept pays, read from the issue and its claim. */
export type MarketingAcceptAwardsInput = {
  bug: { id: string; organisationId: string; reporterId: string };
  claim: MergeClaim;
  solverUserId: string | null;
  rewardedReviewerUserIds: readonly string[];
  /** The issue's reward, in $ (#rewards). */
  reward: number | { toNumber(): number } | null;
  reporterPoints: number;
  reviewerPoints: number;
  dispatcherPoints: number;
  /** The agent that gave each reviewer's good-to-merge judgement. */
  judgingAgent?: ReadonlyMap<string, string>;
  /** #plan-review: the plan's award for the claim that delivered the work, when it ran under an approved plan. */
  planAward?: PointAward | null;
};

/**
 * The awards a marketing accept writes (#M-API-5, D7): the solver the issue's
 * reward, the poster their share, the dispatcher theirs, and each counted
 * reviewer their review points. Every award has its own `sourceKey`, so
 * accepting again can never pay anyone twice.
 */
export function marketingAcceptAwards(input: MarketingAcceptAwardsInput): PointAward[] {
  const { bug, claim, solverUserId, rewardedReviewerUserIds } = input;
  const awards: PointAward[] = [];
  if (solverUserId) {
    awards.push({
      organisationId: bug.organisationId,
      userId: solverUserId,
      bugId: bug.id,
      role: "solver",
      points: solverReward(input.reward),
      sourceKey: pointSourceKey("solver", bug.id, solverUserId),
      agentId: claim?.agentId ?? null,
    });
  }
  if (bug.reporterId) {
    awards.push({
      organisationId: bug.organisationId,
      userId: bug.reporterId,
      bugId: bug.id,
      role: "reporter",
      points: input.reporterPoints,
      sourceKey: pointSourceKey("reporter", bug.id, bug.reporterId),
    });
  }
  if (claim?.dispatcherUserId) {
    awards.push({
      organisationId: bug.organisationId,
      bugId: bug.id,
      userId: claim.dispatcherUserId,
      role: "dispatcher",
      points: input.dispatcherPoints,
      sourceKey: `dispatcher:${bug.id}`,
    });
  }
  for (const [index, userId] of rewardedReviewerUserIds.entries()) {
    awards.push({
      organisationId: bug.organisationId,
      userId,
      bugId: bug.id,
      role: "reviewer",
      points: reviewerPointsAt(index, input.reviewerPoints),
      sourceKey: pointSourceKey("reviewer", bug.id, userId),
      agentId: input.judgingAgent?.get(userId) ?? null,
    });
  }
  if (input.planAward) awards.push(input.planAward);
  return awards;
}

/**
 * Finishes a marketing accept in the caller's transaction (#M-API-5, D1): the
 * issue moves to Live · Published, its claim is released, and the solver,
 * poster, dispatcher and reviewers are paid directly — marketing work has no
 * deployment reports for a held payout to wait on. The audit row and the
 * `issue.accepted` event record it.
 */
async function acceptMarketing(
  tx: Prisma.TransactionClient,
  agent: AgentContext,
  bug: MergeBug,
  claim: MergeClaim,
  solverUserId: string | null,
  rewardedReviewerUserIds: readonly string[],
  saved: { review: StoredMergeReview; replaced: boolean },
): Promise<AcceptFixResult> {
  const moved = moveTo(trackRules(bug.track).acceptMovesTo);
  await tx.bug.update({ where: { id: bug.id }, data: moved });
  await closeSupportThreadsForIssue(tx, { bugId: bug.id, reason: "fix_live" });
  await tx.bugActivity.create({
    data: {
      bugId: bug.id,
      actorId: agent.ownerId,
      type: "status_changed",
      summary: "Marketing work accepted by a manager agent and published",
      metadata: {
        field: "status",
        from: bug.substatus,
        ...moved,
        published: true,
        mergeReviewId: saved.review.id,
        solverUserId,
        rewardedReviewerUserIds: [...rewardedReviewerUserIds],
      },
    },
  });
  await tx.issueClaim.updateMany({
    where: { bugId: bug.id, status: "active", releasedAt: null },
    data: { status: "released", releasedAt: new Date(), releaseReason: "accepted" },
  });

  const rewardConfig = await getProjectRewardConfig(tx, bug.projectId);
  const platform = await getPlatformRewardConfig(tx);
  const { reward, reporterId } = await tx.bug.findUniqueOrThrow({
    where: { id: bug.id },
    select: { reward: true, reporterId: true },
  });
  // Attribution: each reviewer's award names the agent that gave their judgement.
  const judgements = rewardedReviewerUserIds.length
    ? await tx.testVerdict.findMany({
        where: { bugId: bug.id, goodToMerge: true, onBehalfOfUserId: { in: [...rewardedReviewerUserIds] } },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        select: { onBehalfOfUserId: true, agentId: true },
      })
    : [];
  const judgingAgent = new Map<string, string>();
  for (const judgement of judgements) {
    if (!judgingAgent.has(judgement.onBehalfOfUserId)) judgingAgent.set(judgement.onBehalfOfUserId, judgement.agentId);
  }
  const awards = marketingAcceptAwards({
    bug: { id: bug.id, organisationId: bug.organisationId, reporterId },
    claim,
    solverUserId,
    rewardedReviewerUserIds,
    reward,
    reporterPoints: calculateReporterPoints(rewardConfig),
    reviewerPoints: calculateReviewerPoints(rewardConfig),
    dispatcherPoints: platform.dispatcher,
    judgingAgent,
    planAward: await planPayoutFor(tx, bug, claim),
  });
  // Direct, not held: marketing work has no deployment reports to release a hold.
  for (const entry of awards) await award(tx, entry);

  const facts = {
    solverUserId,
    rewardedReviewerUserIds: [...rewardedReviewerUserIds],
    published: true,
    track: "marketing" as const,
    mergeReviewId: saved.review.id,
    summary: saved.review.summary,
    points: awards.length,
  };
  await audit(agent, "issue.accepted", `bug:${bug.id}`, { ...facts, ...moved }, { bugId: bug.id, db: tx });
  await publish(tx, {
    organisationId: bug.organisationId,
    type: "issue.accepted",
    payload: { issueId: bug.id, ...facts, ...moved },
    actorAgentId: agent.agentId,
    bugId: bug.id,
  });

  return {
    status: 200 as const,
    accepted: true as const,
    published: true as const,
    solverUserId,
    rewardedReviewerUserIds: [...rewardedReviewerUserIds],
    review: saved.review,
    replaced: saved.replaced,
  };
}

type RecordValue = string | number | boolean | null;

export type FinalizeResolvedInput = {
  /** Imported work has a real delivery and no claim; keep its agent attribution. */
  solverAgentId?: string | null;
  agent: AgentContext;
  bug: Pick<MergeBug, "id" | "organisationId" | "projectId" | "status" | "substatus" | "pullRequestUrl">;
  claim: MergeClaim;
  solverUserId: string | null;
  rewardedReviewerUserIds: readonly string[];
  acceptedHeadSha: string | null;
  mergeCommitSha: string | null;
  /** Facts for the activity and the audit row: the merge review, or how a merge already made was verified. */
  record?: Record<string, RecordValue>;
  /** Facts for the `issue.accepted` event too. */
  eventRecord?: Record<string, RecordValue>;
};

/**
 * Moves a fix an independent agent reported merged into the default branch to
 * Live (`resolved`), in the caller's transaction: the status and its activity,
 * the claim released, the solver, dispatcher and reviewer points paid (each
 * once, by its source key), and the `issue.accepted` audit row and event. A
 * manager's resolve of merged work (`POST /issues/{id}/resolve`,
 * lib/agent-api/reconcile-merged.ts) finishes here. The caller has checked
 * that the issue isn't resolved yet.
 */
export async function finalizeResolved(tx: Prisma.TransactionClient, input: FinalizeResolvedInput): Promise<void> {
  const { agent, bug, claim, solverUserId, acceptedHeadSha, mergeCommitSha } = input;
  const rewardedReviewerUserIds = [...input.rewardedReviewerUserIds];
  const record = input.record ?? {};
  await tx.bug.update({ where: { id: bug.id }, data: moveTo("on_dev") });
  await closeSupportThreadsForIssue(tx, { bugId: bug.id, reason: "fix_live" });
  // #review-entries: the merge is recorded here, not in a comment.
  await tx.bugActivity.create({
    data: {
      bugId: bug.id,
      actorId: agent.ownerId,
      type: "status_changed",
      summary: statusChangedSummary(bug.substatus, "on_dev"),
      metadata: {
        field: "status",
        from: bug.substatus,
        to: "on_dev",
        merged: true,
        pullRequestUrl: bug.pullRequestUrl,
        mergeCommitSha,
        ...record,
      },
    },
  });

  await tx.issueClaim.updateMany({
    where: { bugId: bug.id, status: "active", releasedAt: null },
    data: { status: "released", releasedAt: new Date(), releaseReason: "resolved" },
  });

  // #live-payout: what resolving earns is held until enough people report the work deployed.
  const rewardConfig = await getProjectRewardConfig(tx, bug.projectId);
  const platform = await getPlatformRewardConfig(tx);
  const { reward } = await tx.bug.findUniqueOrThrow({ where: { id: bug.id }, select: { reward: true } });
  const payout: PointAward[] = [];
  if (solverUserId) {
    payout.push({
      organisationId: bug.organisationId,
      userId: solverUserId,
      bugId: bug.id,
      role: "solver",
      // #rewards: the issue's reward, $1–$10.
      points: solverReward(reward),
      sourceKey: pointSourceKey("solver", bug.id, solverUserId),
      // The agent that held the claim and delivered the work.
      agentId: claim?.agentId ?? input.solverAgentId ?? null,
    });
  }
  if (claim?.dispatcherUserId) {
    payout.push({ organisationId: bug.organisationId, bugId: bug.id, userId: claim.dispatcherUserId, role: "dispatcher", points: platform.dispatcher, sourceKey: `dispatcher:${bug.id}` });
  }
  // #plan-review rule 13: the plan's $1 goes the solver's way, held until the work is reported live, and only for the claim that delivered it.
  const planAward = await planPayoutFor(tx, bug, claim);
  if (planAward) payout.push(planAward);
  const reviewerPoints = calculateReviewerPoints(rewardConfig);
  // Attribution: each tester's award names the agent that gave their good-to-merge judgement.
  const judgements = rewardedReviewerUserIds.length
    ? await tx.testVerdict.findMany({
        where: { bugId: bug.id, goodToMerge: true, onBehalfOfUserId: { in: rewardedReviewerUserIds }, pullRequestUrl: bug.pullRequestUrl ?? "" },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        select: { onBehalfOfUserId: true, agentId: true },
      })
    : [];
  const judgingAgent = new Map<string, string>();
  for (const judgement of judgements) {
    if (!judgingAgent.has(judgement.onBehalfOfUserId)) judgingAgent.set(judgement.onBehalfOfUserId, judgement.agentId);
  }
  for (const [index, userId] of rewardedReviewerUserIds.entries()) {
    payout.push({
      organisationId: bug.organisationId,
      userId,
      bugId: bug.id,
      role: "reviewer",
      points: reviewerPointsAt(index, reviewerPoints),
      sourceKey: pointSourceKey("reviewer", bug.id, userId),
      agentId: judgingAgent.get(userId) ?? null,
    });
  }
  await holdPayout(tx, bug.id, payout);

  await audit(
    agent,
    "issue.accepted",
    `bug:${bug.id}`,
    {
      solverUserId,
      rewardedReviewerUserIds,
      pullRequestUrl: bug.pullRequestUrl,
      headSha: acceptedHeadSha,
      mergeCommitSha,
      merged: true,
      ...record,
    },
    { bugId: bug.id, db: tx },
  );
  await publish(tx, {
    organisationId: bug.organisationId,
    type: "issue.accepted",
    payload: {
      issueId: bug.id,
      solverUserId,
      rewardedReviewerUserIds,
      pullRequestUrl: bug.pullRequestUrl,
      headSha: acceptedHeadSha,
      mergeCommitSha,
      ...moveTo("on_dev"),
      merged: true,
      ...(input.eventRecord ?? {}),
    },
    actorAgentId: agent.agentId,
    bugId: bug.id,
  });
  // #851: a merged revert returns the original issue to Open.
  await reopenOriginalAfterRevert(tx, bug.id);
}

/** A threshold-only project's merge-review vote (#vote-governance): the threshold and the manager weight. */
type Voting = { threshold: number; managerVoteWeight: number };

/**
 * A threshold-only merge review short of the threshold: the review is
 * recorded (by the caller) and announced; the issue stays where it is.
 */
async function recordReviewVote(
  tx: Prisma.TransactionClient,
  agent: AgentContext,
  bug: Pick<LoadedBug, "id" | "organisationId" | "status">,
  saved: { review: StoredMergeReview; replaced: boolean },
  votes: number,
  threshold: number,
): Promise<AcceptFixResult> {
  const facts = { mergeReviewId: saved.review.id, verdict: saved.review.verdict, votes, threshold, summary: saved.review.summary };
  await audit(agent, "issue.merge_reviewed", `bug:${bug.id}`, facts, { bugId: bug.id, db: tx });
  await publish(tx, {
    organisationId: bug.organisationId,
    type: "issue.updated",
    payload: { issueId: bug.id, status: bug.status, ...facts },
    actorAgentId: agent.agentId,
    bugId: bug.id,
  });
  return { status: 200, accepted: false, review: saved.review, replaced: saved.replaced, votes, threshold, ...(saved.review.verdict === "reject" ? { rejected: false } : {}) };
}

/**
 * A manager's reject (#review-entries): the merge review carries the
 * feedback, the issue goes back to `in_progress`, and an anti-pattern may go
 * in the mistake registry. It needs the pull request it rejects. In a
 * threshold-only project (`voting`) the reject is a vote: the issue goes back
 * only once the weighted rejects reach the threshold.
 */
async function rejectFix(agent: AgentContext, bug: LoadedBug, review: MergeReviewInput, voting: Voting | null): Promise<AcceptFixResult> {
  // The mistake registry is a manager's (lib/agent-api/mistakes.ts), in either governance mode.
  if (review.mistake && !hasLevel(agent.level, "manager")) {
    return { status: 403, error: "insufficient_level", message: "Only manager or merger agents record mistakes. Send the reject without mistake." };
  }
  if (bug.status === "resolved") {
    return {
      status: 409,
      error: "not_ready",
      missing: "already_accepted",
      message: "This issue's fix has already been merged, so it can't be rejected.",
    };
  }
  const pullRequestUrl = bug.track === "marketing" ? null : bug.pullRequestUrl;
  if (!pullRequestUrl && bug.track !== "marketing") {
    return {
      status: 409,
      error: "not_ready",
      missing: "pull_request",
      message: "This issue has no linked pull request to review.",
    };
  }
  return prisma.$transaction(async (tx): Promise<AcceptFixResult> => {
    if (bug.track === "marketing") {
      await tx.$queryRaw`SELECT "id" FROM "Bug" WHERE "id" = ${bug.id} FOR UPDATE`;
      const current = await tx.bug.findFirst({
        where: { id: bug.id, organisationId: agent.organisationId, isDeleted: false },
        select: mergeBugSelect,
      });
      if (!current || current.status === "resolved") {
        return {
          status: 409,
          error: "not_ready",
          missing: "already_accepted",
          message: "This issue's fix has already been merged, so it can't be rejected.",
        };
      }
      if (current.substatus !== "accepted") {
        return {
          status: 409,
          error: "not_ready",
          missing: "verdicts",
          message: "Marketing work can be reviewed once its reviewers approve it (Done · Accepted).",
        };
      }

      const saved = await saveMergeReview(tx, agent, current, review, pullRequestUrl, current.pullRequestHeadSha ?? null);
      if (review.mistake) {
        await recordMistake(agent, current.projectId, { ...review.mistake, bugId: current.id }, tx);
      }

      const workflow = await workflowFor(current.projectId, tx);
      const sendBack = afterSendBack(current, workflow.revisionLimit, "manager_reject");
      if (sendBack.keepsClaim) {
        await tx.bug.update({
          where: { id: current.id },
          data: { ...moveTo(sendBack.substatus), revisionCount: sendBack.revisionCount },
        });
      } else {
        const now = new Date();
        const held = current.claims.filter((claim) => !claim.releasedAt && (claim.status === "active" || claim.status === "offered"));
        for (const claim of held) {
          await tx.issueClaim.update({ where: { id: claim.id }, data: { status: "released", releasedAt: now, releaseReason: "manager_rejected" } });
          await publish(tx, {
            organisationId: current.organisationId,
            type: "claim.released",
            actorAgentId: null,
            bugId: current.id,
            payload: { claimId: claim.id, issueId: current.id, beneficiaryUserId: claim.beneficiaryUserId, reason: "manager_rejected" },
          });
        }
        await tx.bug.update({
          where: { id: current.id },
          data: { ...moveTo("open"), assigneeId: null, revisionCount: 0 },
        });
      }
      await tx.bugActivity.create({
        data: {
          bugId: current.id,
          actorId: agent.ownerId,
          type: "status_changed",
          summary: sendBack.keepsClaim
            ? `Work rejected by manager: ${review.summary} (revision round ${sendBack.revisionCount} of ${workflow.revisionLimit})`
            : `Work rejected by manager: ${review.summary} and revision limit reached (${workflow.revisionLimit}): reopened for bids`,
          metadata: {
            field: "status",
            from: current.substatus,
            to: sendBack.substatus,
            rejected: true,
            mergeReviewId: saved.review.id,
            revisionCount: sendBack.revisionCount,
            revisionLimit: workflow.revisionLimit,
          },
        },
      });
      await audit(
        agent,
        "issue.merge_rejected",
        `bug:${current.id}`,
        {
          ...moveTo(sendBack.substatus),
          rejected: true,
          mergeReviewId: saved.review.id,
          summary: review.summary,
          notes: review.description,
          pullRequestUrl,
          headSha: saved.review.headSha,
          revisionCount: sendBack.revisionCount,
        },
        { bugId: current.id, db: tx },
      );
      await publish(tx, {
        organisationId: current.organisationId,
        type: "issue.updated",
        payload: {
          issueId: current.id,
          rejected: true,
          ...moveTo(sendBack.substatus),
          mergeReviewId: saved.review.id,
          summary: review.summary,
          notes: review.description,
          pullRequestUrl,
          headSha: saved.review.headSha,
          revisionCount: sendBack.revisionCount,
        },
        actorAgentId: agent.agentId,
        bugId: current.id,
      });
      return { status: 200, accepted: false, review: saved.review, replaced: saved.replaced, rejected: true };
    }

    const saved = await saveMergeReview(tx, agent, bug, review, pullRequestUrl, bug.pullRequestHeadSha ?? null);
    if (review.mistake) {
      await recordMistake(agent, bug.projectId, { ...review.mistake, bugId: bug.id }, tx);
    }
    // Threshold-only: only the reject that reaches acceptThreshold sends the issue back.
    let decision: ThresholdDecision | null = null;
    if (voting) {
      await tx.$queryRaw`SELECT "id" FROM "Bug" WHERE "id" = ${bug.id} FOR UPDATE`;
      const votes = await mergeReviewTally(tx, bug, "reject", voting.managerVoteWeight);
      if (votes < voting.threshold) return recordReviewVote(tx, agent, bug, saved, votes, voting.threshold);
      decision = thresholdDecision({ userId: agent.ownerId, agentId: agent.agentId }, votes, voting.threshold);
    }

    await tx.bug.update({ where: { id: bug.id }, data: moveTo("in_progress") });
    await tx.bugActivity.create({
      data: {
        bugId: bug.id,
        actorId: agent.ownerId,
        type: "status_changed",
        summary: `Fix rejected for merging: ${review.summary}`,
        metadata: { field: "status", from: bug.substatus, to: "in_progress", rejected: true, mergeReviewId: saved.review.id, ...(decision ?? {}) },
      },
    });
    // #1429: the audit log keeps every merge decision, the review only the latest.
    await audit(
      agent,
      "issue.merge_rejected",
      `bug:${bug.id}`,
      {
        ...moveTo("in_progress"),
        rejected: true,
        mergeReviewId: saved.review.id,
        summary: review.summary,
        notes: review.description,
        pullRequestUrl,
        headSha: saved.review.headSha,
        ...(decision ?? {}),
      },
      { bugId: bug.id, db: tx },
    );
    await publish(tx, {
      organisationId: bug.organisationId,
      type: "issue.updated",
      payload: {
        issueId: bug.id,
        rejected: true,
        ...moveTo("in_progress"),
        mergeReviewId: saved.review.id,
        summary: review.summary,
        notes: review.description,
        ...(decision ?? {}),
      },
      actorAgentId: agent.agentId,
      bugId: bug.id,
    });
    return { status: 200, accepted: false, review: saved.review, replaced: saved.replaced, ...(decision ? { votes: decision.votes, threshold: decision.threshold, rejected: true } : {}) };
  });
}

/** One merge review as the API and the issue page show it, with its replies. */
export type MergeReviewEntry = StoredMergeReview & {
  agentId: string;
  agentName: string;
  /** The agent's owner, for whom it reviewed. */
  by: string;
  /** On the pull request (and head commit, when both are known) linked now. */
  current: boolean;
  replies: EntryReply[];
};

/** Every merge review on one issue, newest first. */
export async function mergeReviewEntries(
  bug: { id: string; pullRequestUrl: string | null; pullRequestHeadSha: string | null },
  db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<MergeReviewEntry[]> {
  const rows = await db.mergeReview.findMany({
    where: { bugId: bug.id },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    select: {
      ...reviewSelect,
      agentId: true,
      agent: { select: { name: true } },
      onBehalfOf: { select: { name: true } },
      replies: entryReplySelect,
    },
  });
  return rows.map(({ agent, onBehalfOf, replies, ...row }) => ({
    ...row,
    agentName: agent.name,
    by: onBehalfOf.name ?? "A member",
    current:
      row.pullRequestUrl === bug.pullRequestUrl &&
      (!bug.pullRequestHeadSha || !row.headSha || sameCommit(row.headSha, bug.pullRequestHeadSha)),
    replies: toEntryReplies(replies),
  }));
}

/** GET /issues/{id}/merge-reviews: the issue's merge reviews, each with its replies. */
export async function listMergeReviews(scope: { organisationId: string; projectId?: string }, issueRef: string) {
  const ref = parseIssueRef(issueRef);
  const bug = await prisma.bug.findFirst({
    where: { ...scope, isDeleted: false, ...(ref.kind === "number" ? { number: ref.number } : { id: ref.id }) },
    select: { id: true, number: true, status: true, substatus: true, pullRequestUrl: true, pullRequestHeadSha: true },
  });
  if (!bug) throw new IssueApiError(404, "Issue not found.", { error: "not_found", message: "Issue not found." });
  return {
    issueId: bug.id,
    issueNumber: bug.number,
    status: bug.status,
    substatus: bug.substatus,
    pullRequestUrl: bug.pullRequestUrl,
    headSha: bug.pullRequestHeadSha,
    // #plan-review rule 12: on a complex issue, the approved plan the delivery is reviewed against.
    plan: await approvedPlanSummary(bug.id),
    reviews: await mergeReviewEntries(bug),
  };
}
