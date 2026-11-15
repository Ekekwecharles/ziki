import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { canContributeToProject, canManageProject, type UserIdentifier } from "@/lib/project-permissions";
import { isSuperAdmin } from "@/lib/roles";

type ProjectAccess = {
  id: string;
  organisationId: string;
  visibility: "public" | "private";
};

export type ProjectOverviewPerson = {
  id: string;
  name: string;
  image: string | null;
};

export type ProjectOverviewData = {
  project: {
    id: string;
    slug: string;
    name: string;
    goal: string | null;
    repoUrl: string | null;
    siteUrl: string | null;
    stagingUrl: string | null;
    contributorGuidelines: string | null;
    visibility: "public" | "private";
    isOpenForContributors: boolean;
    acceptsGuestIdeas: boolean;
    organisation: { id: string; name: string; slug: string };
    repositories: Array<{ label: string | null; url: string; branch: string | null }>;
    maintainer: ProjectOverviewPerson | null;
    contributors: ProjectOverviewPerson[];
    contributorCount: number;
  };
  openIdeas: number;
  openIssues: number;
  deliveredFixes: number;
  isMember: boolean;
  canManage: boolean;
  /** The viewer's request to join (#join-requests), when they asked and aren't a member: "none" otherwise. */
  joinRequest: "none" | "pending" | "rejected";
};

/** What "open issues" means on every public page: not yet delivered. Delivered work (done, merge, resolved) is counted as delivered fixes, never as both. */
export const OPEN_ISSUES_WHERE = { isDeleted: false, status: { in: ["open", "in_progress"] } } satisfies Prisma.BugWhereInput;

const overviewSelect = {
  id: true,
  slug: true,
  name: true,
  goal: true,
  repoUrl: true,
  siteUrl: true,
  stagingUrl: true,
  contributorGuidelines: true,
  visibility: true,
  isOpenForContributors: true,
  acceptsGuestIdeas: true,
  organisationId: true,
  organisation: {
    select: {
      id: true,
      name: true,
      slug: true,
      memberships: {
        where: { role: { in: ["owner", "admin"] } },
        orderBy: { createdAt: "asc" },
        select: { role: true, user: { select: { id: true, name: true, image: true } } },
      },
    },
  },
  repositories: {
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { label: true, url: true, branch: true },
  },
  memberships: {
    orderBy: { createdAt: "asc" },
    take: 12,
    select: { user: { select: { id: true, name: true, image: true } } },
  },
  _count: {
    select: {
      bugs: { where: OPEN_ISSUES_WHERE },
      ideas: { where: { isDeleted: false, status: "open" } },
      memberships: true,
    },
  },
} satisfies Prisma.ProjectSelect;

function canViewProject(user: UserIdentifier | null, project: ProjectAccess, isMember: boolean): boolean {
  return project.visibility === "public" || Boolean(user && isMember);
}

function visibleProjectWhere(user: UserIdentifier | null): Prisma.ProjectWhereInput {
  if (!user) return { visibility: "public" };
  if (isSuperAdmin(user.role)) return {};

  return {
    OR: [
      { visibility: "public" },
      { visibility: "private", memberships: { some: { userId: user.id } } },
      { visibility: "private", organisation: { memberships: { some: { userId: user.id } } } },
    ],
  };
}

/** Load the public overview only after checking whether this viewer may see it. */
export async function loadProjectOverview(
  orgSlug: string,
  projectSlug: string,
  user: UserIdentifier | null,
): Promise<ProjectOverviewData | null> {
  const scope = {
    slug: projectSlug,
    archivedAt: null,
    organisation: { slug: orgSlug, archivedAt: null },
  } satisfies Prisma.ProjectWhereInput;

  const access = await prisma.project.findFirst({
    where: scope,
    select: { id: true, organisationId: true, visibility: true },
  });
  if (!access) return null;

  const isMember = user
    ? await canContributeToProject(user, access.id, access.organisationId)
    : false;
  if (!canViewProject(user, access, isMember)) return null;

  const project = await prisma.project.findFirst({
    where: { ...scope, id: access.id, ...visibleProjectWhere(user) },
    select: overviewSelect,
  });
  if (!project) return null;

  const [canManage, deliveredFixes, request] = await Promise.all([
    user ? canManageProject(user, project.organisationId) : Promise.resolve(false),
    prisma.bug.count({
      where: {
        projectId: project.id,
        isDeleted: false,
        status: { in: ["done", "merge", "resolved"] },
      },
    }),
    user && !isMember
      ? prisma.projectJoinRequest.findUnique({
          where: { projectId_userId: { projectId: project.id, userId: user.id } },
          select: { status: true },
        })
      : Promise.resolve(null),
  ]);
  const maintainer =
    project.organisation.memberships.find((membership) => membership.role === "owner") ??
    project.organisation.memberships[0] ??
    null;

  return {
    project: {
      id: project.id,
      slug: project.slug,
      name: project.name,
      goal: project.goal,
      repoUrl: project.repoUrl,
      siteUrl: project.siteUrl,
      stagingUrl: project.stagingUrl,
      contributorGuidelines: project.contributorGuidelines,
      visibility: project.visibility,
      isOpenForContributors: project.isOpenForContributors,
      acceptsGuestIdeas: project.acceptsGuestIdeas,
      organisation: project.organisation,
      repositories: project.repositories,
      maintainer: maintainer
        ? { id: maintainer.user.id, name: maintainer.user.name, image: maintainer.user.image }
        : null,
      contributors: project.memberships.map(({ user: contributor }) => ({
        id: contributor.id,
        name: contributor.name,
        image: contributor.image,
      })),
      contributorCount: project._count.memberships,
    },
    openIdeas: project._count.ideas,
    openIssues: project._count.bugs,
    deliveredFixes,
    isMember,
    canManage,
    joinRequest: request?.status === "pending" || request?.status === "rejected" ? request.status : "none",
  };
}
