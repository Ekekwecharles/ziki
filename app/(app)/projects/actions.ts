"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth-helpers";
import { fieldError, fromZodError } from "@/lib/form-errors";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { refererProjectRef } from "@/lib/referer-path";
import { ideasPath, orgPath, projectRef } from "@/lib/project-paths";
import { currentOrganisationIdFor, NO_ORGANISATION_MESSAGE } from "@/lib/organisation-context";
import { isAdminOfOrganisation } from "@/lib/agents/membership";
import { isSuperAdmin, type AppRole } from "@/lib/roles";
import {
  nextProjectSlug,
  projectLinksSchema,
  projectSettingsSchema,
  projectSlugBase,
  parseRewardConfigFromFormData,
} from "./validation";
import {
  getPlatformRewardConfig,
  projectDefaultsFromPlatform,
} from "@/lib/points/platform-rewards";
import { parseProjectRewardConfig } from "@/lib/points/project-rewards";

export type ProjectActionResult = {
  error?: string;
  field?: string;
  fieldErrors?: Record<string, string>;
  message?: string;
};

/**
 * Back to the org's Projects page (#project-urls), with a message. From a
 * project's page it is that project's; from the project's settings (no project
 * in the address), or when that project is the one just deleted, it is the
 * organisation's first active project's.
 */
async function projectsMessage(
  key: "error" | "notice",
  message: string,
  place?: { organisationId: string; deletedSlug?: string },
): Promise<string> {
  let slug = await refererProjectRef();
  if (place && (!slug || (place.deletedSlug && String(slug).split("/")[1] === encodeURIComponent(place.deletedSlug)))) {
    const other = await prisma.project.findFirst({
      where: { organisationId: place.organisationId, archivedAt: null, ...(place.deletedSlug ? { slug: { not: place.deletedSlug } } : {}) },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { slug: true, organisation: { select: { slug: true } } },
    });
    slug = other ? projectRef(other.organisation.slug, other.slug) : null;
  }
  return slug ? `${orgPath(slug, "projects")}?${key}=${encodeURIComponent(message)}` : "/home";
}

/** The current organisation, only when the signed-in person owns it or is super admin. */
async function ownerOrganisationFor(
  userId: string,
  userRole?: AppRole | null,
): Promise<{ organisationId: string } | { error: string }> {
  const organisationId = await currentOrganisationIdFor(userId);
  if (!organisationId) return { error: NO_ORGANISATION_MESSAGE };

  if (isSuperAdmin(userRole)) {
    return { organisationId };
  }

  const membership = await prisma.membership.findUnique({
    where: { organisationId_userId: { organisationId, userId } },
    select: { role: true },
  });
  if (membership?.role !== "owner") {
    return { error: "Only a organisation owner can manage its projects." };
  }
  return { organisationId };
}

function projectInOrganisation(organisationId: string, projectId: string) {
  if (!projectId) return null;
  return prisma.project.findFirst({
    where: { id: projectId, organisationId },
    select: {
      id: true,
      name: true,
      slug: true,
      archivedAt: true,
      _count: { select: { bugs: true } },
    },
  });
}

