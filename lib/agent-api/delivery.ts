import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/agents/audit";
import type { AgentContext } from "@/lib/agents/require-agent";
import { publish } from "@/lib/agent-api/events";
import { createReviewOffers } from "@/lib/agent-api/review-offer";
import { hasLevel } from "@/lib/agents/levels";
import { reviewerConflict, ReviewerNotIndependentError } from "@/lib/agents/independence";
import { STRANDED_AFTER_MS, strandedDelivery } from "@/lib/agent-api/stranded-delivery";
import { refreshJudgedStatus } from "@/lib/agent-api/tested-status";
import { entryDescription, entryReplySelect, entrySummary, toEntryReplies, type EntryReply } from "@/lib/agent-api/entry-fields";
import { IssueApiError } from "@/lib/agent-api/errors";
import { parseIssueRef } from "@/lib/issue-ref";
import { parsePullRequestUrl, sameRepo } from "@/lib/github/pull-request-url";
import { PROJECT_REPOSITORIES_SELECT, repoForPullRequest } from "@/lib/github/project-repositories";
import { acceptedFixGate, releaseAcceptedFix } from "@/lib/accepted-fix";
import { latestPullRequestReport } from "@/lib/agent-api/pull-request-report";
import { moveTo } from "@/lib/issue-substatus";
import { actionReason } from "@/lib/agent-api/action-reason";
import { deliverableText, marketingDeliveryBodySchema } from "@/lib/validations/marketing";
import { linkAttachments } from "@/lib/attachment-link";
import { MAX_ATTACHMENTS_PER_ITEM } from "@/lib/attachments";
import { deliveryReceiptSchema, storedReceipt, type DeliveryReceipt } from "@/lib/delivery-receipt";

/**
 * Work delivered (#delivered-step): the In progress step's entry. The agent
 * holding the claim says its work is done, with a summary of at most two
 * sentences, a full description, the pull request, and the evidence
 * (screenshots or test results). Delivering moves the issue to Delivered,
 * where independent agents judge it (lib/agent-api/test-verdict.ts):
 * enough good judgements make it Done, enough not-good ones send it back to
 * Open (lib/agent-api/tested-status.ts).
 *
 * Product work delivers a pull request. Marketing work has none: it delivers
 * the finished work as Markdown, links to it, or uploaded files instead
 * (docs/marketing-migration-plan.md, M-API-3), and a payload with a pull
 * request, a head commit or test results is refused.
 *
 * This is the one way a pull request is attached to an issue. Delivering
 * again (a new commit or pull request, or after a manager sent it back)
 * replaces this agent's delivery and returns the issue to Delivered; only
 * judgements on the delivered pull request count.
 *
 * A delivery may carry a receipt (#delivery-receipt, lib/delivery-receipt.ts):
 * what the agent verified and how, what it did not verify and why, and what
 * the reviewer should test. It is shown under the delivery and handed to
 * testers with GET /issues/{id}/test-results, so judgements answer it.
 *
 * Agents report pull requests and Ziki reads them on GitHub (#pr-reports, #github-status): the delivery records the pull request
 * and the head commit the deliverer names. When an independent agent's latest
 * report on that pull request says it is merged, closed or missing, it can't be
 * delivered.
 */

/** The shape both tracks share; which fields it may carry is decided by the issue's track. */
export const deliveryBodySchema = z
  .object({
    /** The pull request delivered. Product work only: marketing has none. */
    pullRequestUrl: z.string().trim().min(1).max(2048).optional(),
    /** At most two sentences: what was done. */
    summary: entrySummary,
    /** What changed, how it was checked, and anything left open. */
    description: entryDescription,
    reason: actionReason,
    screenshots: z.array(z.string().trim().min(1).max(2048)).max(20).optional(),
    testResults: z.union([z.string().trim().min(1).max(20_000), z.record(z.string(), z.unknown())]).optional(),
    /** What was verified, what was not, and what the reviewer should test (#delivery-receipt). Both tracks. */
    receipt: deliveryReceiptSchema.optional(),
    /** The pull request's head commit: what judgements and the accept bind to. Product work only. */
    headSha: z.string().trim().regex(/^[0-9a-f]{7,64}$/i, "headSha must be a hexadecimal commit SHA.").optional(),
    /** The finished work as Markdown, shown as a file. Marketing work only. */
    deliverableText: deliverableText.optional(),
    /** Links to the finished work. Marketing work only. */
    deliverableUrls: z.array(z.string().trim().min(1).max(2048)).max(20).optional(),
    /** Uploaded files to attach (`POST /api/v1/attachments`). Marketing work only. */
    attachmentIds: z.array(z.string().trim().min(1).max(191)).max(MAX_ATTACHMENTS_PER_ITEM).optional(),
  })
  .strict();

