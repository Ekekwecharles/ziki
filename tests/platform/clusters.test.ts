import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Agent clusters (#agent-clusters): a cluster's card is public in its project, but
 * its forum, shared doc and private notes are for active member agents only (and
 * their owners, read-only). Anyone else gets the same 404 as a missing cluster.
 * Skills decide who joins and who is invited; creation is limited per agent; a
 * cluster quiet for 14 days is archived until a member reopens it.
 */
const db = vi.hoisted(() => ({
  project: { findFirst: vi.fn() }, membership: { findUnique: vi.fn() }, agent: { findMany: vi.fn() },
  skillTag: { findMany: vi.fn() }, agentSkill: { findMany: vi.fn() }, bug: { findFirst: vi.fn() },
  cluster: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), count: vi.fn(), delete: vi.fn() },
  clusterMember: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), createMany: vi.fn(), update: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
  clusterPost: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() },
  clusterBlocker: { findFirst: vi.fn(), create: vi.fn(), createMany: vi.fn(), update: vi.fn() },
  clusterNote: { findMany: vi.fn(), upsert: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
import {
  agentClusterViewer, addBlocker, addTask, createCluster, decideMember, deleteCluster, ownerActingAgent, inviteToCluster, joinCluster,
  listClusters, listTasks, readNotes, reopenCluster, setBlockerSolved, shareInformation, suggestInvites, type ClusterViewer,
} from "@/lib/clusters";
import type { AgentContext } from "@/lib/agents/require-agent";

const agent = (agentId: string): AgentContext => ({ agentId, ownerId: `owner-${agentId}`, organisationId: "org", name: `Agent ${agentId}`, level: "working", keyId: "key", burst: false });
const viewerFor = (agentId: string): ClusterViewer => ({ organisationId: "org", projectId: "project", userId: `owner-${agentId}`, agent: agent(agentId) });
const DAY = 24 * 60 * 60 * 1000;
const cluster = {
  id: "c1", organisationId: "org", projectId: "project", name: "Payments", purpose: "Harden payments", creatorAgentId: "creator",
  neededSkills: ["security", "testing"], doc: "Plan", docVersion: 3, lastActivityAt: new Date(),
};
// Agent skills in the organisation: the creator does security; "tester" and "member" test; "designer" does UX.
const SKILLS: Record<string, string[]> = { creator: ["security"], member: ["testing"], tester: ["testing"], designer: ["ux"] };

beforeEach(() => {
  vi.resetAllMocks();
  db.$transaction.mockImplementation(async (run) => run(db));
  db.cluster.findFirst.mockResolvedValue(cluster);
  // Only "creator" and "member" are active members of c1.
  db.clusterMember.findFirst.mockImplementation(async ({ where }) =>
    where.agentId === "creator" || where.agentId === "member" ? { agentId: where.agentId } : null);
  db.agentSkill.findMany.mockImplementation(async ({ where }) =>
    (where.agentId.in as string[]).flatMap((agentId) => (SKILLS[agentId] ?? []).map((slug) => ({ agentId, tag: { slug } }))));
  db.skillTag.findMany.mockImplementation(async ({ where }) => (where.slug.in as string[]).filter((s) => ["security", "testing", "ux"].includes(s)).map((slug) => ({ slug })));
  db.agent.findMany.mockImplementation(async ({ where }) => (where.id?.in ?? []).map((id: string) => ({ id })));
  db.cluster.count.mockResolvedValue(0);
});

describe("cluster access", () => {
  it("does not let a key reach another organisation's project", async () => {
    db.project.findFirst.mockResolvedValue(null);
    db.membership.findUnique.mockResolvedValue({ role: "member" });
    await expect(agentClusterViewer(agent("a"), "foreign")).rejects.toMatchObject({ status: 404 });
    expect(db.project.findFirst.mock.calls[0][0].where).toMatchObject({ id: "foreign", organisationId: "org" });
  });

  it("answers 404, not 403, to a non-member reading tasks or notes", async () => {
    const outsider = viewerFor("outsider");
    await expect(listTasks(outsider, "c1")).rejects.toMatchObject({ status: 404, message: "Cluster not found." });
    await expect(readNotes(outsider, "c1")).rejects.toMatchObject({ status: 404, message: "Cluster not found." });
    expect(db.clusterPost.findMany).not.toHaveBeenCalled();
    expect(db.clusterNote.findMany).not.toHaveBeenCalled();
  });

  it("treats an invited agent as outside until it joins", async () => {
    db.clusterPost.findMany.mockResolvedValue([]);
    await listTasks(viewerFor("member"), "c1");
    expect(db.clusterMember.findFirst.mock.calls[0][0].where).toMatchObject({ clusterId: "c1", status: "active", agentId: "member" });
  });

  it("scopes a cluster to the caller's project and organisation", async () => {
    db.cluster.findFirst.mockResolvedValue(null);
    await expect(listTasks(viewerFor("member"), "other-project-cluster")).rejects.toMatchObject({ status: 404 });
    expect(db.cluster.findFirst.mock.calls[0][0].where).toMatchObject({ id: "other-project-cluster", projectId: "project", organisationId: "org" });
  });

  it("never lets one member read another member's private notes", async () => {
    db.clusterNote.findMany.mockResolvedValue([]);
    await readNotes(viewerFor("member"), "c1");
    expect(db.clusterNote.findMany.mock.calls[0][0].where).toEqual({ clusterId: "c1", agentId: "member" });
  });

  it("shows a person only their own agents' notes", async () => {
    db.clusterNote.findMany.mockResolvedValue([]);
    db.clusterMember.findFirst.mockResolvedValue({ agentId: "member" });
    await readNotes({ organisationId: "org", projectId: "project", userId: "owner-member" }, "c1");
    expect(db.clusterNote.findMany.mock.calls[0][0].where).toEqual({ clusterId: "c1", agent: { ownerUserId: "owner-member" } });
  });

  it("lists cards without content, with the skills still missing, and hides archived clusters unless asked", async () => {
    db.cluster.findMany.mockResolvedValue([{ id: "c1", name: "Payments", purpose: "Harden payments", creatorAgentId: "creator",
      neededSkills: ["security", "testing"], lastActivityAt: new Date(), createdAt: new Date(0), _count: { posts: 2, blockers: 1 },
      project: { name: "Web", slug: "web", organisation: { slug: "ziki" } }, posts: [{ title: "Refund retries", authorName: "Creator" }],
      members: [{ agentId: "creator", joinedAt: new Date(0), agent: { name: "Creator", ownerUserId: "owner-creator" } }] }]);
    db.clusterMember.findMany.mockResolvedValue([]);
    const { items } = await listClusters(viewerFor("outsider"));
    expect(items[0]).toMatchObject({ id: "c1", taskCount: 2, openBlockers: 1, project: { name: "Web", path: "/ziki/web" }, lastTask: { title: "Refund retries" }, myStatus: null, missingSkills: ["testing"], archived: false });
    expect(items[0]).not.toHaveProperty("doc");
    expect(db.cluster.findMany.mock.calls[0][0].select).not.toHaveProperty("doc");
    expect(db.cluster.findMany.mock.calls[0][0].where).toHaveProperty("lastActivityAt");
    await listClusters(viewerFor("outsider"), { includeArchived: true });
    expect(db.cluster.findMany.mock.calls[1][0].where).not.toHaveProperty("lastActivityAt");
  });

  it("lists the whole organisation's clusters for everyone, not only one project's", async () => {
    db.cluster.findMany.mockResolvedValue([]);
    db.clusterMember.findMany.mockResolvedValue([]);
    await listClusters(viewerFor("outsider"), { wholeOrganisation: true });
    const where = db.cluster.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ organisationId: "org" });
    expect(where).not.toHaveProperty("projectId");
    await listClusters(viewerFor("outsider"));
    expect(db.cluster.findMany.mock.calls[1][0].where).toMatchObject({ organisationId: "org", projectId: "project" });
  });
});

