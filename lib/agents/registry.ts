import type { AgentLevel, Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { isAdmin, type AppRole } from "@/lib/roles";
import { audit } from "@/lib/agents/audit";
import { freeUsername, removeAgentPicture, replaceAgentSkills, setAgentPicture, updateAgentProfile } from "@/lib/agents/profile";
import { agentUsernameSchema } from "@/lib/validations/agent-profile";
import { generateApiKey } from "@/lib/agents/keys";
import { sealSecret } from "@/lib/secret-box";
import { CREATION_LEVELS, DEFAULT_AGENT_LEVEL, canSetLevel } from "@/lib/agents/levels";
import { isAgentAvatar } from "@/lib/agents/avatars";
import { isAdminOfOrganisation } from "@/lib/agents/membership";
import { currentOrganisationIdFor } from "@/lib/organisation-context";
import type { AgentContext } from "@/lib/agents/require-agent";
import { AGENT_LIMIT_MESSAGE, AGENT_MODEL_MAX, AGENT_NAME_MAX, MAX_ACTIVE_AGENTS_PER_OWNER } from "@/lib/agents/registry-limits";
import { releaseWorkOfRevokedAgent } from "@/lib/agent-api/revoke-release";

/**
 * Registering agents and managing their keys (#427). A person owns their agents
 * (#user-agents) and activates each in the organisations they belong to; a key
 * works in one organisation, in every project there. The owner changes who an
 * agent is and where it works; an organisation's admin sets its class and budget
 * there and may switch it off there. An agent can only rotate its own key: it
 * can't rename itself, change owner, create agents or raise its class.
 */

export { AGENT_MODEL_MAX, AGENT_NAME_MAX };

const text = (max: number, label: string) =>
  z
    .string()
    .transform((value) => value.replace(/\s+/g, " ").trim())
    .pipe(
      z
        .string()
        .max(max, `${label} must be ${max} characters or fewer.`)
        .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), `${label} can't contain control characters.`),
    );

export const agentNameSchema = text(AGENT_NAME_MAX, "Name").pipe(
  z.string().min(2, "Give the agent a name of at least 2 characters, like “Ada's Claude”."),
);
export const agentModelSchema = text(AGENT_MODEL_MAX, "Model");

export const createAgentSchema = z.object({
  name: agentNameSchema,
  model: agentModelSchema.optional().transform((value) => value || null),
  level: z.enum(CREATION_LEVELS).default(DEFAULT_AGENT_LEVEL),
});

export type Actor = { id: string; role?: AppRole | null };

type Db = PrismaClient | Prisma.TransactionClient;

export type IssuedKey = { agentId: string; name: string; level: AgentLevel; rawKey: string; prefix: string };

/** A new key for the agent in one organisation (#user-agents), sealed so its owner can copy it again. */
async function insertKey(db: Db, agentId: string, organisationId: string) {
  const key = generateApiKey();
  await db.agentApiKey.create({
    data: { agentId, organisationId, keyHash: key.hash, prefix: key.prefix, sealedKey: sealSecret(key.raw) },
  });
  return key;
}

/**
 * Inserts an agent, activates it in `organisationId` and issues its key there
 * (#user-agents). Shared by the settings page and pairing. The agent is its
 * owner's; the activation carries that organisation's class for it.
 */
export async function insertAgentWithKey(
  db: Db,
  input: { organisationId: string; ownerUserId: string; name: string; model: string | null; level: AgentLevel; instructions?: string | null },
): Promise<IssuedKey> {
  const { organisationId, level, ...agentInput } = input;
  const agent = await db.agent.create({
    data: {
      ...agentInput,
      // #agent-profile: its @username starts as its name; it can change it.
      username: await freeUsername(db, organisationId, input.name),
      activations: { create: { organisationId, level } },
    },
    select: { id: true, name: true },
  });
  const key = await insertKey(db, agent.id, organisationId);
  return { agentId: agent.id, name: agent.name, level, rawKey: key.raw, prefix: key.prefix };
}

/** The person's live agents, whichever organisations they are active in: what the agent cap counts (#511). */
export function countActiveAgents(db: Db, ownerUserId: string): Promise<number> {
  return db.agent.count({ where: { ownerUserId, revokedAt: null } });
}

export type CreateAgentResult =
  | { ok: true; key: IssuedKey }
  | { ok: false; error: string; field?: "name" | "model" | "level" };

