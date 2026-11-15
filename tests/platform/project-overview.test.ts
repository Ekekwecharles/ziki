import { beforeEach, describe, expect, it, vi } from "vitest";

const prisma = vi.hoisted(() => ({
  project: { findFirst: vi.fn(), findMany: vi.fn() },
  bug: { count: vi.fn() },
  projectJoinRequest: { findUnique: vi.fn() },
}));
const canContributeToProject = vi.hoisted(() => vi.fn());
const canManageProject = vi.hoisted(() => vi.fn());

vi.mock("@/lib/prisma", () => ({ prisma }));
vi.mock("@/lib/project-permissions", () => ({ canContributeToProject, canManageProject }));
vi.mock("server-only", () => ({}));
// The Discover page signs nobody in here, and its card brings in the join action: the count this file checks needs neither.
vi.mock("@/lib/auth-helpers", () => ({ optionalUser: vi.fn().mockResolvedValue(null) }));
vi.mock("@/components/discover-project-card", () => ({ DiscoverProjectCard: () => null }));

import DiscoverPage from "@/app/(app)/discover/page";
import { loadProjectOverview } from "@/lib/project-overview";
import { projectOverviewSegments } from "@/lib/project-slug";
import { publicIntakeSegments } from "@/lib/public-project-paths";
import { projectJsonLd } from "@/lib/seo/projects";

function overviewProject(overrides: Record<string, unknown> = {}) {
  return {
    id: "project-1",
    slug: "tracker",
    name: "Job Tracker",
    goal: "A streamlined issue tracker.",
    repoUrl: "https://github.com/example/tracker",
    siteUrl: "https://tracker.example",
    stagingUrl: null,
    contributorGuidelines: "Write hermetic tests.",
    visibility: "public" as const,
    isOpenForContributors: true,
    acceptsGuestIdeas: true,
    organisationId: "org-1",
    organisation: {
      id: "org-1",
      name: "Example Org",
      slug: "example",
      memberships: [{ role: "owner", user: { id: "owner-1", name: "Maintainer", image: null } }],
    },
    repositories: [{ label: "API", url: "https://github.com/example/api", branch: "main" }],
    memberships: [{ user: { id: "contributor-1", name: "Chloe", image: null } }],
    _count: { ideas: 12, bugs: 5, memberships: 1 },
    ...overrides,
  };
}

function mockProject(visibility: "public" | "private" = "public", overrides: Record<string, unknown> = {}) {
  prisma.project.findFirst
    .mockResolvedValueOnce({ id: "project-1", organisationId: "org-1", visibility })
    .mockResolvedValueOnce(overviewProject({ visibility, ...overrides }));
  prisma.bug.count.mockResolvedValue(28);
}