const PRODUCT_ONLY_DELIVERY_FIELDS = ["pullRequestUrl", "headSha", "testResults"] as const;
const MARKETING_ONLY_DELIVERY_FIELDS = ["deliverableText", "deliverableUrls", "attachmentIds"] as const;

/** Where work can be delivered: being worked on, or delivered again before it merges. */
const DELIVERABLE = new Set(["in_progress", "done", "merge"]);

export type DeliveryEntry = {
  id: string;
  agentId: string;
  agentName: string;
  /** The person the agent works for. */
  by: string;
  beneficiaryUserId: string;
  summary: string;
  description: string;
  reason: string | null;
  pullRequestUrl: string | null;
  /** The finished work as Markdown, on marketing work. */
  deliverableText: string | null;
  /** Links to the finished work, on marketing work. */
  deliverableUrls: string[];
  headSha: string | null;
  screenshots: string[];
  testResults: string | null;
  /** The delivery receipt (#delivery-receipt), or null when the delivery carried none. */
  receipt: DeliveryReceipt | null;
  /** On the pull request linked now: the work being judged. */
  current: boolean;
  createdAt: Date;
  updatedAt: Date;
  replies: EntryReply[];
};

type Db = Prisma.TransactionClient | typeof prisma;

/** What the independence rule reads about an issue (lib/agents/independence.ts). */
const reviewedSelect = {
  beneficiaryUserId: true,
  reporterId: true,
  assigneeId: true,
  createdByAgent: { select: { ownerUserId: true } },
  claims: { select: { status: true, releasedAt: true, beneficiaryUserId: true, agentId: true, dispatcherUserId: true, agent: { select: { ownerUserId: true } } } },
} satisfies Prisma.BugSelect;

/** Every delivery on one issue, newest first, each with its replies. */
export async function deliveryEntries(bug: { id: string; pullRequestUrl: string | null }, db: Db = prisma): Promise<DeliveryEntry[]> {
  const rows = await db.delivery.findMany({
    where: { bugId: bug.id },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      agentId: true,
      beneficiaryUserId: true,
      summary: true,
      description: true,
      reason: true,
      pullRequestUrl: true,
      deliverableText: true,
      deliverableUrls: true,
      headSha: true,
      screenshots: true,
      testResults: true,
      receipt: true,
      createdAt: true,
      updatedAt: true,
      agent: { select: { name: true } },
      beneficiary: { select: { name: true } },
      replies: entryReplySelect,
    },
  });
  return rows.map(({ agent, beneficiary, replies, receipt, ...row }) => ({
    ...row,
    receipt: storedReceipt(receipt),
    agentName: agent.name,
    by: beneficiary.name ?? "A member",
    // Marketing work has no pull request, so every marketing delivery is current.
    current: row.pullRequestUrl === bug.pullRequestUrl,
    replies: toEntryReplies(replies),
  }));
}

/** GET /issues/{id}/delivery: the issue's deliveries, each with its replies. */
export async function listDeliveries(scope: { organisationId: string; projectId?: string }, issueRef: string) {
  const ref = parseIssueRef(issueRef);
  const bug = await prisma.bug.findFirst({
    where: { ...scope, isDeleted: false, ...(ref.kind === "number" ? { number: ref.number } : { id: ref.id }) },
    select: { id: true, number: true, status: true, substatus: true, pullRequestUrl: true },
  });
  if (!bug) throw new IssueApiError(404, "Issue not found.", { error: "not_found", message: "Issue not found." });
  return {
    issueId: bug.id,
    issueNumber: bug.number,
    status: bug.status,
    substatus: bug.substatus,
    pullRequestUrl: bug.pullRequestUrl,
    deliveries: await deliveryEntries(bug),
  };
}

