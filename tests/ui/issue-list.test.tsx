import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

/** The issue list: the main status tabs and their counts, filters that keep search and scope, rows that link to the issue, and ideas listed apart from issues. */
/**
 * Renders the whole issue list with a small fake database, so the layout
 * changes from the Oct 20 call (#1054–#1063) are checked on real markup.
 */

const count = vi.hoisted(() => vi.fn());
const findMany = vi.hoisted(() => vi.fn());
// #idea-table: ideas come from their own table, on the Ideas tab.
const ideaCount = vi.hoisted(() => vi.fn());
const ideaFindMany = vi.hoisted(() => vi.fn());
// Each idea's votes by opinion, to mark bad ideas red (#idea-rejected).
const ideaVerdictGroupBy = vi.hoisted(() => vi.fn());
const bugFindFirst = vi.hoisted(() => vi.fn());
const groupBy = vi.hoisted(() => vi.fn(async (_args: { by: string[]; where?: Record<string, unknown> }) => {
  void _args;
  return [];
}));
const indexedSearch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/search-index", () => ({
  searchWorkItems: indexedSearch,
  bugSearchSort: () => "createdAt:desc,sourceId:desc",
  ideaSearchSort: () => "score:desc,createdAt:desc,sourceId:desc",
  typesenseFilter: (field: string, value: unknown) => value === undefined ? null : `${field}:=${String(value)}`,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/zedu/acme/issues/all",
  useParams: () => ({ org: "zedu", project: "acme" }),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => ({ user: { id: "dave" } })) }));
vi.mock("@/lib/auth-helpers", () => ({ requireUser: vi.fn(async () => ({ id: "dave", role: "user" })) }));
// #project-urls: the organisation and project in the address pick the project and check access.
vi.mock("@/lib/project-route", () => ({
  requireProject: vi.fn(async () => ({
    user: { id: "dave", role: "user" },
    organisationId: "organisation-acme",
    project: { id: "project-acme", slug: "acme", name: "Acme Web", goal: null, organisationId: "organisation-acme", orgSlug: "zedu", ref: "zedu/acme" },
    isOrgMember: true,
    isOrgAdmin: false,
    isProjectMember: false,
    canContribute: true,
  })),
}));
vi.mock("@/lib/organisation-access", () => ({
  currentOrganisationAccess: vi.fn(async () => ({ membershipRole: "member", admin: false })),
  organisationAccessFor: vi.fn(async () => ({ membershipRole: "member", admin: false })),
}));
vi.mock("@/lib/lookups", () => ({
  getIssueTypes: vi.fn(async () => []),
}));
vi.mock("@/lib/organisation-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/organisation-context")>()),
  currentOrganisationIdFor: vi.fn(async () => "organisation-acme"),
}));
vi.mock("@/lib/issue-stage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/issue-stage")>()),
  openIssueConfirmations: vi.fn(async () => new Map([["bug-1", { stage: "confirming", accepts: 1, rejects: 0, needed: 2, confirmed: false }]])),
}));
vi.mock("@/lib/voter-summaries", () => ({
  fetchVoterSummaries: vi.fn(async () =>
    new Map([
      [
        "bug-1",
        {
          likes: { count: 2, voters: [{ id: "a", name: "Ann", image: null }, { id: "b", name: "Ben", image: null }] },
          dislikes: { count: 1, voters: [{ id: "c", name: "Cy", image: null }] },
        },
      ],
    ]),
  ),
}));
vi.mock("@/lib/workflow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workflow")>()),
  workflowFor: vi.fn(async () => ({ ...(await import("@/lib/workflow-config")).DEFAULT_PROJECT_WORKFLOW, ideaThreshold: 4 })),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    project: { findFirst: vi.fn(async () => ({ slug: "acme-web", name: "Acme Web", goal: null })), findMany: vi.fn(async () => []) },
    bug: { count, findMany, groupBy, findFirst: bugFindFirst },
    // #live-check, #live-confirm: what the Live rows show.
    pullRequestReport: { findMany: vi.fn(async () => []) },
    deploymentReport: { findMany: vi.fn(async () => []) },
    idea: { count: ideaCount, findMany: ideaFindMany },
    ideaVerdict: { groupBy: ideaVerdictGroupBy, findMany: vi.fn(async () => []) },
    milestone: { findMany: vi.fn(async () => []) },
    projectArea: { findMany: vi.fn(async () => []) },
    user: { findUnique: vi.fn(async () => ({ keyboardShortcuts: true })) },
  },
}));

