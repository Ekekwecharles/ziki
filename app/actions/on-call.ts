"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireSuperAdmin, requireUser } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import {
  OnCallError,
  cancelOnCallInvite,
  inviteToOnCall,
  removeFromOnCall,
  resolveInviteEmail,
  respondToOnCallInvite,
  searchPeopleForOnCall,
  setSecurityClearance,
  type PersonMatch,
} from "@/lib/security-checks/on-call";

/**
 * On-call people (#on-call, 14 Nov plan). Super admins invite people by email and
 * manage the list at /superadmin/on-call; the invited person answers on My agents. Errors come back to the page as `?error=<code>`.
 */

const ADMIN_PAGE = "/superadmin/on-call";
const MY_AGENTS = "/agents/mine";

function field(formData: FormData, name: string): string {
  return String(formData.get(name) ?? "").trim();
}

async function orRedirect(page: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (error instanceof OnCallError) redirect(`${page}?error=${error.code}`);
    throw error;
  }
  // The staff page and the pages under it (a person's own page) all show what was just changed.
  if (page === ADMIN_PAGE) revalidatePath(page, "layout");
  else revalidatePath(page);
}

/** Invite a person by email, or by display name when it matches exactly one person. */
export async function inviteOnCallAction(formData: FormData): Promise<void> {
  const admin = await requireSuperAdmin();
  const typed = field(formData, "email");
  if (!typed) return;
  await orRedirect(ADMIN_PAGE, async () => {
    const email = await resolveInviteEmail(typed, prisma);
    return inviteToOnCall(prisma, { email, invitedById: admin.id, clearForSecurity: formData.get("clearForSecurity") === "on" });
  });
}

/** The invite box's search as staff type: people by display name or email. */
export async function searchOnCallPeopleAction(query: string): Promise<PersonMatch[]> {
  await requireSuperAdmin();
  return searchPeopleForOnCall(typeof query === "string" ? query.slice(0, 100) : "", prisma);
}

export async function cancelOnCallInviteAction(formData: FormData): Promise<void> {
  await requireSuperAdmin();
  const inviteId = field(formData, "inviteId");
  if (!inviteId) return;
  await orRedirect(ADMIN_PAGE, () => cancelOnCallInvite(prisma, inviteId));
}

export async function removeOnCallAction(formData: FormData): Promise<void> {
  await requireSuperAdmin();
  const userId = field(formData, "userId");
  if (!userId) return;
  await orRedirect(ADMIN_PAGE, () => removeFromOnCall(prisma, userId));
}

export async function setSecurityClearanceAction(formData: FormData): Promise<void> {
  await requireSuperAdmin();
  const userId = field(formData, "userId");
  if (!userId) return;
  await orRedirect(ADMIN_PAGE, () => setSecurityClearance(prisma, userId, formData.get("cleared") === "true"));
}

/** The invited person accepts or declines. */
export async function respondOnCallInviteAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const inviteId = field(formData, "inviteId");
  if (!inviteId) return;
  await orRedirect(MY_AGENTS, () => respondToOnCallInvite(prisma, { inviteId, userId: user.id, accept: formData.get("accept") === "true" }));
}
