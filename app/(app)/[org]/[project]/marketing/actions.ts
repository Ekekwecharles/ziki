"use server";

import type { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { projectLinksSchema } from "@/app/(app)/projects/validation";
import { askMarketingAssistant, cleanMarketingHistory } from "@/lib/marketing/assistant";
import type { MarketingAnswer } from "@/lib/marketing/assistant-shared";
import { MARKETING_TRACK } from "@/lib/marketing/track";
import { prisma } from "@/lib/prisma";
import { marketingPath, type ProjectRef } from "@/lib/project-paths";
import { requireProject } from "@/lib/project-route";
import { checkRateLimit, RATE_LIMIT_MESSAGE } from "@/lib/rate-limit";

export type MarketingSiteResult = { error?: string; ok?: boolean };

const siteSchema = projectLinksSchema.pick({ siteUrl: true });

/**
 * The Marketing home's first step (#marketing-home): the website to improve the
 * marketing for. It is the project's site link, the same one Project settings
 * and the panel above the issue list set, so it has their rule: organisation
 * owners and admins only, validated the same way, recorded in the audit log.
 */
export async function saveMarketingSiteAction(
  slug: ProjectRef,
  _previous: MarketingSiteResult | undefined,
  formData: FormData,
): Promise<MarketingSiteResult> {
  const [org, projectSlug] = slug.split("/");
  const context = await requireProject(org, projectSlug);
  if (!context.isOrgAdmin) return { error: "Only organisation owners and admins can set the website." };

  const parsed = siteSchema.safeParse({ siteUrl: formData.get("siteUrl") ?? "" });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the address." };
  const siteUrl = parsed.data.siteUrl;
  if (!siteUrl) return { error: "Enter your website's address." };

  const project = await prisma.project.findUnique({ where: { id: context.project.id }, select: { siteUrl: true } });
  if (project?.siteUrl !== siteUrl) {
    await prisma.$transaction(async (tx) => {
      await tx.project.update({ where: { id: context.project.id }, data: { siteUrl } });
      await tx.projectAuditEvent.create({
        data: {
          organisationId: context.organisationId,
          projectId: context.project.id,
          actorUserId: context.user.id,
          action: "settings.updated",
          changes: { siteUrl: { from: project?.siteUrl ?? null, to: siteUrl } } as Prisma.InputJsonValue,
        },
      });
    });
  }
  revalidatePath(marketingPath(slug));
  return { ok: true };
}

/** Messages one person may send the Marketing assistant in an hour. */
const ASSISTANT_RATE_LIMIT = { max: 60, windowMs: 60 * 60 * 1000 };

/**
 * Send the conversation to the Marketing assistant (#marketing-assistant) and
 * get its reply. Organisation owners and admins only, once the project has its
 * website. Its tools read this project only; a drafted task is filed only when
 * the person files it. Nothing is saved: the page keeps the conversation.
 */
export async function askMarketingAssistantAction(slug: ProjectRef, history: unknown): Promise<MarketingAnswer> {
  const [org, projectSlug] = slug.split("/");
  const context = await requireProject(org, projectSlug);
  if (!context.isOrgAdmin) return { ok: false, error: "Only organisation owners and admins can use the marketing assistant." };

  const turns = cleanMarketingHistory(history);
  if (turns.at(-1)?.role !== "user") return { ok: false, error: "Describe the marketing problem first." };

  const [project, taskTypes] = await Promise.all([
    prisma.project.findUnique({ where: { id: context.project.id }, select: { name: true, siteUrl: true } }),
    prisma.issueType.findMany({
      where: { organisationId: context.organisationId, ...MARKETING_TRACK, isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
  ]);
  if (!project?.siteUrl) return { ok: false, error: "Add the project's website first." };

  const limit = checkRateLimit(`marketing-assistant:${context.user.id}`, ASSISTANT_RATE_LIMIT);
  if (!limit.allowed) return { ok: false, error: RATE_LIMIT_MESSAGE };

  return askMarketingAssistant(turns, {
    name: project.name,
    siteUrl: project.siteUrl,
    organisationId: context.organisationId,
    projectId: context.project.id,
    taskTypes,
  });
}
