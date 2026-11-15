import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("typesense", () => ({ default: class {} }));

const findFirst = vi.hoisted(() => vi.fn());
const findMany = vi.hoisted(() => vi.fn());
vi.mock("@/lib/prisma", () => ({ prisma: { project: { findFirst }, skillSubmission: { findMany } } }));
const publishedTasks = vi.hoisted(() => vi.fn());
const taskCounts = vi.hoisted(() => vi.fn());
const proposalCount = vi.hoisted(() => vi.fn());
const proposals = vi.hoisted(() => vi.fn());
const proposalVotes = vi.hoisted(() => vi.fn());
const myVerdicts = vi.hoisted(() => vi.fn());
const proposalAgents = vi.hoisted(() => vi.fn());

const membershipFindUnique = vi.hoisted(() => vi.fn());
const projectFindUnique = vi.hoisted(() => vi.fn());
const projectMembershipFindUnique = vi.hoisted(() => vi.fn());
const projectJoinRequestFindUnique = vi.hoisted(() => vi.fn());
const projectJoinRequestUpsert = vi.hoisted(() => vi.fn());
const projectMembershipUpsert = vi.hoisted(() => vi.fn());
const projectJoinRequestUpdateMany = vi.hoisted(() => vi.fn());
const bugCount = vi.hoisted(() => vi.fn());
const bugFindFirst = vi.hoisted(() => vi.fn());
const membershipUpsert = vi.hoisted(() => vi.fn());
const txMembershipFindFirst = vi.hoisted(() => vi.fn());
const awardSignupBonus = vi.hoisted(() => vi.fn());
const ideaFindFirst = vi.hoisted(() => vi.fn());
const notificationCreateMany = vi.hoisted(() => vi.fn().mockResolvedValue({ count: 1 }));
const membershipFindMany = vi.hoisted(() => vi.fn());
const bugFindUnique = vi.hoisted(() => vi.fn());
const findProjectIssue = vi.hoisted(() => vi.fn());
const skillSubmissionFindMany = vi.hoisted(() => vi.fn());
const skillSubmissionFindUnique = vi.hoisted(() => vi.fn());
const skillSubmissionUpdate = vi.hoisted(() => vi.fn());
const projectFindMany = vi.hoisted(() => vi.fn());

vi.mock("@/lib/prisma", () => ({
  prisma: {
    project: { findFirst, findUnique: projectFindUnique, findMany: projectFindMany },
    bug: { findUnique: bugFindUnique, findMany: publishedTasks, groupBy: taskCounts, count: bugCount, findFirst: bugFindFirst },
    idea: { count: proposalCount, findMany: proposals, findFirst: ideaFindFirst },
    ideaVerdict: { groupBy: proposalVotes, findMany: myVerdicts },
    agent: { findMany: proposalAgents },
    membership: { findUnique: membershipFindUnique, findMany: membershipFindMany },
    projectMembership: { findUnique: projectMembershipFindUnique, upsert: projectMembershipUpsert },
    projectJoinRequest: { findUnique: projectJoinRequestFindUnique, upsert: projectJoinRequestUpsert, updateMany: projectJoinRequestUpdateMany },
    notification: { createMany: notificationCreateMany },
    skillSubmission: { findMany: skillSubmissionFindMany, findUnique: skillSubmissionFindUnique, update: skillSubmissionUpdate },
    $transaction: async (run: (tx: unknown) => Promise<unknown>) =>
      run({ projectMembership: { upsert: projectMembershipUpsert }, membership: { upsert: membershipUpsert, findFirst: txMembershipFindFirst }, projectJoinRequest: { updateMany: projectJoinRequestUpdateMany } }),
  },
}));
vi.mock("@/components/marketing/tasks/tasks-board", () => ({ TasksBoard: () => null }));
vi.mock("@/lib/points/signup-bonus", () => ({ awardSignupBonus }));
vi.mock("@/lib/organisation-next-step-load", () => ({ loadOrganisationNextStep: vi.fn(async () => null) }));
vi.mock("@/lib/workflow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workflow")>()),
  workflowFor: vi.fn(async () => ({ ideaThreshold: 3, revisionLimit: 2 })),
}));
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

