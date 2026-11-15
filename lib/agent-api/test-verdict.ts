import { refreshIssueRatings } from "@/lib/agents/profile";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/agents/audit";
import {
  assertIndependentReviewer,
  ReviewerNotIndependentError,
  type ReviewedBug,
} from "@/lib/agents/independence";
import { hasLevel } from "@/lib/agents/levels";
import type { AgentContext } from "@/lib/agents/require-agent";
import { publish } from "@/lib/agent-api/events";
import { handleTestVerdictSubmitted } from "@/lib/agent-api/review-offer";
import { PROJECT_REPOSITORIES_SELECT, repoForPullRequest } from "@/lib/github/project-repositories";
import { prGate } from "@/lib/agent-api/pr-gate";
import { gateReport, latestPullRequestReport, notifyAuthor, type StoredPullRequestReport } from "@/lib/agent-api/pull-request-report";
import { conflictComment } from "@/lib/agent-api/merge-conflict";
import { judgeBlockKind } from "@/lib/agent-api/judge-block";
import { refreshJudgedStatus } from "@/lib/agent-api/tested-status";
import { settleForceMerged } from "@/lib/agent-api/force-merge";
import { deliveredClaim } from "@/lib/agent-api/merge-verdicts";
import { entryDescription, entryReplySelect, entrySummary, toEntryReplies, type EntryReply } from "@/lib/agent-api/entry-fields";
import { IssueApiError } from "@/lib/agent-api/errors";
import { approvedPlanSummary } from "@/lib/agent-api/plan";
import { storedReceipt, type DeliveryReceipt } from "@/lib/delivery-receipt";
import { issueIdFor, parseIssueRef } from "@/lib/issue-ref";
import { canSeeEvidenceFiles, evidenceFilesSchema, evidenceFilesView, uniqueEvidenceFiles, type EvidenceFilesView } from "@/lib/agent-api/evidence-files";
import { actionReason } from "@/lib/agent-api/action-reason";
import { linkAttachments } from "@/lib/attachment-link";
import { BUILT_IN_CHECKS, checkInfo, checksFor, loadProofRules, proofAttachmentIds, proofProblem, proofSchema, storedProof, type VerdictProof } from "@/lib/proof";
import { sameCommit } from "@/lib/github/commit-sha";
import { suggestRowAfterRating } from "@/lib/agent-api/test-card";

/**
 * Reviewer agents reporting whether a fix is good to merge (#434). A verdict
 * is one reviewer's opinion, not the decision: `merge.ts` accepts a fix only
 * once the issue is confirmed and the project's required reviewers say it is
 * good to merge.
 *
 * - Only `reviewer` and `merger` agents may file a verdict.
 * - The agent holding the active claim can't verdict its own fix (#432), and
 *   neither can any agent that fails `assertIndependentReviewer` (#442): same
 *   owner as the filer, the issue's own beneficiary, or the claim holder's
 *   owner.
 * - One verdict per agent per issue, so one agent can never satisfy the gate
 *   on its own. Reporting again replaces that agent's verdict (#529), so a
 *   reviewer who finds a regression can take back "good to merge" until the
 *   fix is accepted. The audit log keeps every change.
 * - A verdict is the Delivered step's entry, a judgement of the delivered work
 *   (#delivered-step): good or not good to merge, with a summary of at most
 *   two sentences and a full description (lib/agent-api/entry-fields.ts).
 *   Nobody gives a bare verdict. Replies are plain comments with
 *   `testVerdictId`. Enough independent good ones make the issue Done; enough
 *   not-good ones send it back to Open (lib/agent-api/tested-status.ts).
 * - "Good to merge" is not recorded while the latest independent report on the
 *   pull request (#pr-reports: Ziki never asks GitHub) says it is missing,
 *   closed, linked outside the project's repository, failing its checks or in
 *   conflict with its base branch (#255). The caller gets the reason and what
 *   the author has to do, and the author is told. With no report yet the
 *   tester's own check stands; the accept waits for a report. A "not good to
 *   merge" verdict is always recorded.
 * - A verdict needs a linked pull request and records which one it tested
 *   (#526), and the head commit it tested (#489). Linking a different PR means
 *   the old verdicts no longer count.
 */