/** The owner, signed in, registers an agent, activated in the organisation they are working in, and gets its key once. */
export async function createAgent(owner: Actor, input: unknown): Promise<CreateAgentResult> {
  const parsed = createAgentSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path[0];
    return {
      ok: false,
      error: issue?.message ?? "Check the agent's details.",
      field: field === "name" || field === "model" || field === "level" ? field : undefined,
    };
  }
  const organisationId = await currentOrganisationIdFor(owner.id);
  if (!organisationId) {
    return { ok: false, error: "Join or create an organisation before you register agents." };
  }
  if (!canSetLevel({ isOwner: true, isAdminOfOrganisation: await isAdminOfOrganisation(owner, organisationId) }, parsed.data.level)) {
    return { ok: false, error: "Only an organisation admin can make an agent a manager or merger agent.", field: "level" };
  }

  const key = await prisma.$transaction(async (tx) => {
    // Per-agent budgets would multiply with every extra agent (#511).
    if ((await countActiveAgents(tx, owner.id)) >= MAX_ACTIVE_AGENTS_PER_OWNER) return null;
    const issued = await insertAgentWithKey(tx, {
      organisationId,
      ownerUserId: owner.id,
      name: parsed.data.name,
      model: parsed.data.model,
      level: parsed.data.level,
    });
    await audit(
      { agentId: issued.agentId, organisationId },
      "agent.created",
      `agent:${issued.agentId}`,
      { name: issued.name, model: parsed.data.model, level: parsed.data.level, via: "settings" },
      { actorUserId: owner.id, db: tx },
    );
    return issued;
  });
  if (!key) return { ok: false, error: AGENT_LIMIT_MESSAGE };
  return { ok: true, key };
}

type OwnedAgent = {
  id: string;
  name: string;
  ownerUserId: string;
  revokedAt: Date | null;
  activations: { organisationId: string; level: AgentLevel }[];
};

/**
 * The agent, as its owner sees it: with every organisation it is active in.
 * Null unless the actor owns it (#user-agents): an agent is its owner's, so
 * only they change who it is, where it works and its keys.
 */
async function ownedAgent(actor: Actor, agentId: string): Promise<OwnedAgent | null> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: {
      id: true,
      name: true,
      ownerUserId: true,
      revokedAt: true,
      activations: { where: { deactivatedAt: null }, orderBy: { activatedAt: "asc" }, select: { organisationId: true, level: true } },
    },
  });
  if (!agent || agent.ownerUserId !== actor.id) return null;
  return agent;
}

/**
 * The agent's activation in one organisation, for its owner or that
 * organisation's admin: the class and budget there, and switching it off there.
 */
async function activationFor(actor: Actor, agentId: string, organisationId: string) {
  const activation = await prisma.agentActivation.findUnique({
    where: { agentId_organisationId: { agentId, organisationId } },
    select: {
      id: true,
      level: true,
      burst: true,
      burstUntil: true,
      deactivatedAt: true,
      guest: true,
      agent: { select: { id: true, name: true, ownerUserId: true, revokedAt: true } },
    },
  });
  if (!activation || activation.deactivatedAt) return null;
  const isOwner = activation.agent.ownerUserId === actor.id;
  const isAdminHere = await isAdminOfOrganisation(actor, organisationId);
  if (!isOwner && !isAdminHere) return null;
  return { activation, agent: activation.agent, isOwner, isAdminOfOrganisation: isAdminHere };
}

/** Writes the same audit entry in every organisation the agent is active in, so each sees what happened to it. */
async function auditWhereActive(
  agent: Pick<OwnedAgent, "id" | "activations">,
  action: string,
  metadata: Prisma.InputJsonValue,
  actorUserId: string,
  db: Prisma.TransactionClient,
) {
  for (const { organisationId } of agent.activations) {
    await audit({ agentId: agent.id, organisationId }, action, `agent:${agent.id}`, metadata, { actorUserId, db });
  }
}

export type ManageResult = { ok: true } | { ok: false; error: string };

const NOT_FOUND = "That agent doesn't exist, or it isn't yours to change.";

/**
 * Revokes the agent everywhere, with every key it has. A revoked key fails
 * `requireAgent()` from the next call on. Revoking twice is harmless. Only its
 * owner may: an organisation admin switches it off in their organisation instead.
 */
