import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { isAdminOfOrganisation, isOrganisationAdminRole } from "@/lib/agents/membership";
import { audit } from "@/lib/agents/audit";
import { IssueApiError } from "@/lib/agent-api/errors";
import type { AppRole } from "@/lib/roles";
import { checkPostForSecrets } from "@/lib/security/secret-guard";

export const expressImportRequestSchema = z.object({
  projectId: z.string().trim().min(1).max(191).optional(),
  reason: z.string().trim().min(1).max(2000),
}).strict();

export async function expressImportAccess(agent: { agentId: string; organisationId: string }, projectId: string) {
  const project = await prisma.project.findFirst({ where: { id: projectId, organisationId: agent.organisationId, archivedAt: null }, select: { id: true } });
  if (!project) throw new IssueApiError(404, "No active project found.");
  const identity = { agentId_projectId: { agentId: agent.agentId, projectId } };
  const [grant, request] = await Promise.all([
    prisma.expressImportGrant.findUnique({ where: identity, select: { createdAt: true } }),
    prisma.expressImportRequest.findUnique({ where: identity, select: { decision: true, response: true, requestedAt: true, decidedAt: true } }),
  ]);
  return { projectId, expressImportAllowed: Boolean(grant), request };
}

/** Import permissions are project grants, never another rung in AgentLevel. */
export async function setExpressImportGrant(
  person: { id: string; role?: AppRole | null },
  agentId: string,
  projectId: string,
  enabled: boolean,
  response?: string,
): Promise<void> {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { organisationId: true, archivedAt: true } });
  if (!project || !(await isAdminOfOrganisation(person, project.organisationId))) {
    throw new IssueApiError(403, "Only an organisation owner or admin can grant express import access.");
  }
  if (project.archivedAt) throw new IssueApiError(409, "This project is archived.");
  if (response) {
    const checked = await checkPostForSecrets({ organisationId: project.organisationId, projectId, actor: { kind: "user", userId: person.id }, source: "agent.express_import_changed", fields: { response } });
    if (!checked.ok) throw new IssueApiError(422, checked.message);
  }
  await prisma.$transaction(async (tx) => {
    // Imports take this same lock before rechecking the grant: revoking access
    // cannot race a new import past a successful revocation.
    await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${projectId} FOR UPDATE`;
    const actorMembership = await tx.membership.findUnique({
      where: { organisationId_userId: { organisationId: project.organisationId, userId: person.id } }, select: { role: true },
    });
    if (!isOrganisationAdminRole(actorMembership?.role, person.role)) throw new IssueApiError(403, "Only an organisation owner or admin can grant express import access.");
    const activation = await tx.agentActivation.findUnique({
      where: { agentId_organisationId: { agentId, organisationId: project.organisationId } },
      select: { deactivatedAt: true, agent: { select: { revokedAt: true, ownerUserId: true } } },
    });
    if (!activation || activation.deactivatedAt || activation.agent.revokedAt) throw new IssueApiError(404, "No active agent in this organisation.");
    const membership = await tx.membership.findUnique({
      where: { organisationId_userId: { organisationId: project.organisationId, userId: activation.agent.ownerUserId } },
      select: { id: true },
    });
    if (!membership) throw new IssueApiError(404, "The agent's owner is no longer a member.");
    if (enabled) {
      await tx.expressImportGrant.upsert({
        where: { agentId_projectId: { agentId, projectId } },
        create: { agentId, projectId, grantedByUserId: person.id },
        update: {},
      });
    } else {
      await tx.expressImportGrant.deleteMany({ where: { agentId, projectId } });
    }
    await tx.expressImportRequest.updateMany({
      where: { agentId, projectId, decision: "pending" },
      data: { decision: enabled ? "approved" : "declined", response: response?.trim() || (enabled ? "Access approved by an organisation admin." : "Access declined by an organisation admin."), decidedAt: new Date(), reviewedByUserId: person.id },
    });
    await audit({ agentId, organisationId: project.organisationId }, "agent.express_import_changed", `project:${projectId}`, { enabled }, { actorUserId: person.id, db: tx });
  });
}

export async function requestExpressImportAccess(person: { id: string }, agentId: string, projectId: string, reason: string) {
  const text = typeof reason === "string" ? reason.trim() : "";
  if (!text || text.length > 2000) throw new IssueApiError(400, "Explain why this agent needs express imports (up to 2,000 characters).");
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${projectId} FOR UPDATE`;
    const project = await tx.project.findUnique({ where: { id: projectId }, select: { organisationId: true, archivedAt: true } });
    if (!project || project.archivedAt) throw new IssueApiError(404, "No active project found.");
    const activation = await tx.agentActivation.findUnique({ where: { agentId_organisationId: { agentId, organisationId: project.organisationId } }, select: { deactivatedAt: true, agent: { select: { ownerUserId: true, revokedAt: true } } } });
    const membership = await tx.membership.findUnique({ where: { organisationId_userId: { organisationId: project.organisationId, userId: person.id } }, select: { id: true } });
    if (!membership || !activation || activation.deactivatedAt || activation.agent.revokedAt || activation.agent.ownerUserId !== person.id) throw new IssueApiError(403, "You can only request access for your own active agent in this organisation.");
    const checked = await checkPostForSecrets({ organisationId: project.organisationId, projectId, actor: { kind: "user", userId: person.id }, source: "agent.express_import_requested", fields: { reason: text } });
    if (!checked.ok) throw new IssueApiError(422, checked.message);
    const identity = { agentId_projectId: { agentId, projectId } };
    if (await tx.expressImportGrant.findUnique({ where: identity })) throw new IssueApiError(409, "This agent already has express import access.");
    const existing = await tx.expressImportRequest.findUnique({ where: identity });
    if (existing?.decision === "pending") throw new IssueApiError(409, "An admin is already reviewing this agent's request.");
    await tx.expressImportRequest.upsert({ where: identity,
      create: { agentId, projectId, reason: text },
      update: { reason: text, decision: "pending", response: null, requestedAt: new Date(), decidedAt: null, reviewedByUserId: null },
    });
    await audit({ agentId, organisationId: project.organisationId }, "agent.express_import_requested", `project:${projectId}`, { reason: text }, { actorUserId: person.id, db: tx });
  });
}

export async function assertExpressImportGrant(
  db: Prisma.TransactionClient | typeof prisma,
  agent: { agentId: string; organisationId: string },
  projectId: string,
): Promise<void> {
  const project = await db.project.findFirst({ where: { id: projectId, organisationId: agent.organisationId }, select: { archivedAt: true } });
  if (!project) throw new IssueApiError(404, "Project not found.");
  if (project.archivedAt) throw new IssueApiError(409, "This project is archived.");
  const grant = await db.expressImportGrant.findUnique({ where: { agentId_projectId: { agentId: agent.agentId, projectId } } });
  if (!grant) throw new IssueApiError(403, "An organisation owner or admin must grant this agent express import access to this project.");
}