describe("creating clusters", () => {
  it("makes the creator the first member and invites only agents with a needed skill the creator lacks", async () => {
    db.cluster.create.mockResolvedValue({ id: "new", name: "Search", purpose: "Make search fast" });
    await createCluster(viewerFor("creator"), { name: "Search", purpose: "Make search fast", neededSkills: ["security", "testing"], invite: ["tester"] });
    expect(db.clusterMember.create).toHaveBeenCalledWith({ data: expect.objectContaining({ clusterId: "new", agentId: "creator", status: "active" }) });
    expect(db.clusterMember.createMany).toHaveBeenCalledWith({ data: [expect.objectContaining({ agentId: "tester", status: "invited" })] });
    await expect(createCluster(viewerFor("creator"), { name: "Search", purpose: "Make search fast", neededSkills: ["security", "testing"], invite: ["designer"] }))
      .rejects.toMatchObject({ status: 422, body: { code: "skill_not_missing" } });
  });

  it("needs at least one skill, and only the organisation's skill tags", async () => {
    await expect(createCluster(viewerFor("creator"), { name: "Search", purpose: "Make search fast", neededSkills: [] })).rejects.toThrow();
    await expect(createCluster(viewerFor("creator"), { name: "Search", purpose: "Make search fast", neededSkills: ["juggling"] }))
      .rejects.toMatchObject({ status: 422, body: { code: "unknown_skill" } });
    expect(db.cluster.create).not.toHaveBeenCalled();
  });

  it("stops an agent at 3 open clusters it leads, and at 5 new ones a day", async () => {
    db.cluster.count.mockResolvedValueOnce(3).mockResolvedValueOnce(0);
    await expect(createCluster(viewerFor("creator"), { name: "Search", purpose: "Make search fast", neededSkills: ["security"] }))
      .rejects.toMatchObject({ status: 429, body: { code: "cluster_limit_open" } });
    db.cluster.count.mockResolvedValueOnce(1).mockResolvedValueOnce(5);
    await expect(createCluster(viewerFor("creator"), { name: "Search", purpose: "Make search fast", neededSkills: ["security"] }))
      .rejects.toMatchObject({ status: 429, body: { code: "cluster_limit_daily" } });
    expect(db.cluster.create).not.toHaveBeenCalled();
    expect(db.cluster.count.mock.calls[0][0].where).toMatchObject({ organisationId: "org", creatorAgentId: "creator" });
  });
});

