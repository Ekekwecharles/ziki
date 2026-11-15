"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import { isAgentPlatformEnabled } from "@/lib/feature-flags";
import { importOutsideWork, outsideWorkSchema } from "@/lib/agent-api/outside-work";
import { IssueApiError } from "@/lib/agent-api/errors";
import { assertAgentMayWork, AgentWorkBlockedError } from "@/lib/agents/work-gate";
import { consumeAgentBudget } from "@/lib/agents/rate-budget";
import { checkPostForSecrets, stringsIn } from "@/lib/security/secret-guard";
import { eventStreamBus, ORGANISATION_WRITE } from "@/lib/events/stream-bus";

/** The signed-in owner submits for their own agent; no API credential enters the browser. */
export async function importOutsideWorkAction(agentId: string, projectId: string, raw: unknown, requestKey: string) {
  const person = await requireUser();
  if (!isAgentPlatformEnabled()) return { ok: false as const, error: "The agent platform is turned off." };
  if (typeof agentId !== "string" || !agentId || agentId.length > 191 || typeof projectId !== "string" || !projectId || projectId.length > 191 || typeof requestKey !== "string") return { ok: false as const, error: "Choose an agent and project." };
  const parsed = outsideWorkSchema.safeParse(raw);
  if (!parsed.success) return { ok: false as const, error: parsed.error.issues.map((issue) => `${issue.path.join(".") || "Import"}: ${issue.message}`).join(" ") };
  try {
    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { organisationId: true, slug: true, organisation: { select: { slug: true } } } });
    if (!project) throw new IssueApiError(404, "Project not found.");
    const agent = await prisma.agent.findFirst({ where: { id: agentId, ownerUserId: person.id, revokedAt: null }, select: {
      id: true, name: true, username: true, tagline: true, about: true, pausedAt: true, _count: { select: { skills: true } },
      activations: { where: { organisationId: project.organisationId, deactivatedAt: null }, select: { level: true, burst: true, burstUntil: true } },
      apiKeys: { where: { organisationId: project.organisationId, revokedAt: null }, select: { id: true }, take: 1 },
    } });
    const activation = agent?.activations[0];
    if (!agent || !activation || !agent.apiKeys[0]) throw new IssueApiError(403, "Choose your own active agent in this organisation, with a live API key.");
    if (agent.pausedAt) throw new IssueApiError(423, "This agent is paused. Resume it before importing work.");
    assertAgentMayWork({ ...agent, skillCount: agent._count.skills }, { method: "POST", url: "http://localhost/api/v1/issues/import" });
    const budget = await consumeAgentBudget({ id: agent.id, ...activation }, "write");
    if (!budget.allowed) throw new IssueApiError(429, "Too many import attempts. Wait a moment and try again.");
    const secretCheck = await checkPostForSecrets({ organisationId: project.organisationId, projectId,
      actor: { kind: "agent", agentId: agent.id, agentName: agent.name, ownerId: person.id }, source: "issues.import", fields: stringsIn(parsed.data), noun: "this import" });
    if (!secretCheck.ok) return { ok: false as const, error: secretCheck.message };
    const result = await importOutsideWork({ agentId: agent.id, name: agent.name, ownerId: person.id, ownerRole: person.role, organisationId: project.organisationId, ...activation, keyId: agent.apiKeys[0].id }, projectId, parsed.data, requestKey);
    eventStreamBus.emit(ORGANISATION_WRITE, project.organisationId);
    const href = `/${encodeURIComponent(project.organisation.slug)}/${encodeURIComponent(project.slug)}/${result.issue.number}`;
    revalidatePath(href);
    return { ok: true as const, href, number: result.issue.number };
  } catch (error) {
    if (error instanceof IssueApiError || error instanceof AgentWorkBlockedError) return { ok: false as const, error: error.message };
    return { ok: false as const, error: "The import could not be completed. Retry with the same details; an existing import will not be duplicated." };
  }
}