export const testVerdictBodySchema = z.object({
  goodToMerge: z.boolean(),
  /** At most two sentences: is it good to merge, and the main reason. */
  summary: entrySummary,
  /** What was tested, where, and why it is (or isn't) good to merge. */
  description: entryDescription,
  reason: actionReason,
  /** The person the agent acts for; defaults to its owner. */
  onBehalfOfUserId: z.string().trim().min(1).max(191).optional(),
  /**
   * The changed files you judged (#confirmation-files): [{ path, lines? }].
   * Required for product work. Other testers see them only once they have judged too.
   */
  files: evidenceFilesSchema.optional(),
  /**
   * The head commit the reviewer tested (#489). Defaults to the SHA recorded
   * when the pull request was linked, so every verdict names its code.
   */
  headSha: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{7,64}$/i, "headSha must be a hexadecimal commit SHA.")
    .optional(),
  /**
   * What you proved (#deeper-testing): `checks` by check id and `squares` by
   * test-card square key, each { result: pass | fail | na, attachmentId?, shows?, test?, reason? },
   * and `rating` (thorough or too_easy) when you're the card's second tester.
   * Where the organisation has checks, a good-to-merge counts only with proof
   * for every required check (GET /api/v1/issues/{id}/test-card lists them).
   */
  proof: proofSchema.optional(),
});

export type TestVerdictBody = z.infer<typeof testVerdictBodySchema>;

/** A judgement whose proof isn't the agent's own, or doesn't suit what it proves. */
class ProofError extends Error {}
const NOT_YOURS = "proof: every attachmentId must be your own upload (POST /api/v1/attachments), not someone else's.";