const section = vi.hoisted(() => ({
  notFound: vi.fn(() => { throw new Error("NOT_FOUND"); }),
  redirect: vi.fn((to: string) => { throw new Error(`REDIRECT ${to}`); }),
  requireProject: vi.fn(),
  firstProjectRefFor: vi.fn(),
  requireUser: vi.fn(async () => ({ id: "ada" })),
  requireSuperAdmin: vi.fn(),
}));
vi.mock("next/navigation", () => ({ notFound: section.notFound, redirect: section.redirect, permanentRedirect: section.redirect }));
vi.mock("@/lib/project-route", () => ({ requireProject: section.requireProject, firstProjectRefFor: section.firstProjectRefFor }));
vi.mock("@/lib/auth-helpers", () => ({ requireUser: section.requireUser, requireSuperAdmin: section.requireSuperAdmin }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => ({ user: { id: "viewer" } })) }));
vi.mock("@/lib/project-issue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/project-issue")>()),
  findProjectIssue,
}));
vi.mock("@/lib/organisation-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/organisation-access")>()),
  // The viewer owns an organisation of their own, as every new account does.
  currentOrganisationAccess: vi.fn(async () => ({ membershipRole: "owner", admin: true })),
  organisationAccessFor: vi.fn(async (_userId: string, organisationId: string | null) =>
    organisationId === "org-they-admin" ? { membershipRole: "admin", admin: true } : { membershipRole: null, admin: false }),
}));

import MarketingHomePage from "@/app/(app)/[org]/[project]/marketing/tasks/page";
import MarketingPage from "@/app/(app)/marketing/page";
import LibraryPage from "@/app/(app)/[org]/[project]/marketing/output-box/page";
import { readLibrary } from "@/app/(app)/[org]/[project]/marketing/output-box/data";
import { readTasksBoard } from "@/app/(app)/[org]/[project]/marketing/data";
import RejectedIdeasPage from "@/app/(app)/[org]/[project]/marketing/ideas/rejected/page";
import { readRejectedIdeas } from "@/app/(app)/[org]/[project]/marketing/ideas/rejected/data";
import { parseTaskView } from "@/components/marketing/tasks/model";
import { marketingTabHref } from "@/lib/header-nav";
import { issueProject } from "@/lib/agent-api/issues";
import { getSkills, CORE_SKILL_TEMPLATES } from "@/app/(app)/skills/skills-data";
import { projectRef } from "@/lib/project-paths";
import { canManageProject } from "@/lib/project-permissions";
import { joinOpenProjectAction } from "@/app/actions/project-join-requests";
import { requireUser } from "@/lib/auth-helpers";
import { reviewSkillSubmissionAction } from "@/app/actions/skill-submissions";
import { generateMetadata as projectOverviewMetadata } from "@/app/(app)/[org]/[project]/page";
import { sitemapSectionXml } from "@/lib/seo/sitemap";
import IssueHistoryPage from "@/app/(app)/[org]/[project]/[number]/history/page";
import ProjectIssueLayout from "@/app/(app)/[org]/[project]/[number]/layout";

const agent = {
  agentId: "agent1",
  name: "Ada's Claude",
  ownerId: "ada",
  organisationId: "organisation_zedu",
  level: "working" as const,
  burst: false,
  keyId: "key1",
};

describe("issueProject organisation scope (#user-agents)", () => {
  beforeEach(() => {
    findFirst.mockReset();
  });

  it("lets a key work in any project of its organisation", async () => {
    findFirst.mockResolvedValue({ id: "project_mobile" });
    await expect(issueProject(agent, new URLSearchParams("projectId=project_mobile"))).resolves.toEqual({
      organisationId: "organisation_zedu",
      projectId: "project_mobile",
    });
  });

  it("refuses another organisation's project as not found", async () => {
    findFirst.mockResolvedValue(null);
    await expect(issueProject(agent, new URLSearchParams("projectId=project_elsewhere"))).rejects.toMatchObject({ status: 404 });
    expect(findFirst.mock.calls[0][0].where).toEqual({ id: "project_elsewhere", organisationId: "organisation_zedu" });
  });
});

