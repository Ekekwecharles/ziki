import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { SessionAppUser } from "@/lib/auth-helpers";
import { canContributeToProject } from "@/lib/project-permissions";
import {
  marketingPlanDraftSchema,
  saveMarketingPlanDraftSchema,
  type MarketingPlanActivityInput,
  type MarketingPlanDraftInput,
  type MarketingPlanStrategyInput,
  type SaveMarketingPlanDraftInput,
} from "@/lib/validations/structured-marketing-plan";

export class MarketingPlanStoreError extends Error {
  constructor(message: string, readonly status: 404 | 409 | 422) {
    super(message);
  }
}

const STALE = "This marketing plan changed in another tab. Reload the latest draft before saving.";

function splitStrategy(strategy: MarketingPlanStrategyInput) {
  const { activities, ...summary } = strategy;
  return { summary: summary as Prisma.InputJsonObject, activities };
}

function activityContent(activity: MarketingPlanActivityInput): Prisma.InputJsonObject {
  const { id: _id, ...content } = activity;
  return content as Prisma.InputJsonObject;
}

async function accessibleProject(user: SessionAppUser, projectId: string) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, archivedAt: null, organisation: { archivedAt: null } },
    select: { id: true, organisationId: true },
  });
  if (!project || !await canContributeToProject(user, project.id, project.organisationId)) {
    throw new MarketingPlanStoreError("Project not found or membership required.", 404);
  }
  return project;
}

export async function assertMarketingPlanProjectAccess(user: SessionAppUser, projectId: string) {
  return accessibleProject(user, projectId);
}

async function storeActivities(
  tx: Prisma.TransactionClient,
  planId: string,
  revisionId: string,
  activities: MarketingPlanActivityInput[],
  existingIds: Set<string>,
) {
  const stored: Array<MarketingPlanActivityInput & { id: string }> = [];
  for (const [position, activity] of activities.entries()) {
    let activityId = activity.id;
    if (activityId) {
      if (!existingIds.has(activityId)) {
        throw new MarketingPlanStoreError("An activity id does not belong to this marketing plan.", 422);
      }
    } else {
      activityId = randomUUID();
      await tx.marketingPlanActivity.create({ data: { id: activityId, planId }, select: { id: true } });
      existingIds.add(activityId);
    }
    await tx.marketingPlanActivityRevision.create({
      data: { revisionId, activityId, position, content: activityContent(activity) },
    });
    stored.push({ ...activity, id: activityId });
  }
  return stored;
}

function snapshot<T extends {
  id: string;
  revision: number;
  version: number;
  status: string;
  sourceContextId: string;
  sourceContextRevision: string;
  strategy: Prisma.JsonValue;
  activities: Array<{ activityId: string; position: number; content: Prisma.JsonValue }>;
}>(revision: T) {
  return {
    id: revision.id,
    revision: revision.revision,
    version: revision.version,
    status: revision.status,
    source: { contextId: revision.sourceContextId, revision: revision.sourceContextRevision },
    strategy: {
      ...(revision.strategy as Record<string, unknown>),
      activities: [...revision.activities]
        .sort((left, right) => left.position - right.position)
        .map(({ activityId, content }) => ({ id: activityId, ...(content as Record<string, unknown>) })),
    } as MarketingPlanStrategyInput,
  };
}

export async function createMarketingPlan(
  user: SessionAppUser,
  projectId: string,
  rawInput: MarketingPlanDraftInput,
) {
  await accessibleProject(user, projectId);
  const input = marketingPlanDraftSchema.parse(rawInput);
  const { summary, activities } = splitStrategy(input.strategy);

  return prisma.$transaction(async (tx) => {
    const plan = await tx.marketingPlan.create({
      data: { projectId, creatorId: user.id, title: input.title },
      select: { id: true },
    });
    const revision = await tx.marketingPlanRevision.create({
      data: {
        planId: plan.id, revision: 1, version: 1, status: "draft",
        sourceContextId: input.source.contextId,
        sourceContextRevision: input.source.revision,
        strategy: summary,
        createdById: user.id,
      },
      select: { id: true, revision: true, version: true, status: true, sourceContextId: true, sourceContextRevision: true, strategy: true },
    });
    const existingIds = new Set<string>();
    for (const activity of activities) {
      if (!activity.id) continue;
      await tx.marketingPlanActivity.create({ data: { id: activity.id, planId: plan.id }, select: { id: true } });
      existingIds.add(activity.id);
    }
    const storedActivities = await storeActivities(tx, plan.id, revision.id, activities, existingIds);
    return {
      planId: plan.id,
      title: input.title,
      revision: revision.revision,
      version: revision.version,
      status: revision.status,
      source: input.source,
      strategy: { ...input.strategy, activities: storedActivities },
    };
  });
}