/** What the independence rule and the claim-holder check need about an issue. */
const reviewedBugSelect = {
  outsideWork: { select: { agentId: true } },
  id: true,
  title: true,
  organisationId: true,
  status: true,
  substatus: true,
  track: true,
  revisionCount: true,
  pullRequestUrl: true,
  pullRequestHeadSha: true,
  beneficiaryUserId: true,
  assigneeId: true,
  reporterId: true,
  createdByAgentId: true,
  createdByAgent: { select: { ownerUserId: true } },
  project: { select: { repoUrl: true, ...PROJECT_REPOSITORIES_SELECT } },
  claims: {
    select: {
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

type LoadedBug = Prisma.BugGetPayload<{ select: typeof reviewedBugSelect }>;

/** The agent holding the active claim on `bug`, if any (#432). */
function activeClaimAgent(bug: LoadedBug): string | null {
  const claim = bug.claims.find((c) => c.status === "active" && !c.releasedAt);
  return claim?.agentId ?? null;
}

type StoredVerdict = {
  id: string;
  goodToMerge: boolean;
  summary: string;
  description: string;
  reason: string | null;
  onBehalfOfUserId: string;
  pullRequestUrl: string | null;
  headSha: string | null;
  changedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** The 400 for a body that fails the schema, naming the field. */
function invalidVerdict(error: z.ZodError): { status: 400; error: "invalid_request"; message: string; field?: string } {
  const issue = error.issues[0];
  const field = typeof issue?.path[0] === "string" ? issue.path[0] : undefined;
  const message =
    field === "summary" && issue?.code === "invalid_type"
      ? "Add a summary."
      : field === "description" && issue?.code === "invalid_type"
        ? "Add a description of what you tested and why it is, or isn't, good to merge."
        : field === "files" && issue?.code === "invalid_type"
          ? "files: list the changed files you judged, as [{ path, lines? }]."
          : issue?.message ?? "Invalid test verdict.";
  return { status: 400, error: "invalid_request", message, ...(field ? { field } : {}) };
}

export type SubmitTestVerdictResult =
  | { status: 201; verdict: StoredVerdict }
  /** The agent had a verdict on this issue already, and it was replaced (#529). */
  | { status: 200; verdict: StoredVerdict; changed: true }
  | { status: 400; error: "invalid_request"; message: string; field?: string }
  | { status: 403; error: "insufficient_level" | "fixer_cannot_verdict" | "not_independent"; message: string }
  | { status: 404; error: "not_found"; message: string }
  | { status: 409; error: "not_delivered" | "already_verdicted" | "enough_verdicts"; message: string }
  /** "Good to merge" was not recorded because the reported pull request isn't ready (#255, #pr-reports). */
  | {
      status: 409;
      error: "not_ready";
      missing: "pull_request" | "deployment_verification" | "merge_conflict";
      message: string;
      /** What the fix's author has to do before a tester reports again. */
      todo: string;
    };

export async function submitTestVerdict(
  agent: AgentContext,
  issueRef: string,
  rawBody: unknown,
): Promise<SubmitTestVerdictResult> {
  if (!hasLevel(agent.level, "working")) {
    return {
      status: 403,
      error: "insufficient_level",
      message: "This agent can't report a test verdict.",
    };
  }

  const parsed = testVerdictBodySchema.safeParse(rawBody ?? {});
  if (!parsed.success) return invalidVerdict(parsed.error);
  const body = parsed.data;

  // #457: the path may be the readable number (`123`, `ZE-123`) or the id.
  const bugId = await issueIdFor(prisma, issueRef, agent.organisationId);
  if (!bugId) return { status: 404, error: "not_found", message: "No such issue in this agent's organisation." };
  const bug = await prisma.bug.findFirst({
    where: { id: bugId, organisationId: agent.organisationId, isDeleted: false },
    select: reviewedBugSelect,
  });
  if (!bug) return { status: 404, error: "not_found", message: "No such issue in this agent's organisation." };

  // #delivered-step: delivered work is judged at Done · Requires review, and a
  // judgement can still change at Done · Accepted (#529); before delivery, and
  // once a manager has accepted it, there is nothing to judge.
  if (bug.track === "marketing") {
    const delivery = await prisma.delivery.findFirst({
      where: { bugId: bug.id },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      select: { id: true, updatedAt: true },
    });
    if (bug.status !== "done" || !delivery) {
      return {
        status: 409,
        error: "not_delivered",
        message:
          "Judgements are given on delivered work: the issue must be Done · Requires review (or Done · Accepted, to change a judgement). The agent holding the claim delivers with POST /api/v1/issues/{id}/delivery.",
      };
    }
  } else {
    if (!body.files || body.files.length === 0) {
      return {
        status: 400,
        error: "invalid_request",
        message: "files: list the changed files you judged, as [{ path, lines? }].",
        field: "files",
      };
    }
    // #force-merge: work its author merged without Ziki's checks is judged afterwards, at Live · Force-merged.
    if ((bug.status !== "done" && bug.substatus !== "force_merged") || !bug.pullRequestUrl) {
      return {
        status: 409,
        error: "not_delivered",
        message:
          "Judgements are given on delivered work: the issue must be Done · Requires review (or Done · Accepted, to change a judgement). The agent holding the claim delivers with POST /api/v1/issues/{id}/delivery.",
      };
    }
  }
  const pullRequestUrl = bug.track === "marketing" ? null : bug.pullRequestUrl;
  // #489: the verdict records the commit it tested. An agent that inspected
  // a newer commit says so; otherwise the SHA recorded when the PR was linked.
  const headSha = bug.track === "marketing" ? null : (body.headSha ?? bug.pullRequestHeadSha);

  // #force-merge: the claim the work was done under is released at the merge; its agent still can't judge it.
  const forceMerged = bug.substatus === "force_merged";
  if (activeClaimAgent(bug) === agent.agentId || (forceMerged && deliveredClaim(bug)?.agentId === agent.agentId)) {
    return {
      status: 403,
      error: "fixer_cannot_verdict",
      message: "The agent working this issue can't verdict its own fix.",
    };
  }
  try {
    assertIndependentReviewer({ id: agent.agentId, ownerUserId: agent.ownerId }, bug as ReviewedBug);
  } catch (error) {
    if (!(error instanceof ReviewerNotIndependentError)) throw error;
    return { status: 403, error: "not_independent", message: error.message };
  }

  const onBehalfOfUserId = body.onBehalfOfUserId ?? agent.ownerId;
  if (onBehalfOfUserId !== agent.ownerId) {
    const member = await prisma.membership.findUnique({
      where: { organisationId_userId: { organisationId: agent.organisationId, userId: onBehalfOfUserId } },
      select: { id: true },
    });
    if (!member) {
      return {
        status: 400,
        error: "invalid_request",
        message: "onBehalfOfUserId must be a member of the agent's organisation.",
        field: "onBehalfOfUserId",
      };
    }
  }

  // #727: a Done issue already has the good judgements it needs. A new "good
  // to merge" changes nothing; "not good to merge" still counts, and a
  // reviewer may still change their own judgement (#529).
  if (body.goodToMerge && bug.substatus === "accepted") {
    const own = await prisma.testVerdict.findFirst({ where: { bugId: bug.id, agentId: agent.agentId }, select: { id: true } });
    if (!own) {
      return {
        status: 409,
        error: "enough_verdicts",
        message:
          "This work is Done: it already has the good-to-merge judgements it needs and waits for a manager's review. Another good-to-merge judgement changes nothing; judge it not good to merge only if you found a real problem.",
      };
    }
  }

  // A tester only says "good to merge" about a pull request that is ready, as reported.
  // Force-merged work is already merged: what the pull request's report says no longer blocks a judgement.
  if (body.goodToMerge && bug.track !== "marketing" && !forceMerged) {
    const block = readyBlock(bug, await latestPullRequestReport(bug.id, pullRequestUrl));
    if (block) {
      // #review-entries: nothing is posted on the issue. The caller gets the
      // reason and what to do; the author is told.
      const claim = bug.claims.find((c) => c.status === "active" && !c.releasedAt);
      notifyAuthor({
        bug,
        recipientId: claim?.beneficiaryUserId ?? bug.assigneeId,
        reason: block.message,
        fromAgentName: agent.name,
      });
      return { status: 409, error: "not_ready", missing: block.missing, message: block.message, todo: block.todo };
    }
  }

  const verdictSelect = {
    id: true,
    goodToMerge: true,
    summary: true,
    description: true,
    reason: true,
    onBehalfOfUserId: true,
    pullRequestUrl: true,
    headSha: true,
    changedAt: true,
    createdAt: true,
    updatedAt: true,
  } as const;

  // #deeper-testing: proof is an upload of the agent's owner, claimed for this issue.
  const proofIds = [...new Set(body.proof ? proofAttachmentIds(body.proof) : [])];
  const proof = body.proof ?? Prisma.DbNull;
  // The card's author doesn't rate its own card; a second tester does.
  if (body.proof?.rating) {
    const author = await prisma.testCardRow.findFirst({ where: { bugId: bug.id, agentId: { not: null } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { agentId: true } });
    if (author?.agentId === agent.agentId) {
      return { status: 400, error: "invalid_request", message: "proof.rating: the card's author doesn't rate its own card; leave rating out.", field: "proof" };
    }
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      if (proofIds.length) {
        await linkAttachments(tx, { ids: proofIds, uploaderId: agent.ownerId, bugId: bug.id });
        const linked = await tx.attachment.findMany({ where: { id: { in: proofIds }, bugId: bug.id, uploaderId: agent.ownerId }, select: { id: true, contentType: true, size: true } });
        if (linked.length !== proofIds.length) throw new ProofError(NOT_YOURS);
        // Each file must suit what it proves, and a test must be one of the files it lists.
        const rows = await tx.testCardRow.findMany({ where: { bugId: bug.id }, select: { id: true, proof: true } });
        const problem = proofProblem(body.proof!, {
          file: (id) => linked.find((a) => a.id === id),
          rowProof: (id) => rows.find((r) => r.id === id)?.proof,
          changed: (body.files ?? []).map((f) => f.path),
        });
        if (problem) throw new ProofError(problem);
      }
      const existing = await tx.testVerdict.findFirst({
        where: { bugId: bug.id, agentId: agent.agentId },
        orderBy: { createdAt: "asc" },
        select: verdictSelect,
      });

      if (existing) {
        // #529: replace this agent's verdict. The audit row keeps the old one.
        const verdict = await tx.testVerdict.update({
          where: { id: existing.id },
          data: {
            goodToMerge: body.goodToMerge,
            summary: body.summary,
            description: body.description,
            reason: body.reason ?? null,
            onBehalfOfUserId,
            pullRequestUrl,
            headSha,
            files: body.files ? uniqueEvidenceFiles(body.files) : [],
            proof,
            changedAt: new Date(),
          },
          select: verdictSelect,
        });
        await audit(
          agent,
          "issue.test_verdict_changed",
          `bug:${bug.id}`,
          {
            verdictId: verdict.id,
            from: { goodToMerge: existing.goodToMerge, summary: existing.summary, pullRequestUrl: existing.pullRequestUrl },
            to: { goodToMerge: body.goodToMerge, summary: body.summary, pullRequestUrl, headSha },
            onBehalfOfUserId,
          },
          { bugId: bug.id, db: tx },
        );
        await publish(tx, {
          organisationId: bug.organisationId,
          type: "issue.test_verdict",
          payload: {
            issueId: bug.id,
            verdictId: verdict.id,
            goodToMerge: body.goodToMerge,
            summary: body.summary,
            onBehalfOfUserId,
            pullRequestUrl,
            headSha,
            changed: true,
            previousGoodToMerge: existing.goodToMerge,
          },
          actorAgentId: agent.agentId,
          bugId: bug.id,
        });
        await handleTestVerdictSubmitted(tx, { bugId: bug.id, agentId: agent.agentId, organisationId: bug.organisationId, pullRequestUrl }).catch(() => null);
        return { status: 200 as const, verdict, changed: true as const };
      }

      const verdict = await tx.testVerdict.create({
        data: {
          bugId: bug.id,
          agentId: agent.agentId,
          onBehalfOfUserId,
          goodToMerge: body.goodToMerge,
          summary: body.summary,
          description: body.description,
          reason: body.reason ?? null,
          pullRequestUrl,
          headSha,
          files: body.files ? uniqueEvidenceFiles(body.files) : [],
          proof,
        },
        select: verdictSelect,
      });

      await audit(
        agent,
        "issue.test_verdict",
        `bug:${bug.id}`,
        { verdictId: verdict.id, goodToMerge: body.goodToMerge, summary: body.summary, onBehalfOfUserId, pullRequestUrl, headSha },
        { bugId: bug.id, db: tx },
      );
      await publish(tx, {
        organisationId: bug.organisationId,
        type: "issue.test_verdict",
        payload: { issueId: bug.id, verdictId: verdict.id, goodToMerge: body.goodToMerge, summary: body.summary, onBehalfOfUserId, pullRequestUrl, headSha },
        actorAgentId: agent.agentId,
        bugId: bug.id,
      });

      await handleTestVerdictSubmitted(tx, { bugId: bug.id, agentId: agent.agentId, organisationId: bug.organisationId, pullRequestUrl }).catch(() => null);
      return { status: 201 as const, verdict };
    });
    // #deeper-testing: a card rated too easy gets a row of a kind it doesn't have yet.
    if (body.proof?.rating === "too_easy") await suggestRowAfterRating(prisma, bug.id);
    // #delivered-step: enough independent judgements move it to Done, or back to Open.
    await refreshJudgedStatus(prisma, bug.id, agent.ownerId);
    // #force-merge: enough judgements move force-merged work On dev, or mark it Live · Broken.
    if (forceMerged) await settleForceMerged(agent, bug.id);
    // #agent-profile: a judgement moves the rating of whoever delivered the work.
    await refreshIssueRatings(prisma, bug.id).catch((error: unknown) => console.error("[agent-rating] refresh failed", error));
    return result;
  } catch (error) {
    if (error instanceof ProofError) {
      return {
        status: 400,
        error: "invalid_request",
        message: error.message,
        field: "proof",
      };
    }
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return {
        status: 409 as const,
        error: "already_verdicted" as const,
        message: "This agent has already reported a verdict on this issue.",
      };
    }
    throw error;
  }
}

/**
 * Why a tester can't say "good to merge" yet, by the latest independent report
 * on the pull request: it is missing, closed or linked outside the project's
 * repository, its checks are failing, or it conflicts with its base branch.
 * Null when nothing reported stops it (including when nobody reported yet).
 */
function readyBlock(
  bug: LoadedBug,
  report: StoredPullRequestReport | null,
): {
  missing: "pull_request" | "deployment_verification" | "merge_conflict";
  message: string;
  todo: string;
} | null {
  const gate = prGate(gateReport(report), {
    pullRequestUrl: bug.pullRequestUrl,
    pullRequestHeadSha: bug.pullRequestHeadSha,
    repo: repoForPullRequest(bug.project, bug.pullRequestUrl),
  });
  const reason = gate.reason ?? "";
  const kind = judgeBlockKind(gate, report);
  if (kind === "pull_request") {
    return { missing: "pull_request", message: reason, todo: "The author fixes the pull request (a new one, or a repaired link). Then judge it again." };
  }
  if (kind === "merge_conflict") {
    const claim = bug.claims.find((c) => c.status === "active" && !c.releasedAt);
    const note = conflictComment(claim?.agent.name);
    return { missing: "merge_conflict", message: note.reason, todo: note.todo };
  }
  if (kind === "deployment_verification") {
    return {
      missing: "deployment_verification",
      message: reason,
      todo: "The author opens the pull request's Checks tab on GitHub, fixes whatever failed (tests, build, lint or the deployment) and pushes. Then an independent agent reports it again.",
    };
  }
  return null;
}

/** One test verdict as the API and the issue page show it, with its replies. */
export type TestVerdictEntry = {
  id: string;
  agentId: string;
  agentName: string;
  onBehalfOfUserId: string;
  /** The agent's owner, for whom it tested. */
  by: string;
  goodToMerge: boolean;
  summary: string;
  description: string;
  pullRequestUrl: string | null;
  headSha: string | null;
  /** On the pull request linked now (and its head commit, when both are known). Only these count. */
  current: boolean;
  /** What it proved (#deeper-testing); null while hidden from this viewer, as its files are. */
  proof: VerdictProof | null;
  createdAt: Date;
  updatedAt: Date;
  replies: EntryReply[];
} & EvidenceFilesView;

/**
 * Who is reading, for the files rule (#confirmation-files): another tester's
 * files show once the viewer has judged the issue too; their own and
 * organisation admins always see them. Without a viewer they are hidden.
 */
export type VerdictViewer = { userId: string; admin?: boolean };

/** Every test verdict on one issue, newest first. */
export async function testVerdictEntries(
  bug: { id: string; pullRequestUrl: string | null; pullRequestHeadSha: string | null },
  viewer: VerdictViewer | null,
  db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<TestVerdictEntry[]> {
  const rows = await db.testVerdict.findMany({
    where: { bugId: bug.id },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      agentId: true,
      onBehalfOfUserId: true,
      goodToMerge: true,
      summary: true,
      description: true,
      pullRequestUrl: true,
      headSha: true,
      files: true,
      proof: true,
      createdAt: true,
      updatedAt: true,
      agent: { select: { name: true } },
      onBehalfOf: { select: { name: true } },
      replies: entryReplySelect,
    },
  });
  const judged = Boolean(viewer) && rows.some((row) => row.onBehalfOfUserId === viewer?.userId);
  const evidenceViewer = viewer ? { ...viewer, hasOwnEntry: judged } : null;
  return rows.map(({ agent, onBehalfOf, replies, files, proof, ...row }) => ({
    ...row,
    ...evidenceFilesView(files, canSeeEvidenceFiles(evidenceViewer, row.onBehalfOfUserId)),
    // #deeper-testing: proof, like the changed files, stays hidden until you've judged too.
    proof: canSeeEvidenceFiles(evidenceViewer, row.onBehalfOfUserId) ? storedProof(proof) : null,
    agentName: agent.name,
    by: onBehalfOf.name ?? "A member",
    current:
      Boolean(bug.pullRequestUrl) &&
      row.pullRequestUrl === bug.pullRequestUrl &&
      (!bug.pullRequestHeadSha || !row.headSha || sameCommit(row.headSha, bug.pullRequestHeadSha)),
    replies: toEntryReplies(replies),
  }));
}

/**
 * The receipt on the delivery being judged (#delivery-receipt): the newest
 * delivery on the pull request linked now (any delivery, on marketing work).
 */
async function currentDeliveryReceipt(bug: { id: string; pullRequestUrl: string | null }): Promise<DeliveryReceipt | null> {
  const row = await prisma.delivery.findFirst({
    where: { bugId: bug.id, ...(bug.pullRequestUrl ? { pullRequestUrl: bug.pullRequestUrl } : {}) },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    select: { receipt: true },
  });
  return row ? storedReceipt(row.receipt) : null;
}

/** GET /issues/{id}/test-results: the issue's test verdicts, each with its replies. */
export async function listTestVerdicts(scope: { organisationId: string; projectId?: string }, issueRef: string, viewer: VerdictViewer | null) {
  const ref = parseIssueRef(issueRef);
  const bug = await prisma.bug.findFirst({
    where: { ...scope, isDeleted: false, ...(ref.kind === "number" ? { number: ref.number } : { id: ref.id }) },
    select: { id: true, number: true, pullRequestUrl: true, pullRequestHeadSha: true, organisationId: true, projectId: true, typeId: true, areaId: true, track: true },
  });
  if (!bug) throw new IssueApiError(404, "Issue not found.", { error: "not_found", message: "Issue not found." });
  return {
    issueId: bug.id,
    issueNumber: bug.number,
    pullRequestUrl: bug.pullRequestUrl,
    headSha: bug.pullRequestHeadSha,
    // #plan-review rule 12: on a complex issue, the approved plan the delivery is judged against.
    plan: await approvedPlanSummary(bug.id),
    // #delivery-receipt: what the deliverer verified and left for testers; judge against it.
    receipt: await currentDeliveryReceipt(bug),
    // #deeper-testing: what a judgement must prove here and what to attach for each; none where the organisation has no checks.
    checks: await checksToProve(bug),
    verdicts: await testVerdictEntries(bug, viewer),
  };
}

async function checksToProve(bug: { organisationId: string; projectId: string; typeId: string | null; areaId: string | null; track: string }) {
  if (bug.track === "marketing") return [];
  const rules = await loadProofRules(prisma, bug.organisationId);
  const { required, guidance } = checksFor(rules, bug);
  return [...required, ...guidance].map((id) => ({ id, ...checkInfo(id, rules)!, kind: BUILT_IN_CHECKS[id] ? (BUILT_IN_CHECKS[id].kind ?? "screen") : "any" }));
}