describe("Library project isolation", () => {
  it("refuses access before reading published deliverables", async () => {
    section.requireProject.mockRejectedValue(new Error("NOT_FOUND"));
    publishedTasks.mockClear();
    await expect(LibraryPage({ params: Promise.resolve({ org: "acme", project: "private" }) })).rejects.toThrow("NOT_FOUND");
    expect(publishedTasks).not.toHaveBeenCalled();
  });

  it("returns only published marketing work in the authorized organisation and project, with the latest delivery", async () => {
    const approved = {
      id: "approved", number: 42, title: "Launch campaign", projectId: "project_web", organisationId: "organisation_zedu",
      track: "marketing", status: "resolved", substatus: "published", isDeleted: false,
      deliveries: [
        { id: "new", updatedAt: new Date("2026-11-03"), summary: "Approved version", deliverableUrls: ["https://example.com/final.png"], agent: { name: "Studio" } },
        { id: "old", updatedAt: new Date("2026-11-01"), summary: "Earlier version", deliverableUrls: ["https://example.com/draft.png"], agent: { name: "Earlier agent" } },
      ],
      mergeReviews: [{ updatedAt: new Date("2026-11-04") }],
      attachments: [{ id: "evidence", filename: "unrelated-evidence.png", contentType: "image/png", size: 20 }],
    };
    const records = [approved,
      { ...approved, id: "other-project", projectId: "project_other" },
      { ...approved, id: "other-organisation", organisationId: "organisation_other" },
      { ...approved, id: "product", track: "product" },
      { ...approved, id: "unpublished", status: "done", substatus: "accepted" },
      { ...approved, id: "deleted", isDeleted: true },
    ];
    publishedTasks.mockImplementation(async ({ where, select }) => records
      .filter((row) => Object.entries(where).every(([key, value]) => row[key as keyof typeof row] === value))
      .map((row) => ({ ...row, deliveries: select.deliveries.orderBy[0].updatedAt === "desc" ? [...row.deliveries].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()).slice(0, select.deliveries.take) : row.deliveries })));
    const result = await readLibrary({ organisationId: "organisation_zedu", project: { id: "project_web" } } as Parameters<typeof readLibrary>[0]);
    expect(result).toEqual([expect.objectContaining({
      id: "approved", agent: "Studio", publishedAt: "2026-11-04T00:00:00.000Z",
      files: [expect.objectContaining({ url: "https://example.com/final.png" })],
    })]);
  });
});

