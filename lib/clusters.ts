import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { IssueApiError } from "@/lib/agent-api/errors";
import type { AgentContext } from "@/lib/agents/require-agent";
import { activeIn } from "@/lib/agents/active-in";

/**
 * Agent clusters (#agent-clusters, Ziki Major Feature #17).
 *
 * A cluster is a standing group of agents on one project that helps its members
 * get tasks done. An agent posts a task (what it is trying to achieve, and what
 * blocks it); the other members share the information that unblocks it, each piece
 * saying which blocker it answers; the task's author marks blockers solved. Its
 * card (name, purpose, needed skills, members) is visible to everyone who can see
 * the project. Everything inside it (tasks, shared information and each member's
 * private notes) is visible only to its active member agents, and read-only to
 * those agents' owners in the app.
 *
 * Rules every function here keeps:
 * - Content is read through `requireMember`, which answers 404 to anyone who is
 *   not an active member, so a private cluster's content can't be probed.
 * - Private notes are always filtered by the reading agent (or its owner's agents).
 * - Skills decide membership: an agent with one of the cluster's needed skills
 *   joins at once, with no cap on members; an invite goes only to an agent that
 *   brings a needed skill no member has yet.
 * - An agent leads at most `MAX_OPEN_CLUSTERS` open clusters it created in an
 *   organisation and starts at most `MAX_NEW_CLUSTERS_PER_DAY` a day.
 * - A cluster with no tasks, shared information or blocker changes for `INACTIVE_DAYS` is archived: hidden
 *   from the list and read-only until a member reopens it.
 * - Only agents act. People work a cluster from the app through one of their own
 *   agents (`ownerActingAgent`), under the same rules; the cluster's owner is the
 *   owner of its creator agent, who alone removes members and deletes it.
 */

export const MAX_OPEN_CLUSTERS = 3;
export const MAX_NEW_CLUSTERS_PER_DAY = 5;
export const INACTIVE_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

export type ClusterViewer = {
  organisationId: string;
  projectId: string;
  /** The person: the agent's owner, or the signed-in member. */
  userId: string;
  /** Set when an agent key is calling. */
  agent?: AgentContext;
};

const MAX_INVITES = 20;
const NOT_FOUND = "Cluster not found.";
const skillSlug = z.string().trim().toLowerCase().min(1).max(64);
const neededSkillsInput = z.array(skillSlug).min(1).max(10);

export const createClusterInput = z.object({
  name: z.string().trim().min(3).max(80),
  purpose: z.string().trim().min(10).max(500),
  neededSkills: neededSkillsInput,
  invite: z.array(z.string().trim().min(1).max(64)).max(MAX_INVITES).optional(),
}).strict();
export const updateClusterInput = z.object({ neededSkills: neededSkillsInput }).strict();
export const inviteInput = z.object({ agentIds: z.array(z.string().trim().min(1).max(64)).min(1).max(MAX_INVITES) }).strict();
export const decisionInput = z.object({ decision: z.enum(["remove", "cancel_invite"]) }).strict();
const blockerText = z.string().trim().min(3).max(1000);
export const taskInput = z.object({
  title: z.string().trim().min(3).max(200),
  tryingToAchieve: z.string().trim().min(3).max(10_000),
  blockers: z.array(blockerText).max(20).optional(),
  issueNumber: z.number().int().positive().optional(),
}).strict();
export const shareInput = z.object({
  body: z.string().trim().min(1).max(10_000),
  blockerId: z.string().trim().min(1).max(64).optional(),
}).strict();
export const blockerInput = z.object({ text: blockerText }).strict();
export const solveInput = z.object({ solved: z.boolean() }).strict();
export const noteInput = z.object({ body: z.string().max(20_000) }).strict();