export async function updateProjectAction(
  _previous: ProjectActionResult | undefined,
  formData: FormData,
): Promise<ProjectActionResult> {
  const user = await requireUser();
  const organisationId = await currentOrganisationIdFor(user.id);
  if (!organisationId) return { error: NO_ORGANISATION_MESSAGE };
  if (!(await isAdminOfOrganisation(user, organisationId))) return { error: "Only organisation owners and admins can change project settings." };

  const visibilityRaw = (formData.get("visibility") as string | null)?.trim();
  const visibility = visibilityRaw === "public" ? "public" : "private";
  const isOpenForContributors = visibility === "public" && (formData.get("isOpenForContributors") === "true" || formData.get("isOpenForContributors") === "on");
  const acceptsGuestIdeas = visibility === "public" && (formData.get("acceptsGuestIdeas") === "true" || formData.get("acceptsGuestIdeas") === "on");
  // The schema trims it and turns an empty box into null; it must be given a string.
  const contributorGuidelines = (formData.get("contributorGuidelines") as string | null) ?? "";

  const parsed = projectSettingsSchema.safeParse({
    name: formData.get("name"),
    goal: formData.get("goal"),
    repoUrl: formData.get("repoUrl"),
    stagingUrl: formData.get("stagingUrl"),
    siteUrl: formData.get("siteUrl") ?? "",
    visibility,
    isOpenForContributors,
    acceptsGuestIdeas,
    contributorGuidelines,
  });
  if (!parsed.success) return fromZodError(parsed.error, "Check the project settings.");
  const slug = String(formData.get("slug") ?? "").trim();
  const project = await prisma.project.findFirst({
    where: { organisationId, slug },
    select: { id: true, name: true, goal: true, repoUrl: true, stagingUrl: true, siteUrl: true, visibility: true, isOpenForContributors: true, acceptsGuestIdeas: true, contributorGuidelines: true, rewardConfig: true },
  });
  if (!project) return { error: "Project not found." };

  const rawReward = parseRewardConfigFromFormData(formData);
  const platformBase = projectDefaultsFromPlatform(await getPlatformRewardConfig(prisma));
  const rewardConfig = rawReward ? parseProjectRewardConfig(rawReward, platformBase) : undefined;

  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const field of ["name", "goal", "repoUrl", "stagingUrl", "siteUrl", "visibility", "isOpenForContributors", "acceptsGuestIdeas", "contributorGuidelines"] as const) {
    if (project[field] !== parsed.data[field]) {
      changes[field] = { from: project[field], to: parsed.data[field] };
    }
  }
  if (rewardConfig !== undefined && JSON.stringify(project.rewardConfig) !== JSON.stringify(rewardConfig)) {
    changes.rewardConfig = { from: project.rewardConfig, to: rewardConfig };
  }

  if (Object.keys(changes).length > 0) {
    await prisma.$transaction(async (tx) => {
      await tx.project.update({
        where: { id: project.id },
        data: {
          ...parsed.data,
          ...(rewardConfig !== undefined ? { rewardConfig } : {}),
          // Opened to contributors just now: the Earn banner names it and comes back for it (#earnings).
          ...(parsed.data.isOpenForContributors && !project.isOpenForContributors ? { openedForContributorsAt: new Date() } : {}),
        },
      });
      await tx.projectAuditEvent.create({
        data: {
          organisationId,
          projectId: project.id,
          actorUserId: user.id,
          action: "settings.updated",
          changes: changes as Prisma.InputJsonValue,
        },
      });
    });
  }
  revalidatePath(`/projects/${slug}/settings`);
  revalidatePath("/", "layout");
  return {};
}

/**
 * The panel above the list (#project-links): set the project's live site and
 * GitHub repository in one step. Same rules as the settings page: organisation
 * owners and admins only, validated the same way, recorded in the project's
 * audit log.
 */
export async function saveProjectLinksAction(
  _previous: ProjectActionResult | undefined,
  formData: FormData,
): Promise<ProjectActionResult> {
  const user = await requireUser();
  const organisationId = await currentOrganisationIdFor(user.id);
  if (!organisationId) return { error: NO_ORGANISATION_MESSAGE };
  if (!(await isAdminOfOrganisation(user, organisationId))) return { error: "Only organisation owners and admins can set these." };

  const parsed = projectLinksSchema.safeParse({ siteUrl: formData.get("siteUrl") ?? "", repoUrl: formData.get("repoUrl") ?? "" });
  if (!parsed.success) return fromZodError(parsed.error, "Check the addresses.");
  const slug = String(formData.get("slug") ?? "").trim();
  const project = await prisma.project.findFirst({ where: { organisationId, slug }, select: { id: true, siteUrl: true, repoUrl: true } });
  if (!project) return { error: "Project not found." };

  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const field of ["siteUrl", "repoUrl"] as const) {
    if (project[field] !== parsed.data[field]) changes[field] = { from: project[field], to: parsed.data[field] };
  }
  if (Object.keys(changes).length > 0) {
    await prisma.$transaction(async (tx) => {
      await tx.project.update({ where: { id: project.id }, data: parsed.data });
      await tx.projectAuditEvent.create({
        data: { organisationId, projectId: project.id, actorUserId: user.id, action: "settings.updated", changes: changes as Prisma.InputJsonValue },
      });
    });
  }
  revalidatePath("/", "layout");
  return { message: "Saved." };
}

/**
 * Create a project in the current organisation and make it active (#426).
 *
 * The slug is derived from the name; a second "Zedu Web" becomes
 * "zedu-web-2" rather than failing the person's click.
 */
