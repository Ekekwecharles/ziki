import { DEFAULT_MARKETING_TASK_TYPES } from "@/lib/marketing/default-task-types";
import { randomInt } from "node:crypto";
import { cookies } from "next/headers";
import { awardSignupBonus } from "@/lib/points/signup-bonus";
import { addOnCallGuests } from "@/lib/on-call-guests";
import { unstable_rethrow } from "next/navigation";
import type { MembershipRole, Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { isSuperAdmin, type AppRole } from "@/lib/roles";
import { ZEDU_SLUG } from "@/lib/organisation";
import { appCookieOptions } from "@/lib/cookie-options";
import { isReservedProjectSlug } from "@/lib/project-slug";

/**
 * Picking, creating and owning organisations (#444).
 *
 * After sign-in a person works inside one organisation: one they already belong
 * to, one they create, or one they were invited to (lib/invites.ts). A
 * membership is the only way in. Nothing here adds anyone to a organisation except
 * its creator, and there is no joining by name or slug.
 *
 * The organisation picked on this device lives in a cookie, like the active project
 * (#426). It is only a hint: lib/organisation-context.ts checks it against the
 * person's memberships on every request, so a stale or forged id falls back.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export const ACTIVE_ORGANISATION_COOKIE = "ziki_active_organisation";
export const ACTIVE_ORGANISATION_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export const ORGANISATION_NAME_MIN = 2;
export const ORGANISATION_NAME_MAX = 60;
export const ORGANISATION_SLUG_MAX = 48;

/** Creating organisations is rare; this only stops a script from filling the table. */
export const CREATE_ORGANISATION_RATE_LIMIT = { max: 5, windowMs: 60 * 60 * 1000 };

export const MEMBERSHIP_ROLE_LABELS: Record<MembershipRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

const MEMBERSHIP_ROLE_ORDER: Record<MembershipRole, number> = {
  owner: 0,
  admin: 1,
  member: 2,
};

/**
 * Pair memberships with the people they point at. A membership whose user
 * row is gone is skipped: joining it in one query makes Prisma throw
 * "Field user is required" and the whole members page (/org/members) fails.
 */
export function organisationMembersFrom<TUser extends { id: string; name: string | null }>(
  memberships: { role: MembershipRole; createdAt: Date; userId: string }[],
  users: TUser[],
): { role: MembershipRole; createdAt: Date; user: TUser }[] {
  const byId = new Map(users.map((user) => [user.id, user]));
  return memberships
    .flatMap((membership) => {
      const user = byId.get(membership.userId);
      if (!user) return [];
      return [{ role: membership.role, createdAt: membership.createdAt, user }];
    })
    .sort((a, b) => {
      const byRole = MEMBERSHIP_ROLE_ORDER[a.role] - MEMBERSHIP_ROLE_ORDER[b.role];
      if (byRole !== 0) return byRole;
      return (a.user.name ?? "").localeCompare(b.user.name ?? "");
    });
}

export type OrganisationChoice = {
  id: string;
  slug: string;
  name: string;
  /** Set when the organisation is archived and can't be opened (#573). */
  archivedAt: Date | null;
  /** The person's role in this organisation. */
  role: MembershipRole;
};

const organisationChoiceSelect = {
  role: true,
  organisation: { select: { id: true, slug: true, name: true, archivedAt: true } },
} as const;

/** Same row, for a database that has not added Organisation.archivedAt yet (#573). */
const organisationIdentitySelect = {
  role: true,
  organisation: { select: { id: true, slug: true, name: true } },
} as const;

function toChoice(membership: {
  role: MembershipRole;
  organisation: { id: string; slug: string; name: string; archivedAt: Date | null };
}): OrganisationChoice {
  return { ...membership.organisation, role: membership.role };
}

function choiceWithoutArchive(membership: {
  role: MembershipRole;
  organisation: { id: string; slug: string; name: string };
}): OrganisationChoice {
  return { ...membership.organisation, archivedAt: null, role: membership.role };
}

/**
 * True when Postgres is behind the migration that added Organisation.archivedAt.
 * A printed query that merely mentions the name does not count.
 */
function archivedAtMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  const metaColumn =
    error !== null &&
    typeof error === "object" &&
    "meta" in error &&
    typeof (error as { meta?: { column?: unknown } }).meta?.column === "string"
      ? (error as { meta: { column: string } }).meta.column
      : "";
  if (/(?:^|[\w."]*\.)?archivedAt$/i.test(metaColumn)) return true;
  return /column [`'"]?(?:[\w."]+\.)*archivedAt[`'"]?(?: of relation [`'"]?[\w.]+[`'"]?)? does not exist/i.test(
    message,
  );
}

// ---------------------------------------------------------------------------
// The organisation picked on this device
// ---------------------------------------------------------------------------

export async function readActiveOrganisationCookie(): Promise<string | null> {
  try {
    return (await cookies()).get(ACTIVE_ORGANISATION_COOKIE)?.value || null;
  } catch (error) {
    // Let Next see its own signals (e.g. "this page is dynamic").
    unstable_rethrow(error);
    // Tests and scripts have no cookie jar: nothing is picked.
    return null;
  }
}

/** Remember the organisation on this device. Callers check the membership first. */
export async function setActiveOrganisationCookie(organisationId: string): Promise<void> {
  (await cookies()).set(ACTIVE_ORGANISATION_COOKIE, organisationId, appCookieOptions(ACTIVE_ORGANISATION_COOKIE_MAX_AGE));
}

// ---------------------------------------------------------------------------
// The person's organisations, and where they land
// ---------------------------------------------------------------------------

/** Only the organisations the person belongs to, by name. Never anyone else's. */
export async function organisationsForUser(
  db: Db,
  userId: string,
  userRole?: AppRole | null,
): Promise<OrganisationChoice[]> {
  try {
    const memberships = await db.membership.findMany({
      where: { userId },
      select: organisationChoiceSelect,
      orderBy: { organisation: { name: "asc" } },
    });
    const choices = memberships.map(toChoice);
    if (isSuperAdmin(userRole)) {
      return choices.map((c) => ({ ...c, role: "owner" as const }));
    }
    return choices;
  } catch (error) {
    if (!archivedAtMissing(error)) {
      console.error("[organisations] organisationsForUser failed", error);
      return [];
    }
    console.error("[organisations] archivedAt is missing; listing organisations without it", error);
    try {
      const memberships = await db.membership.findMany({
        where: { userId },
        select: organisationIdentitySelect,
        orderBy: { organisation: { name: "asc" } },
      });
      const choices = memberships.map(choiceWithoutArchive);
      if (isSuperAdmin(userRole)) {
        return choices.map((c) => ({ ...c, role: "owner" as const }));
      }
      return choices;
    } catch (retryError) {
      console.error("[organisations] organisationsForUser failed", retryError);
      return [];
    }
  }
}

/**
 * Where the home page sends a signed-in person:
 *
 * - one membership: straight into it, never the picker;
 * - several, and one of them picked on this device: into that one;
 * - several and none picked, or none at all: the picker, where they can
 *   choose, create a organisation, or accept an invite.
 */
export function landingPath(
  memberOrganisationIds: ReadonlyArray<string>,
  pickedOrganisationId: string | null,
): "/home" | "/organisations" {
  if (memberOrganisationIds.length === 1) return "/home";
  if (pickedOrganisationId && memberOrganisationIds.includes(pickedOrganisationId)) return "/home";
  return "/organisations";
}

export async function homePathFor(db: Db, userId: string): Promise<"/home" | "/organisations"> {
  try {
    const memberships = await db.membership.findMany({
      where: { userId },
      select: { organisationId: true, organisation: { select: { archivedAt: true } } },
    });
    return landingPath(
      memberships.filter((m) => !m.organisation.archivedAt).map((m) => m.organisationId),
      await readActiveOrganisationCookie(),
    );
  } catch (error) {
    console.error("[organisations] homePathFor failed", error);
    return "/home";
  }
}

/** A organisation the person belongs to, by id. Null for any other id. */
export async function memberOrganisationById(
  db: Db,
  userId: string,
  organisationId: string,
): Promise<OrganisationChoice | null> {
  if (!organisationId) return null;
  try {
    const membership = await db.membership.findUnique({
      where: { organisationId_userId: { organisationId, userId } },
      select: organisationChoiceSelect,
    });
    return membership ? toChoice(membership) : null;
  } catch (error) {
    if (!archivedAtMissing(error)) {
      console.error("[organisations] memberOrganisationById failed", error);
      return null;
    }
    console.error("[organisations] archivedAt is missing; loading the organisation without it", error);
    try {
      const membership = await db.membership.findUnique({
        where: { organisationId_userId: { organisationId, userId } },
        select: organisationIdentitySelect,
      });
      return membership ? choiceWithoutArchive(membership) : null;
    } catch (retryError) {
      console.error("[organisations] memberOrganisationById failed", retryError);
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Creating a organisation
// ---------------------------------------------------------------------------

const collapse = (value: string) => value.replace(/\s+/g, " ").trim();
const hasControlChars = (value: string) => /[\u0000-\u001f\u007f]/.test(value);

/** Names are shown in the header and the picker: short, readable, one line. */
function nameRules(label: string) {
  return z
    .string()
    .refine(
      (value) => value.length >= ORGANISATION_NAME_MIN,
      `${label} must be at least ${ORGANISATION_NAME_MIN} characters.`,
    )
    .refine(
      (value) => value.length <= ORGANISATION_NAME_MAX,
      `${label} must be ${ORGANISATION_NAME_MAX} characters or fewer.`,
    )
    .refine((value) => !hasControlChars(value), `${label} can't contain control characters.`)
    // #537: a name is plain text. Angle brackets only ever mean markup here.
    .refine((value) => !/[<>]/.test(value), `${label} can't contain < or >.`);
}

export const organisationNameSchema = z
  .string()
  .transform(collapse)
  .pipe(nameRules("Organisation name"));

export const createOrganisationSchema = z.object({
  name: organisationNameSchema,
});

/** Slugs kept back because they read as route names, such as /organisations/invite. */
const RESERVED_ORGANISATION_SLUGS: ReadonlySet<string> = new Set(["invite", "new"]);

/**
 * A URL-safe slug from a display name, by the same rules as project slugs
 * (#426): accents dropped, lower case, runs of anything else become "-".
 */
export function slugFromName(name: string, fallback: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, ORGANISATION_SLUG_MAX)
    .replace(/-+$/g, "");
  return slug || fallback;
}

const SUFFIX_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

function randomSuffix(): string {
  let suffix = "";
  for (let i = 0; i < 4; i++) suffix += SUFFIX_ALPHABET[randomInt(SUFFIX_ALPHABET.length)];
  return suffix;
}

/**
 * The slug to try on each attempt: the name's own slug first, then that slug
 * with a random tail. Random rather than "-2", "-3", ..., so the slug a
 * creator gets says nothing about how many organisations share their name.
 */
export function organisationSlugCandidate(
  base: string,
  attempt: number,
  suffix: () => string = randomSuffix,
): string {
  // An organisation's slug starts its addresses (`/<org>/<project>`), so never a top-level route's name.
  if (attempt === 0 && !RESERVED_ORGANISATION_SLUGS.has(base) && !isReservedProjectSlug(base)) return base;
  const tail = `-${suffix()}`;
  return `${base.slice(0, ORGANISATION_SLUG_MAX - tail.length).replace(/-+$/g, "")}${tail}`;
}

const SLUG_ATTEMPTS = 5;

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

export type CreateOrganisationResult =
  | {
      ok: true;
      organisation: { id: string; slug: string; name: string };
    }
  | {
      ok: false;
      error: string;
      field?: "name";
      /** #537: set when the creator already belongs to a organisation with this name. */
      duplicateName?: string;
    };

/** The project every new organisation starts with. */
export const DEFAULT_PROJECT_NAME = "Web";
const DEFAULT_PROJECT_SLUG = "web";

/**
 * Creates an organisation with the creator as its owner and one project, Web,
 * so nobody is asked to name a first project; more are added from the Projects
 * page (`/<org>`). Projects have no owner of their own: the organisation's owner
 * owns every project in it. One nested create, so an organisation never exists
 * without its owner or its first project.
 */
export async function createOrganisation(
  db: Db,
  creator: { id: string },
  input: { name?: unknown; confirmDuplicate?: unknown },
  suffix: () => string = randomSuffix,
): Promise<CreateOrganisationResult> {
  const parsed = createOrganisationSchema.safeParse({
    name: typeof input.name === "string" ? input.name : "",
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      error: issue?.message ?? "Check the organisation's name.",
      field: "name",
    };
  }

  const { name } = parsed.data;
  const base = slugFromName(name, "organisation");

  // #537: two organisations you're in with the same name look identical. Ask first;
  // sending the same name back as `confirmDuplicate` creates it anyway.
  const confirmed = typeof input.confirmDuplicate === "string" && collapse(input.confirmDuplicate) === name;
  if (!confirmed) {
    const same = await db.membership.findFirst({
      where: { userId: creator.id, organisation: { name: { equals: name, mode: "insensitive" } } },
      select: { organisation: { select: { name: true, slug: true } } },
    });
    if (same) {
      return {
        ok: false,
        field: "name",
        duplicateName: name,
        error: `You're already in an organisation called "${same.organisation.name}" (${same.organisation.slug}). Choose another name, or select Create anyway to have both.`,
      };
    }
  }

  for (let attempt = 0; attempt < SLUG_ATTEMPTS; attempt++) {
    const slug = organisationSlugCandidate(base, attempt, suffix);
    try {
      const organisation = await db.organisation.create({
        data: {
          slug,
          name,
          memberships: { create: { userId: creator.id, role: "owner" } },
          // Every new organisation starts with one project, Web, so nobody is asked to name a first one.
          projects: { create: { name: DEFAULT_PROJECT_NAME, slug: DEFAULT_PROJECT_SLUG, workflow: { create: {} } } },
          issueTypes: { create: DEFAULT_MARKETING_TASK_TYPES.map((type) => ({ ...type, track: "marketing" as const })) },
        },
        select: { id: true, slug: true, name: true },
      });
      await awardSignupBonus(db, creator.id, organisation.id);
      // On-call guests (12 Nov plan, D2): a few free on-call agents join to give a quick win. Never fails the create.
      await addOnCallGuests(db, { organisationId: organisation.id, creatorId: creator.id });
      return { ok: true, organisation: { id: organisation.id, slug: organisation.slug, name: organisation.name } };
    } catch (error) {
      // Only the slug is unique on a brand-new organisation: try another one.
      if (isUniqueViolation(error)) continue;
      throw error;
    }
  }
  return { ok: false, error: "Couldn't create that organisation. Try a different name.", field: "name" };
}

// ---------------------------------------------------------------------------
// Renaming, archiving and deleting a organisation (#573)
// ---------------------------------------------------------------------------

export type OrganisationLifecycleResult =
  | { ok: true; organisation: OrganisationChoice }
  | { ok: false; error: string };

/** The organisation, only when this person owns it. */
async function ownerOrganisation(
  db: Db,
  userId: string,
  organisationId: string,
): Promise<OrganisationChoice | null> {
  if (!organisationId) return null;
  const membership = await db.membership.findUnique({
    where: { organisationId_userId: { organisationId, userId } },
    select: organisationChoiceSelect,
  });
  if (!membership || membership.role !== "owner") return null;
  return toChoice(membership);
}

/**
 * Rename a organisation without changing its slug: links and project URLs keep
 * working. Only an owner can rename, and archived organisations are read-only.
 */
export async function renameOrganisation(
  db: Db,
  userId: string,
  organisationId: string,
  name: unknown,
): Promise<OrganisationLifecycleResult> {
  const parsed = organisationNameSchema.safeParse(typeof name === "string" ? name : "");
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the organisation's name." };
  }

  const organisation = await ownerOrganisation(db, userId, organisationId);
  if (!organisation) return { ok: false, error: "Only the organisation's owner can rename it." };
  if (organisation.archivedAt) return { ok: false, error: "Restore this organisation before renaming it." };

  await db.organisation.update({ where: { id: organisation.id }, data: { name: parsed.data } });
  return { ok: true, organisation: { ...organisation, name: parsed.data } };
}

/**
 * Archive or restore a organisation. Archiving hides it from the switcher, stops it
 * being auto-selected, and makes its settings read-only. Zedu is the default
 * organisation and is never archived.
 */
export async function setOrganisationArchived(
  db: Db,
  userId: string,
  organisationId: string,
  archived: boolean,
): Promise<OrganisationLifecycleResult> {
  const organisation = await ownerOrganisation(db, userId, organisationId);
  if (!organisation) return { ok: false, error: "Only the organisation's owner can archive it." };
  if (archived && organisation.slug === ZEDU_SLUG) {
    return { ok: false, error: "Zedu is the default organisation and can't be archived." };
  }
  if (Boolean(organisation.archivedAt) === archived) return { ok: true, organisation };

  const archivedAt = archived ? new Date() : null;
  await db.organisation.update({ where: { id: organisation.id }, data: { archivedAt } });
  return { ok: true, organisation: { ...organisation, archivedAt } };
}

/**
 * Permanently delete an empty organisation. "Empty" means no issues, no agents and
 * no members besides the owner. Anything else must be archived instead.
 */
export async function deleteOrganisation(
  db: Db,
  userId: string,
  organisationId: string,
  confirmName: unknown,
): Promise<OrganisationLifecycleResult> {
  const organisation = await ownerOrganisation(db, userId, organisationId);
  if (!organisation) return { ok: false, error: "Only the organisation's owner can delete it." };
  if (organisation.slug === ZEDU_SLUG) {
    return { ok: false, error: "Zedu is the default organisation and can't be deleted." };
  }

  const counts = await db.organisation.findUnique({
    where: { id: organisation.id },
    select: { _count: { select: { bugs: true, ideas: true, agentActivations: { where: { deactivatedAt: null } }, memberships: true } } },
  });
  if (!counts) return { ok: false, error: "That organisation no longer exists." };

  const { bugs, ideas, agentActivations: agents, memberships } = counts._count;
  if (bugs > 0 || ideas > 0 || agents > 0 || memberships > 1) {
    return {
      ok: false,
      error: "This organisation still has issues, ideas, agents or other members. Archive it instead.",
    };
  }

  const typed = typeof confirmName === "string" ? confirmName.trim() : "";
  if (typed !== organisation.name) {
    return { ok: false, error: "Type the organisation's name exactly to confirm." };
  }

  try {
    await db.organisation.delete({ where: { id: organisation.id } });
  } catch (error) {
    console.error("[organisations] deleteOrganisation failed", error);
    return { ok: false, error: "Couldn't delete this organisation. Archive it instead." };
  }
  return { ok: true, organisation };
}

// ---------------------------------------------------------------------------
// Zedu's first owner
// ---------------------------------------------------------------------------

/**
 * Ensure a user has an owner membership in the primary Zedu organisation (#536).
 * Any super admin automatically gets owner privileges.
 */
export async function ensureZeduOwnerMembership(
  userId: string,
  db: Db,
): Promise<void> {
  const organisation = await db.organisation.upsert({
    where: { slug: ZEDU_SLUG },
    update: {},
    create: { slug: ZEDU_SLUG, name: "Ziki" },
  });

  await db.membership.upsert({
    where: { organisationId_userId: { organisationId: organisation.id, userId } },
    update: { role: "owner" },
    create: { organisationId: organisation.id, userId, role: "owner" },
  });
}

/**
 * Everyone moved into Zedu by the migration is a member, never an owner
 * (#423), so nobody could invite anyone. The site's super admin picks the
 * first owner from Zedu's existing members. This never adds anyone to Zedu,
 * and once Zedu has an owner the super admin has no say here.
 */
export async function zeduNeedsOwner(db: Db): Promise<boolean> {
  const zedu = await db.organisation.findUnique({ where: { slug: ZEDU_SLUG }, select: { id: true } });
  if (!zedu) return false;
  const owners = await db.membership.count({ where: { organisationId: zedu.id, role: "owner" } });
  return owners === 0;
}

const memberEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email("Enter the member's email address."));

export type PromoteOwnerResult =
  | { ok: true; name: string }
  | { ok: false; error: string; field?: "email" };

export async function promoteFirstZeduOwner(
  db: Db,
  actor: { role?: AppRole | null },
  email: unknown,
): Promise<PromoteOwnerResult> {
  if (!isSuperAdmin(actor.role)) {
    return { ok: false, error: "Only the site's super admin can choose Zedu's first owner." };
  }
  const parsed = memberEmailSchema.safeParse(typeof email === "string" ? email : "");
  if (!parsed.success) {
    return { ok: false, error: "Enter the member's email address.", field: "email" };
  }

  const zedu = await db.organisation.findUnique({ where: { slug: ZEDU_SLUG }, select: { id: true } });
  if (!zedu) return { ok: false, error: "There's no Zedu organisation yet. Run the database migrations." };

  const owners = await db.membership.count({ where: { organisationId: zedu.id, role: "owner" } });
  if (owners > 0) return { ok: false, error: "Zedu already has an owner." };

  const membership = await db.membership.findFirst({
    where: { organisationId: zedu.id, user: { email: { equals: parsed.data, mode: "insensitive" } } },
    select: { id: true, user: { select: { name: true } } },
  });
  if (!membership) {
    return { ok: false, error: "Nobody in Zedu has that email. Only an existing member can be made owner.", field: "email" };
  }

  await db.membership.update({ where: { id: membership.id }, data: { role: "owner" } });
  return { ok: true, name: membership.user.name };
}