describe("joining and inviting by skill", () => {
  it("lets any agent with a needed skill join at once, and refuses one without", async () => {
    db.clusterMember.findUnique.mockResolvedValue(null);
    await expect(joinCluster(viewerFor("tester"), "c1")).resolves.toEqual({ status: "active" });
    expect(db.clusterMember.create).toHaveBeenCalledWith({ data: expect.objectContaining({ agentId: "tester", status: "active" }) });
    await expect(joinCluster(viewerFor("designer"), "c1")).rejects.toMatchObject({ status: 403, body: { code: "skill_needed" } });
  });

  it("turns an invite into membership", async () => {
    db.clusterMember.findUnique.mockResolvedValue({ id: "row", status: "invited" });
    await expect(joinCluster(viewerFor("designer"), "c1")).resolves.toEqual({ status: "active" });
    expect(db.clusterMember.update).toHaveBeenCalledWith({ where: { id: "row" }, data: expect.objectContaining({ status: "active" }) });
  });

  it("lets only members invite, and only for a skill the members lack", async () => {
    await expect(inviteToCluster(viewerFor("outsider"), "c1", { agentIds: ["tester"] })).rejects.toMatchObject({ status: 404 });
    db.cluster.findFirst.mockResolvedValue({ ...cluster, neededSkills: ["security", "testing", "ux"] });
    db.clusterMember.findMany.mockImplementation(async ({ where }) => (where.status === "active" ? [{ agentId: "creator" }, { agentId: "member" }] : []));
    await expect(inviteToCluster(viewerFor("member"), "c1", { agentIds: ["tester"] })).rejects.toMatchObject({ status: 422, body: { missingSkills: ["ux"] } });
    await expect(inviteToCluster(viewerFor("member"), "c1", { agentIds: ["designer"] })).resolves.toMatchObject({ invited: ["designer"] });
  });

  it("suggests agents who bring the missing skills", async () => {
    db.cluster.findFirst.mockResolvedValue({ ...cluster, neededSkills: ["security", "testing", "ux"] });
    db.clusterMember.findMany.mockImplementation(async ({ where }) => (where.status === "active" ? [{ agentId: "creator" }, { agentId: "member" }] : [{ agentId: "creator" }, { agentId: "member" }]));
    db.agent.findMany.mockResolvedValue([{ id: "designer", name: "Designer", skills: [{ tag: { slug: "ux" } }] }]);
    await expect(suggestInvites(viewerFor("member"), "c1")).resolves.toEqual({ missingSkills: ["ux"], items: [{ agentId: "designer", name: "Designer", brings: ["ux"] }] });
  });

  it("lets only the creator remove a member, and never the creator", async () => {
    await expect(decideMember(viewerFor("member"), "c1", "tester", { decision: "remove" })).rejects.toMatchObject({ status: 403 });
    await expect(decideMember(viewerFor("creator"), "c1", "creator", { decision: "remove" })).rejects.toMatchObject({ status: 409 });
  });
});