export async function getMarketingPlan(user: SessionAppUser, projectId: string, planId: string) {
  await accessibleProject(user, projectId);
  const plan = await prisma.marketingPlan.findFirst({
    where: { id: planId, projectId },
    select: {
      id: true, title: true, currentRevision: true, createdAt: true, updatedAt: true,
      revisions: {
        orderBy: { revision: "desc" },
        select: {
          id: true, revision: true, version: true, status: true, sourceContextId: true,
          sourceContextRevision: true, strategy: true, createdAt: true, updatedAt: true,
          activities: { orderBy: { position: "asc" }, select: { activityId: true, position: true, content: true } },
          approvedAt: true, approvedById: true,
          decisions: { orderBy: { decidedAt: "asc" }, select: { activityId: true, decision: true, decidedAt: true, decidedById: true, history: { orderBy: { createdAt: "asc" }, select: { decision: true, actorId: true, createdAt: true } } } },
        },
      },
    },
  });
  if (!plan) throw new MarketingPlanStoreError("Marketing plan not found.", 404);
  return {
    id: plan.id,
    title: plan.title,
    currentRevision: plan.currentRevision,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    revisions: plan.revisions.map((revision) => ({ ...snapshot(revision), createdAt: revision.createdAt, updatedAt: revision.updatedAt, approvedAt: revision.approvedAt, approvedById: revision.approvedById, decisions: revision.decisions })),
  };
}

export async function saveMarketingPlanDraft(
  user: SessionAppUser,
  projectId: string,
  planId: string,
  rawInput: SaveMarketingPlanDraftInput,
) {
  await accessibleProject(user, projectId);
  const input = saveMarketingPlanDraftSchema.parse(rawInput);
  const { summary, activities } = splitStrategy(input.strategy);

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "MarketingPlan" WHERE "id" = ${planId} AND "projectId" = ${projectId} FOR UPDATE`;
    const plan = await tx.marketingPlan.findFirst({
      where: { id: planId, projectId },
      include: {
        revisions: {
          orderBy: { revision: "desc" }, take: 1,
          include: { activities: { select: { activityId: true } } },
        },
      },
    });
    const current = plan?.revisions[0];
    if (!plan || !current) throw new MarketingPlanStoreError("Marketing plan not found.", 404);
    if (plan.currentRevision !== input.expectedRevision || current.revision !== input.expectedRevision || current.version !== input.expectedVersion) {
      throw new MarketingPlanStoreError(STALE, 409);
    }

    const identityRows = await tx.marketingPlanActivity.findMany({ where: { planId }, select: { id: true } });
    const existingIds = new Set(identityRows.map((row) => row.id));
    for (const activity of activities) {
      if (activity.id && !existingIds.has(activity.id)) {
        throw new MarketingPlanStoreError("An activity id does not belong to this marketing plan.", 422);
      }
    }

    let revisionId = current.id;
    let revisionNumber = current.revision;
    let version: number;
    if (current.status === "approved") {
      revisionNumber++;
      const next = await tx.marketingPlanRevision.create({
        data: {
          planId, revision: revisionNumber, version: 1, status: "draft",
          sourceContextId: input.source.contextId,
          sourceContextRevision: input.source.revision,
          strategy: summary,
          createdById: user.id,
        },
        select: { id: true, version: true, status: true, sourceContextId: true, sourceContextRevision: true, strategy: true },
      });
      revisionId = next.id;
      version = next.version;
      await tx.marketingPlan.update({ where: { id: planId }, data: { title: input.title, currentRevision: revisionNumber } });
    } else if (current.status === "draft") {
      const updated = await tx.marketingPlanRevision.update({
        where: { id: current.id },
        data: {
          version: { increment: 1 },
          sourceContextId: input.source.contextId,
          sourceContextRevision: input.source.revision,
          strategy: summary,
        },
        select: { version: true },
      });
      version = updated.version;
      await tx.marketingPlan.update({ where: { id: planId }, data: { title: input.title } });
      await tx.marketingPlanActivityRevision.deleteMany({ where: { revisionId: current.id } });
    } else {
      throw new MarketingPlanStoreError("This marketing plan revision cannot be edited.", 409);
    }

    const storedActivities = await storeActivities(tx, planId, revisionId, activities, existingIds);
    return {
      planId,
      title: input.title,
      revision: revisionNumber,
      version,
      status: "draft" as const,
      source: input.source,
      strategy: {
        ...summary,
        activities: storedActivities,
      } as MarketingPlanStrategyInput,
    };
  });
}