/** Before this moment, a cluster with no activity is archived. */
export function archiveCutoff(now = new Date()) {
  return new Date(now.getTime() - INACTIVE_DAYS * DAY_MS);
}
export function isArchived(cluster: { lastActivityAt: Date }, now = new Date()) {
  return cluster.lastActivityAt < archiveCutoff(now);
}
function requireOpen(cluster: { lastActivityAt: Date }) {
  if (isArchived(cluster)) {
    throw new IssueApiError(409, `This cluster was archived after ${INACTIVE_DAYS} days without activity. A member reopens it first.`, { code: "cluster_archived" });
  }
}

/** A project id never grants access: recheck the project, its organisation and the owner's membership. */
export async function agentClusterViewer(agent: AgentContext, projectId: string): Promise<ClusterViewer> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, organisationId: agent.organisationId, archivedAt: null, organisation: { archivedAt: null } },
    select: { id: true },
  });
  const membership = await prisma.membership.findUnique({
    where: { organisationId_userId: { organisationId: agent.organisationId, userId: agent.ownerId } }, select: { role: true },
  });
  if (!project || !membership) throw new IssueApiError(404, "Project not found.");
  return { organisationId: agent.organisationId, projectId, userId: agent.ownerId, agent };
}

function agentOf(viewer: ClusterViewer) {
  if (!viewer.agent) throw new IssueApiError(403, "Only agents work inside clusters: use an agent key.");
  return viewer.agent;
}

/** The viewer's agents that are active members of the cluster: the calling agent, or all of a person's agents. */
function memberWhere(viewer: ClusterViewer, clusterId: string) {
  return viewer.agent
    ? { clusterId, status: "active" as const, agentId: viewer.agent.agentId }
    : { clusterId, status: "active" as const, agent: { ownerUserId: viewer.userId } };
}

async function findCluster(viewer: ClusterViewer, clusterId: string) {
  const cluster = await prisma.cluster.findFirst({
    where: { id: clusterId, projectId: viewer.projectId, organisationId: viewer.organisationId },
  });
  if (!cluster) throw new IssueApiError(404, NOT_FOUND);
  return cluster;
}

/** The cluster, if the viewer may see inside it. Anyone else gets the same 404 as a missing cluster. */
export async function requireMember(viewer: ClusterViewer, clusterId: string) {
  const cluster = await findCluster(viewer, clusterId);
  const member = await prisma.clusterMember.findFirst({ where: memberWhere(viewer, clusterId), select: { agentId: true } });
  if (!member) throw new IssueApiError(404, NOT_FOUND);
  return cluster;
}

/** Each agent's skill slugs in the organisation. */
async function skillsOf(organisationId: string, agentIds: string[]) {
  const map = new Map<string, Set<string>>(agentIds.map((id) => [id, new Set<string>()]));
  if (!agentIds.length) return map;
  const rows = await prisma.agentSkill.findMany({
    where: { agentId: { in: agentIds }, tag: { organisationId } },
    select: { agentId: true, tag: { select: { slug: true } } },
  });
  for (const row of rows) map.get(row.agentId)?.add(row.tag.slug);
  return map;
}

/** Needed skills no active member has yet. */
function missingSkills(needed: string[], memberSkills: Iterable<Set<string>>) {
  const covered = new Set<string>();
  for (const skills of memberSkills) for (const slug of skills) covered.add(slug);
  return needed.filter((slug) => !covered.has(slug));
}

/** Needed skills must be the organisation's own skill tags. */
async function requireKnownSkills(organisationId: string, slugs: string[]) {
  const unique = [...new Set(slugs)];
  const found = await prisma.skillTag.findMany({ where: { organisationId, slug: { in: unique } }, select: { slug: true } });
  const known = new Set(found.map((tag) => tag.slug));
  const unknown = unique.filter((slug) => !known.has(slug));
  if (unknown.length) throw new IssueApiError(422, `Unknown skill: ${unknown.join(", ")}. Use the organisation's skill tags (GET /api/v1/skill-tags).`, { code: "unknown_skill", unknown });
  return unique;
}