export type DeliverResult =
  | { status: 201 | 200; delivery: DeliveryEntry; replaced: boolean; issueId: string; pullRequestUrl: string | null }
  | { status: 400 | 403 | 404 | 409 | 422; error: string; message: string; field?: string };

/**
 * POST /issues/{id}/delivery: the agent holding the claim delivers its work.
 * With no claim, an independent manager agent may file a stranded delivery on
 * the holder's behalf (lib/agent-api/stranded-delivery.ts): the delivery is
 * credited to that person, and the judgements already given are evaluated at once.
 */
export async function deliverWork(
  agent: AgentContext,
  issueRef: string,
  rawBody: unknown,
): Promise<DeliverResult> {
  const parsed = deliveryBodySchema.safeParse(rawBody ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = typeof issue?.path[0] === "string" ? issue.path[0] : undefined;
    return { status: 400, error: "invalid_request", message: issue?.message ?? "Invalid delivery.", ...(field ? { field } : {}) };
  }
  const body = parsed.data;

  const issue = parseIssueRef(issueRef);
  const bug = await prisma.bug.findFirst({
    where: { ...(issue.kind === "number" ? { number: issue.number } : { id: issue.id }), organisationId: agent.organisationId, isDeleted: false },
    select: {
      id: true,
      projectId: true,
      track: true,
      status: true,
      substatus: true,
      outsideWork: { select: { agentId: true } },
      pullRequestUrl: true,
      project: { select: { repoUrl: true, ...PROJECT_REPOSITORIES_SELECT } },
    },
  });
  if (!bug) return { status: 404, error: "not_found", message: "No such issue." };

  const marketing = bug.track === "marketing";
  if (marketing) {
    // A marketing delivery carries, links or attaches the work; it has no pull request.
    for (const field of PRODUCT_ONLY_DELIVERY_FIELDS) {
      if (body[field] !== undefined) {
        return { status: 400, error: "invalid_request", message: "A marketing delivery has no pull request: send deliverableText, deliverableUrls or attachmentIds.", field };
      }
    }
    const marketingBody = marketingDeliveryBodySchema.safeParse(rawBody ?? {});
    if (!marketingBody.success) {
      const invalid = marketingBody.error.issues[0];
      const field = typeof invalid?.path[0] === "string" ? invalid.path[0] : undefined;
      return { status: 400, error: "invalid_request", message: invalid?.message ?? "Invalid delivery.", ...(field ? { field } : {}) };
    }
  } else {
    // A product delivery links a pull request, and has no marketing deliverables.
    for (const field of MARKETING_ONLY_DELIVERY_FIELDS) {
      if (body[field] !== undefined) {
        return { status: 400, error: "invalid_request", message: "A product delivery links a pull request: send pullRequestUrl.", field };
      }
    }
    if (!body.pullRequestUrl) {
      return { status: 400, error: "invalid_request", message: "Send the pull request you delivered.", field: "pullRequestUrl" };
    }
    if ((body.screenshots?.length ?? 0) === 0 && body.testResults === undefined) {
      return { status: 400, error: "invalid_request", message: "Include screenshots of the fix or test results that show it works.", field: "testResults" };
    }
    if (!parsePullRequestUrl(body.pullRequestUrl)) {
      return { status: 400, error: "invalid_request", message: "That is not a GitHub pull request URL.", field: "pullRequestUrl" };
    }
  }

  if (!DELIVERABLE.has(bug.status)) {
    return {
      status: 409,
      error: "not_in_progress",
      message: "Work is delivered while the issue is In progress (or again before it merges). Win a bid or accept an offer first.",
    };
  }

  const claim = await prisma.issueClaim.findFirst({
    where: { bugId: bug.id, agentId: agent.agentId, status: "active", releasedAt: null },
    select: { id: true, beneficiaryUserId: true },
  });
  let beneficiaryUserId = claim?.beneficiaryUserId ?? null;
  /** Set when a manager agent files the delivery on the holder's behalf (#stranded-delivery). */
  let onBehalfOf = false;
  let outsideResubmission = false;
  if (!claim && bug.outsideWork?.agentId === agent.agentId) {
    // A manager may send an imported open PR back to In progress. Its original
    // contributor can revise that delivery without inventing a claim, provided
    // no other agent has since taken the work through the ordinary workflow.
    const otherClaim = await prisma.issueClaim.findFirst({
      where: { bugId: bug.id, releasedAt: null, status: { in: ["active", "planning", "offered"] } }, select: { id: true },
    });
    if (otherClaim) return { status: 409, error: "no_claim", message: "Another agent holds this issue. Only its holder may deliver." };
    beneficiaryUserId = agent.ownerId;
    outsideResubmission = true;
  } else if (!claim) {
    // #539: a reviewer who accepted this issue's review offer may deliver when
    // nothing is delivered yet, so a missing solver doesn't strand the work.
    const reviewOffer = await prisma.reviewOffer.findFirst({
      where: { bugId: bug.id, agentId: agent.agentId, status: "accepted" },
      select: { id: true },
    });
    if (reviewOffer && !bug.pullRequestUrl) {
      beneficiaryUserId = agent.ownerId;
    } else if (!marketing && hasLevel(agent.level, "manager")) {
      const stranded = await strandedDelivery(bug.id);
      if (!stranded) {
        return {
          status: 409,
          error: "not_stranded",
          message: `You hold no claim on this issue. A manager agent delivers on the holder's behalf only when the issue is In progress, has a linked pull request and no delivery, the pull request was linked more than ${STRANDED_AFTER_MS / 3_600_000} hours ago, someone is credited (the claim's beneficiary, the assignee or the owner of the agent that linked it), and enough independent judgements on that pull request say it is good to merge.`,
        };
      }
      const reviewed = await prisma.bug.findUnique({ where: { id: bug.id }, select: reviewedSelect });
      const conflict = reviewed ? reviewerConflict({ id: agent.agentId, ownerUserId: agent.ownerId }, reviewed) : null;
      // #owner-agents: the credited person's own manager agent may file it too.
      if (conflict) {
        return { status: 403, error: "not_independent", message: new ReviewerNotIndependentError(conflict).message };
      }
      if (body.pullRequestUrl !== stranded.pullRequestUrl) {
        return {
          status: 409,
          error: "wrong_pull_request",
          message: `Deliver the pull request linked to this issue on the holder's behalf: ${stranded.pullRequestUrl}.`,
          field: "pullRequestUrl",
        };
      }
      beneficiaryUserId = stranded.creditedUserId;
      onBehalfOf = true;
    } else {
      return { status: 409, error: "no_claim", message: "Only the agent holding the claim delivers the work. Win a bid or accept an offer first." };
    }
  }

  // Marketing work stops here: no pull request, repository, report or head commit.
  const pullRequestUrl = marketing ? null : body.pullRequestUrl!;
  const headSha = marketing ? null : body.headSha ?? null;
  /** Set when this delivery replaces an accepted pull request that was closed unmerged (#replacement-pr). */
  let replacing: { acceptanceId: string; previous: string } | null = null;
  if (!marketing) {
    const ref = parsePullRequestUrl(pullRequestUrl!)!;
    const repo = repoForPullRequest(bug.project, pullRequestUrl);
    if (repo && !sameRepo(ref, repo)) {
      return { status: 422, error: "wrong_repository", message: "That pull request is not in this project's repository.", field: "pullRequestUrl" };
    }
    // #489: an accepted fix is bound to the pull request that was reviewed.
    // #replacement-pr: unless that pull request was closed without merging, so it
    // can never merge: then a replacement is delivered and review starts again.
    const gate = await acceptedFixGate(bug.id, bug.pullRequestUrl);
    if (gate.acceptance && bug.pullRequestUrl && bug.pullRequestUrl !== pullRequestUrl) {
      if (!gate.replaceable) {
        return {
          status: 409,
          error: "accepted_pull_request",
          message: "This issue's accepted fix is bound to a different pull request: deliver the accepted one. (A replacement is accepted only when the accepted pull request is reported closed without merging.)",
        };
      }
      replacing = { acceptanceId: gate.acceptance.id, previous: bug.pullRequestUrl };
    }

    // The pull request has to be open: the latest independent report on it says
    // so, or nobody has reported it yet (#pr-reports, #github-status).
    const report = await latestPullRequestReport(bug.id, pullRequestUrl!);
    const reporter = report?.agent ? `reported by ${report.agent.name}` : "read on GitHub by Ziki";
    const reported = report ? ` (${reporter} at ${(report.checkedAt ?? report.createdAt).toISOString()}; report again if that changed)` : "";
    if (report?.state === "merged") {
      return { status: 422, error: "pull_request_merged", message: `That pull request is already merged${reported}. Only an open pull request can be delivered.` };
    }
    if (report?.state === "closed") {
      return { status: 422, error: "pull_request_closed", message: `That pull request is closed${reported}. Reopen it or open a new one, then deliver.` };
    }
    if (report?.state === "not_found") {
      return { status: 422, error: "pull_request_not_found", message: `That pull request doesn't exist on GitHub${reported}. Open one, then deliver it.` };
    }
  }

  const testResults = marketing ? null : body.testResults === undefined ? null : typeof body.testResults === "string" ? body.testResults : JSON.stringify(body.testResults);
  const screenshots = body.screenshots ?? [];
  const attachmentIds = marketing ? [...new Set(body.attachmentIds ?? [])] : [];
  if (attachmentIds.length > 0) {
    const owned = await prisma.attachment.count({
      where: { id: { in: attachmentIds }, uploaderId: agent.ownerId, bugId: null, ideaId: null, commentId: null, confirmationId: null },
    });
    if (owned !== attachmentIds.length) {
      const message = "One or more attachmentIds weren't found, belong to someone else, or are already attached.";
      return { status: 422, error: "invalid_attachments", message, field: "attachmentIds" };
    }
  }
  const from = bug.substatus;

  const { delivery, replaced } = await prisma.$transaction(async (tx) => {
    if (outsideResubmission) {
      await tx.$queryRaw`SELECT "id" FROM "Bug" WHERE "id" = ${bug.id} FOR UPDATE`;
      const current = await tx.bug.findUnique({ where: { id: bug.id }, select: { status: true, pullRequestUrl: true, assigneeId: true } });
      const held = await tx.issueClaim.findFirst({ where: { bugId: bug.id, releasedAt: null, status: { in: ["active", "planning", "offered"] } }, select: { id: true } });
      if (!current || current.status !== bug.status || current.pullRequestUrl !== bug.pullRequestUrl || current.assigneeId !== agent.ownerId || held) {
        throw new IssueApiError(409, "This issue's state or holder changed. Read it again before revising the imported delivery.");
      }
    }
    const existing = await tx.delivery.findUnique({ where: { bugId_agentId: { bugId: bug.id, agentId: agent.agentId } }, select: { id: true } });
    const data = {
      beneficiaryUserId: beneficiaryUserId!,
      summary: body.summary,
      description: body.description,
      reason: body.reason ?? null,
      pullRequestUrl,
      deliverableText: marketing ? body.deliverableText ?? null : null,
      deliverableUrls: marketing ? body.deliverableUrls ?? [] : [],
      headSha,
      screenshots,
      testResults,
      // Delivering again replaces the delivery, its receipt included.
      receipt: body.receipt ?? Prisma.JsonNull,
    };
    const saved = existing
      ? await tx.delivery.update({ where: { id: existing.id }, data, select: { id: true } })
      : await tx.delivery.create({ data: { ...data, bugId: bug.id, agentId: agent.agentId }, select: { id: true } });

    // The deliverer's own uploads, attached to the issue as part of the delivery.
    if (attachmentIds.length > 0) {
      await linkAttachments(tx, { ids: attachmentIds, uploaderId: agent.ownerId, bugId: bug.id });
    }

    await tx.bug.update({
      where: { id: bug.id },
      data: {
        ...moveTo("requires_review"),
        ...(screenshots.length ? { proofLinks: { push: screenshots } } : {}),
        ...(marketing ? {} : { pullRequestUrl: pullRequestUrl!, pullRequestHeadSha: headSha }),
      },
    });
    if (!marketing) {
      // #539: verdicts recorded without a pull request can only have meant this one.
      await tx.testVerdict.updateMany({
        where: { bugId: bug.id, OR: [{ pullRequestUrl: null }, { pullRequestUrl: "" }] },
        data: { pullRequestUrl: pullRequestUrl! },
      });
    }
    // #replacement-pr: the accepted pull request is closed unmerged; the acceptance goes
    // with it and the replacement is reviewed afresh.
    if (replacing) {
      await releaseAcceptedFix(tx, { bugId: bug.id, acceptanceId: replacing.acceptanceId, previous: replacing.previous, next: pullRequestUrl!, actorUserId: agent.ownerId });
    }
    await tx.bugActivity.create({
      data: {
        bugId: bug.id,
        actorId: agent.ownerId,
        type: "status_changed",
        summary: marketing
          ? "delivered the work"
          : replacing
            ? `delivered the work in ${pullRequestUrl}, replacing ${replacing.previous}`
            : `delivered the work in ${pullRequestUrl}`,
        metadata: {
          field: "status",
          from,
          to: "requires_review",
          deliveryId: saved.id,
          ...(replacing ? { replacesPullRequestUrl: replacing.previous } : {}),
          ...(marketing
            ? { deliverableUrls: body.deliverableUrls ?? [], attachmentIds }
            : { pullRequestUrl: pullRequestUrl! }),
          replaced: Boolean(existing),
          ...(onBehalfOf ? { onBehalfOf: true, creditedUserId: beneficiaryUserId! } : {}),
        },
      },
    });
    const payload: Prisma.InputJsonObject = {
      issueId: bug.id,
      projectId: bug.projectId,
      deliveryId: saved.id,
      ...(marketing ? { deliverableUrls: body.deliverableUrls ?? [] } : { pullRequestUrl: pullRequestUrl!, headSha }),
      summary: body.summary,
      agentId: agent.agentId,
      ...(replacing ? { replacesPullRequestUrl: replacing.previous } : {}),
      // #delivery-receipt: the receipt travels with the event, so a listener can judge against it.
      ...(body.receipt ? { receipt: body.receipt } : {}),
      // #stranded-delivery: a manager agent filed it for the person credited.
      ...(onBehalfOf ? { onBehalfOf: true, filedBy: agent.agentId, creditedUserId: beneficiaryUserId! } : {}),
    };
    await publish(tx, { organisationId: agent.organisationId, type: "issue.delivered", payload, actorAgentId: agent.agentId, bugId: bug.id });
    await audit({ agentId: agent.agentId, organisationId: agent.organisationId }, "issue.delivered", `bug:${bug.id}`, payload, { db: tx, bugId: bug.id });
    return { delivery: saved, replaced: Boolean(existing) };
  });

  // #stranded-delivery: the judgements already given on this pull request are
  // evaluated at once, as a new judgement would be, so enough of them make it Done.
  const judged = onBehalfOf ? await refreshJudgedStatus(prisma, bug.id, agent.ownerId) : null;
  if (!marketing && judged !== "accepted") {
    await createReviewOffers(prisma, { agentId: agent.agentId, organisationId: agent.organisationId }, bug.id, { pullRequestUrl: pullRequestUrl!, headSha }).catch(() => null);
  }

  const entries = await deliveryEntries({ id: bug.id, pullRequestUrl });
  const entry = entries.find((row) => row.id === delivery.id)!;
  return { status: replaced ? 200 : 201, delivery: entry, replaced, issueId: bug.id, pullRequestUrl };
}
