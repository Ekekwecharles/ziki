import { trackFilter } from "@/lib/marketing/track";
import { prisma } from "@/lib/prisma";
import type { AgentContext } from "@/lib/agents/require-agent";
import { requireLevel } from "@/lib/agents/levels";
import { reviewerConflict } from "@/lib/agents/independence";
import type { WorkTrack } from "@prisma/client";

export type ReviewType = "confirmation" | "test";

export type ReviewableIssue = {
  id: string;
  number: number;
  title: string;
  projectId: string;
  stage: "ready";
  reviewType: ReviewType;
  pullRequestUrl?: string | null;
  createdAt: Date;
  /** Force-merged (#force-merge): already merged by its author, judged afterwards. */
  forceMerged?: boolean;
};

/**
 * Scan for linked fixes that need a test verdict.
 */
export async function findReviewableIssues(
  agent: AgentContext,
  projectId: string,
  reviewType: "test" = "test",
  track: WorkTrack = "product",
): Promise<ReviewableIssue[]> {
  requireLevel(agent, "working");

  const results: ReviewableIssue[] = [];

  // Delivered work to judge (#delivered-step). Issues to confirm come from
  // openIssueConfirmations() in the work feed (#714).
  if (reviewType === "test") {
    const testCandidates = await prisma.bug.findMany({
      where: {
        organisationId: agent.organisationId,
        projectId,
        ...trackFilter(track),
        isDeleted: false,
        // #force-merge: work merged by its author without Ziki's checks is judged afterwards too.
        substatus: { in: ["requires_review", "force_merged"] },
        ...(track === "marketing" ? {} : { pullRequestUrl: { not: null } }),
        testVerdicts: {
          none: {
            agentId: agent.agentId,
          },
        },
      },
      orderBy: { createdAt: "asc" },
      select: {
        outsideWork: { select: { agentId: true } },
        id: true,
        number: true,
        title: true,
        projectId: true,
        pullRequestUrl: true,
        substatus: true,
        reporterId: true,
        beneficiaryUserId: true,
        createdByAgentId: true,
        createdByAgent: { select: { ownerUserId: true } },
        createdAt: true,
        claims: {
          // The claim a force-merged fix was done under is released at the merge, and its agent still can't judge it.
          where: { OR: [{ status: "active", releasedAt: null }, { releaseReason: "force_merge" }] },
          select: { agentId: true, beneficiaryUserId: true, agent: { select: { ownerUserId: true } } },
        },
      },
    });

    for (const bug of testCandidates) {
      const reviewed = {
        outsideWork: bug.outsideWork,
        reporterId: bug.reporterId,
        beneficiaryUserId: bug.beneficiaryUserId,
        createdByAgentId: bug.createdByAgentId,
        createdByAgent: bug.createdByAgent,
        claims: bug.claims.map((c) => ({
          status: "active" as const,
          releasedAt: null,
          agentId: c.agentId,
          beneficiaryUserId: c.beneficiaryUserId,
          agent: c.agent,
        })),
      };
      if (reviewerConflict({ id: agent.agentId, ownerUserId: agent.ownerId }, reviewed)) continue;

      results.push({
        id: bug.id,
        number: bug.number,
        title: bug.title,
        projectId: bug.projectId,
        stage: "ready",
        reviewType: "test",
        pullRequestUrl: bug.pullRequestUrl,
        createdAt: bug.createdAt,
        ...(bug.substatus === "force_merged" ? { forceMerged: true } : {}),
      });
    }
  }

  return results;
}