const cardSelect = {
  id: true, name: true, purpose: true, creatorAgentId: true, neededSkills: true, lastActivityAt: true, createdAt: true,
  members: {
    where: { status: "active" as const },
    orderBy: { joinedAt: "asc" as const },
    select: { agentId: true, joinedAt: true, agent: { select: { name: true, ownerUserId: true } } },
  },
  _count: { select: { posts: { where: { parentId: null } }, blockers: { where: { solvedAt: null } } } },
  project: { select: { name: true, slug: true, organisation: { select: { slug: true } } } },
  posts: { where: { parentId: null }, orderBy: { createdAt: "desc" as const }, take: 1, select: { title: true, authorName: true } },
};

type CardRow = {
  id: string; name: string; purpose: string; creatorAgentId: string; neededSkills: string[]; lastActivityAt: Date; createdAt: Date;
  members: { agentId: string; joinedAt: Date | null; agent: { name: string; ownerUserId: string } }[];
  _count: { posts: number; blockers: number };
  project: { name: string; slug: string; organisation: { slug: string } };
  posts: { title: string | null; authorName: string }[];
};

/** The public face of a cluster: never any of its content. */
function card(row: CardRow, viewer: ClusterViewer, invited: Set<string>, skills: Map<string, Set<string>>) {
  const isMember = row.members.some((m) => (viewer.agent ? m.agentId === viewer.agent.agentId : m.agent.ownerUserId === viewer.userId));
  return {
    id: row.id, name: row.name, purpose: row.purpose, creatorAgentId: row.creatorAgentId,
    project: { name: row.project.name, path: `/${encodeURIComponent(row.project.organisation.slug)}/${encodeURIComponent(row.project.slug)}` },
    lastTask: row.posts[0] ? { title: row.posts[0].title ?? "", authorName: row.posts[0].authorName } : null,
    neededSkills: row.neededSkills,
    missingSkills: missingSkills(row.neededSkills, row.members.map((m) => skills.get(m.agentId) ?? new Set<string>())),
    members: row.members.map((m) => ({ agentId: m.agentId, name: m.agent.name, joinedAt: m.joinedAt, skills: [...(skills.get(m.agentId) ?? [])] })),
    taskCount: row._count.posts,
    openBlockers: row._count.blockers,
    archived: isArchived(row),
    lastActivityAt: row.lastActivityAt, createdAt: row.createdAt,
    /** `active` (member), `invited`, or null. */
    myStatus: isMember ? "active" : invited.has(row.id) ? "invited" : null,
  };
}

async function myInvites(viewer: ClusterViewer, clusterIds: string[]) {
  if (!clusterIds.length) return new Set<string>();
  const rows = await prisma.clusterMember.findMany({
    where: {
      clusterId: { in: clusterIds }, status: "invited",
      ...(viewer.agent ? { agentId: viewer.agent.agentId } : { agent: { ownerUserId: viewer.userId } }),
    },
    select: { clusterId: true },
  });
  return new Set(rows.map((r) => r.clusterId));
}

async function cards(viewer: ClusterViewer, rows: CardRow[]) {
  const [invited, skills] = await Promise.all([
    myInvites(viewer, rows.map((r) => r.id)),
    skillsOf(viewer.organisationId, [...new Set(rows.flatMap((r) => r.members.map((m) => m.agentId)))]),
  ]);
  return rows.map((row) => card(row, viewer, invited, skills));
}

/** The project's clusters as public cards, most recently active first. Archived ones only when asked. */
export async function listClusters(viewer: ClusterViewer, options: { includeArchived?: boolean; wholeOrganisation?: boolean; query?: string } = {}) {
  const q = options.query?.trim().slice(0, 100);
  const rows = await prisma.cluster.findMany({
    where: {
      organisationId: viewer.organisationId,
      ...(options.wholeOrganisation ? { project: { archivedAt: null } } : { projectId: viewer.projectId }),
      ...(options.includeArchived ? {} : { lastActivityAt: { gte: archiveCutoff() } }),
      ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" as const } }, { purpose: { contains: q, mode: "insensitive" as const } }] } : {}),
    },
    orderBy: [{ lastActivityAt: "desc" }, { id: "desc" }],
    take: 200,
    select: cardSelect,
  });
  return { items: await cards(viewer, rows) };
}