export async function revokeAgent(actor: Actor, agentId: string, now = new Date()): Promise<ManageResult> {
  const agent = await ownedAgent(actor, agentId);
  if (!agent) return { ok: false, error: NOT_FOUND };
  if (agent.revokedAt) return { ok: true };
  await prisma.$transaction(async (tx) => {
    await tx.agent.update({ where: { id: agentId }, data: { revokedAt: now } });
    await tx.agentApiKey.updateMany({ where: { agentId, revokedAt: null }, data: { revokedAt: now } });
    for (const { organisationId } of agent.activations) {
      // #523: a dead key can't deliver, so its claims and bids go back to the team.
      const handedBack = await releaseWorkOfRevokedAgent(tx, { agentId, organisationId, actorUserId: actor.id, now });
      await audit({ agentId, organisationId }, "agent.revoked", `agent:${agentId}`, { by: "owner", ...handedBack }, { actorUserId: actor.id, db: tx });
    }
  });
  return { ok: true };
}

/**
 * Removes the agent. Open offers, claims, and bids are handed back in every
 * organisation it is active in, then the row and its keys are deleted. Issues it filed stay.
 */
export async function deleteAgent(actor: Actor, agentId: string, now = new Date()): Promise<ManageResult> {
  const agent = await ownedAgent(actor, agentId);
  if (!agent) return { ok: false, error: NOT_FOUND };
  await prisma.$transaction(async (tx) => {
    for (const { organisationId } of agent.activations) {
      await releaseWorkOfRevokedAgent(tx, { agentId, organisationId, actorUserId: actor.id, now });
    }
    await tx.agent.delete({ where: { id: agentId } });
  });
  return { ok: true };
}

/**
 * Switches the agent on in an organisation (#user-agents), for its owner only,
 * and only where they are a member: an organisation that has a person may use
 * all their agents, and the person chooses which. A key for it there comes with it.
 */
export async function activateAgent(
  actor: Actor,
  agentId: string,
  organisationId: string,
): Promise<{ ok: true; key: IssuedKey } | { ok: false; error: string }> {
  const agent = await ownedAgent(actor, agentId);
  if (!agent) return { ok: false, error: NOT_FOUND };
  if (agent.revokedAt) return { ok: false, error: "That agent is revoked." };
  const member = await prisma.membership.findUnique({
    where: { organisationId_userId: { organisationId, userId: actor.id } },
    select: { userId: true },
  });
  if (!member) return { ok: false, error: "You can only bring your agents into an organisation you belong to." };
  const key = await prisma.$transaction(async (tx) => {
    const activation = await tx.agentActivation.upsert({
      where: { agentId_organisationId: { agentId, organisationId } },
      // Switched back on, it keeps the class the organisation gave it before.
      update: { deactivatedAt: null, activatedAt: new Date() },
      create: { agentId, organisationId },
      select: { level: true },
    });
    // One live key per activation: switching it on again replaces any left over.
    await tx.agentApiKey.updateMany({ where: { agentId, organisationId, revokedAt: null }, data: { revokedAt: new Date() } });
    const issued = await insertKey(tx, agentId, organisationId);
    await audit({ agentId, organisationId }, "agent.activated", `agent:${agentId}`, { level: activation.level }, { actorUserId: actor.id, db: tx });
    return { agentId, name: agent.name, level: activation.level, rawKey: issued.raw, prefix: issued.prefix };
  });
  return { ok: true, key };
}

/**
 * Switches the agent off in one organisation, as its owner or that
 * organisation's admin. Its keys there stop working and its open work there is
 * handed back; elsewhere it carries on.
 */
export async function deactivateAgent(actor: Actor, agentId: string, organisationId: string, now = new Date()): Promise<ManageResult> {
  const managed = await activationFor(actor, agentId, organisationId);
  if (!managed) return { ok: false, error: NOT_FOUND };
  await prisma.$transaction(async (tx) => {
    // Removing an on-call guest early (12 Nov plan, D2) also ends its guest stay.
    await tx.agentActivation.update({
      where: { id: managed.activation.id },
      data: { deactivatedAt: now, ...(managed.activation.guest ? { guestEndedAt: now } : {}) },
    });
    await tx.agentApiKey.updateMany({ where: { agentId, organisationId, revokedAt: null }, data: { revokedAt: now } });
    const handedBack = await releaseWorkOfRevokedAgent(tx, { agentId, organisationId, actorUserId: actor.id, now });
    await audit(
      { agentId, organisationId },
      "agent.deactivated",
      `agent:${agentId}`,
      { by: managed.isOwner ? "owner" : "organisation_admin", ...handedBack },
      { actorUserId: actor.id, db: tx },
    );
  });
  return { ok: true };
}

