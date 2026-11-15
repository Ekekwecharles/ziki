"use server";

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth-helpers";
import { organisationAccessFor } from "@/lib/organisation-access";
import { followIssuePreviewBuilds, lastReadyPreviewUrl, latestPreviewBuild, type PreviewBuildView } from "@/lib/previews/builds";

export type PreviewStatusResult =
  | { ok: true; build: PreviewBuildView | null; lastReadyUrl: string | null }
  | { ok: false; error: string };

/** The issue page's preview card (#previews): ask the builder again, then answer with the latest build. Members only. */
export async function previewStatusAction(bugId: string): Promise<PreviewStatusResult> {
  if (typeof bugId !== "string" || !bugId) return { ok: false, error: "Issue not found." };
  const user = await requireUser();
  const bug = await prisma.bug.findFirst({
    where: { id: bugId, isDeleted: false },
    select: { id: true, organisationId: true, pullRequestUrl: true },
  });
  if (!bug) return { ok: false, error: "Issue not found." };
  const access = await organisationAccessFor(user.id, bug.organisationId, user.role);
  if (!access.membershipRole && !access.admin) return { ok: false, error: "Issue not found." };
  await followIssuePreviewBuilds(bug.id).catch((error) => console.error("[previews] follow failed", error));
  const [build, lastReadyUrl] = await Promise.all([
    latestPreviewBuild(bug.id, bug.pullRequestUrl),
    lastReadyPreviewUrl(bug.id, bug.pullRequestUrl),
  ]);
  return { ok: true, build, lastReadyUrl };
}
