import type { SessionAppUser } from "@/lib/auth-helpers";
import { assertMarketingSettingsAccess } from "@/lib/marketing/settings";
import { prisma } from "@/lib/prisma";
import { MarketingPlanStoreError } from "@/lib/structured-marketing-plans";

const STALE_APPROVAL = "This plan revision changed. Reload it before recording an approval decision.";

async function requireApprover(user: SessionAppUser, projectId: string) {
  const project = await prisma.project.findFirst({ where: { id: projectId, archivedAt: null, organisation: { archivedAt: null } }, select: { id: true, organisationId: true } });
  if (!project) throw new MarketingPlanStoreError("Project not found.", 404);
  await assertMarketingSettingsAccess(user, project.organisationId, "change");
  return project;
}

export async function decideMarketingActivity(
  user: SessionAppUser,
  projectId: string,
  planId: string,
  revisionNumber: number,
  activityId: string,
  decision: "approved" | "rejected",
  expectedVersion: number,
) {
  await requireApprover(user, projectId);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "MarketingPlan" WHERE "id" = ${planId} AND "projectId" = ${projectId} FOR UPDATE`;
    const plan = await tx.marketingPlan.findFirst({ where: { id: planId, projectId }, select: { id: true, currentRevision: true } });
    const revision = await tx.marketingPlanRevision.findFirst({ where: { planId, revision: revisionNumber }, select: { id: true, version: true, status: true } });
    if (!plan || !revision) throw new MarketingPlanStoreError("Marketing plan revision not found.", 404);
    await tx.$queryRaw`SELECT "id" FROM "MarketingPlanRevision" WHERE "id" = ${revision.id} FOR UPDATE`;
    const latest = await tx.marketingPlanRevision.findUnique({ where: { id: revision.id }, select: { version: true, status: true } });
    if (plan.currentRevision !== revisionNumber || latest?.version !== expectedVersion || latest.status !== "draft") {
      throw new MarketingPlanStoreError(STALE_APPROVAL, 409);
    }
    const activity = await tx.marketingPlanActivityRevision.findUnique({ where: { revisionId_activityId: { revisionId: revision.id, activityId } }, select: { id: true } });
    if (!activity) throw new MarketingPlanStoreError("Activity is not part of this plan revision.", 422);
    const prior = await tx.marketingPlanActivityDecision.findUnique({ where: { revisionId_activityId: { revisionId: revision.id, activityId } }, select: { id: true, decision: true } });
    if (prior?.decision === decision) return { revision: revisionNumber, activityId, decision, idempotent: true };
    const row = await tx.marketingPlanActivityDecision.upsert({
      where: { revisionId_activityId: { revisionId: revision.id, activityId } },
      update: { decision, decidedById: user.id, decidedAt: new Date() },
      create: { revisionId: revision.id, activityId, decision, decidedById: user.id },
      select: { id: true },
    });
    await tx.marketingPlanActivityDecisionEvent.create({ data: { decisionId: row.id, decision, actorId: user.id } });
    return { revision: revisionNumber, activityId, decision, idempotent: false };
  });
}

export async function finalizeMarketingPlanRevision(
  user: SessionAppUser,
  projectId: string,
  planId: string,
  revisionNumber: number,
  expectedVersion: number,
) {
  await requireApprover(user, projectId);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "MarketingPlan" WHERE "id" = ${planId} AND "projectId" = ${projectId} FOR UPDATE`;
    const plan = await tx.marketingPlan.findFirst({ where: { id: planId, projectId }, select: { id: true, currentRevision: true } });
    const revision = await tx.marketingPlanRevision.findFirst({
      where: { planId, revision: revisionNumber },
      select: { id: true, version: true, status: true, approvedAt: true, approvedById: true, activities: { select: { activityId: true } }, decisions: { select: { activityId: true, decision: true } } },
    });
    if (!plan || !revision) throw new MarketingPlanStoreError("Marketing plan revision not found.", 404);
    await tx.$queryRaw`SELECT "id" FROM "MarketingPlanRevision" WHERE "id" = ${revision.id} FOR UPDATE`;
    const current = await tx.marketingPlanRevision.findUnique({
      where: { id: revision.id },
      select: { version: true, status: true, approvedAt: true, approvedById: true, activities: { select: { activityId: true } }, decisions: { select: { activityId: true, decision: true } } },
    });
    if (current?.status === "approved" && current.approvedAt && current.approvedById) {
      return { revision: revisionNumber, approvedAt: current.approvedAt, approvedById: current.approvedById, approvedActivities: current.decisions.filter((item) => item.decision === "approved").map((item) => item.activityId), idempotent: true };
    }
    if (plan.currentRevision !== revisionNumber || current?.version !== expectedVersion || current.status !== "draft") {
      throw new MarketingPlanStoreError(STALE_APPROVAL, 409);
    }
    const included = current.decisions.filter((item) => item.decision === "approved" && current.activities.some((activity) => activity.activityId === item.activityId));
    if (included.length === 0) throw new MarketingPlanStoreError("Approve at least one activity before confirming this plan.", 422);
    const approvedAt = new Date();
    await tx.marketingPlanRevision.update({ where: { id: revision.id }, data: { status: "approved", approvedAt, approvedById: user.id } });
    return { revision: revisionNumber, approvedAt, approvedById: user.id, approvedActivities: included.map((item) => item.activityId), idempotent: false };
  });
}
