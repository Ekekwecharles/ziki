import { PRODUCT_TRACK, trackFilter } from "@/lib/marketing/track";
import { prisma } from "@/lib/prisma";
import type { AgentContext } from "@/lib/agents/require-agent";
import { requireLevel } from "@/lib/agents/levels";
import { liveHoldWhere } from "@/lib/issue-holders";
import { openIssueConfirmations, type ConfirmationState } from "@/lib/issue-stage";
import { workflowFor } from "@/lib/workflow";
import type { Substatus, WorkTrack } from "@prisma/client";

export type ClaimableIssue = {
  id: string;
  number: number;
  title: string;
  projectId: string;
  voteCount: number;
  createdAt: Date;
  /** Open, or merged_broken: force-merged and judged faulty (#force-merge). */
  substatus: Substatus;
};

/**
 * Scan for unassigned issues that are ready to be worked on.
 *
 * Ordered oldest first, so older issues are picked up first. An unassigned
 * issue whose earlier awards were released, or whose offer expired, is free
 * again (#bids-only-offers). Readiness comes from one bulk read (`openIssueConfirmations`), so the
 * database returns only ready rows and `limit` is never eaten by unconfirmed
 * ones (#714). Pass `confirmations` to reuse a read the caller already made.
 */
export async function findClaimableIssues(
  agent: AgentContext,
  projectId: string,
  confirmations?: Map<string, ConfirmationState>,
  track: WorkTrack = "product",
): Promise<ClaimableIssue[]> {
  requireLevel(agent, "working");
  const workflow = await workflowFor(projectId);

  if (track === "marketing") {
    // Marketing issues are ready as soon as they are open (no confirmation step).
    return prisma.bug.findMany({
      where: {
        organisationId: agent.organisationId,
        projectId,
        ...trackFilter(track),
        status: "open",
        substatus: "open",
        claims: { none: liveHoldWhere(workflow.offerWindowSeconds) },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        number: true,
        title: true,
        projectId: true,
        voteCount: true,
        createdAt: true,
        substatus: true,
      },
    });
  }

  const stages = confirmations ?? await openIssueConfirmations(prisma, { ...PRODUCT_TRACK, organisationId: agent.organisationId, projectId });
  const readyIds = [...stages].filter(([, confirmation]) => confirmation.stage === "ready").map(([id]) => id);

  return prisma.bug.findMany({
    where: {
      // Confirmed and open, or Live · Broken: force-merged and judged faulty, waiting for a fix (#force-merge).
      OR: [{ id: { in: readyIds } }, { status: "resolved", substatus: "merged_broken", isDeleted: false }],
      organisationId: agent.organisationId,
      projectId,
      ...PRODUCT_TRACK,
      // Nothing holds it (liveHoldWhere); a stale assignee does not (#stale-assignee).
      claims: { none: liveHoldWhere(workflow.offerWindowSeconds) },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      number: true,
      title: true,
      projectId: true,
      voteCount: true,
      createdAt: true,
      substatus: true,
    },
  });
}
