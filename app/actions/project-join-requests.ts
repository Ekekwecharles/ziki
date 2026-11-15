"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth-helpers";
import { canContributeToProject, canManageProject } from "@/lib/project-permissions";
import { marketingPath, orgPath, projectPath, projectRef } from "@/lib/project-paths";
import { projectHomePath } from "@/lib/marketing/project-home";
import { awardSignupBonus } from "@/lib/points/signup-bonus";
import { DECLINED_REQUEST_COOLDOWN_MS } from "@/lib/join-requests";

export type JoinRequestActionResult = {
  ok?: boolean;
  error?: string;
};

/**
 * Accept a pending join request. Org admins only.
 */
export async function acceptJoinRequestAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const requestId = String(formData.get("requestId") ?? "").trim();
  if (!requestId) return;

  const joinRequest = await prisma.projectJoinRequest.findUnique({
    where: { id: requestId },
    include: {
      project: {
        select: {
          id: true,
          slug: true,
          name: true,
          organisationId: true,
          organisation: { select: { slug: true } },
        },
      },
    },
  });

  if (!joinRequest || joinRequest.status !== "pending") {
    return;
  }

  if (!(await canManageProject(user, joinRequest.project.organisationId))) {
    return;
  }

  await prisma.$transaction(async (tx) => {
    // 1. Move it out of pending, only once: a second admin (or a double click) deciding the same request
    // changes nothing, so the applicant is never added twice or told two different answers.
    const decided = await tx.projectJoinRequest.updateMany({
      where: { id: requestId, status: "pending" },
      data: {
        status: "accepted",
        reviewedBy: user.id,
        reviewedAt: new Date(),
      },
    });
    if (decided.count === 0) return;

    // 2. Add ProjectMembership
    await tx.projectMembership.upsert({
      where: { projectId_userId: { projectId: joinRequest.projectId, userId: joinRequest.userId } },
      create: { projectId: joinRequest.projectId, userId: joinRequest.userId },
      update: {},
    });

    const pRef = projectRef(joinRequest.project.organisation.slug, joinRequest.project.slug);
    // 3. Notify the applicant
    await tx.notification.create({
      data: {
        userId: joinRequest.userId,
        organisationId: null,
        kind: "join_request_accepted",
        title: `Your request to join ${joinRequest.project.name} was accepted!`,
        url: projectPath(pRef),
      },
    });
  });

  const pRef = projectRef(joinRequest.project.organisation.slug, joinRequest.project.slug);
  revalidatePath(orgPath(pRef, "invites"));
  revalidatePath(orgPath(pRef, "members"));
  revalidatePath("/[org]/[project]/org", "layout");
  revalidatePath("/discover");
}

/**
 * Reject a pending join request. Org admins only.
 */
export async function rejectJoinRequestAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const requestId = String(formData.get("requestId") ?? "").trim();
  if (!requestId) return;

  const joinRequest = await prisma.projectJoinRequest.findUnique({
    where: { id: requestId },
    include: {
      project: {
        select: {
          id: true,
          slug: true,
          name: true,
          organisationId: true,
          organisation: { select: { slug: true } },
        },
      },
    },
  });

  if (!joinRequest || joinRequest.status !== "pending") {
    return;
  }

  if (!(await canManageProject(user, joinRequest.project.organisationId))) {
    return;
  }

  await prisma.$transaction(async (tx) => {
    // Only a request still pending can be declined, and only once (see accept).
    const decided = await tx.projectJoinRequest.updateMany({
      where: { id: requestId, status: "pending" },
      data: {
        status: "rejected",
        reviewedBy: user.id,
        reviewedAt: new Date(),
      },
    });
    if (decided.count === 0) return;

    await tx.notification.create({
      data: {
        userId: joinRequest.userId,
        organisationId: null,
        kind: "join_request_rejected",
        title: `Your request to join ${joinRequest.project.name} was not accepted`,
        url: "/discover",
      },
    });
  });

  const pRef = projectRef(joinRequest.project.organisation.slug, joinRequest.project.slug);
  revalidatePath(orgPath(pRef, "invites"));
  revalidatePath("/[org]/[project]/org", "layout");
  revalidatePath("/discover");
}

/**
 * Remove an external contributor from a project. Org admins only.
 */
export async function removeProjectMemberAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const projectId = String(formData.get("projectId") ?? "").trim();
  const targetUserId = String(formData.get("userId") ?? "").trim();

  if (!projectId || !targetUserId) return;

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      organisationId: true,
      slug: true,
      organisation: { select: { slug: true } },
    },
  });

  if (!project) return;

  if (!(await canManageProject(user, project.organisationId))) {
    return;
  }

  await prisma.projectMembership.deleteMany({
    where: { projectId, userId: targetUserId },
  });

  const pRef = projectRef(project.organisation.slug, project.slug);
  revalidatePath(orgPath(pRef, "members"));
  revalidatePath("/[org]/[project]/org", "layout");
  revalidatePath("/discover");
}

export type JoinOpenProjectResult = { ok: true; href: string } | { ok: false; error: string };

/**
 * Joins a project that is open for contributors straight away (#earnings): no request to wait on and nobody to
 * accept it, because opening the project to contributors already said yes. Any earlier request is marked accepted.
 * Returns where to go next: the project's Marketing tab when it has marketing tasks waiting for bids or is all
 * marketing (#marketing-home), else its Ideas.
 */