export async function createProjectAction(
  _previous: ProjectActionResult | undefined,
  formData: FormData,
): Promise<ProjectActionResult> {
  const user = await requireUser();
  const requestedOrgSlug = (formData.get("orgSlug") as string | null)?.trim();
  let organisationId = await currentOrganisationIdFor(user.id);
  if (requestedOrgSlug) {
    const orgBySlug = await prisma.organisation.findUnique({
      where: { slug: requestedOrgSlug },
      select: { id: true, slug: true },
    });
    if (orgBySlug) {
      organisationId = orgBySlug.id;
    }
  }
  if (!organisationId) return { error: NO_ORGANISATION_MESSAGE };
  if (!(await isAdminOfOrganisation(user, organisationId))) {
    return { error: "Only organisation owners and admins can create projects." };
  }

  const visibilityRaw = (formData.get("visibility") as string | null)?.trim();
  const visibility: "public" | "private" = visibilityRaw === "public" ? "public" : "private";
  const isOpenForContributors = visibility === "public" && (formData.get("isOpenForContributors") === "true" || formData.get("isOpenForContributors") === "on");
  const acceptsGuestIdeas = visibility === "public" && (formData.get("acceptsGuestIdeas") === "true" || formData.get("acceptsGuestIdeas") === "on");
  // The schema trims it and turns an empty box into null; it must be given a string.
  const contributorGuidelines = (formData.get("contributorGuidelines") as string | null) ?? "";

  const parsed = projectSettingsSchema.safeParse({
    name: formData.get("name"),
    goal: formData.get("goal") ?? "",
    repoUrl: formData.get("repoUrl") ?? "",
    stagingUrl: formData.get("stagingUrl") ?? "",
    siteUrl: formData.get("siteUrl") ?? "",
    visibility,
    isOpenForContributors,
    acceptsGuestIdeas,
    contributorGuidelines,
  });
  if (!parsed.success) return fromZodError(parsed.error, "Check the project settings.");

  const existing = await prisma.project.findMany({
    where: { organisationId },
    select: { slug: true },
  });
  const slug = nextProjectSlug(
    projectSlugBase(parsed.data.name),
    new Set(existing.map((project) => project.slug)),
  );

  const rawReward = parseRewardConfigFromFormData(formData);
  const platformBase = projectDefaultsFromPlatform(await getPlatformRewardConfig(prisma));
  const rewardConfig = rawReward ? parseProjectRewardConfig(rawReward, platformBase) : null;

  try {
    await prisma.project.create({
      data: {
        organisationId,
        name: parsed.data.name,
        slug,
        goal: parsed.data.goal,
        repoUrl: parsed.data.repoUrl,
        siteUrl: parsed.data.siteUrl,
        stagingUrl: parsed.data.stagingUrl,
        visibility,
        isOpenForContributors,
        openedForContributorsAt: isOpenForContributors ? new Date() : null,
        acceptsGuestIdeas,
        contributorGuidelines: parsed.data.contributorGuidelines,
        rewardConfig: rewardConfig ?? undefined,
        workflow: { create: {} },
      },
      select: { id: true },
    });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "P2002"
    ) {
      return fieldError("name", "A project with that name already exists.");
    }
    throw error;
  }

  revalidatePath("/", "layout");
  // A new project opens on its own page (#project-urls).
  const organisation = await prisma.organisation.findUnique({ where: { id: organisationId }, select: { slug: true } });
  redirect(organisation ? ideasPath(projectRef(organisation.slug, slug)) : "/home");
}

/** Archive or restore a project the organisation owner owns. */
export async function setProjectArchivedAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const owner = await ownerOrganisationFor(user.id, user.role);
  if ("error" in owner) redirect(await projectsMessage("error", owner.error));

  const project = await projectInOrganisation(owner.organisationId, String(formData.get("projectId") ?? ""));
  if (!project) redirect(await projectsMessage("error", "That project isn't in this organisation."));

  const archived = String(formData.get("archived") ?? "") === "true";
  if (Boolean(project.archivedAt) !== archived) {
    await prisma.project.update({
      where: { id: project.id },
      data: { archivedAt: archived ? new Date() : null },
    });
  }

  revalidatePath("/", "layout");
  redirect(await projectsMessage("notice", archived ? "Project archived." : "Project restored.", { organisationId: owner.organisationId }));
}

/** Delete a project after the owner types its name, and only when it has no issues. */
export async function deleteProjectAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const owner = await ownerOrganisationFor(user.id, user.role);
  if ("error" in owner) redirect(await projectsMessage("error", owner.error));

  const project = await projectInOrganisation(owner.organisationId, String(formData.get("projectId") ?? ""));
  if (!project) redirect(await projectsMessage("error", "That project isn't in this organisation."));

  if (project._count.bugs > 0) {
    redirect(
      await projectsMessage("error", "This project still has issues. Archive it instead."),
    );
  }

  const typed = String(formData.get("confirmName") ?? "").trim();
  if (typed !== project.name) {
    redirect(await projectsMessage("error", "Type the project's name exactly to confirm."));
  }

  try {
    await prisma.project.delete({ where: { id: project.id } });
  } catch (error) {
    console.error("[projects] deleteProjectAction failed", error);
    redirect(await projectsMessage("error", "Couldn't delete this project. Archive it instead."));
  }

  revalidatePath("/", "layout");
  redirect(await projectsMessage("notice", "Project deleted.", { organisationId: owner.organisationId, deletedSlug: project.slug }));
}