describe("project overview access and data", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canContributeToProject.mockResolvedValue(false);
    canManageProject.mockResolvedValue(false);
    prisma.projectJoinRequest.findUnique.mockResolvedValue(null);
  });

  it("shows a public project to visitors and signed-in people outside the organisation", async () => {
    mockProject("public");
    await expect(loadProjectOverview("example", "tracker", null)).resolves.toMatchObject({
      project: { visibility: "public", acceptsGuestIdeas: true },
      openIdeas: 12,
      openIssues: 5,
      deliveredFixes: 28,
    });

    vi.clearAllMocks();
    canContributeToProject.mockResolvedValue(false);
    canManageProject.mockResolvedValue(false);
    prisma.projectJoinRequest.findUnique.mockResolvedValue(null);
    mockProject("public");
    await expect(
      loadProjectOverview("example", "tracker", { id: "outsider", role: "user" }),
    ).resolves.toMatchObject({ project: { visibility: "public" }, isMember: false, joinRequest: "none" });
  });

  it("tells a signed-in outsider about their own request to join, and never asks for a guest or a member (#join-requests)", async () => {
    mockProject("public", { isOpenForContributors: false });
    prisma.projectJoinRequest.findUnique.mockResolvedValue({ status: "pending" });
    await expect(
      loadProjectOverview("example", "tracker", { id: "outsider", role: "user" }),
    ).resolves.toMatchObject({ isMember: false, joinRequest: "pending" });
    expect(prisma.projectJoinRequest.findUnique).toHaveBeenCalledWith({
      where: { projectId_userId: { projectId: "project-1", userId: "outsider" } },
      select: { status: true },
    });

    prisma.projectJoinRequest.findUnique.mockClear();
    mockProject("public", { isOpenForContributors: false });
    await expect(loadProjectOverview("example", "tracker", null)).resolves.toMatchObject({ joinRequest: "none" });

    canContributeToProject.mockResolvedValue(true);
    mockProject("public", { isOpenForContributors: false });
    await expect(
      loadProjectOverview("example", "tracker", { id: "member-1", role: "user" }),
    ).resolves.toMatchObject({ isMember: true, joinRequest: "none" });
    expect(prisma.projectJoinRequest.findUnique).not.toHaveBeenCalled();
  });

  it("hides a private project from external non-members", async () => {
    for (const user of [null, { id: "outsider", role: "user" as const }]) {
      prisma.project.findFirst.mockResolvedValueOnce({
        id: "project-1",
        organisationId: "org-1",
        visibility: "private",
      });
      canContributeToProject.mockResolvedValue(false);

      await expect(loadProjectOverview("example", "tracker", user)).resolves.toBeNull();
    }

    expect(prisma.project.findFirst).toHaveBeenCalledTimes(2);
    expect(prisma.bug.count).not.toHaveBeenCalled();
  });

  it("loads a private project for an accepted project member", async () => {
    canContributeToProject.mockResolvedValue(true);
    mockProject("private");

    await expect(
      loadProjectOverview("example", "tracker", { id: "contributor-1", role: "user" }),
    ).resolves.toMatchObject({ project: { visibility: "private" }, isMember: true });
  });

  it("returns repository links, project story, and the ProjectMembership total", async () => {
    mockProject("public");

    await expect(loadProjectOverview("example", "tracker", null)).resolves.toMatchObject({
      project: {
        repoUrl: "https://github.com/example/tracker",
        goal: "A streamlined issue tracker.",
        contributorGuidelines: "Write hermetic tests.",
        repositories: [{ label: "API", url: "https://github.com/example/api", branch: "main" }],
        contributorCount: 1,
        maintainer: { id: "owner-1", name: "Maintainer" },
        contributors: [{ id: "contributor-1", name: "Chloe" }],
      },
    });
    expect(prisma.project.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          _count: expect.objectContaining({
            select: expect.objectContaining({ memberships: true }),
          }),
        }),
      }),
    );
  });

  it("counts open issues the same way on the Discover list and on the project's own page", async () => {
    // Discover used to count delivered work (done, merge) as open, so a project showed 195 there and 156 on its page.
    const openIssuesFilter = (call: unknown[]) =>
      (call[0] as { select: { _count: { select: { bugs: unknown } } } }).select._count.select.bugs;

    mockProject("public");
    await loadProjectOverview("example", "tracker", null);
    prisma.project.findMany.mockResolvedValue([]);
    await DiscoverPage({ searchParams: Promise.resolve({}) });

    const onProjectPage = openIssuesFilter(prisma.project.findFirst.mock.calls.at(-1)!);
    const onDiscover = openIssuesFilter(prisma.project.findMany.mock.calls.at(-1)!);
    expect(onDiscover).toEqual(onProjectPage);
    expect(onDiscover).toEqual({ where: { isDeleted: false, status: { in: ["open", "in_progress"] } } });
  });

  it("preserves empty goal and guidelines for the view's fallback states", async () => {
    mockProject("public", { goal: null, contributorGuidelines: null });

    await expect(loadProjectOverview("example", "tracker", null)).resolves.toMatchObject({
      project: { goal: null, contributorGuidelines: null },
    });
  });
});

describe("project overview route recognition", () => {
  it("recognizes only non-reserved two-segment project roots", () => {
    expect(projectOverviewSegments("/example/tracker")).toEqual({
      orgSlug: "example",
      projectSlug: "tracker",
    });
    expect(projectOverviewSegments("/example/tracker/issues")).toBeNull();
    expect(projectOverviewSegments("/example/issues")).toBeNull();
    expect(projectOverviewSegments("/example/123")).toBeNull();
  });

  it("recognizes only the nested guest report and tracking routes", () => {
    expect(publicIntakeSegments("/example/tracker/report")).toEqual({ orgSlug: "example", projectSlug: "tracker", kind: "report" });
    expect(publicIntakeSegments("/example/tracker/track/private-token")).toEqual({ orgSlug: "example", projectSlug: "tracker", kind: "track" });
    expect(publicIntakeSegments("/example/tracker/issues/12")).toBeNull();
  });
});

describe("project structured data for search engines", () => {
  const project = {
    slug: "tracker",
    name: "Job Tracker",
    goal: "A **streamlined** issue tracker.",
    repoUrl: "https://github.com/example/tracker",
    siteUrl: null,
    visibility: "public" as const,
    organisation: { name: "Example Org", slug: "example" },
  };

  it("describes a public project: its name, its goal as plain text, who runs it and where its code is", () => {
    const [described] = projectJsonLd(project) as Array<Record<string, unknown>>;
    expect(described).toMatchObject({
      "@type": "Project",
      name: "Job Tracker",
      parentOrganization: { name: "Example Org" },
      sameAs: ["https://github.com/example/tracker"],
    });
    expect(String(described.url)).toMatch(/\/example\/tracker$/);
    expect(described.description).not.toContain("*");
  });

  it("says nothing about a private project, even to a member who may open its page", () => {
    expect(projectJsonLd({ ...project, visibility: "private" })).toBeNull();
  });
});
