"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth-helpers";
import { securityReturnPath } from "@/lib/security-return-path";
import { fieldError } from "@/lib/form-errors";
import {
  ACCEPT_INVITE_RATE_LIMIT,
  CREATE_INVITE_RATE_LIMIT,
  acceptInvite,
  createInvite,
  deliverInvite,
  destinationForInviteInput,
  inviteUrl,
  revokeInvite,
  type InviteDelivery,
} from "@/lib/invites";
import { acceptShareLink, createShareLink, revokeShareLink } from "@/lib/share-invites";
import { prisma } from "@/lib/prisma";

import { RATE_LIMIT_MESSAGE, consumeRateLimit } from "@/lib/rate-limit";
import {
  CREATE_ORGANISATION_RATE_LIMIT,
  createOrganisation,
  createOrganisationSchema,
  deleteOrganisation,
  memberOrganisationById,
  promoteFirstZeduOwner,
  renameOrganisation,
  setActiveOrganisationCookie,
  setOrganisationArchived,
  type PromoteOwnerResult,
} from "@/lib/organisations";
import { refererProjectRef } from "@/lib/referer-path";
import { orgPath } from "@/lib/project-paths";

/**
 * The organisation picker's actions (#444), and the organisation admin's actions
 * behind /org. Each acts as the signed-in person and only ever on organisations
 * they belong to; lib/organisations.ts and lib/invites.ts hold the rules.
 */

/** The organisation admin area. It always shows the organisation this device is working in. */
/** The org Settings page the action came from (`/<org>/<project>/org/settings`, #project-urls). */
async function orgSettingsPath(): Promise<string> {
  const slug = await refererProjectRef();
  return slug ? orgPath(slug, "settings") : "/home";
}

export type OrganisationFormResult = {
  error?: string;
  field?: string;
  fieldErrors?: Record<string, string>;
  /** #537: the name to confirm before a second organisation with it is created. */
  duplicateName?: string;
};

/** Work in this organisation on this device, and open its project (#project-urls): the one given, else its first. */
async function enterOrganisation(organisationId: string, next?: string | null): Promise<never> {
  await setActiveOrganisationCookie(organisationId);
  revalidatePath("/", "layout");
  // Back to where the person was going, if that was Security (a site they scanned on the public page).
  // Otherwise /home opens the first project of the organisation just made current, or its Projects page when it has none.
  redirect(next ?? "/home");
}

/**
 * Open one of the person's organisations. An id they aren't a member of changes
 * nothing and says nothing about whether that organisation exists.
 */
export async function selectOrganisationAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const organisation = await memberOrganisationById(prisma, user.id, String(formData.get("organisationId") ?? ""));
  if (!organisation) redirect("/organisations");
  if (organisation.archivedAt) {
    redirect(`/organisations?error=${encodeURIComponent("Restore this organisation before opening it.")}`);
  }
  await enterOrganisation(organisation.id);
}

/** Create an organisation owned by the person, with its Web project, and enter it. */
export async function createOrganisationAction(
  _previous: OrganisationFormResult | undefined,
  formData: FormData,
): Promise<OrganisationFormResult> {
  const user = await requireUser();
  const input = { name: formData.get("name") ?? "" };

  // Typos don't count against the limit; only real attempts do.
  const parsed = createOrganisationSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return fieldError("name", issue?.message ?? "Check the name.");
  }
  if (!(await consumeRateLimit(`organisation-create:${user.id}`, CREATE_ORGANISATION_RATE_LIMIT)).allowed) {
    return { error: RATE_LIMIT_MESSAGE };
  }

  const confirmDuplicate = formData.get("confirmDuplicate");
  const result = await createOrganisation(prisma, user, {
    ...input,
    ...(typeof confirmDuplicate === "string" && confirmDuplicate ? { confirmDuplicate } : {}),
  });
  if (!result.ok) {
    const error = fieldError(result.field ?? "name", result.error);
    return result.duplicateName ? { ...error, duplicateName: result.duplicateName } : error;
  }
  return enterOrganisation(result.organisation.id, securityReturnPath(formData.get("next")));
}