export async function getClusterCard(viewer: ClusterViewer, clusterId: string) {
  const row = await prisma.cluster.findFirst({
    where: { id: clusterId, projectId: viewer.projectId, organisationId: viewer.organisationId },
    select: cardSelect,
  });
  if (!row) throw new IssueApiError(404, NOT_FOUND);
  return { cluster: (await cards(viewer, [row]))[0] };
}

/** Agents active in the organisation, not revoked. Unknown ids are refused, not skipped. */
async function requireOrganisationAgents(viewer: ClusterViewer, agentIds: string[]) {
  const ids = [...new Set(agentIds)].filter((id) => id !== viewer.agent?.agentId);
  if (!ids.length) return [];
  const found = await prisma.agent.findMany({
    where: { id: { in: ids }, ...activeIn(viewer.organisationId), revokedAt: null },
    select: { id: true },
  });
  if (found.length !== ids.length) throw new IssueApiError(422, "Invite only agents active in this organisation.");
  return ids;
}

/** Each invitee must bring a needed skill the cluster's members lack. */
async function requireMissingSkill(viewer: ClusterViewer, invitees: string[], missing: string[]) {
  if (!invitees.length) return;
  if (!missing.length) throw new IssueApiError(409, "The cluster's members already cover every skill it needs. Add a needed skill first.", { code: "no_missing_skill" });
  const skills = await skillsOf(viewer.organisationId, invitees);
  const without = invitees.filter((id) => !missing.some((slug) => skills.get(id)?.has(slug)));
  if (without.length) {
    throw new IssueApiError(422, `Invite agents for a skill the cluster lacks (${missing.join(", ")}). These agents have none of them: ${without.join(", ")}.`, { code: "skill_not_missing", missingSkills: missing, agentIds: without });
  }
}

/** Start a cluster, within the creator's limits, for the skills it needs. */
export async function createCluster(viewer: ClusterViewer, input: unknown) {
  const agent = agentOf(viewer);
  const data = createClusterInput.parse(input);
  const now = new Date();
  const [open, today] = await Promise.all([
    prisma.cluster.count({ where: { organisationId: viewer.organisationId, creatorAgentId: agent.agentId, lastActivityAt: { gte: archiveCutoff(now) } } }),
    prisma.cluster.count({ where: { organisationId: viewer.organisationId, creatorAgentId: agent.agentId, createdAt: { gte: new Date(now.getTime() - DAY_MS) } } }),
  ]);
  if (open >= MAX_OPEN_CLUSTERS) {
    throw new IssueApiError(429, `You already lead ${MAX_OPEN_CLUSTERS} open clusters in this organisation. Reuse one (a thread per task), or let one archive.`, { code: "cluster_limit_open", limit: MAX_OPEN_CLUSTERS });
  }
  if (today >= MAX_NEW_CLUSTERS_PER_DAY) {
    throw new IssueApiError(429, `You can start at most ${MAX_NEW_CLUSTERS_PER_DAY} clusters a day. Reuse an existing one, or try again tomorrow.`, { code: "cluster_limit_daily", limit: MAX_NEW_CLUSTERS_PER_DAY });
  }
  const neededSkills = await requireKnownSkills(viewer.organisationId, data.neededSkills);
  const invite = await requireOrganisationAgents(viewer, data.invite ?? []);
  const creatorSkills = (await skillsOf(viewer.organisationId, [agent.agentId])).get(agent.agentId) ?? new Set<string>();
  await requireMissingSkill(viewer, invite, missingSkills(neededSkills, [creatorSkills]));
  const cluster = await prisma.$transaction(async (db) => {
    const created = await db.cluster.create({ data: {
      organisationId: viewer.organisationId, projectId: viewer.projectId,
      name: data.name, purpose: data.purpose, neededSkills, creatorAgentId: agent.agentId,
    } });
    await db.clusterMember.create({ data: { clusterId: created.id, agentId: agent.agentId, status: "active", joinedAt: now } });
    if (invite.length) {
      await db.clusterMember.createMany({ data: invite.map((agentId) => ({
        clusterId: created.id, agentId, status: "invited" as const, invitedByAgentId: agent.agentId,
      })) });
    }
    return created;
  });
  return { cluster: { id: cluster.id, name: cluster.name, purpose: cluster.purpose, neededSkills }, invited: invite };
}

