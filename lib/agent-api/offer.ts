import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { AgentContext } from "@/lib/agents/require-agent";
import { IssueApiError } from "@/lib/agent-api/errors";
import { publish } from "@/lib/agent-api/events";
import { workflowFor } from "@/lib/workflow";
import { DEFAULT_PROJECT_WORKFLOW } from "@/lib/workflow-config";
import { canAssignTicket } from "@/lib/ticket-assignment";
import { assigneeChangedSummary, statusChangedSummary } from "@/lib/activity-log";
import { ensureWatching } from "@/lib/watch";
import { deliveryDeadline, deliveryWindowMinutes } from "@/lib/claim-deadline";
import { parseIssueRef, resolveIssueRef } from "@/lib/issue-ref";
import { AWARDABLE_SUBSTATUSES, moveTo } from "@/lib/issue-substatus";
import { releasePlanningClaim } from "@/lib/agent-api/plan";
import { notifyLater } from "@/lib/notify";

/**
 * Offers (#bids-only-offers). Only awarding a bid makes an offer: any agent
 * awards a bid whose votes reached the project's awardThreshold
 * (lib/agent-api/bid.ts `awardBid`), or in a threshold-only project the vote
 * that reaches it does. Nothing else offers an issue. An offer the agent does not accept in the
 * project's window expires, and a declined, expired or released offer leaves
 * the issue in Open for bids.
 */

/** Pure helper/tests default; requests use the project's offerWindowSeconds. */
export const OFFER_TTL_MS = DEFAULT_PROJECT_WORKFLOW.offerWindowSeconds * 1000;
const id = z.string().trim().min(1).max(191);

export function isOfferExpired(
  offeredAt: Date | null,
  now = Date.now(),
  windowMs = OFFER_TTL_MS,
): boolean {
  return !offeredAt || now - offeredAt.getTime() >= windowMs;
}

/**
 * Offers have a durable due date (`offeredAt + the project's offerWindowSeconds`) swept by the platform runner (#647).
 * Replaces in-process setTimeout so serverless and multi-instance deploys do not rely on dying timers (#527, #647).
 */
export function scheduleOfferExpiry(claimId?: string): void {
  void claimId;
  // Expiry is handled by sweepExpiredOffers on the scheduled runner.
}

/** Durable expiry state is checked here and again on acceptance after restarts. Returns true if expired. */
export async function expireOffer(claimId: string): Promise<boolean> {
  const result = await prisma.$transaction(async (tx) => {
    const claim = await tx.issueClaim.findUnique({ where: { id: claimId }, select: { id: true, bugId: true, status: true, offeredAt: true, releasedAt: true, agentId: true, beneficiaryUserId: true, bug: { select: { organisationId: true, id: true, title: true, projectId: true, assigneeId: true, areaId: true } } } });
    if (!claim || claim.status !== "offered" || claim.releasedAt) return null;
    const { offerWindowSeconds } = await workflowFor(claim.bug.projectId, tx);
    const offerWindowMs = offerWindowSeconds * 1000;
    if (!isOfferExpired(claim.offeredAt, Date.now(), offerWindowMs)) return null;
    await tx.$queryRaw`SELECT "id" FROM "Bug" WHERE "id" = ${claim.bugId} FOR UPDATE`;
    const fresh = await tx.issueClaim.findUnique({ where: { id: claimId }, select: { id: true, bugId: true, status: true, offeredAt: true, releasedAt: true, agentId: true, beneficiaryUserId: true, bug: { select: { organisationId: true, id: true, title: true, projectId: true, assigneeId: true, areaId: true } } } });
    if (!fresh || fresh.status !== "offered" || fresh.releasedAt || !isOfferExpired(fresh.offeredAt, Date.now(), offerWindowMs)) return null;
    const now = new Date();
    await tx.issueClaim.update({ where: { id: claimId }, data: { status: "released", releasedAt: now, releaseReason: "expired" } });
    await publish(tx, { organisationId: fresh.bug.organisationId, type: "claim.released", actorAgentId: fresh.agentId, bugId: fresh.bugId,
      payload: { claimId, issueId: fresh.bugId, beneficiaryUserId: fresh.beneficiaryUserId, reason: "expired" } });
    // The issue stays Open for bids; nobody is offered it in turn.
    return { released: true };
  });
  return Boolean(result);
}

/**
 * Sweeps and expires all pending offers whose TTL has elapsed (#681).
 * Durable across process restarts; safe to run from a cron or interval.
 */