/** Rename a organisation the person owns; the slug stays the same. */
export async function renameOrganisationAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const organisationId = String(formData.get("organisationId") ?? "");
  const organisation = await memberOrganisationById(prisma, user.id, organisationId);
  if (!organisation) redirect("/organisations");

  const result = await renameOrganisation(prisma, user.id, organisationId, formData.get("name"));
  if (!result.ok) {
    redirect(`${await orgSettingsPath()}?error=${encodeURIComponent(result.error)}`);
  }

  revalidatePath("/", "layout");
  redirect(`${await orgSettingsPath()}?notice=${encodeURIComponent("Organisation renamed.")}`);
}

/**
 * Archive or restore a organisation the person owns. Archiving happens in /org;
 * an archived organisation can't be opened, so it is restored from /organisations.
 */
export async function setOrganisationArchivedAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const organisationId = String(formData.get("organisationId") ?? "");
  const organisation = await memberOrganisationById(prisma, user.id, organisationId);
  if (!organisation) redirect("/organisations");

  const archived = String(formData.get("archived") ?? "") === "true";
  const result = await setOrganisationArchived(prisma, user.id, organisationId, archived);
  if (!result.ok) {
    redirect(`${archived ? await orgSettingsPath() : "/organisations"}?error=${encodeURIComponent(result.error)}`);
  }

  revalidatePath("/", "layout");
  redirect(`/organisations?notice=${encodeURIComponent(archived ? "Organisation archived." : "Organisation restored.")}`);
}

/** Delete an empty organisation after the owner types its name. */
export async function deleteOrganisationAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const organisationId = String(formData.get("organisationId") ?? "");
  const organisation = await memberOrganisationById(prisma, user.id, organisationId);
  if (!organisation) redirect("/organisations");

  const result = await deleteOrganisation(prisma, user.id, organisationId, formData.get("confirmName"));
  if (!result.ok) {
    redirect(`${await orgSettingsPath()}?error=${encodeURIComponent(result.error)}`);
  }

  revalidatePath("/", "layout");
  redirect(`/organisations?notice=${encodeURIComponent("Organisation deleted.")}`);
}

export type CreateInviteActionResult =
  | {
      ok: true;
      email: string;
      /** The single-use link, shown to the inviter this once. */
      link: string;
      expiresAt: string;
      delivery: InviteDelivery;
    }
  | { ok: false; error: string; field?: string };