describe("the cluster's owner", () => {
  it("alone deletes the cluster", async () => {
    await expect(deleteCluster(viewerFor("member"), "c1")).rejects.toMatchObject({ status: 403 });
    expect(db.cluster.delete).not.toHaveBeenCalled();
    await deleteCluster(viewerFor("creator"), "c1");
    expect(db.cluster.delete).toHaveBeenCalledWith({ where: { id: "c1" } });
  });

  it("acts from the app only through one of their own agents in the organisation", async () => {
    db.agent.findMany.mockReset();
    const findFirst = vi.fn().mockResolvedValue(null);
    (db.agent as unknown as { findFirst: typeof findFirst }).findFirst = findFirst;
    await expect(ownerActingAgent("owner-creator", "org", "someone-elses-agent")).rejects.toMatchObject({ status: 403 });
    expect(findFirst.mock.calls[0][0].where).toMatchObject({ id: "someone-elses-agent", ownerUserId: "owner-creator", revokedAt: null });
    findFirst.mockResolvedValue({ id: "creator", name: "Creator" });
    await expect(ownerActingAgent("owner-creator", "org", "creator")).resolves.toMatchObject({ agentId: "creator", ownerId: "owner-creator", organisationId: "org" });
  });
});

describe("archived clusters", () => {
  it("are read-only after 14 days without activity until a member reopens them", async () => {
    const quiet = { ...cluster, lastActivityAt: new Date(Date.now() - 15 * DAY) };
    db.cluster.findFirst.mockResolvedValue(quiet);
    await expect(addTask(viewerFor("member"), "c1", { title: "New task", tryingToAchieve: "Ship it" })).rejects.toMatchObject({ status: 409, body: { code: "cluster_archived" } });
    await expect(shareInformation(viewerFor("member"), "c1", "t1", { body: "x" })).rejects.toMatchObject({ status: 409 });
    db.clusterMember.findUnique.mockResolvedValue(null);
    await expect(joinCluster(viewerFor("tester"), "c1")).rejects.toMatchObject({ status: 409 });
    await reopenCluster(viewerFor("member"), "c1");
    expect(db.cluster.update).toHaveBeenCalledWith({ where: { id: "c1" }, data: { lastActivityAt: expect.any(Date) } });
  });
});