describe("the marketing tasks board", () => {
  const context = { organisationId: "organisation_zedu", user: { id: "ada" }, project: { id: "project_web", slug: "web" } } as Parameters<typeof readTasksBoard>[0];
  const scope = { organisationId: "organisation_zedu", projectId: "project_web", track: "marketing", isDeleted: false };
  const rowsOf = (board: Awaited<ReturnType<typeof readTasksBoard>>) => (board.list.kind === "tasks" ? board.list.rows : []);

  beforeEach(() => {
    publishedTasks.mockReset();
    publishedTasks.mockResolvedValue([]);
    taskCounts.mockReset();
    taskCounts.mockResolvedValue([{ status: "open", _count: { _all: 3 } }, { status: "resolved", _count: { _all: 2 } }]);
    proposalCount.mockReset();
    proposalCount.mockResolvedValue(0);
    proposals.mockReset();
    proposals.mockResolvedValue([]);
    proposalVotes.mockReset();
    proposalVotes.mockResolvedValue([]);
    myVerdicts.mockReset();
    myVerdicts.mockResolvedValue([]);
  });

  it("refuses access before reading any task", async () => {
    section.requireProject.mockRejectedValue(new Error("NOT_FOUND"));
    await expect(MarketingHomePage({ params: Promise.resolve({ org: "acme", project: "private" }), searchParams: Promise.resolve({}) })).rejects.toThrow("NOT_FOUND");
    expect(publishedTasks).not.toHaveBeenCalled();
    expect(proposals).not.toHaveBeenCalled();
    expect(taskCounts).not.toHaveBeenCalled();
  });

  it("reads this project's marketing issues for the tab, and counts every tab", async () => {
    const board = await readTasksBoard(context, parseTaskView({ status: "live" }));
    expect(publishedTasks.mock.calls[0][0].where).toMatchObject({ ...scope, status: "resolved" });
    expect(taskCounts.mock.calls[0][0].where).toMatchObject(scope);
    expect(taskCounts.mock.calls[0][0].where.status).toBeUndefined();
    expect(board.counts).toEqual({ ideas: 0, open: 3, "in-progress": 0, closed: 0, done: 0, live: 2 });
  });

  it("lists open marketing ideas under Ideas with their votes, and marks the ones you voted on", async () => {
    proposalCount.mockResolvedValue(1);
    proposals.mockResolvedValue([{
      id: "idea_1", number: 12, title: "A launch post", score: 2, createdAt: new Date("2026-11-01"), updatedAt: new Date("2026-11-01"),
      verdicts: [{ updatedAt: new Date("2026-11-02") }], reporter: { name: "Ada" }, category: null, _count: { verdicts: 2 },
    }]);
    proposalVotes.mockResolvedValue([{ ideaId: "idea_1", opinion: "good", _sum: { votes: 3 } }, { ideaId: "idea_1", opinion: "bad", _sum: { votes: 1 } }]);
    myVerdicts.mockResolvedValue([{ ideaId: "idea_1" }]);
    const board = await readTasksBoard(context, parseTaskView({ status: "ideas" }));
    expect(proposals.mock.calls[0][0].where).toMatchObject({ ...scope, status: "open" });
    expect(publishedTasks).not.toHaveBeenCalled();
    expect(board.list).toMatchObject({ kind: "proposals", ideas: [{
      number: 12, threshold: 3, good: 3, badVotes: 1, approvedByMe: true, lastUpdateAt: new Date("2026-11-02"),
    }] });
  });

  it("opens Ideas when the address names no list or an unknown one", async () => {
    expect((await readTasksBoard(context, parseTaskView({}))).tab.param).toBe("ideas");
    expect((await readTasksBoard(context, parseTaskView({ status: "merge" }))).tab.param).toBe("ideas");
  });

  it("names who delivered finished work, but not the last worker of work reopened for bids", async () => {
    const task = {
      id: "t1", number: 41, title: "A launch post", closeReason: null, voteCount: 0, revisionCount: 0, updatedAt: new Date("2026-11-03"), reward: 4,
      rewardEstimateCount: 0, rewardFixedAt: null, project: { slug: "web", organisation: { slug: "acme" } }, type: null, assignee: null, claims: [],
      deliveries: [{ agent: { name: "Studio" } }], _count: { comments: 0, bids: 0 },
    };
    publishedTasks.mockResolvedValue([{ ...task, status: "resolved", substatus: "published" }]);
    expect(rowsOf(await readTasksBoard(context, parseTaskView({ status: "live" })))[0].agentName).toBe("Studio");
    publishedTasks.mockResolvedValue([{ ...task, status: "open", substatus: "open" }]);
    expect(rowsOf(await readTasksBoard(context, parseTaskView({ status: "open" })))[0].agentName).toBeNull();
  });

  it("shows the revision round while work is back with its worker", async () => {
    publishedTasks.mockResolvedValue([{
      id: "t1", number: 41, title: "A launch post", status: "in_progress", substatus: "in_progress", closeReason: null, voteCount: 0, revisionCount: 1,
      updatedAt: new Date("2026-11-03"), reward: 4, rewardEstimateCount: 0, rewardFixedAt: null, project: { slug: "web", organisation: { slug: "acme" } }, type: null, assignee: null,
      claims: [], deliveries: [], _count: { comments: 0, bids: 0 },
    }]);
    expect(rowsOf(await readTasksBoard(context, parseTaskView({ status: "in-progress" })))[0].revision).toBe("Revision 1 of 2");
  });
});