/** An owner or admin invites an email address into their organisation. */
export async function createInviteAction(
  _previous: CreateInviteActionResult | undefined,
  formData: FormData,
): Promise<CreateInviteActionResult> {
  const user = await requireUser();
  if (!(await consumeRateLimit(`organisation-invite:${user.id}`, CREATE_INVITE_RATE_LIMIT)).allowed) {
    return { ok: false, error: RATE_LIMIT_MESSAGE };
  }

  const result = await createInvite(prisma, user, {
    organisationId: String(formData.get("organisationId") ?? ""),
    email: formData.get("email"),
  });
  if (!result.ok) return result;

  let delivery: InviteDelivery = "manual";
  try {
    delivery = await deliverInvite(prisma, {
      invite: result.invite,
      rawToken: result.rawToken,
      organisationId: result.organisation.id,
      organisationName: result.organisation.name,
      inviter: { id: user.id, name: user.name || user.email || "Someone" },
    });
  } catch (error) {
    // The invite exists and the inviter still gets the link to send.
    console.error("[invites] could not tell the invitee", {
      inviteId: result.invite.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  revalidatePath("/[org]/[project]/org", "layout");
  return {
    ok: true,
    email: result.invite.email,
    link: inviteUrl(result.rawToken),
    expiresAt: result.invite.expiresAt.toISOString(),
    delivery,
  };
}

export type CreateShareLinkActionResult =
  | { ok: true; url: string }
  | { ok: false; error: string; field?: string };

/** An owner or admin creates a link anyone can use, within the limits they set. */
export async function createShareLinkAction(
  _previous: CreateShareLinkActionResult | undefined,
  formData: FormData,
): Promise<CreateShareLinkActionResult> {
  const user = await requireUser();
  if (!(await consumeRateLimit(`organisation-share:${user.id}`, CREATE_INVITE_RATE_LIMIT)).allowed) {
    return { ok: false, error: RATE_LIMIT_MESSAGE };
  }

  const result = await createShareLink(prisma, user, {
    organisationId: String(formData.get("organisationId") ?? ""),
    expiresDays: formData.get("expiresDays"),
    maxUses: formData.get("maxUses"),
    label: formData.get("label"),
  });
  if (!result.ok) return result;

  revalidatePath("/[org]/[project]/org", "layout");
  return { ok: true, url: result.url };
}

/** Turn off a share link that hasn't been revoked yet. */
export async function revokeShareLinkAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const result = await revokeShareLink(prisma, user, String(formData.get("linkId") ?? ""));
  if (result.ok) revalidatePath("/[org]/[project]/org", "layout");
}

/**
 * Join via a share link. Called from the join page after Google sign-in, or
 * from the Join button if the person is already signed in.
 */
export async function acceptShareLinkAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const token = String(formData.get("token") ?? "");
  const back = `/join/${token}`;
  if (!(await consumeRateLimit(`organisation-share-accept:${user.id}`, ACCEPT_INVITE_RATE_LIMIT)).allowed) {
    redirect(`${back}?error=rate`);
  }

  const result = await acceptShareLink(prisma, token, user);
  if (!result.ok) redirect(`${back}?error=${result.reason}`);
  return enterOrganisation(result.organisation.id);
}

/** Withdraw a link that hasn't been used. */
export async function revokeInviteAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const result = await revokeInvite(prisma, user, String(formData.get("inviteId") ?? ""));
  if (result.ok) revalidatePath("/[org]/[project]/org", "layout");
}

export type AcceptInviteActionResult = { error?: string };

/** Accept an invite, by its link or from an in-app notification. */
export async function acceptInviteAction(
  _previous: AcceptInviteActionResult | undefined,
  formData: FormData,
): Promise<AcceptInviteActionResult> {
  const user = await requireUser();
  if (!(await consumeRateLimit(`organisation-accept:${user.id}`, ACCEPT_INVITE_RATE_LIMIT)).allowed) {
    return { error: RATE_LIMIT_MESSAGE };
  }

  const token = formData.get("token");
  const inviteId = formData.get("inviteId");
  const result = await acceptInvite(
    prisma,
    typeof token === "string" && token
      ? { token }
      : { inviteId: typeof inviteId === "string" ? inviteId : "" },
    user,
  );
  if (!result.ok) return { error: result.error };
  return enterOrganisation(result.organisation.id);
}

/** Paste an invite link to open it. */
export async function openInviteLinkAction(
  _previous: OrganisationFormResult | undefined,
  formData: FormData,
): Promise<OrganisationFormResult> {
  await requireUser();
  const destination = destinationForInviteInput(String(formData.get("link") ?? ""));
  if (!destination) {
    return fieldError("link", "That isn't a Ziki invite link. Paste the whole link from the invite.");
  }
  redirect(destination);
}

/** The site's super admin makes an existing Zedu member its first owner. */
export async function promoteZeduOwnerAction(
  _previous: PromoteOwnerResult | undefined,
  formData: FormData,
): Promise<PromoteOwnerResult> {
  const user = await requireUser();
  const result = await promoteFirstZeduOwner(prisma, user, formData.get("email"));
  if (result.ok) revalidatePath("/organisations");
  return result;
}