/** The creator changes the skills the cluster needs. */
export async function updateCluster(viewer: ClusterViewer, clusterId: string, input: unknown) {
  const agent = agentOf(viewer);
  const cluster = await requireMember(viewer, clusterId);
  if (cluster.creatorAgentId !== agent.agentId) throw new IssueApiError(403, "Only the cluster's creator changes its needed skills.");
  const { neededSkills } = updateClusterInput.parse(input);
  const known = await requireKnownSkills(viewer.organisationId, neededSkills);
  await prisma.cluster.update({ where: { id: clusterId }, data: { neededSkills: known } });
  return getClusterCard(viewer, clusterId);
}

async function activeMemberIds(clusterId: string) {
  const rows = await prisma.clusterMember.findMany({ where: { clusterId, status: "active" }, select: { agentId: true } });
  return rows.map((r) => r.agentId);
}

/** A member invites agents that bring a needed skill no member has yet. */
export async function inviteToCluster(viewer: ClusterViewer, clusterId: string, input: unknown) {
  const agent = agentOf(viewer);
  const cluster = await requireMember(viewer, clusterId);
  requireOpen(cluster);
  const { agentIds } = inviteInput.parse(input);
  const ids = await requireOrganisationAgents(viewer, agentIds);
  const existing = await prisma.clusterMember.findMany({ where: { clusterId, agentId: { in: ids } }, select: { agentId: true } });
  const known = new Set(existing.map((row) => row.agentId));
  const fresh = ids.filter((id) => !known.has(id));
  const members = await activeMemberIds(clusterId);
  const missing = missingSkills(cluster.neededSkills, (await skillsOf(viewer.organisationId, members)).values());
  await requireMissingSkill(viewer, fresh, missing);
  if (fresh.length) {
    await prisma.clusterMember.createMany({ data: fresh.map((agentId) => ({ clusterId, agentId, status: "invited" as const, invitedByAgentId: agent.agentId })) });
  }
  return { invited: fresh, alreadyThere: ids.filter((id) => known.has(id)) };
}

/** Agents worth inviting: active in the organisation, outside the cluster, with the most missing skills first. */
export async function suggestInvites(viewer: ClusterViewer, clusterId: string) {
  const cluster = await requireMember(viewer, clusterId);
  const members = await activeMemberIds(clusterId);
  const missing = missingSkills(cluster.neededSkills, (await skillsOf(viewer.organisationId, members)).values());
  if (!missing.length) return { missingSkills: [], items: [] };
  const taken = await prisma.clusterMember.findMany({ where: { clusterId }, select: { agentId: true } });
  const candidates = await prisma.agent.findMany({
    where: {
      ...activeIn(viewer.organisationId), revokedAt: null,
      id: { notIn: taken.map((row) => row.agentId) },
      skills: { some: { tag: { organisationId: viewer.organisationId, slug: { in: missing } } } },
    },
    take: 100,
    select: { id: true, name: true, skills: { where: { tag: { organisationId: viewer.organisationId } }, select: { tag: { select: { slug: true } } } } },
  });
  const items = candidates
    .map((a) => ({ agentId: a.id, name: a.name, brings: missing.filter((slug) => a.skills.some((s) => s.tag.slug === slug)) }))
    .sort((a, b) => b.brings.length - a.brings.length || a.name.localeCompare(b.name))
    .slice(0, 20);
  return { missingSkills: missing, items };
}

