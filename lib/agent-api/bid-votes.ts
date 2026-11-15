import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { AgentContext } from "@/lib/agents/require-agent";
import { hasLevel, requireLevel } from "@/lib/agents/levels";
import { audit } from "@/lib/agents/audit";
import { IssueApiError } from "@/lib/agent-api/errors";
import { publish } from "@/lib/agent-api/events";
import { AWARDABLE_SUBSTATUSES } from "@/lib/issue-substatus";
import { afterAward, awardInTransaction, bidTally, type AwardResult } from "@/lib/agent-api/bid";
import { workflowFor } from "@/lib/workflow";
import { isThresholdOnly, thresholdDecision } from "@/lib/governance";
import { isAtCapacityError } from "@/lib/agent-api/capacity";
import { award as awardPoints } from "@/lib/points/award";
import { VOTE_POINTS, bidVoteSourceKey } from "@/lib/points/rules";

/**
 * Bid votes (#bid-votes). When a bid comes in, agents vote it up if they think
 * it is good. One vote per person per bid; voting again is fine and is
 * counted once. A working agent can't vote for its own owner's bid; a manager
 * or merger agent can, so a manager acts through the same votes as everyone.
 *
 * The tally is weighted in both governance modes (lib/governance.ts): a
 * manager or merger agent's vote counts the project's `managerVoteWeight`,
 * any other counts 1. Once a bid's tally reaches the project's
 * `awardThreshold`, any agent may award it (lib/agent-api/bid.ts `awardBid`).
 * In a threshold-only project (#vote-governance) the vote that brings a bid to
 * the threshold awards it as well, in the same transaction. If the issue can't
 * be awarded right then (an offer is still pending), the vote stands and the
 * award waits.
 */

export type BidVoteResult = {
  bidId: string;
  /** The bid's weighted votes. */
  votes: number;
  /** The project's awardThreshold: once `votes` reaches it, any agent may award the bid. */
  threshold: number;
  /** True when this vote awarded the bid (threshold-only). */
  awarded: boolean;
  /** The offer's claim, when it awarded the bid. */
  claimId?: string;
  /** Why the bid at the threshold was not awarded yet, when that happened: `at_capacity` when its bidder holds the project's limit, else the reason in words. */
  awardBlocked?: string;
};

/**
 * `POST /api/v1/bids/{id}/votes` (working): vote for an open bid. The bid must
 * not be awarded or withdrawn, and its issue must be Open. 403 `own_bid` when
 * a working agent's owner is the bid's beneficiary or its agent's owner; a
 * manager or merger agent may vote for its own owner's bid.
 */
export async function voteForBid(agent: AgentContext, projectId: string, bidId: string): Promise<BidVoteResult> {
  requireLevel(agent, "working");
  const found = await prisma.issueBid.findUnique({
    where: { id: bidId },
    select: { id: true, bugId: true, bug: { select: { organisationId: true, projectId: true, isDeleted: true } } },
  });
  if (!found || found.bug.organisationId !== agent.organisationId || found.bug.projectId !== projectId || found.bug.isDeleted) {
    throw new IssueApiError(404, "Bid not found.");
  }
  const workflow = await workflowFor(projectId);
  const thresholdOnly = isThresholdOnly(workflow);

  const result = await prisma.$transaction(async (tx) => {
    // Lock the issue as an award does, so a vote never lands on a bid being awarded.
    await tx.$queryRaw`SELECT "id" FROM "Bug" WHERE "id" = ${found.bugId} AND "isDeleted" = false FOR UPDATE`;
    const bid = await tx.issueBid.findUnique({
      where: { id: bidId },
      select: {
        id: true, bugId: true, agentId: true, beneficiaryUserId: true, withdrawnAt: true, awardedAt: true,
        agent: { select: { ownerUserId: true } },
        bug: { select: { number: true, substatus: true } },
      },
    });
    if (!bid) throw new IssueApiError(404, "Bid not found.");
    if (bid.withdrawnAt || bid.awardedAt) throw new IssueApiError(409, "This bid is no longer open.");
    if (!AWARDABLE_SUBSTATUSES.includes(bid.bug.substatus)) throw new IssueApiError(409, "Only bids on open (or Live · Broken) issues take votes.");
    const ownBid = agent.ownerId === bid.beneficiaryUserId || agent.ownerId === bid.agent.ownerUserId;
    if (ownBid && !hasLevel(agent.level, "manager")) {
      const message = "This is your owner's own bid; other agents vote for it.";
      throw new IssueApiError(403, message, { error: "own_bid", message });
    }
    const created = await tx.bidVote.createMany({
      data: [{ bidId: bid.id, bugId: bid.bugId, onBehalfOfUserId: agent.ownerId, agentId: agent.agentId }],
      skipDuplicates: true,
    });
    const votes = await bidTally(bid.id, workflow.managerVoteWeight, agent.organisationId, tx);
    if (created.count) {
      // A person's first bid vote on an issue earns a point (#vote-points).
      await awardPoints(tx, {
        organisationId: agent.organisationId,
        userId: agent.ownerId,
        bugId: bid.bugId,
        role: "vote",
        points: VOTE_POINTS,
        sourceKey: bidVoteSourceKey(bid.bugId, agent.ownerId),
        agentId: agent.agentId,
      });
      await publish(tx, {
        organisationId: agent.organisationId,
        type: "issue.bid_voted",
        actorAgentId: agent.agentId,
        bugId: bid.bugId,
        projectId,
        payload: { bidId: bid.id, issueId: bid.bugId, issueNumber: bid.bug.number, projectId, bidAgentId: bid.agentId, votes },
      });
    }
    // Threshold-only (#vote-governance): the vote that reaches awardThreshold awards the bid.
    let award: AwardResult | null = null;
    let awardBlocked: string | undefined;
    if (thresholdOnly && votes >= workflow.awardThreshold) {
      const by = { userId: agent.ownerId, agentId: agent.agentId };
      try {
        award = await awardInTransaction(tx, bid.id, by, thresholdDecision(by, votes, workflow.awardThreshold));
      } catch (error) {
        // A refused award writes nothing (awardInTransaction), so the vote still stands.
        if (!(error instanceof IssueApiError) || error.status !== 409) throw error;
        // A bid at capacity is skipped (#bidder-capacity): the code, so agents can tell it apart.
        awardBlocked = isAtCapacityError(error) ? "at_capacity" : error.message;
      }
    }
    return { bidId: bid.id, bugId: bid.bugId, votes, created: created.count > 0, award, awardBlocked };
  }).catch((error: unknown) => {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new IssueApiError(409, "This issue already has an active claim.");
    }
    throw error;
  });
  if (result.created) {
    await audit(agent, "issue.bid_voted", `issue:${result.bugId}`, { bidId: result.bidId, votes: result.votes }, { bugId: result.bugId });
  }
  if (result.award) {
    await audit(
      agent,
      "issue.bid_awarded",
      `issue:${result.bugId}`,
      { bidId: result.bidId, claimId: result.award.claimId, votes: result.votes, threshold: workflow.awardThreshold, via: "threshold" },
      { bugId: result.bugId },
    );
    afterAward(result.award);
  }
  return {
    bidId: result.bidId,
    votes: result.votes,
    threshold: workflow.awardThreshold,
    awarded: Boolean(result.award),
    ...(result.award ? { claimId: result.award.claimId } : {}),
    ...(result.awardBlocked ? { awardBlocked: result.awardBlocked } : {}),
  };
}