describe("tasks, blockers and shared information", () => {
  it("posts a task with what it is trying to achieve and its blockers, linked to an issue of this project", async () => {
    db.bug.findFirst.mockResolvedValue(null);
    await expect(addTask(viewerFor("member"), "c1", { title: "Refund retries", tryingToAchieve: "Retry soft declines", issueNumber: 42 })).rejects.toMatchObject({ status: 404 });
    expect(db.bug.findFirst.mock.calls[0][0].where).toMatchObject({ projectId: "project", number: 42 });
    db.bug.findFirst.mockResolvedValue({ id: "bug" });
    db.clusterPost.create.mockResolvedValue({ id: "t1", createdAt: new Date() });
    await addTask(viewerFor("member"), "c1", { title: "Refund retries", tryingToAchieve: "Retry soft declines", issueNumber: 42, blockers: ["Which declines are soft?"] });
    expect(db.clusterPost.create).toHaveBeenCalledWith({ data: expect.objectContaining({ title: "Refund retries", body: "Retry soft declines", issueNumber: 42, authorAgentId: "member" }) });
    expect(db.clusterBlocker.createMany).toHaveBeenCalledWith({ data: [expect.objectContaining({ taskId: "t1", text: "Which declines are soft?", raisedByAgentId: "member" })] });
  });

  it("needs a title and what the task is trying to achieve", async () => {
    await expect(addTask(viewerFor("member"), "c1", { title: "No aim" })).rejects.toThrow();
    expect(db.clusterPost.create).not.toHaveBeenCalled();
  });

  it("shares information only on a task in this cluster, and only against that task's own blockers", async () => {
    db.clusterPost.findFirst.mockResolvedValue(null);
    await expect(shareInformation(viewerFor("member"), "c1", "elsewhere", { body: "Here you go" })).rejects.toMatchObject({ status: 404 });
    expect(db.clusterPost.findFirst.mock.calls[0][0].where).toEqual({ id: "elsewhere", clusterId: "c1", parentId: null });
    db.clusterPost.findFirst.mockResolvedValue({ id: "t1", authorAgentId: "creator" });
    db.clusterBlocker.findFirst.mockResolvedValue(null);
    await expect(shareInformation(viewerFor("member"), "c1", "t1", { body: "Answer", blockerId: "other-task-blocker" })).rejects.toMatchObject({ status: 404 });
    expect(db.clusterBlocker.findFirst.mock.calls[0][0].where).toEqual({ id: "other-task-blocker", taskId: "t1" });
    db.clusterBlocker.findFirst.mockResolvedValue({ id: "b1" });
    db.clusterPost.create.mockResolvedValue({ id: "i1", createdAt: new Date() });
    await shareInformation(viewerFor("member"), "c1", "t1", { body: "Answer", blockerId: "b1" });
    expect(db.clusterPost.create).toHaveBeenCalledWith({ data: expect.objectContaining({ parentId: "t1", blockerId: "b1", authorAgentId: "member" }) });
  });

  it("lets any member raise a blocker on a task", async () => {
    db.clusterPost.findFirst.mockResolvedValue({ id: "t1", authorAgentId: "creator" });
    db.clusterBlocker.create.mockResolvedValue({ id: "b2", createdAt: new Date() });
    await addBlocker(viewerFor("member"), "c1", "t1", { text: "No staging access" });
    expect(db.clusterBlocker.create).toHaveBeenCalledWith({ data: { clusterId: "c1", taskId: "t1", text: "No staging access", raisedByAgentId: "member" } });
  });

  it("lets only the task's author mark a blocker solved", async () => {
    db.clusterBlocker.findFirst.mockResolvedValue({ id: "b1", task: { authorAgentId: "creator" } });
    await expect(setBlockerSolved(viewerFor("member"), "c1", "b1", { solved: true })).rejects.toMatchObject({ status: 403 });
    db.clusterBlocker.update.mockResolvedValue({ id: "b1" });
    await setBlockerSolved(viewerFor("creator"), "c1", "b1", { solved: true });
    expect(db.clusterBlocker.update).toHaveBeenCalledWith({ where: { id: "b1" }, data: { solvedAt: expect.any(Date), solvedByAgentId: "creator" } });
  });

  it("lists open blockers first and counts them", async () => {
    db.clusterPost.findMany.mockResolvedValue([{ id: "t1", title: "T", body: "B", replies: [], blockers: [
      { id: "b1", text: "done", solvedAt: new Date(0) }, { id: "b2", text: "still stuck", solvedAt: null },
    ] }]);
    const { items } = await listTasks(viewerFor("member"), "c1");
    expect(items[0].blockers.map((b) => b.id)).toEqual(["b2", "b1"]);
    expect(items[0]).toMatchObject({ openBlockers: 1, shared: [] });
  });

  it("lets no one but an agent write", async () => {
    db.clusterMember.findFirst.mockResolvedValue({ agentId: "member" });
    await expect(addTask({ organisationId: "org", projectId: "project", userId: "owner-member" }, "c1", { title: "Hi", tryingToAchieve: "Hello" })).rejects.toMatchObject({ status: 403 });
  });
});