export async function sweepExpiredOffers(organisationId?: string, projectId?: string): Promise<{ expired: number }> {
  // Offers in different projects can have different windows, so the decision
  // is made per candidate instead of with one global cutoff.
  const candidates = await prisma.issueClaim.findMany({
    where: {
      status: "offered",
      releasedAt: null,
      ...(organisationId || projectId
        ? {
            bug: {
              ...(organisationId ? { organisationId } : {}),
              ...(projectId ? { projectId } : {}),
            },
          }
        : {}),
    },
    select: { id: true, offeredAt: true, bug: { select: { projectId: true } } },
  });
  const now = Date.now();
  let expired = 0;
  for (const candidate of candidates) {
    const { offerWindowSeconds } = await workflowFor(candidate.bug.projectId);
    if (!isOfferExpired(candidate.offeredAt, now, offerWindowSeconds * 1000)) continue;
    const didExpire = await expireOffer(candidate.id);
    if (didExpire) expired++;
  }
  return { expired };
}

export async function acceptOffer(agent: AgentContext, claimId: string) {
  if (agent.pausedAt) throw new IssueApiError(423, "This agent is paused by its owner.");
  try {
    const result = await prisma.$transaction(async (tx) => {
      const claim = await tx.issueClaim.findUnique({ where: { id: claimId }, include: { beneficiary: { select: { name: true } }, bug: { select: { id: true, title: true, substatus: true, assigneeId: true, organisationId: true, projectId: true, areaId: true, voteCount: true, assignee: { select: { name: true } } } } } });
      if (!claim || claim.bug.organisationId !== agent.organisationId) throw new IssueApiError(404, "Offer not found.");
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Bug" WHERE "id" = ${claim.bugId} AND "organisationId" = ${agent.organisationId} FOR UPDATE`;
      if (!locked.length) throw new IssueApiError(404, "Offer not found.");
      const agents = await tx.$queryRaw<{ pausedAt: Date | null }[]>`SELECT "pausedAt" FROM "Agent" WHERE "id" = ${agent.agentId} FOR UPDATE`;
      if (agents[0]?.pausedAt) throw new IssueApiError(423, "This agent is paused by its owner.");
      await tx.$queryRaw`SELECT "id" FROM "IssueClaim" WHERE "id" = ${claimId} FOR UPDATE`;
      const fresh = await tx.issueClaim.findUnique({ where: { id: claimId }, include: { beneficiary: { select: { name: true } }, bug: { select: { id: true, title: true, substatus: true, assigneeId: true, organisationId: true, projectId: true, areaId: true, voteCount: true, assignee: { select: { name: true } } } } } });
      if (!fresh || fresh.agentId !== agent.agentId) throw new IssueApiError(409, "This offer is no longer available to this agent.");
      if (fresh.status === "released" && fresh.releaseReason === "expired") throw new IssueApiError(410, "This offer expired and has been released.");
      if (fresh.status !== "offered" || fresh.releasedAt) throw new IssueApiError(409, "This offer is no longer available to this agent.");

      // Check if an active claim already exists on this bug (#662)
      const existingActive = await tx.issueClaim.findFirst({
        where: { bugId: fresh.bugId, status: "active", releasedAt: null, id: { not: fresh.id } },
      });
      if (existingActive) {
        throw new IssueApiError(409, "This issue already has an active claim.");
      }

      const now = new Date();
      const workflow = await workflowFor(fresh.bug.projectId, tx);
      if (isOfferExpired(fresh.offeredAt, now.getTime(), workflow.offerWindowSeconds * 1000)) {
        await tx.issueClaim.update({ where: { id: fresh.id }, data: { status: "released", releasedAt: now, releaseReason: "expired" } });
        await publish(tx, { organisationId: agent.organisationId, type: "claim.released", actorAgentId: agent.agentId, bugId: fresh.bugId,
          payload: { claimId: fresh.id, issueId: fresh.bugId, beneficiaryUserId: fresh.beneficiaryUserId, reason: "expired" } });
        return { expired: true as const };
      }
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${fresh.beneficiaryUserId} FOR UPDATE`;
      const activeClaims = await tx.issueClaim.count({ where: {
        beneficiaryUserId: fresh.beneficiaryUserId, status: "active", releasedAt: null,
        // #760: delivered work (Done, Merge) no longer takes a slot; only work In progress does.
        bug: { organisationId: agent.organisationId, projectId: fresh.bug.projectId, isDeleted: false, status: "in_progress" },
      } });
      if (activeClaims >= workflow.maxActiveClaims) {
        await tx.issueClaim.update({ where: { id: fresh.id }, data: { status: "released", releasedAt: now, releaseReason: "capacity" } });
        await publish(tx, { organisationId: agent.organisationId, type: "claim.released", actorAgentId: agent.agentId, bugId: fresh.bugId,
          payload: { claimId: fresh.id, issueId: fresh.bugId, beneficiaryUserId: fresh.beneficiaryUserId, reason: "capacity" } });
        return { unavailable: true as const };
      }
      if (!AWARDABLE_SUBSTATUSES.includes(fresh.bug.substatus) || !canAssignTicket({ actorId: fresh.beneficiaryUserId, actorRole: "user", currentAssigneeId: fresh.bug.assigneeId, targetAssigneeId: fresh.beneficiaryUserId, claimed: true })) {
        await tx.issueClaim.update({ where: { id: fresh.id }, data: { status: "released", releasedAt: now, releaseReason: "unavailable" } });
        await publish(tx, { organisationId: agent.organisationId, type: "claim.released", actorAgentId: agent.agentId, bugId: fresh.bugId,
          payload: { claimId: fresh.id, issueId: fresh.bugId, beneficiaryUserId: fresh.beneficiaryUserId, reason: "unavailable" } });
        return { unavailable: true as const };
      }
      const deliverBy = deliveryDeadline(now, deliveryWindowMinutes(workflow.deliveryMinutes));
      await tx.issueClaim.update({ where: { id: fresh.id }, data: { status: "active", claimedAt: now, lastHeartbeatAt: now, deliverBy } });
      const issue = await tx.bug.update({ where: { id: fresh.bugId }, data: { assigneeId: fresh.beneficiaryUserId, ...moveTo("in_progress") }, select: { id: true, assigneeId: true, status: true, substatus: true } });
      await tx.bugActivity.createMany({ data: [
        ...(fresh.bug.assigneeId !== fresh.beneficiaryUserId ? [{ bugId: fresh.bugId, actorId: fresh.beneficiaryUserId, type: "assignee_changed" as const, summary: assigneeChangedSummary(fresh.bug.assignee?.name ?? null, fresh.beneficiary.name), metadata: { field: "assignee", from: fresh.bug.assigneeId, to: fresh.beneficiaryUserId } }] : []),
        { bugId: fresh.bugId, actorId: fresh.beneficiaryUserId, type: "status_changed", summary: statusChangedSummary(fresh.bug.substatus, "in_progress"), metadata: { field: "status", from: fresh.bug.substatus, to: "in_progress" } },
      ] });
      await ensureWatching(tx, fresh.bugId, [fresh.beneficiaryUserId]);
      // An accepted bid award: the other open bids on the issue are withdrawn.
      if (tx.issueBid?.findFirst && await tx.issueBid.findFirst({ where: { claimId: fresh.id }, select: { id: true } })) {
        await tx.issueBid.updateMany({ where: { bugId: fresh.bugId, withdrawnAt: null, awardedAt: null }, data: { withdrawnAt: now } });
      }
      await publish(tx, { organisationId: agent.organisationId, type: "claim.accepted", actorAgentId: agent.agentId, bugId: fresh.bugId,
        payload: { claimId: fresh.id, issueId: fresh.bugId, projectId: fresh.bug.projectId, beneficiaryUserId: fresh.beneficiaryUserId } });
      return { expired: false as const, claim: { ...fresh, status: "active", claimedAt: now, deliverBy }, issue };
    }, { maxWait: 10000, timeout: 15000 });
    if ("expired" in result && result.expired) {
      throw new IssueApiError(410, "This offer expired and has been released.");
    }
    if ("unavailable" in result) {
      throw new IssueApiError(409, "The issue can no longer be assigned to this person.");
    }
    return result;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new IssueApiError(409, "This issue already has an active claim.");
    }
    throw error;
  }
}

export const releaseSchema = z.object({
  projectId: id.optional(),
  /** Why the agent is giving the work back, shown in the audit log. */
  reason: z.string().trim().max(500).optional(),
}).strict();

/**
 * An agent gives back an issue it holds (#547): declines a pending offer, or
 * releases an active claim it can't finish, without waiting for an offer to
 * expire or a heartbeat to lapse.
 *
 * - Only the agent holding the offer or claim can release it.
 * - releaseReason is "declined" for an offer and "agent" for an active claim.
 *   Neither counts as a silence release, so giving work back promptly is never
 *   penalised the way going quiet is.
 * - An active claim's issue goes back to open and unassigned, unless a person
 *   has reassigned or resolved it since.
 * - Nobody is offered it in turn: the issue waits in Open for bids, and once
 *   a bid has enough votes any agent awards it.
 */
export async function releaseClaim(agent: AgentContext, projectId: string, issueRef: string, reason?: string) {
  let reopenedBug: { id: string; title: string; reporterId: string } | null = null;
  const result = await prisma.$transaction(async (tx) => {
    // #605: the path may be the readable number (`123`, `ZE-123`) or the id, as on reads.
    const ref = parseIssueRef(issueRef);
    const bugId = ref.kind === "id" ? ref.id : (await resolveIssueRef(tx, ref, { organisationId: agent.organisationId }))?.id;
    if (!bugId) throw new IssueApiError(404, "Issue not found in this project.");
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Bug" WHERE "id" = ${bugId} AND "organisationId" = ${agent.organisationId} AND "projectId" = ${projectId} AND "isDeleted" = false FOR NO KEY UPDATE`;
    if (!locked.length) throw new IssueApiError(404, "Issue not found in this project.");
    const claim = await tx.issueClaim.findFirst({
      where: { bugId, agentId: agent.agentId, releasedAt: null, status: { in: ["offered", "planning", "active"] } },
      include: { beneficiary: { select: { name: true } } },
    });
    if (!claim) throw new IssueApiError(409, "This agent holds no offer or claim on this issue.");
    // #plan-review: giving up an award under plan review is a decline; the issue is Open for bids again (the agent bids afresh, as after an expired offer).
    if (claim.status === "planning") {
      await releasePlanningClaim(tx, claim, "declined", { actorAgentId: agent.agentId, organisationId: agent.organisationId });
      return { claimId: claim.id, issueId: bugId, reason: "declined" as const, reopened: true };
    }
    const now = new Date();
    const releaseReason = claim.status === "offered" ? "declined" : "agent";
    await tx.issueClaim.update({ where: { id: claim.id }, data: { status: "released", releasedAt: now, releaseReason } });

    const bug = await tx.bug.findFirstOrThrow({
      where: { id: bugId },
      select: { id: true, title: true, reporterId: true, status: true, assigneeId: true, projectId: true, areaId: true, pullRequestUrl: true },
    });
    let reopened = false;
    if (claim.status === "active") {
      const otherOpen = await tx.issueClaim.count({ where: { bugId, releasedAt: null, id: { not: claim.id } } });
      // A delivered fix stays where it got to (#one-status): only an undelivered one goes back to Open.
      if (!otherOpen && bug.status === "in_progress" && !bug.pullRequestUrl && bug.assigneeId === claim.beneficiaryUserId) {
        await tx.bug.update({ where: { id: bugId }, data: { assigneeId: null, ...moveTo("open") } });
        await tx.bugActivity.createMany({ data: [
          { bugId, actorId: claim.beneficiaryUserId, type: "assignee_changed", summary: assigneeChangedSummary(claim.beneficiary.name, null), metadata: { field: "assignee", from: claim.beneficiaryUserId, to: null } },
          { bugId, actorId: claim.beneficiaryUserId, type: "status_changed", summary: statusChangedSummary("in_progress", "open"), metadata: { field: "status", from: "in_progress", to: "open" } },
        ] });
        reopened = true;
        reopenedBug = { id: bugId, title: bug.title, reporterId: bug.reporterId };
      }
    }
    await publish(tx, { organisationId: agent.organisationId, type: "claim.released", actorAgentId: agent.agentId, bugId,
      payload: { claimId: claim.id, issueId: bugId, beneficiaryUserId: claim.beneficiaryUserId, reason: releaseReason, ...(reason ? { note: reason } : {}) } });

    return { claimId: claim.id, issueId: bugId, reason: releaseReason, reopened: claim.status === "active" ? reopened : false };
  }, { maxWait: 10000, timeout: 15000 });
  if (reopenedBug) {
    const { id, title, reporterId } = reopenedBug as { id: string; title: string; reporterId: string };
    notifyLater({ kind: "status_changed", actorId: agent.ownerId, actorName: agent.name, bugId: id, bugTitle: title, reporterId, from: "in_progress", to: "open" });
  }
  return result;
}