describe("Rejected marketing ideas project isolation", () => {
  const context = {
    organisationId: "organisation_zedu",
    project: { id: "project_web" },
    user: { id: "ada" },
  } as Parameters<typeof readRejectedIdeas>[0];

  beforeEach(() => {
    vi.clearAllMocks();
    proposalCount.mockReset();
    proposalCount.mockResolvedValue(1);
    proposals.mockReset();
    proposals.mockResolvedValue([]);
    proposalAgents.mockReset();
    proposalAgents.mockResolvedValue([]);
  });

  it("refuses access before reading marketing ideas", async () => {
    section.requireProject.mockRejectedValue(new Error("NOT_FOUND"));
    await expect(
      RejectedIdeasPage({ params: Promise.resolve({ org: "acme", project: "private" }), searchParams: Promise.resolve({}) }),
    ).rejects.toThrow("NOT_FOUND");
    expect(proposals).not.toHaveBeenCalled();
  });

  it("reads rejected and archived marketing ideas only inside the authorized organisation and project", async () => {
    await readRejectedIdeas(context);
    expect(proposals).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        organisationId: "organisation_zedu", projectId: "project_web", track: "marketing",
        status: { in: ["rejected", "archived"] },
      }),
    }));
  });
});

describe("the marketing section", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    section.requireUser.mockResolvedValue({ id: "ada" });
  });

  it("is refused to someone who can't open the project", async () => {
    section.requireProject.mockRejectedValue(new Error("NOT_FOUND"));
    await expect(MarketingHomePage({ params: Promise.resolve({ org: "acme", project: "web" }), searchParams: Promise.resolve({}) })).rejects.toThrow("NOT_FOUND");
    expect(section.requireProject).toHaveBeenCalledWith("acme", "web");
  });

  it("sends the Marketing tab and /marketing to the project's section, not Amp", async () => {
    expect(marketingTabHref(projectRef("acme", "web"))).toBe("/acme/web/marketing");
    expect(marketingTabHref(null)).toBe("/marketing");
    section.firstProjectRefFor.mockResolvedValue(projectRef("acme", "web"));
    await expect(MarketingPage()).rejects.toThrow("REDIRECT /acme/web/marketing");
  });

  it("sends someone with no project to their organisations", async () => {
    section.firstProjectRefFor.mockResolvedValue(null);
    await expect(MarketingPage()).rejects.toThrow("REDIRECT /organisations");
  });
});

describe("project addresses carry the organisation (#project-urls)", () => {
  it("reads an old project-first address as old, and an org/project address as new", async () => {
    const { isProjectFirstPath, issuesPath, projectRef } = await import("@/lib/project-paths");
    expect(isProjectFirstPath("/desktop/ideas/2297")).toBe(true);
    expect(isProjectFirstPath("/desktop/740")).toBe(true);
    expect(isProjectFirstPath("/zedu/desktop/ideas/2297")).toBe(false);
    expect(isProjectFirstPath("/zedu")).toBe(false);
    expect(issuesPath(projectRef("zedu", "desktop"), "in_progress")).toBe("/zedu/desktop/issues/in-progress");
  });

  it("never lets a new project or organisation take a name an address reads as old or as a site page", async () => {
    const { unreservedProjectSlug } = await import("@/lib/project-slug");
    const { organisationSlugCandidate } = await import("@/lib/organisations");
    expect(unreservedProjectSlug("123")).toBe("123-project");
    expect(unreservedProjectSlug("workstream")).toBe("workstream-project");
    expect(organisationSlugCandidate("agents", 0, () => "x2y3")).toBe("agents-x2y3");
    expect(organisationSlugCandidate("zedu", 0)).toBe("zedu");
  });
});

describe("canManageProject permissions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows site super_admin", async () => {
    expect(await canManageProject({ id: "admin-1", role: "super_admin" }, "organisation-1")).toBe(true);
  });

  it("allows organisation owners and admins", async () => {
    membershipFindUnique.mockResolvedValue({ role: "owner" });
    expect(await canManageProject({ id: "user-1", role: "user" }, "organisation-1")).toBe(true);

    membershipFindUnique.mockResolvedValue({ role: "admin" });
    expect(await canManageProject({ id: "user-1", role: "user" }, "organisation-1")).toBe(true);
  });

  it("denies regular organisation members and outsiders", async () => {
    membershipFindUnique.mockResolvedValue({ role: "member" });
    expect(await canManageProject({ id: "user-1", role: "user" }, "organisation-1")).toBe(false);

    membershipFindUnique.mockResolvedValue(null);
    expect(await canManageProject({ id: "stranger-1", role: "user" }, "organisation-1")).toBe(false);
  });
});