// A person's answer on Your call is posted through the ordinary comment action: here it only records what it was given.
vi.mock("@/lib/idea-structuring", () => ({ structureIdea: vi.fn(async (input: unknown) => input) }));
vi.mock("@/app/actions/issues", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/app/actions/issues")>()), addCommentAction: vi.fn(async () => ({ ok: true })) }));
// Your call (#your-call) asks the database for the split issues on every view (for its step's count): the layout tests below read the list's own queries, so it gets an empty answer here.
vi.mock("@/lib/your-call", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/your-call")>()), loadYourCall: vi.fn(async () => []) }));
import { IssuesList } from "@/app/(app)/[org]/[project]/issues/_list/issues-list";
import { requireProject } from "@/lib/project-route";
import { organisationAccessFor } from "@/lib/organisation-access";
import { answerFrom, topShare, urgencyOf, yardsticksFor, type UrgencySignals } from "@/lib/your-call";
import { currentOrganisationAccess } from "@/lib/organisation-access";
import { addCommentAction } from "@/app/actions/issues";
import { answerYourCallAction } from "@/app/actions/your-call";
import { TasksBoard } from "@/components/marketing/tasks/tasks-board";
import { taskTab, type TaskRow, type TasksBoardData } from "@/components/marketing/tasks/model";
import { projectRef } from "@/lib/project-paths";
import { PROJECT_ALL, PROJECT_ALL_PARAM } from "@/lib/issue-list-filters";

const BUG = {
  id: "bug-1",
  number: 7,
  title: "Login button does nothing",
  description: "## Summary\nLogin button does nothing\n\n## Acceptance Criteria\n- [ ] Fix login",
  createdByAgentId: null,
  status: "open",
  substatus: "requires_confirmation",
  voteCount: 2,
  proofLinks: ["https://github.com/acme/web/pull/1", "https://github.com/acme/web/pull/2"],
  isDeleted: false,
  isBoosted: false,
  duplicateOf: null,
  createdAt: new Date("2026-10-01T10:00:00Z"),
  updatedAt: new Date("2026-10-20T10:00:00Z"),
  type: null,
  reporter: { name: "Rita Reporter", role: "user", image: null },
  assignee: { name: "Bob Builder", role: "user", image: null },
  area: null,
  project: { slug: "acme", organisation: { slug: "zedu" } },
  votes: [],
  _count: { comments: 3, attachments: 1 },
};

const IDEA = {
  id: "idea-1",
  number: 12,
  title: "Export activity as CSV",
  score: 2,
  projectId: "project-acme",
  createdAt: new Date("2026-10-02T10:00:00Z"),
  updatedAt: new Date("2026-10-03T10:00:00Z"),
  rejectedAt: null,
  archivedAt: null,
  verdicts: [],
  reporter: { name: "Rita Reporter" },
  _count: { verdicts: 3 },
};

/** Renders `/zedu/acme/issues/<status>`, or `/zedu/acme/ideas` when no status is given. */
async function renderList({ status = "ideas", ...query }: Record<string, string> = {}) {
  const returnTo = status === "ideas" ? "/zedu/acme/ideas" : `/zedu/acme/issues/${status}`;
  const page = (await IssuesList({ org: "zedu", slug: "acme", status, returnTo, searchParams: Promise.resolve(query) })) as ReactElement;
  return renderToStaticMarkup(page);
}

const clean = (html: string) => html.replace(/<!-- -->/g, "");
/** The stage bar above the panel, and the status list down its left. */
const stages = (html: string) => clean(html).match(/<nav aria-label="Stages"[\s\S]*?<\/nav>/)?.[0] ?? "";
const statusList = (html: string) => clean(html).match(/<nav aria-label="Status"[\s\S]*?<\/nav>/)?.[0] ?? "";
const links = (nav: string) => [...nav.matchAll(/<a [^>]*>[\s\S]*?<\/a>/g)].map((m) => m[0]).filter((link) => !/^<a [^>]*aria-hidden="true"/.test(link));
const labelOf = (link: string) => link.match(/>([A-Za-z][A-Za-z ]*?)(?:<span|<\/a>)/)?.[1] ?? "";
const current = (nav: string) => links(nav).filter((link) => link.includes('aria-current="page"')).map(labelOf);
/** Each link's label and count: beside the label in the stage bar, read out after it in the status list. */
const counted = (nav: string) => Object.fromEntries(links(nav).map((link) => [labelOf(link), Number(link.match(/(\d+)<\/span>/)?.[1])]));

beforeEach(() => {
  vi.clearAllMocks();
  count.mockResolvedValue(1);
  findMany.mockResolvedValue([BUG]);
  ideaCount.mockResolvedValue(4);
  ideaFindMany.mockResolvedValue([IDEA]);
  ideaVerdictGroupBy.mockResolvedValue([]);
  indexedSearch.mockRejectedValue(new Error("Typesense is unavailable in this test."));
});

describe("issue list layout", () => {
  it("links each row to its project address and offers Add Idea", async () => {
    const html = await renderList({ status: "all" });
    expect(html).toContain("Login button does nothing");
    // #project-urls: a row opens the issue at /<org>/<project>/<number>.
    expect(html).toContain('href="/zedu/acme/7"');
    // Add Idea opens the idea chat box in the toolbar (#idea-chat).
    expect(html).toMatch(/<button[^>]*title="Add Idea"/);
  });

  it("says no issues match when the project has issues but the filters hide them", async () => {
    count.mockImplementation(async (args: { where?: { assigneeId?: unknown } }) => (args?.where?.assigneeId ? 0 : 3));
    findMany.mockResolvedValue([]);
    const html = await renderList({ mine: "assigned", status: "all" });
    expect(html).toMatch(/no issues match/i);
    expect(html).toContain("Clear filters");
    expect(html).not.toMatch(/no issues yet/i);
  });

  it("lists ideas under Ideas' New ideas, from the Idea table, with their score and no importance button (#idea-table)", async () => {
    const html = await renderList();
    expect(ideaFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ organisationId: "organisation-acme", projectId: "project-acme", status: "open", isDeleted: false }),
    }));
    expect(html).toContain('href="/zedu/acme/ideas/12"');
    expect(html).toContain("Idea #12");
    expect(html).toMatch(/aria-label="[^"]*idea score 2 of 4"/);
    expect(html).toContain("3 verdicts");
    expect(html).not.toMatch(/click to mark important/);
    // No issue row matches an idea list.
    expect(findMany.mock.calls.at(-1)![0].where.id).toEqual({ in: [] });
  });

  it("keeps search and scope when switching status, and resets paging and intake", async () => {
    const html = await renderList({ q: "login", mine: "assigned", stage: "reported", page: "2", status: "open" });
    const list = statusList(html);
    // #project-urls: the status is the path, the rest stays in the query.
    expect(list).toContain('href="/zedu/acme/issues/in-progress?q=login&amp;mine=assigned"');
    expect(list).not.toContain("page=");
    expect(list).not.toContain("stage=");
    const statusCount = groupBy.mock.calls.find(([args]) => args?.by?.[0] === "status");
    expect(statusCount?.[0].where).toMatchObject({ organisationId: "organisation-acme", projectId: "project-acme" });
    expect(statusCount?.[0].where).not.toHaveProperty("status");
  });

  it("lists both of Open's substatuses on its tab, by the main status (#substatus)", async () => {
    await renderList({ status: "open" });
    const where = findMany.mock.calls.at(-1)![0].where;
    expect(where.status).toBe("open");
    expect(where).not.toHaveProperty("substatus");
  });

  it("searches across every issue on All, so a just-reported issue can be found", async () => {
    const html = await renderList({ q: "login", status: "all" });
    const where = findMany.mock.calls.at(-1)![0].where;
    expect(where).not.toHaveProperty("id");
    expect(where).not.toHaveProperty("status");
    expect(current(stages(html))).toEqual([]);
  });

  it("uses Typesense for issue text hits and rechecks the current organisation-scoped rows in PostgreSQL", async () => {
    indexedSearch.mockResolvedValue({ found: 1, hits: [{ id: "bug-1", kind: "bug", score: 10 }] });
    await renderList({ q: "login", status: "all" });
    expect(indexedSearch).toHaveBeenCalledWith(expect.objectContaining({
      kind: "bug", organisationId: "organisation-acme", projectId: "project-acme", track: "product",
      extraFilters: expect.arrayContaining(["isDeleted:=false"]),
    }));
    const rowQuery = findMany.mock.calls.at(-1)![0];
    expect(rowQuery.where.id).toEqual({ in: ["bug-1"] });
    expect(rowQuery.where).not.toHaveProperty("OR");
    expect(rowQuery.where).toMatchObject({ organisationId: "organisation-acme", projectId: "project-acme", track: "product", isDeleted: false });
  });

  it("uses Typesense for Idea text hits while retaining project and track predicates", async () => {
    ideaCount.mockResolvedValue(1);
    indexedSearch.mockResolvedValue({ found: 1, hits: [{ id: "idea-1", kind: "idea", score: 10 }] });
    await renderList({ q: "export", status: "ideas" });
    expect(indexedSearch).toHaveBeenCalledWith(expect.objectContaining({
      kind: "idea", organisationId: "organisation-acme", projectId: "project-acme", track: "product",
    }));
    const rowQuery = ideaFindMany.mock.calls.at(-1)![0];
    expect(rowQuery.where.id).toEqual({ in: ["idea-1"] });
    expect(rowQuery.where).not.toHaveProperty("OR");
    expect(rowQuery.where).toMatchObject({ organisationId: "organisation-acme", projectId: "project-acme", track: "product", isDeleted: false });
  });

  it("falls back to PostgreSQL for issue text search when Typesense is unavailable", async () => {
    const html = await renderList({ q: "login", status: "all" });
    expect(html).toContain("Issues");
    expect(indexedSearch).toHaveBeenCalled();
    const rowQuery = findMany.mock.calls.at(-1)![0];
    expect(rowQuery.where).toMatchObject({ organisationId: "organisation-acme", projectId: "project-acme", track: "product" });
    expect(rowQuery.where).toHaveProperty("OR");
  });

  it("falls back to PostgreSQL for idea text search and keeps its source-of-truth count", async () => {
    const html = await renderList({ q: "export", status: "ideas" });
    expect(html).toContain("Export activity as CSV");
    expect(indexedSearch).toHaveBeenCalled();
    const rowQuery = ideaFindMany.mock.calls.at(-1)![0];
    expect(rowQuery.where).toMatchObject({ organisationId: "organisation-acme", projectId: "project-acme", track: "product" });
    expect(rowQuery.where).toHaveProperty("OR");
    expect(ideaCount).toHaveBeenCalled();
  });

  it("refills a stale Typesense page from PostgreSQL instead of returning a short page", async () => {
    indexedSearch.mockResolvedValue({ found: 1, hits: [{ id: "deleted-or-missing", kind: "bug", score: 10 }] });
    findMany.mockImplementation(async (args: { where?: Record<string, unknown> }) => args.where?.id ? [] : [BUG]);
    await renderList({ q: "login", status: "all" });
    expect(findMany.mock.calls.at(-1)![0].where).not.toHaveProperty("id");
    expect(findMany.mock.calls.at(-1)![0].where).toHaveProperty("OR");
  });

  it("uses PostgreSQL rows when the indexed total disagrees with the exact database count", async () => {
    indexedSearch.mockResolvedValue({ found: 99, hits: [{ id: "bug-1", kind: "bug", score: 10 }] });
    await renderList({ q: "login", status: "all" });
    expect(findMany.mock.calls.at(-1)![0].where).not.toHaveProperty("id");
    expect(findMany.mock.calls.at(-1)![0].where).toHaveProperty("OR");
  });

  it("lists each tab by its main status (Ziki #713, #substatus)", async () => {
    for (const status of ["in_progress", "done", "merge", "resolved"]) {
      await renderList({ status });
      const where = findMany.mock.calls.at(-1)![0].where;
      expect(where.status).toBe(status);
      expect(where).not.toHaveProperty("AND");
    }
  });

  it("counts each stage as its statuses added up, and each status on the left by itself", async () => {
    groupBy.mockImplementation((async (args: { by: string[] }) =>
      args.by[0] !== "status"
        ? []
        : [
          { status: "open", _count: { _all: 13 } },
          { status: "in_progress", _count: { _all: 2 } },
          { status: "done", _count: { _all: 7 } },
          { status: "merge", _count: { _all: 1 } },
          { status: "resolved", _count: { _all: 7 } },
          { status: "closed", _count: { _all: 3 } },
        ]) as never);
    const html = await renderList({ status: "open" });
    // Project Overview: the project's goals, then the issues assigned to you. Ideas: new ideas + rejected ideas. In Progress: Open, In progress,
    // Closed. Delivered: Done, Merge. Live: its own stage. Possibly delivered is a list inside Open, so In
    // Progress's total doesn't count it again.
    expect(counted(stages(html))).toEqual({ Overview: 1, New: 8, "In Progress": 18, Delivered: 8, Live: 7 });
    expect(counted(statusList(html))).toEqual({ Open: 13, "In progress": 2, Closed: 3, "Possibly delivered": 1 });
  });

  it("shows Overview to anyone who can contribute, and Live only once something went live", async () => {
    groupBy.mockImplementation((async (args: { by: string[] }) =>
      args.by[0] !== "status" ? [] : [{ status: "open", _count: { _all: 4 } }, { status: "done", _count: { _all: 2 } }]) as never);
    count.mockResolvedValue(0);
    const html = await renderList({ status: "open" });
    expect(Object.keys(counted(stages(html)))).toEqual(["Overview", "New", "In Progress", "Delivered"]);
  });

});