/** The agent's class in one organisation, set by its owner (working only) or that organisation's admin. */
export async function setAgentLevel(actor: Actor, agentId: string, organisationId: string, level: AgentLevel): Promise<ManageResult> {
  const managed = await activationFor(actor, agentId, organisationId);
  if (!managed) return { ok: false, error: NOT_FOUND };
  if (managed.agent.revokedAt) return { ok: false, error: "That agent is revoked." };
  if (!canSetLevel(managed, level)) {
    return { ok: false, error: "Only an organisation admin can make an agent a manager or merger agent." };
  }
  if (managed.activation.level === level) return { ok: true };
  await prisma.$transaction(async (tx) => {
    await tx.agentActivation.update({ where: { id: managed.activation.id }, data: { level, levelChangedAt: new Date() } });
    await audit(
      { agentId, organisationId },
      "agent.level_changed",
      `agent:${agentId}`,
      { from: managed.activation.level, to: level, by: managed.isOwner ? "owner" : "organisation_admin" },
      { actorUserId: actor.id, db: tx },
    );
  });
  return { ok: true };
}

export type RenameResult = { ok: true; name: string } | { ok: false; error: string };

/**
 * Rename an agent, as its owner. An owner keeps one agent per name, because
 * the agent's page is addressed by its name.
 */
export async function renameAgent(actor: Actor, agentId: string, input: unknown): Promise<RenameResult> {
  const parsed = agentNameSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the agent's name." };
  const agent = await ownedAgent(actor, agentId);
  if (!agent) return { ok: false, error: NOT_FOUND };
  if (agent.revokedAt) return { ok: false, error: "That agent is revoked." };
  const name = parsed.data;
  if (name === agent.name) return { ok: true, name };

  const taken = await prisma.agent.findFirst({
    where: { ownerUserId: agent.ownerUserId, name: { equals: name, mode: "insensitive" }, id: { not: agentId } },
    select: { id: true },
  });
  if (taken) return { ok: false, error: `There's already an agent called “${name}”. Pick another name.` };

  await prisma.$transaction(async (tx) => {
    await tx.agent.update({ where: { id: agentId }, data: { name } });
    await auditWhereActive(agent, "agent.renamed", { from: agent.name, to: name, by: "owner" }, actor.id, tx);
  });
  return { ok: true, name };
}

/** Pick the agent's robot avatar, as its owner. Null goes back to the automatic one drawn from its id. */
export async function setAgentAvatar(actor: Actor, agentId: string, avatar: unknown): Promise<ManageResult> {
  if (avatar !== null && !isAgentAvatar(avatar)) return { ok: false, error: "Pick one of the avatars." };
  const agent = await ownedAgent(actor, agentId);
  if (!agent) return { ok: false, error: NOT_FOUND };
  if (agent.revokedAt) return { ok: false, error: "That agent is revoked." };
  const before = await prisma.agent.findUniqueOrThrow({ where: { id: agentId }, select: { avatar: true } });
  if (before.avatar === avatar) return { ok: true };
  await prisma.$transaction(async (tx) => {
    await tx.agent.update({ where: { id: agentId }, data: { avatar } });
    await auditWhereActive(agent, "agent.avatar_changed", { from: before.avatar, to: avatar, by: "owner" }, actor.id, tx);
  });
  return { ok: true };
}

/** Save an agent's preferred areas for one project (#609), in an organisation it is active in. */
export async function setAgentAreaPreferences(
  actor: Actor,
  agentId: string,
  projectId: string,
  areaIds: string[],
): Promise<ManageResult> {
  const agent = await ownedAgent(actor, agentId);
  if (!agent) return { ok: false, error: NOT_FOUND };
  if (agent.revokedAt) return { ok: false, error: "That agent is revoked." };
  const project = projectId
    ? await prisma.project.findFirst({
        where: { id: projectId, organisationId: { in: agent.activations.map((row) => row.organisationId) } },
        select: { id: true, organisationId: true },
      })
    : null;
  if (!project) return { ok: false, error: "Choose a project in an organisation this agent works in." };

  const wanted = [...new Set(areaIds)].sort();
  const validAreas = wanted.length
    ? await prisma.projectArea.findMany({
        where: { projectId: project.id, id: { in: wanted } },
        select: { id: true },
      })
    : [];
  if (validAreas.length !== wanted.length) return { ok: false, error: "Choose areas from this project." };

  const current = await prisma.agentAreaPreference.findMany({
    where: { agentId, projectArea: { projectId: project.id } },
    select: { projectAreaId: true },
  });
  const before = current.map((preference) => preference.projectAreaId).sort();
  if (before.length === wanted.length && before.every((areaId, index) => areaId === wanted[index])) {
    return { ok: true };
  }

  await prisma.$transaction(async (tx) => {
    await tx.agentAreaPreference.deleteMany({ where: { agentId, projectArea: { projectId: project.id } } });
    if (wanted.length) {
      await tx.agentAreaPreference.createMany({ data: wanted.map((projectAreaId) => ({ agentId, projectAreaId })) });
    }
    await audit(
      { agentId, organisationId: project.organisationId },
      "agent.area_preferences_changed",
      `agent:${agentId}`,
      { projectId: project.id, from: before, to: wanted, by: "owner" },
      { actorUserId: actor.id, db: tx },
    );
  });
  return { ok: true };
}

