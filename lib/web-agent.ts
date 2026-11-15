import type { AgentContext } from "@/lib/agents/require-agent";
import { activeLevels, levelIn } from "@/lib/agents/active-in";
import { awardingAgentOf } from "@/lib/bid-award-permission";
import { prisma } from "@/lib/prisma";

/**
 * A person acting from the website through their agent (#owner-control):
 * the agent the API would act as, so the person can do exactly what that
 * agent could and nothing more. Their highest-level agent active in the
 * organisation, as bid awards and idea decisions already use.
 */
export async function webAgentFor(userId: string, organisationId: string): Promise<AgentContext | null> {
  const agent = await awardingAgentOf(userId, organisationId);
  if (!agent) return null;
  return { agentId: agent.id, name: agent.name, ownerId: agent.ownerUserId, organisationId, level: agent.level, burst: false, keyId: "web" };
}

/**
 * The person's own agent that holds this issue now (an offered, planning or
 * active claim), as a context to act as it: release it, extend it, accept
 * its offer. Null when none of their agents holds it.
 */
export async function heldByMyAgent(userId: string, bugId: string) {
  const claim = await prisma.issueClaim.findFirst({
    where: { bugId, releasedAt: null, status: { in: ["offered", "planning", "active"] }, agent: { ownerUserId: userId, revokedAt: null } },
    select: {
      id: true,
      status: true,
      agent: { select: { id: true, name: true, ownerUserId: true, pausedAt: true, activations: activeLevels } },
      bug: { select: { organisationId: true, projectId: true } },
    },
  });
  if (!claim) return null;
  const context: AgentContext = {
    agentId: claim.agent.id,
    name: claim.agent.name,
    ownerId: claim.agent.ownerUserId,
    organisationId: claim.bug.organisationId,
    level: levelIn(claim.agent, claim.bug.organisationId),
    burst: false,
    keyId: "web",
    pausedAt: claim.agent.pausedAt,
  };
  return { claimId: claim.id, status: claim.status, projectId: claim.bug.projectId, agent: context };
}