/** The agents dock's settings (#agents-dock): saved per browser, and the dock still works when they can't be. */
describe("a signed-in stranger on another organisation's public project", () => {
  const visitor = {
    user: { id: "stranger", role: "user" },
    organisationId: "organisation-acme",
    project: { id: "project-acme", slug: "acme", name: "Acme Web", goal: null, organisationId: "organisation-acme", orgSlug: "zedu", ref: projectRef("zedu", "acme"), visibility: "public", isOpenForContributors: true },
    isOrgMember: false,
    isOrgAdmin: false,
    isProjectMember: false,
    canContribute: false,
  } as unknown as Awaited<ReturnType<typeof requireProject>>;
  const asMember = vi.mocked(requireProject).getMockImplementation()!;
  const memberRole = vi.mocked(organisationAccessFor).getMockImplementation()!;
  const ownRole = vi.mocked(currentOrganisationAccess).getMockImplementation()!;
  const owner = { organisationId: "own", organisationName: "Own", organisationSlug: "own", membershipRole: "owner", admin: true } as const;
  const none = { organisationId: "organisation-acme", organisationName: null, organisationSlug: null, membershipRole: null, admin: false } as const;
  const listQuery = () => findMany.mock.calls[0][0].where as { projectId?: string; isDeleted?: boolean };

  beforeEach(() => {
    vi.mocked(requireProject).mockImplementation(async () => visitor);
    // They own an organisation of their own, as every new account does, and have no role in this one.
    vi.mocked(currentOrganisationAccess).mockImplementation(async () => owner);
    vi.mocked(organisationAccessFor).mockImplementation(async () => none);
  });

  afterEach(() => {
    vi.mocked(requireProject).mockImplementation(asMember);
    vi.mocked(currentOrganisationAccess).mockImplementation(ownRole);
    vi.mocked(organisationAccessFor).mockImplementation(memberRole);
  });

  it("can't reach the organisation's private projects with ?project=all, which a member can", async () => {
    await renderList({ status: "all", [PROJECT_ALL_PARAM]: PROJECT_ALL });
    expect(listQuery().projectId).toBe("project-acme");
    for (const [args] of ideaCount.mock.calls) expect((args as { where: { projectId?: string } }).where.projectId).toBe("project-acme");

    findMany.mockClear();
    vi.mocked(requireProject).mockImplementation(asMember);
    await renderList({ status: "all", [PROJECT_ALL_PARAM]: PROJECT_ALL });
    expect(listQuery().projectId).toBeUndefined();
  });

  it("can't list deleted issues, though they own an organisation of their own", async () => {
    await renderList({ status: "all", deleted: "true" });
    expect(listQuery().isDeleted).toBe(false);
  });
});