export async function joinOpenProjectAction(projectId: string): Promise<JoinOpenProjectResult> {
  const user = await requireUser();
  const project = await prisma.project.findFirst({
    where: { id: projectId, archivedAt: null },
    select: { id: true, slug: true, isOpenForContributors: true, visibility: true, organisationId: true, organisation: { select: { slug: true } } },
  });
  if (!project) return { ok: false, error: "Project not found." };
  if (!project.isOpenForContributors || project.visibility !== "public") {
    return { ok: false, error: "This project isn't open to join right now." };
  }

  await prisma.$transaction(async (tx) => {
    await tx.projectMembership.upsert({
      where: { projectId_userId: { projectId: project.id, userId: user.id } },
      create: { projectId: project.id, userId: user.id },
      update: {},
    });
    // Joining a project puts you in that project only, not its organisation (Chloe's call, reverting #531): you
    // see and work in just what you joined. A brand-new person (in no organisation) still gets the signup bonus,
    // paid in the joined project's organisation: once per account (its source key is the account), so it is never
    // paid twice, and someone who already has an organisation got theirs, or comes in another way.
    const inAnOrganisation = await tx.membership.findFirst({ where: { userId: user.id }, select: { id: true } });
    if (!inAnOrganisation) await awardSignupBonus(tx, user.id, project.organisationId);
    await tx.projectJoinRequest.updateMany({
      where: { projectId: project.id, userId: user.id, status: "pending" },
      data: { status: "accepted", reviewedAt: new Date() },
    });
  });

  const pRef = projectRef(project.organisation.slug, project.slug);
  const marketingTasks = await prisma.bug.count({
    where: { projectId: project.id, track: "marketing", status: "open", isDeleted: false },
  });
  revalidatePath("/discover");
  revalidatePath(orgPath(pRef, "members"));
  const href = marketingTasks > 0 ? marketingPath(pRef) : await projectHomePath(prisma, project.id, pRef);
  return { ok: true, href };
}

export type RequestToJoinResult = { ok: true } | { ok: false; error: string };

/**
 * Ask to join a public project that is not open for contributors (#join-requests). An open project needs no
 * request (joinOpenProjectAction lets you straight in), and a private project can't be asked at all: it answers
 * exactly like a project that doesn't exist, so a request never confirms a private project is there.
 *
 * One request per person per project (the table's unique key). A pending request can't be sent again; a
 * declined one can be sent again after DECLINED_REQUEST_COOLDOWN_MS; an accepted one whose membership was
 * later removed can be sent again straight away. The organisation's owners and admins are notified and
 * decide it from Organisation → Invites.
 */
export async function requestToJoinProjectAction(projectId: string, rawMessage: string): Promise<RequestToJoinResult> {
  const user = await requireUser();
  if (typeof projectId !== "string" || !projectId.trim()) return { ok: false, error: "Project not found." };
  const message = typeof rawMessage === "string" ? rawMessage.trim().slice(0, 1000) : "";

  const project = await prisma.project.findFirst({
    where: { id: projectId, archivedAt: null, visibility: "public", organisation: { archivedAt: null } },
    select: {
      id: true,
      slug: true,
      name: true,
      organisationId: true,
      isOpenForContributors: true,
      organisation: { select: { slug: true } },
    },
  });
  if (!project) return { ok: false, error: "Project not found." };
  if (project.isOpenForContributors) {
    return { ok: false, error: "This project is open to everyone: use Join instead." };
  }
  if (await canContributeToProject(user, project.id, project.organisationId)) {
    return { ok: false, error: "You're already a member of this project." };
  }

  const existing = await prisma.projectJoinRequest.findUnique({
    where: { projectId_userId: { projectId: project.id, userId: user.id } },
    select: { status: true, reviewedAt: true, updatedAt: true },
  });
  if (existing?.status === "pending") {
    return { ok: false, error: "You've already asked to join this project. The maintainers will get back to you." };
  }
  if (existing?.status === "rejected") {
    const declinedAt = (existing.reviewedAt ?? existing.updatedAt).getTime();
    if (Date.now() - declinedAt < DECLINED_REQUEST_COOLDOWN_MS) {
      return { ok: false, error: "Your last request was declined. You can ask again tomorrow." };
    }
  }

  try {
    await prisma.projectJoinRequest.upsert({
      where: { projectId_userId: { projectId: project.id, userId: user.id } },
      create: { projectId: project.id, userId: user.id, message: message || null, status: "pending" },
      update: { message: message || null, status: "pending", reviewedBy: null, reviewedAt: null },
    });
  } catch (error) {
    // Two sends at once: the other one made the row, so this one is the duplicate.
    if ((error as { code?: string })?.code === "P2002") {
      return { ok: false, error: "You've already asked to join this project. The maintainers will get back to you." };
    }
    throw error;
  }

  const pRef = projectRef(project.organisation.slug, project.slug);
  const managers = await prisma.membership.findMany({
    where: { organisationId: project.organisationId, role: { in: ["owner", "admin"] } },
    select: { userId: true },
  });
  if (managers.length > 0) {
    await prisma.notification
      .createMany({
        data: managers.map((manager) => ({
          userId: manager.userId,
          organisationId: project.organisationId,
          kind: "join_request",
          title: `${user.name || "Someone"} asked to join ${project.name}`,
          url: orgPath(pRef, "invites"),
        })),
      })
      .catch((error) => console.error("[join-requests] notifying maintainers failed", error));
  }

  revalidatePath("/discover");
  revalidatePath(projectPath(pRef));
  revalidatePath(orgPath(pRef, "invites"));
  return { ok: true };
}