/**
 * Turns the higher read budget on or off in one organisation (#440; writes
 * have no hourly cap since #699), optionally until a time (#596). That
 * organisation's admin or a site admin may do this; an owner who is not an admin cannot.
 *
 * `burst` stays the enabled flag; `burstUntil` only limits it. Disabling
 * clears the expiry, so turning it back on cannot inherit a stale window.
 * The budget helper treats an expired time as the standard budget, so no
 * scheduled job is needed.
 */
export async function setAgentBurst(
  actor: Actor,
  agentId: string,
  organisationId: string,
  burst: boolean,
  burstUntil: Date | null = null,
  now = new Date(),
): Promise<ManageResult> {
  const managed = await activationFor(actor, agentId, organisationId);
  if (!managed) return { ok: false, error: NOT_FOUND };
  if (!managed.isAdminOfOrganisation && !isAdmin(actor.role)) {
    return { ok: false, error: "Only an admin can change an agent's read budget." };
  }
  if (managed.agent.revokedAt) return { ok: false, error: "That agent is revoked." };

  const nextUntil = burst ? burstUntil : null;
  if (nextUntil && (!Number.isFinite(nextUntil.getTime()) || nextUntil.getTime() <= now.getTime())) {
    return { ok: false, error: "Choose an expiry time in the future." };
  }

  const before = managed.activation;
  const beforeUntil = before.burstUntil?.getTime() ?? null;
  const nextTime = nextUntil?.getTime() ?? null;
  // Re-saving the same state is harmless and does not add a misleading audit row.
  if (before.burst === burst && beforeUntil === nextTime) return { ok: true };

  try {
    await prisma.$transaction(async (tx) => {
      await tx.agentActivation.update({ where: { id: before.id }, data: { burst, burstUntil: nextUntil } });
      await audit(
        { agentId, organisationId },
        "agent.burst_changed",
        `agent:${agentId}`,
        {
          from: before.burst,
          to: burst,
          fromUntil: before.burstUntil?.toISOString() ?? null,
          toUntil: nextUntil?.toISOString() ?? null,
          by: "admin",
        },
        { actorUserId: actor.id, db: tx },
      );
    });
  } catch {
    // The transaction rolled back, so the old budget still applies. Never
    // report success when the change was not persisted.
    return { ok: false, error: "Couldn't change the read budget. Try again." };
  }
  return { ok: true };
}

/**
 * The agent replaces the key it called with. Same agent, name, owner and
 * organisation; the old key stops working. The new one is sealed so the owner can copy it again.
 */
export async function rotateKey(agent: AgentContext, now = new Date()): Promise<IssuedKey> {
  return prisma.$transaction(async (tx) => {
    const revoked = await tx.agentApiKey.updateMany({
      where: { id: agent.keyId, agentId: agent.agentId, revokedAt: null },
      data: { revokedAt: now },
    });
    // Two rotations racing with the same key: only the first gets a new one.
    if (revoked.count !== 1) throw new Error("This key was already rotated or revoked.");
    const key = await insertKey(tx, agent.agentId, agent.organisationId);
    await audit(agent, "agent.key_rotated", `agent:${agent.agentId}`, { prefix: key.prefix }, { db: tx });
    return { agentId: agent.agentId, name: agent.name, level: agent.level, rawKey: key.raw, prefix: key.prefix };
  });
}

export type RegenerateKeyResult = { ok: true; key: IssuedKey } | { ok: false; error: string };

/**
 * The owner replaces the agent's key for one organisation without the old
 * secret (#572). The agent, its class and its history stay; its keys for other
 * organisations are untouched. The new key is sealed so it can be copied again.
 */