describe("joinOpenProjectAction (#earnings)", () => {
  const open = {
    id: "p-1",
    slug: "ziki-marketing",
    organisationId: "t-1",
    isOpenForContributors: true,
    visibility: "public",
    organisation: { slug: "ziki" },
  };
  beforeEach(() => {
    vi.clearAllMocks();
    (requireUser as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "user-1", name: "Alice", email: "alice@example.com" });
  });

  it("joins an open project straight away, with no request to accept, and opens its marketing tasks", async () => {
    findFirst.mockResolvedValue(open);
    bugCount.mockResolvedValue(3);
    const res = await joinOpenProjectAction("p-1");
    expect(res).toEqual({ ok: true, href: "/ziki/ziki-marketing/marketing" });
    expect(projectMembershipUpsert).toHaveBeenCalledWith(expect.objectContaining({ create: { projectId: "p-1", userId: "user-1" } }));
    // Joining puts you in that project only, never in its whole organisation.
    expect(membershipUpsert).not.toHaveBeenCalled();
    expect(projectJoinRequestUpsert).not.toHaveBeenCalled();
  });

  it("opens the project's Ideas when it has no marketing tasks waiting", async () => {
    findFirst.mockResolvedValue(open);
    bugCount.mockResolvedValue(0);
    // Product work in it: an ordinary project.
    bugFindFirst.mockImplementation(async ({ where }: { where: { track: string } }) => (where.track === "product" ? { id: "b" } : null));
    ideaFindFirst.mockResolvedValue(null);
    expect(await joinOpenProjectAction("p-1")).toEqual({ ok: true, href: "/ziki/ziki-marketing/ideas" });
  });

  it("opens an all-marketing project's Marketing tab while its tasks are all still ideas (#marketing-home)", async () => {
    findFirst.mockResolvedValue(open);
    bugCount.mockResolvedValue(0);
    bugFindFirst.mockResolvedValue(null);
    ideaFindFirst.mockImplementation(async ({ where }: { where: { track: string } }) => (where.track === "marketing" ? { id: "i" } : null));
    expect(await joinOpenProjectAction("p-1")).toEqual({ ok: true, href: "/ziki/ziki-marketing/marketing" });
  });

  it("pays the signup bonus to a brand-new person (in no organisation), and not to someone already in one", async () => {
    findFirst.mockResolvedValue(open);
    bugCount.mockResolvedValue(1);
    txMembershipFindFirst.mockResolvedValue(null);
    await joinOpenProjectAction("p-1");
    expect(awardSignupBonus).toHaveBeenCalledWith(expect.anything(), "user-1", "t-1");

    awardSignupBonus.mockClear();
    txMembershipFindFirst.mockResolvedValue({ id: "m-1" });
    await joinOpenProjectAction("p-1");
    expect(awardSignupBonus).not.toHaveBeenCalled();
    expect(membershipUpsert).not.toHaveBeenCalled();
  });

  it("refuses a project that isn't open, or isn't public, and adds nobody", async () => {
    findFirst.mockResolvedValue({ ...open, isOpenForContributors: false });
    expect(await joinOpenProjectAction("p-1")).toEqual({ ok: false, error: expect.any(String) });
    findFirst.mockResolvedValue({ ...open, visibility: "private" });
    expect(await joinOpenProjectAction("p-1")).toEqual({ ok: false, error: expect.any(String) });
    expect(projectMembershipUpsert).not.toHaveBeenCalled();
    expect(membershipUpsert).not.toHaveBeenCalled();
  });
});

describe("a deleted issue on a public project", () => {
  const params = Promise.resolve({ org: "acme", project: "web", number: "7" });
  const deletedIn = (organisationId: string) => {
    findProjectIssue.mockResolvedValue({
      kind: "found",
      issue: { id: "bug-7", number: 7, organisationId, ref: "acme/web", isDeleted: true },
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (requireUser as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "viewer", role: "user" });
    bugFindUnique.mockResolvedValue({
      id: "bug-7",
      number: 7,
      project: { slug: "web", organisation: { slug: "acme" } },
      title: "Removed for a reason",
      description: "Secret",
      createdAt: new Date("2026-01-01"),
      isDeleted: true,
      reporter: { name: "Rae" },
      revisions: [],
    });
  });

  it("is a 404 for someone who only administers another organisation", async () => {
    deletedIn("org-of-the-project");
    await expect(IssueHistoryPage({ params } as never)).rejects.toThrow("NOT_FOUND");
    await expect(ProjectIssueLayout({ children: null, params })).rejects.toThrow("NOT_FOUND");
  });

  it("still opens for an admin of the issue's own organisation", async () => {
    deletedIn("org-they-admin");
    await expect(IssueHistoryPage({ params } as never)).resolves.toBeTruthy();
    await expect(ProjectIssueLayout({ children: "page", params })).resolves.toBe("page");
  });
});

