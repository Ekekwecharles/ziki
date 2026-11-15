import { trackFilter } from "@/lib/marketing/track";
import { prisma } from "@/lib/prisma";
import type { AgentContext } from "@/lib/agents/require-agent";
import { requireLevel } from "@/lib/agents/levels";
import { confirmedIssueIds } from "@/lib/issue-stage";
import { countedMergeVerdicts, deliveredClaim } from "@/lib/agent-api/merge-verdicts";
import { reviewerConflict } from "@/lib/agents/independence";
import { workflowFor } from "@/lib/workflow";
import type { WorkTrack } from "@prisma/client";
import { activeLevels, levelIn } from "@/lib/agents/active-in";

/**
 * The two merge queues (#substatus): tested fixes waiting for a manager's
 * accept (Done · Accepted), and accepted ones waiting to merge (Merge: Ready
 * to merge or Error).
 */
export type MergeQueueStatus = "accepted" | "merge";

const queueWhere = (queue: MergeQueueStatus) => (queue === "accepted" ? { substatus: "accepted" as const } : { status: "merge" as const });

export type ReadyToMergeIssue = {
  id: string;
  number: number;
  title: string;
  projectId: string;
  pullRequestUrl: string | null;
  pullRequestHeadSha: string | null;
  status: MergeQueueStatus;
  claim: {
    agentId: string;
    beneficiaryUserId: string;
  } | null;
  verdictsCount: number;
  createdAt: Date;
};

/**
 * Confirmed issues with a linked pull request at one merge step, that this
 * agent is independent of: `accepted` (tested, waiting for a manager's accept,
 * which also needs enough independent good-to-merge verdicts on the linked
 * pull request) or `merge` (accepted, waiting for the merge, Error
 * included).
 */
export async function findReadyToMergeIssues(
  agent: AgentContext,
  projectId: string,
  status: MergeQueueStatus,
  track: WorkTrack = "product",
): Promise<ReadyToMergeIssue[]> {
  requireLevel(agent, "manager");
  const { verdictsNeeded } = await workflowFor(projectId);

  if (track === "marketing") {
    // Marketing skips the merge queue entirely; only accepted fixes waiting for a manager exist.
    if (status === "merge") return [];

    const candidates = await prisma.bug.findMany({
      where: {
        organisationId: agent.organisationId,
        projectId,
        ...trackFilter(track),
        isDeleted: false,
        substatus: "accepted",
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        number: true,
        title: true,
        projectId: true,
        pullRequestUrl: true,
        pullRequestHeadSha: true,
        reporterId: true,
        beneficiaryUserId: true,
        assigneeId: true,
        createdByAgentId: true,
        createdByAgent: { select: { ownerUserId: true } },
        createdAt: true,
        claims: {
          select: {
            status: true,
            claimedAt: true,
            releasedAt: true,
            agentId: true,
            beneficiaryUserId: true,
            dispatcherUserId: true,
            agent: { select: { ownerUserId: true } },
          },
        },
        testVerdicts: {
          where: { goodToMerge: true },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: {
            id: true,
            headSha: true,
            onBehalfOfUserId: true,
            pullRequestUrl: true,
            agent: { select: { id: true, ownerUserId: true, activations: activeLevels } },
          },
        },
      },
    });

    const ready: ReadyToMergeIssue[] = [];
    for (const bug of candidates) {
      const claim = deliveredClaim(bug);
      const { weight } = countedMergeVerdicts(bug.testVerdicts, claim, bug, agent.organisationId);
      if (weight < verdictsNeeded) continue;
      if (reviewerConflict({ id: agent.agentId, ownerUserId: agent.ownerId }, bug)) continue;

      ready.push({
        id: bug.id,
        number: bug.number,
        title: bug.title,
        projectId: bug.projectId,
        pullRequestUrl: bug.pullRequestUrl ?? null,
        pullRequestHeadSha: bug.pullRequestHeadSha,
        status,
        claim: claim ? { agentId: claim.agentId, beneficiaryUserId: claim.beneficiaryUserId } : null,
        verdictsCount: weight,
        createdAt: bug.createdAt,
      });
    }
    return ready;
  }

  // Confirmation from one bulk read, not one isConfirmed() per row (#714).
  const confirmed = await confirmedIssueIds(prisma, {
    ...trackFilter(track),
    organisationId: agent.organisationId,
    projectId,
    ...queueWhere(status),
    pullRequestUrl: { not: null },
  });
  if (confirmed.size === 0) return [];

  // Fixes in review are few, so read them all (the work feed has no cap).
  const candidates = await prisma.bug.findMany({
    where: {
      id: { in: [...confirmed] },
      organisationId: agent.organisationId,
      projectId,
      ...trackFilter(track),
      isDeleted: false,
      ...queueWhere(status),
      pullRequestUrl: { not: null },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      number: true,
      title: true,
      projectId: true,
      pullRequestUrl: true,
      pullRequestHeadSha: true,
      reporterId: true,
      beneficiaryUserId: true,
      assigneeId: true,
      outsideWork: { select: { agentId: true } },
      createdByAgentId: true,
      createdByAgent: { select: { ownerUserId: true } },
      createdAt: true,
      claims: {
        select: {
          status: true,
          claimedAt: true,
          releasedAt: true,
          agentId: true,
          beneficiaryUserId: true,
          dispatcherUserId: true,
          agent: { select: { ownerUserId: true } },
        },
      },
      testVerdicts: {
        where: { goodToMerge: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
          id: true,
          headSha: true,
          onBehalfOfUserId: true,
          pullRequestUrl: true,
          agent: { select: { id: true, ownerUserId: true, activations: activeLevels } },
        },
      },
    },
  });

  const ready: ReadyToMergeIssue[] = [];
  for (const bug of candidates) {
    const claim = deliveredClaim(bug);
    // The same verdict rule as the merge gate (merge.ts), on the linked PR only.
    const onLinkedPr = bug.testVerdicts.filter((verdict) => verdict.pullRequestUrl === bug.pullRequestUrl);
    const { weight } = countedMergeVerdicts(onLinkedPr, claim, bug, agent.organisationId);

    if (status === "accepted" && weight < verdictsNeeded) continue;

    if (reviewerConflict({ id: agent.agentId, ownerUserId: agent.ownerId }, bug)) continue;

    ready.push({
      id: bug.id,
      number: bug.number,
      title: bug.title,
      projectId: bug.projectId,
      pullRequestUrl: bug.pullRequestUrl!,
      pullRequestHeadSha: bug.pullRequestHeadSha,
      status,
      claim: claim ? { agentId: claim.agentId, beneficiaryUserId: claim.beneficiaryUserId } : null,
      verdictsCount: weight,
      createdAt: bug.createdAt,
    });
  }

  return ready;
}