export async function regenerateKey(
  actor: Actor,
  agentId: string,
  organisationId: string,
  now = new Date(),
): Promise<RegenerateKeyResult> {
  const managed = await activationFor(actor, agentId, organisationId);
  if (!managed || !managed.isOwner) return { ok: false, error: NOT_FOUND };
  if (managed.agent.revokedAt) return { ok: false, error: "That agent is revoked." };

  const key = await prisma.$transaction(async (tx) => {
    await tx.agentApiKey.updateMany({ where: { agentId, organisationId, revokedAt: null }, data: { revokedAt: now } });
    const issued = await insertKey(tx, agentId, organisationId);
    await audit(
      { agentId, organisationId },
      "agent.key_rotated",
      `agent:${agentId}`,
      { prefix: issued.prefix, by: "owner", via: "settings" },
      { actorUserId: actor.id, db: tx },
    );
    return issued;
  });
  return {
    ok: true,
    key: { agentId, name: managed.agent.name, level: managed.activation.level, rawKey: key.raw, prefix: key.prefix },
  };
}

/** Where the person's edits to an agent's profile are recorded: the first organisation it is active in. */
function profileActor(agent: OwnedAgent, actor: Actor) {
  const organisationId = agent.activations[0]?.organisationId;
  return organisationId ? { agentId: agent.id, organisationId, actorUserId: actor.id } : null;
}

const NOT_ACTIVE = "Bring the agent into an organisation first: its profile is kept with the organisations it works in.";

/**
 * Change an agent's username, tagline or About me from its page (#agent-profile),
 * as its owner. The agent sets the same fields itself with `PATCH /api/v1/agents/me`.
 */
export async function updateAgentProfileAsPerson(
  actor: Actor,
  agentId: string,
  input: unknown,
): Promise<{ ok: true; username: string } | { ok: false; error: string }> {
  const agent = await ownedAgent(actor, agentId);
  if (!agent) return { ok: false, error: NOT_FOUND };
  if (agent.revokedAt) return { ok: false, error: "That agent is revoked." };
  const who = profileActor(agent, actor);
  if (!who) return { ok: false, error: NOT_ACTIVE };
  const result = await updateAgentProfile(who, input);
  return result.ok ? { ok: true, username: result.profile.username } : { ok: false, error: result.error };
}

/**
 * Is this username free for the agent? Usernames are unique across the
 * platform. For its owner, as they type it on the agent's page. The agent's
 * own current username counts as free.
 */
export async function checkAgentUsername(
  actor: Actor,
  agentId: string,
  input: string,
): Promise<{ ok: true; available: boolean; message: string } | { ok: false; error: string }> {
  const agent = await ownedAgent(actor, agentId);
  if (!agent) return { ok: false, error: NOT_FOUND };
  const parsed = agentUsernameSchema.safeParse(input);
  if (!parsed.success) return { ok: true, available: false, message: parsed.error.issues[0]?.message ?? "Check the username." };
  const taken = await prisma.agent.findFirst({
    where: { username: parsed.data, id: { not: agentId } },
    select: { id: true },
  });
  return taken
    ? { ok: true, available: false, message: `@${parsed.data} is taken.` }
    : { ok: true, available: true, message: `@${parsed.data} is available.` };
}

/** Replace the agent's skills from its edit page (#agent-profile), as its owner. */
export async function replaceAgentSkillsAsPerson(actor: Actor, agentId: string, input: unknown): Promise<ManageResult> {
  const agent = await ownedAgent(actor, agentId);
  if (!agent) return { ok: false, error: NOT_FOUND };
  if (agent.revokedAt) return { ok: false, error: "That agent is revoked." };
  const who = profileActor(agent, actor);
  if (!who) return { ok: false, error: NOT_ACTIVE };
  const result = await replaceAgentSkills(who, input);
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

/** Upload or remove the agent's profile picture from its edit page (#agent-profile), as its owner. */
export async function setAgentPictureAsPerson(
  actor: Actor,
  agentId: string,
  bytes: Uint8Array | null,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const agent = await ownedAgent(actor, agentId);
  if (!agent) return { ok: false, status: 404, error: NOT_FOUND };
  if (agent.revokedAt) return { ok: false, status: 409, error: "That agent is revoked." };
  const who = profileActor(agent, actor);
  if (!who) return { ok: false, status: 409, error: NOT_ACTIVE };
  const result = bytes ? await setAgentPicture(who, bytes) : await removeAgentPicture(who);
  return result.ok ? { ok: true } : result;
}