describe("agents dock settings", () => {
  function fakeStorage(saved: string | null, blocked = false) {
    const store = new Map(saved === null ? [] : [["ziki-agents-dock", saved]]);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => { if (blocked) throw new Error("blocked"); return store.get(key) ?? null; },
      setItem: (key: string, value: string) => { if (blocked) throw new Error("blocked"); store.set(key, value); },
    });
    return store;
  }
  /** A fresh copy of the module, as after a page load: it keeps what it read in memory. */
  async function load() {
    vi.resetModules();
    return import("@/components/agents-dock-prefs");
  }

  it("starts with the face look", async () => {
    fakeStorage(null);
    const { readPrefs, lookFor } = await load();
    expect(lookFor(readPrefs(), "agent-1")).toBe("face");
    vi.unstubAllGlobals();
  });

  it("keeps a hidden agent across a page load, and ignores anything it can't read", async () => {
    const store = fakeStorage(null);
    (await load()).writeHidden("agent-1", true);
    expect(JSON.parse(store.get("ziki-agents-dock")!).hidden).toEqual(["agent-1"]);
    expect((await load()).readPrefs().hidden).toEqual(["agent-1"]);
    fakeStorage(JSON.stringify({ hidden: "no", looks: { a: "nonsense", b: "pixel" } }));
    const junk = (await load()).readPrefs();
    expect(junk).toMatchObject({ hidden: [], looks: { b: "pixel" } });
    expect(junk.looks.a).toBeUndefined();
    fakeStorage("not json");
    expect((await load()).readPrefs().hidden).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("still works when the browser blocks storage: the choice holds until the page reloads", async () => {
    fakeStorage(null, true);
    const { readPrefs, writeHidden } = await load();
    expect(readPrefs().hidden).toEqual([]);
    writeHidden("agent-1", true);
    expect(readPrefs().hidden).toEqual(["agent-1"]);
    expect((await load()).readPrefs().hidden).toEqual([]);
    vi.unstubAllGlobals();
  });
});