/** Join: at once with an invite, or with one of the cluster's needed skills. Joining twice changes nothing. */
export async function joinCluster(viewer: ClusterViewer, clusterId: string) {
  const agent = agentOf(viewer);
  const cluster = await findCluster(viewer, clusterId);
  requireOpen(cluster);
  const row = await prisma.clusterMember.findUnique({ where: { clusterId_agentId: { clusterId, agentId: agent.agentId } } });
  if (row?.status === "active") return { status: "active" };
  if (!row) {
    const mine = (await skillsOf(viewer.organisationId, [agent.agentId])).get(agent.agentId) ?? new Set<string>();
    if (!cluster.neededSkills.some((slug) => mine.has(slug))) {
      throw new IssueApiError(403, `This cluster needs one of these skills: ${cluster.neededSkills.join(", ")}. Add the skill to your profile if you have it.`, { code: "skill_needed", neededSkills: cluster.neededSkills });
    }
  }
  const joinedAt = new Date();
  if (row) await prisma.clusterMember.update({ where: { id: row.id }, data: { status: "active", joinedAt } });
  else await prisma.clusterMember.create({ data: { clusterId, agentId: agent.agentId, status: "active", joinedAt } });
  return { status: "active" };
}

/** Leave, or decline an invite. The creator stays: a cluster always has its creator. */
export async function leaveCluster(viewer: ClusterViewer, clusterId: string) {
  const agent = agentOf(viewer);
  const cluster = await findCluster(viewer, clusterId);
  if (cluster.creatorAgentId === agent.agentId) throw new IssueApiError(409, "The creator can't leave the cluster.");
  const { count } = await prisma.clusterMember.deleteMany({ where: { clusterId, agentId: agent.agentId } });
  return { left: count > 0 };
}

/** The creator removes a member or cancels an invite. */
export async function decideMember(viewer: ClusterViewer, clusterId: string, agentId: string, input: unknown) {
  const agent = agentOf(viewer);
  const cluster = await requireMember(viewer, clusterId);
  if (cluster.creatorAgentId !== agent.agentId) throw new IssueApiError(403, "Only the cluster's creator decides on members.");
  const { decision } = decisionInput.parse(input);
  if (agentId === cluster.creatorAgentId) throw new IssueApiError(409, "The creator can't be removed.");
  const row = await prisma.clusterMember.findUnique({ where: { clusterId_agentId: { clusterId, agentId } } });
  if (!row) throw new IssueApiError(404, "That agent has no place in this cluster.");
  if (decision === "remove" && row.status !== "active") throw new IssueApiError(409, "That agent isn't a member yet: cancel the invite instead.");
  if (decision === "cancel_invite" && row.status !== "invited") throw new IssueApiError(409, "That agent is a member: remove it instead.");
  await prisma.clusterMember.delete({ where: { id: row.id } });
  return { status: null };
}

/** A member brings an archived cluster back. */
export async function reopenCluster(viewer: ClusterViewer, clusterId: string) {
  agentOf(viewer);
  const cluster = await requireMember(viewer, clusterId);
  if (!isArchived(cluster)) return { archived: false };
  await prisma.cluster.update({ where: { id: clusterId }, data: { lastActivityAt: new Date() } });
  return { archived: false };
}

/**
 * Tasks, newest first. Each carries what it is trying to achieve (`body`), its
 * blockers (open first) and the information members shared on it, oldest first,
 * each saying which blocker it answers. `issueNumber` picks one issue's tasks.
 */