describe("skills library public scope and review authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("only lists approved skills, filtering out pending or rejected submissions", async () => {
    skillSubmissionFindMany.mockResolvedValue([
      {
        id: "skill-approved",
        slug: "vitest-runner",
        title: "Vitest Deterministic Suite Runner",
        category: "testing",
        categoryLabel: "Testing & QA",
        summary: "Run fast isolated tests.",
        tags: ["vitest", "ci"],
        prompt: "Run tests.",
        checklist: ["All assertions pass"],
        sampleCommand: "npm test",
        documentationUrl: null,
        status: "approved",
        createdAt: new Date("2026-01-01"),
        submittedBy: { name: "Ada" },
      },
    ]);

    const { skills, error } = await getSkills();
    expect(error).toBeUndefined();
    expect(skills).toHaveLength(1 + CORE_SKILL_TEMPLATES.length);
    expect(skills[0].title).toBe("Vitest Deterministic Suite Runner");
    expect(skillSubmissionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: "approved" },
      })
    );
  });

  it("refuses skill submission review for any user who is not a super admin", async () => {
    section.requireSuperAdmin.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(reviewSkillSubmissionAction("sub-1", "approved")).rejects.toThrow("NEXT_REDIRECT");
    expect(skillSubmissionUpdate).not.toHaveBeenCalled();
  });

  it("allows a super admin to approve a pending submission", async () => {
    section.requireSuperAdmin.mockResolvedValue({ id: "admin-42", isRealSuperAdmin: true });
    skillSubmissionFindUnique.mockResolvedValue({ id: "sub-1", status: "pending" });
    skillSubmissionUpdate.mockResolvedValue({ id: "sub-1", status: "approved" });

    const result = await reviewSkillSubmissionAction("sub-1", "approved");
    expect(result).toEqual({ ok: true });
    expect(skillSubmissionUpdate).toHaveBeenCalledWith({
      where: { id: "sub-1" },
      data: expect.objectContaining({
        status: "approved",
        reviewedById: "admin-42",
        rejectionReason: null,
      }),
    });
  });
});

describe("search engines see only public projects (#seo-pages)", () => {
  const params = Promise.resolve({ org: "acme", project: "secret" });

  it("describes and indexes a public project", async () => {
    findFirst.mockResolvedValueOnce({ name: "Web", slug: "web", goal: "Ship the **site**.", organisation: { name: "Acme", slug: "acme" } });
    const metadata = await projectOverviewMetadata({ params: Promise.resolve({ org: "acme", project: "web" }) });
    expect(findFirst.mock.calls.at(-1)?.[0].where).toMatchObject({ slug: "web", visibility: "public", organisation: { slug: "acme" } });
    expect(metadata.robots).toEqual({ index: true, follow: true });
    expect(String(metadata.title)).toContain("Web");
  });

  it("says nothing about a private project, not even its name, and keeps it out of search", async () => {
    findFirst.mockResolvedValueOnce(null);
    const metadata = await projectOverviewMetadata({ params });
    expect(metadata).toEqual({ robots: { index: false, follow: true } });
  });

  it("lists only public projects in the sitemap", async () => {
    projectFindMany.mockResolvedValueOnce([{ slug: "web", updatedAt: new Date("2026-11-01"), organisation: { slug: "acme" } }]);
    const xml = await sitemapSectionXml("projects.xml");
    expect(projectFindMany.mock.calls[0][0].where).toMatchObject({ visibility: "public", archivedAt: null });
    expect(xml).toContain("/acme/web</loc>");
  });
});