/** Your call (#your-call): how urgent an issue the agents split on is, and why. */
describe("Your call urgency", () => {
  const NOW = new Date("2026-11-03T12:00:00Z").getTime();
  const days = (n: number) => new Date(NOW + n * 24 * 60 * 60 * 1000);
  /** A project's open issues as the database counts them: one row per importance value. */
  const spread = (values: number[]) => [...new Set(values)].map((importance) => ({ importance, count: values.filter((v) => v === importance).length }));
  const yardsticks = yardsticksFor(spread([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
  const issue = (over: Partial<UrgencySignals>): UrgencySignals => ({ isBoosted: false, importance: 0, milestone: null, since: days(-1), ...over });

  it("is Critical when boosted, due soon or overdue, or among the most important, and says why", () => {
    expect(urgencyOf(issue({ isBoosted: true }), yardsticks, NOW)).toEqual({ urgency: "critical", reasons: ["Boosted"] });
    expect(urgencyOf(issue({ milestone: { title: "Beta", dueDate: days(3) } }), yardsticks, NOW).reasons).toEqual(["Milestone Beta due in 3 days"]);
    expect(urgencyOf(issue({ milestone: { title: "Beta", dueDate: days(-2) } }), yardsticks, NOW).reasons).toEqual(["Milestone Beta overdue"]);
    expect(urgencyOf(issue({ milestone: { title: "Beta", dueDate: days(30) } }), yardsticks, NOW).urgency).toBe("low");
    expect(urgencyOf(issue({ importance: 10 }), yardsticks, NOW).urgency).toBe("critical");
  });

  it("is High for high importance or a long split, Medium for any marks, and Low otherwise", () => {
    expect(urgencyOf(issue({ importance: 8 }), yardsticks, NOW).urgency).toBe("high");
    expect(urgencyOf(issue({ since: days(-9) }), yardsticks, NOW)).toEqual({ urgency: "high", reasons: ["Split for 9 days"] });
    expect(urgencyOf(issue({ importance: 2 }), yardsticks, NOW).urgency).toBe("medium");
    expect(urgencyOf(issue({}), yardsticks, NOW).urgency).toBe("low");
  });

  it("never makes nearly every issue Critical when most share one value (95 issues on 1 mark, 5 on 2)", () => {
    const crowd = spread([...Array(95).fill(1), ...Array(5).fill(2)]);
    expect(topShare(crowd, 0.1)).toBe(2);
    expect(topShare(crowd, 0.3)).toBe(2);
    const yard = yardsticksFor(crowd);
    expect(urgencyOf(issue({ importance: 1 }), yard, NOW).urgency).toBe("medium");
    expect(urgencyOf(issue({ importance: 2 }), yard, NOW).urgency).toBe("critical");
    // Everyone on the same mark: nothing stands out, so nothing is Critical or High.
    expect(topShare(spread(Array(100).fill(1)), 0.1)).toBe(0);
    // Issues with nothing marked count towards the project's work but never qualify.
    expect(topShare(spread([...Array(90).fill(0), ...Array(10).fill(1)]), 0.1)).toBe(1);
    expect(topShare(spread([...Array(50).fill(0), ...Array(50).fill(1)]), 0.1)).toBe(0);
  });

  it("judges against the project's own work, so a project with nothing marked has no Critical issue", () => {
    expect(urgencyOf(issue({ importance: 5 }), yardsticksFor([]), NOW).urgency).toBe("medium");
  });
});

/** Your call (#your-call): what a person's plain answer sends to the agents, and who may give it. */
describe("Your call answers", () => {
  const posted = () => (vi.mocked(addCommentAction).mock.calls.at(-1)![1] as FormData).get("body") as string;
  const issue = (over: Record<string, unknown> = {}) => ({ reporterId: "dave", beneficiaryUserId: "dave", substatus: "requires_confirmation", ...over });

  beforeEach(() => {
    vi.mocked(addCommentAction).mockClear();
    bugFindFirst.mockResolvedValue(issue());
  });

  it("posts a yes or a no as a comment that starts with the decision line, with the note after it", async () => {
    expect(await answerYourCallAction("bug-1", "confirm", "yes", "  Keep it simple.  ")).toEqual({ ok: true });
    expect(posted()).toBe("**Decision from the owner:** Yes, this is a real problem. Please go ahead and fix it.\n\nKeep it simple.");
    bugFindFirst.mockResolvedValue(issue({ substatus: "requires_review" }));
    await answerYourCallAction("bug-1", "merge", "no", "");
    expect(posted()).toBe("**Decision from the owner:** No, the fix is not ready yet. Please do not merge it.");
  });

  it("is only for the person the issue is for or an admin, and only while the agents are still split", async () => {
    bugFindFirst.mockResolvedValue(issue({ reporterId: "ann", beneficiaryUserId: "ann" }));
    expect(await answerYourCallAction("bug-1", "confirm", "yes", "")).toEqual({ error: "Only the person this issue is for, or an admin, can answer for it." });
    expect(addCommentAction).not.toHaveBeenCalled();
    vi.mocked(currentOrganisationAccess).mockResolvedValueOnce({ membershipRole: "admin" } as never);
    expect(await answerYourCallAction("bug-1", "confirm", "yes", "")).toEqual({ ok: true });
    bugFindFirst.mockResolvedValue(issue({ substatus: "open" }));
    expect(await answerYourCallAction("bug-1", "confirm", "yes", "")).toEqual({ error: "The agents are no longer split on this one." });
    bugFindFirst.mockResolvedValue(null);
    expect(await answerYourCallAction("gone", "confirm", "yes", "")).toEqual({ error: "Issue not found" });
  });

  it("refuses anything but yes or no, and tells the person if the comment could not be posted", async () => {
    expect(await answerYourCallAction("bug-1", "confirm", "maybe" as never, "")).toEqual({ error: "Pick yes or no." });
    expect(addCommentAction).not.toHaveBeenCalled();
    vi.mocked(addCommentAction).mockResolvedValueOnce({ error: "Issue not found" });
    expect(await answerYourCallAction("bug-1", "confirm", "no", "")).toEqual({ error: "Issue not found" });
  });

  it("reads an answer back only from a decision comment, in the words it was posted with", () => {
    expect(answerFrom("confirm", "**Decision from the owner:** Yes, this is a real problem. Please go ahead and fix it.")).toBe("yes");
    expect(answerFrom("confirm", "**Decision from the owner:** No, leave it. Please do not work on this.\n\nBecause.")).toBe("no");
    expect(answerFrom("merge", "**Decision from the owner:** Yes, the fix is ready. Please go ahead and merge it.")).toBe("yes");
    expect(answerFrom("merge", "**Decision from the owner:** Yes, this is a real problem. Please go ahead and fix it.")).toBeNull();
    expect(answerFrom("confirm", "Decision from the owner: Yes, this is a real problem. Please go ahead and fix it.")).toBeNull();
  });
});

/** Your call (#your-call): which issues a person sees and what counts as the agents splitting. */
describe("Your call list", () => {
  const T = (minutes: number) => new Date(Date.UTC(2026, 10, 3, 12, minutes));
  const PR = "https://github.com/acme/web/pull/1";
  const verdict = (over: Record<string, unknown>) => ({
    goodToMerge: true, summary: "Looks fine.", pullRequestUrl: PR, headSha: "head2", createdAt: T(1), changedAt: null, updatedAt: T(1),
    agentId: "a1", onBehalfOfUserId: "tess", agent: { name: "Tess's agent", ownerUserId: "tess" }, ...over,
  });
  const decision = (authorId: string, at: number) => ({ authorId, body: "**Decision from the owner:** Yes, the fix is ready. Please go ahead and merge it.", createdAt: T(at) });
  const issue = (over: Record<string, unknown> = {}) => ({
    id: "bug-9", number: 9, title: "Fix the header", summary: null, substatus: "requires_review", pullRequestUrl: PR, pullRequestHeadSha: "head2", updatedAt: T(0),
    voteCount: 0, isBoosted: false, reporterId: "dave", beneficiaryUserId: "dave", milestone: null, project: { slug: "acme", organisation: { slug: "zedu" } },
    deliveries: [{ beneficiaryUserId: "carl", pullRequestUrl: PR }], comments: [],
    testVerdicts: [verdict({}), verdict({ goodToMerge: false, agentId: "a2", onBehalfOfUserId: "ben", agent: { name: "Ben's agent", ownerUserId: "ben" }, createdAt: T(5), updatedAt: T(5) })],
    confirmations: [], ...over,
  });
  const load = async (issues: unknown[], viewer = { userId: "dave", isAdmin: false }) => {
    findMany.mockResolvedValueOnce(issues as never);
    const real = await vi.importActual<typeof import("@/lib/your-call")>("@/lib/your-call");
    return real.loadYourCall("p1", viewer);
  };

  it("asks only for the issues the person filed, or every issue for an admin", async () => {
    await load([]);
    expect(findMany.mock.calls.at(-1)![0].where).toMatchObject({ OR: [{ reporterId: "dave" }, { beneficiaryUserId: "dave" }] });
    await load([], { userId: "root", isAdmin: true });
    expect(findMany.mock.calls.at(-1)![0].where).not.toHaveProperty("OR");
  });

  it("lists a report only when its confirmations split, asks for neutral ones to be left out, and shows nothing when they agree", async () => {
    const confirmation = (verdict: string, agentId: string, at: number) => ({ verdict, summary: "Checked.", createdAt: T(at), agentId, agent: { name: `${agentId}'s agent` } });
    const report = (confirmations: unknown[]) => issue({ substatus: "requires_confirmation", pullRequestUrl: null, pullRequestHeadSha: null, testVerdicts: [], deliveries: [], confirmations });
    expect(await load([report([confirmation("confirm", "a", 1), confirmation("confirm", "b", 2)])])).toHaveLength(0);
    expect(await load([report([confirmation("reject", "a", 1), confirmation("reject", "b", 2)])])).toHaveLength(0);
    const [item] = await load([report([confirmation("confirm", "a", 1), confirmation("reject", "b", 2)])]);
    expect(item).toMatchObject({ kind: "confirm", number: 9 });
    expect(item!.yes).toHaveLength(1);
    expect(item!.no).toHaveLength(1);
    // Neutral confirmations never reach the list: the query leaves them out.
    const select = findMany.mock.calls.at(-1)![0].select.confirmations;
    expect(select.where).toEqual({ undoneAt: null, verdict: { in: ["confirm", "reject"] } });
  });

  it("lists a fix only when judgements on its current commit split, leaving out old commits and the people who delivered it", async () => {
    expect(await load([issue()])).toHaveLength(1);
    // A verdict on an earlier pull request link says nothing about this one.
    const otherLink = issue({ testVerdicts: [verdict({}), verdict({ goodToMerge: false, pullRequestUrl: "https://github.com/acme/web/pull/0", agentId: "a2", onBehalfOfUserId: "ben", agent: { name: "Ben's agent", ownerUserId: "ben" } })] });
    expect(await load([otherLink])).toHaveLength(0);
    const oldCommit = issue({ testVerdicts: [verdict({}), verdict({ goodToMerge: false, headSha: "head1", agentId: "a2", onBehalfOfUserId: "ben", agent: { name: "Ben's agent", ownerUserId: "ben" } })] });
    expect(await load([oldCommit])).toHaveLength(0);
    const byDeliverer = issue({ testVerdicts: [verdict({}), verdict({ goodToMerge: false, agentId: "a3", onBehalfOfUserId: "carl", agent: { name: "Carl's agent", ownerUserId: "carl" } })] });
    expect(await load([byDeliverer])).toHaveLength(0);
  });

  it("counts a changed verdict from when it changed", async () => {
    const changed = issue({ testVerdicts: [verdict({ createdAt: T(1), changedAt: T(9) }), verdict({ goodToMerge: false, agentId: "a2", onBehalfOfUserId: "ben", agent: { name: "Ben's agent", ownerUserId: "ben" }, createdAt: T(5) })] });
    const [item] = await load([changed]);
    expect(item!.since).toEqual(T(9));
  });

  it("takes an answer only from the viewer or the person the issue is for, given after the split", async () => {
    const [none] = await load([issue({ comments: [decision("mallory", 20)] })]);
    expect(none!.answer).toBeNull();
    const [early] = await load([issue({ comments: [decision("dave", 2)] })]);
    expect(early!.answer).toBeNull();
    const [answered] = await load([issue({ comments: [decision("dave", 20)] })]);
    expect(answered!.answer).toBe("yes");
  });
});

describe("the marketing tasks board", () => {
  const ROW = {
    id: "task-1", number: 41, title: "Write the launch post", href: "/acme/41", status: "open", substatus: "open", closeReason: null,
    importance: 0, reward: 4, rewardEstimates: 2, rewardFixed: false, typeName: "Blog post", agentName: null, work: null, offeredTo: null,
    revision: null, bids: 2, comments: 0, updatedAt: new Date("2026-11-01T10:00:00Z"),
  } satisfies TaskRow;
  
  function renderBoard(board: Partial<TasksBoardData> = {}) {
    return clean(renderToStaticMarkup(
      <TasksBoard slug={projectRef("acme", "acme")} board={{
        tab: taskTab("open"),
        counts: { ideas: 2, open: 1, "in-progress": 4, closed: 1, done: 3, live: 2 },
        sortParam: null,
        list: { kind: "tasks", rows: [ROW], sort: "importance" },
        pagination: { page: 1, totalPages: 1, totalCount: 1, from: 1, to: 1 },
        ...board,
      }} />,
    ));
  }

  it("opens each task on the shared issue route, ready for bids with no confirmation step", () => {
    const html = renderBoard();
    expect(html).toContain('href="/acme/41"');
    expect(html).toContain("2 bids");
    expect(html).not.toContain("Awaiting Confirmation");
  });

  it("shows the three stages across the top, each counting its own steps, with Merge left out", () => {
    const nav = stages(renderBoard());
    expect(counted(nav)).toEqual({ Ideas: 2, "In Progress": 6, Delivered: 5 });
    expect(current(nav)).toEqual(["In Progress"]);
  });

  it("lists a stage's lifecycle steps down the left", () => {
    const inProgress = statusList(renderBoard());
    expect(links(inProgress).map(labelOf)).toEqual(["Open", "In progress", "Closed"]);
    expect(current(inProgress)).toEqual(["Open"]);
    const delivered = statusList(renderBoard({ tab: taskTab("live") }));
    expect(links(delivered).map(labelOf)).toEqual(["Done", "Live"]);
    expect(current(delivered)).toEqual(["Live"]);
  });

  it("has no lifecycle steps under Ideas", () => {
    const html = renderBoard({ tab: taskTab("ideas"), list: { kind: "proposals", sort: "score", ideas: [] } });
    expect(statusList(html)).toBe("");
    expect(current(stages(html))).toEqual(["Ideas"]);
  });

  it("lists proposals as ideas, each opening its idea page", () => {
    const html = renderBoard({
      tab: taskTab("ideas"),
      list: { kind: "proposals", sort: "score", ideas: [{
        id: "idea-1", number: 12, title: "A launch post", score: 2, threshold: 3, createdAt: new Date("2026-11-01T10:00:00Z"),
        reporterName: "Rita", verdicts: 2, good: 3, badVotes: 1,
      }] },
    });
    expect(html).toContain('href="/acme/acme/ideas/12"');
  });

  it("says why a tab is empty instead of showing an empty list", () => {
    expect(renderBoard({ list: { kind: "tasks", rows: [], sort: "importance" }, pagination: { page: 1, totalPages: 1, totalCount: 0, from: 0, to: 0 } })).toContain("No open tasks.");
  });

  it("keeps the tab and sort when paging", () => {
    const html = renderBoard({ sortParam: "reward", pagination: { page: 1, totalPages: 2, totalCount: 30, from: 1, to: 25 } }).replaceAll("&amp;", "&");
    expect(html).toContain("/acme/acme/marketing/tasks?status=open&sort=reward&page=2");
  });
});

describe("the issue list's track filter (M-UI-8)", () => {
  it("lists, and searches, only marketing issues when asked", async () => {
    indexedSearch.mockResolvedValue({ found: 1, hits: [{ id: "bug-1", kind: "bug", score: 10 }] });
    await renderList({ q: "launch", status: "all", track: "marketing" });
    expect(indexedSearch).toHaveBeenCalledWith(expect.objectContaining({ kind: "bug", track: "marketing" }));
    // The first query lists the rows; a later one only reads their descriptions by id.
    expect(findMany.mock.calls[0]![0].where.track).toBe("marketing");
  });

  it("names no track when asked for all work", async () => {
    indexedSearch.mockResolvedValue({ found: 1, hits: [{ id: "bug-1", kind: "bug", score: 10 }] });
    await renderList({ q: "launch", status: "all", track: "all" });
    expect(indexedSearch.mock.calls.at(-1)![0]).not.toHaveProperty("track");
    expect(findMany.mock.calls[0]![0].where.organisationId).toBe("organisation-acme");
    expect(findMany.mock.calls[0]![0].where).not.toHaveProperty("track");
  });
});

describe("keeping marketing work out of the product list", () => {
  it("lists and counts only product issues", async () => {
    await renderList({ status: "open" });
    expect(findMany.mock.calls.at(-1)![0].where.track).toBe("product");
    const statusTabs = groupBy.mock.calls.find(([args]) => args.by.includes("status"));
    expect(statusTabs![0].where).toMatchObject({ track: "product" });
  });

  it("lists and counts only product ideas", async () => {
    await renderList();
    expect(ideaFindMany.mock.calls.at(-1)![0].where.track).toBe("product");
    expect(ideaCount.mock.calls.at(-1)![0].where.track).toBe("product");
  });
});