export async function listTasks(viewer: ClusterViewer, clusterId: string, options: { issueNumber?: number } = {}) {
  await requireMember(viewer, clusterId);
  const tasks = await prisma.clusterPost.findMany({
    where: { clusterId, parentId: null, ...(options.issueNumber ? { issueNumber: options.issueNumber } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 100,
    include: {
      blockers: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
      replies: { orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 200 },
    },
  });
  return {
    items: tasks.map(({ replies, blockers, ...task }) => ({
      ...task,
      blockers: [...blockers].sort((a, b) => Number(a.solvedAt !== null) - Number(b.solvedAt !== null)),
      openBlockers: blockers.filter((blocker) => blocker.solvedAt === null).length,
      shared: replies,
    })),
  };
}

async function touch(db: Prisma.TransactionClient, clusterId: string, at: Date) {
  await db.cluster.update({ where: { id: clusterId }, data: { lastActivityAt: at } });
}

/** Post a task: what it is trying to achieve, and what blocks it. */
export async function addTask(viewer: ClusterViewer, clusterId: string, input: unknown) {
  const agent = agentOf(viewer);
  const cluster = await requireMember(viewer, clusterId);
  requireOpen(cluster);
  const data = taskInput.parse(input);
  if (data.issueNumber) {
    const issue = await prisma.bug.findFirst({ where: { projectId: viewer.projectId, number: data.issueNumber, deletedAt: null }, select: { id: true } });
    if (!issue) throw new IssueApiError(404, `Issue #${data.issueNumber} not found in this project.`);
  }
  const task = await prisma.$transaction(async (db) => {
    const created = await db.clusterPost.create({ data: {
      clusterId, title: data.title, body: data.tryingToAchieve, issueNumber: data.issueNumber ?? null,
      authorAgentId: agent.agentId, authorName: agent.name,
    } });
    if (data.blockers?.length) {
      await db.clusterBlocker.createMany({ data: data.blockers.map((text) => ({ clusterId, taskId: created.id, text, raisedByAgentId: agent.agentId })) });
    }
    await touch(db, clusterId, created.createdAt);
    return created;
  });
  return { task };
}

async function findTask(clusterId: string, taskId: string) {
  const task = await prisma.clusterPost.findFirst({ where: { id: taskId, clusterId, parentId: null }, select: { id: true, authorAgentId: true } });
  if (!task) throw new IssueApiError(404, "Task not found.");
  return task;
}

/** Share information on a task, optionally answering one of its blockers. */
export async function shareInformation(viewer: ClusterViewer, clusterId: string, taskId: string, input: unknown) {
  const agent = agentOf(viewer);
  const cluster = await requireMember(viewer, clusterId);
  requireOpen(cluster);
  await findTask(clusterId, taskId);
  const data = shareInput.parse(input);
  if (data.blockerId) {
    const blocker = await prisma.clusterBlocker.findFirst({ where: { id: data.blockerId, taskId }, select: { id: true } });
    if (!blocker) throw new IssueApiError(404, "That blocker isn't on this task.");
  }
  const shared = await prisma.$transaction(async (db) => {
    const created = await db.clusterPost.create({ data: {
      clusterId, parentId: taskId, body: data.body, blockerId: data.blockerId ?? null,
      authorAgentId: agent.agentId, authorName: agent.name,
    } });
    await touch(db, clusterId, created.createdAt);
    return created;
  });
  return { shared };
}

/** Add a blocker to a task. Any member may raise one. */
export async function addBlocker(viewer: ClusterViewer, clusterId: string, taskId: string, input: unknown) {
  const agent = agentOf(viewer);
  const cluster = await requireMember(viewer, clusterId);
  requireOpen(cluster);
  await findTask(clusterId, taskId);
  const { text } = blockerInput.parse(input);
  const blocker = await prisma.$transaction(async (db) => {
    const created = await db.clusterBlocker.create({ data: { clusterId, taskId, text, raisedByAgentId: agent.agentId } });
    await touch(db, clusterId, created.createdAt);
    return created;
  });
  return { blocker };
}

/** The task's author marks a blocker solved (or open again) once it has what it needs. */
export async function setBlockerSolved(viewer: ClusterViewer, clusterId: string, blockerId: string, input: unknown) {
  const agent = agentOf(viewer);
  const cluster = await requireMember(viewer, clusterId);
  requireOpen(cluster);
  const { solved } = solveInput.parse(input);
  const blocker = await prisma.clusterBlocker.findFirst({ where: { id: blockerId, clusterId }, select: { id: true, task: { select: { authorAgentId: true } } } });
  if (!blocker) throw new IssueApiError(404, "Blocker not found.");
  if (blocker.task.authorAgentId !== agent.agentId) throw new IssueApiError(403, "Only the agent that posted the task marks its blockers solved.");
  const now = new Date();
  const updated = await prisma.$transaction(async (db) => {
    const row = await db.clusterBlocker.update({
      where: { id: blockerId },
      data: solved ? { solvedAt: now, solvedByAgentId: agent.agentId } : { solvedAt: null, solvedByAgentId: null },
    });
    await touch(db, clusterId, now);
    return row;
  });
  return { blocker: updated };
}

/** Private notes: an agent reads its own; a person reads their own agents'. Never another member's. */
export async function readNotes(viewer: ClusterViewer, clusterId: string) {
  await requireMember(viewer, clusterId);
  const notes = await prisma.clusterNote.findMany({
    where: viewer.agent ? { clusterId, agentId: viewer.agent.agentId } : { clusterId, agent: { ownerUserId: viewer.userId } },
    select: { agentId: true, body: true, updatedAt: true, agent: { select: { name: true } } },
  });
  return { items: notes.map((n) => ({ agentId: n.agentId, agentName: n.agent.name, body: n.body, updatedAt: n.updatedAt })) };
}

export async function saveNote(viewer: ClusterViewer, clusterId: string, input: unknown) {
  const agent = agentOf(viewer);
  await requireMember(viewer, clusterId);
  const { body } = noteInput.parse(input);
  const note = await prisma.clusterNote.upsert({
    where: { clusterId_agentId: { clusterId, agentId: agent.agentId } },
    create: { clusterId, agentId: agent.agentId, body },
    update: { body },
    select: { body: true, updatedAt: true },
  });
  return { note };
}

/** Open invites, for members. The creator cancels one on the members route. */
export async function listPending(viewer: ClusterViewer, clusterId: string) {
  await requireMember(viewer, clusterId);
  const rows = await prisma.clusterMember.findMany({
    where: { clusterId, status: "invited" },
    orderBy: { createdAt: "asc" },
    select: { agentId: true, status: true, createdAt: true, agent: { select: { name: true } } },
  });
  return { items: rows.map((r) => ({ agentId: r.agentId, name: r.agent.name, status: r.status, since: r.createdAt })) };
}


/** The cluster's creator deletes it, with everything inside it. */
export async function deleteCluster(viewer: ClusterViewer, clusterId: string) {
  const agent = agentOf(viewer);
  const cluster = await requireMember(viewer, clusterId);
  if (cluster.creatorAgentId !== agent.agentId) throw new IssueApiError(403, "Only the cluster's creator deletes it.");
  await prisma.cluster.delete({ where: { id: clusterId } });
  return { deleted: true };
}

/** A person's agents in an organisation, with their skill slugs, for acting in clusters from the app. */
export async function ownAgentsIn(userId: string, organisationId: string) {
  const agents = await prisma.agent.findMany({
    where: { ownerUserId: userId, ...activeIn(organisationId), revokedAt: null },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, skills: { where: { tag: { organisationId } }, select: { tag: { select: { slug: true } } } } },
  });
  return agents.map((a) => ({ id: a.id, name: a.name, skills: a.skills.map((s) => s.tag.slug) }));
}

/**
 * The context a person's agent acts with when its owner works a cluster from the
 * app: the same rules as its key, since every rule here reads the agent.
 */
export async function ownerActingAgent(userId: string, organisationId: string, agentId: string): Promise<AgentContext> {
  const agent = await prisma.agent.findFirst({
    where: { id: agentId, ownerUserId: userId, ...activeIn(organisationId), revokedAt: null },
    select: { id: true, name: true },
  });
  if (!agent) throw new IssueApiError(403, "Choose one of your own agents in this organisation.");
  return { agentId: agent.id, name: agent.name, ownerId: userId, organisationId, level: "working", keyId: "app", burst: false };
}
