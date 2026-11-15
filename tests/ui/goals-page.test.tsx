import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The goals pages (#616): the list shows every pool with nested funded goals
 * and the create form; the detail page shows the budget figures, the split
 * wizard, and the allocation ledger with each slice's sourceKey.
 */
const requireProject = vi.hoisted(() => vi.fn());
const listGoals = vi.hoisted(() => vi.fn());
const withBudget = vi.hoisted(() => vi.fn());
const goalFindFirst = vi.hoisted(() => vi.fn());
const allocationFindMany = vi.hoisted(() => vi.fn());
const bugFindMany = vi.hoisted(() => vi.fn());
const goalFindMany = vi.hoisted(() => vi.fn());
const agentFindMany = vi.hoisted(() => vi.fn());

vi.mock("@/lib/project-route", () => ({ requireProject }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    goal: { findFirst: goalFindFirst, findMany: goalFindMany },
    goalAllocation: { findMany: allocationFindMany },
    bug: { findMany: bugFindMany },
    agent: { findMany: agentFindMany },
  },
}));
vi.mock("@/lib/goals/service", () => ({
  listGoals,
  withBudget,
  createGoalForPerson: vi.fn(),
  splitGoalPoolForPerson: vi.fn(),
  updateGoalStatusForPerson: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), back: vi.fn() }),
  usePathname: () => "/acme/orbit/goals",
}));

import { describeBudget } from "@/lib/goals/pool-split";
import { ProjectGoals } from "@/app/(app)/[org]/[project]/goals/project-goals";
import GoalDetailPage from "@/app/(app)/[org]/[project]/goals/[id]/page";

const detailParams = Promise.resolve({ org: "acme", project: "orbit", id: "goal-1" });

const context = {
  user: { id: "user-1", role: "member" },
  organisationId: "org-1",
  project: {
    id: "proj-1",
    slug: "orbit",
    name: "Orbit",
    goal: null,
    organisationId: "org-1",
    orgSlug: "acme",
    ref: { org: "acme", slug: "orbit" } as never,
    visibility: "private" as const,
    isOpenForContributors: false,
  },
  isOrgMember: true,
  isProjectMember: false,
  isOrgAdmin: false,
  canContribute: true,
};

function goalRow(overrides: Record<string, unknown> = {}, budget?: Record<string, number>) {
  const base = {
    id: "goal-1",
    organisationId: "org-1",
    projectId: "proj-1",
    createdById: "user-1",
    title: "Ship the launch",
    description: "Everything launch week.",
    budgetPool: 1000,
    allocated: 600,
    status: "active",
    createdAt: new Date("2026-11-01T09:00:00.000Z"),
    updatedAt: new Date("2026-11-09T09:00:00.000Z"),
    ...overrides,
  };
  return { ...base, budget: describeBudget(budget?.budgetPool ?? base.budgetPool as number, budget?.allocated ?? base.allocated as number) };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireProject.mockResolvedValue({ ...context });
  withBudget.mockImplementation((goal: Record<string, unknown>) => ({
    ...goal,
    budget: describeBudget(goal.budgetPool as number, goal.allocated as number),
  }));
  allocationFindMany.mockResolvedValue([]);
  bugFindMany.mockResolvedValue([]);
  goalFindMany.mockResolvedValue([]);
  agentFindMany.mockResolvedValue([]);
  goalFindFirst.mockResolvedValue(goalRow());
});

describe("goals in the project settings (#616)", () => {
  it("renders the create form and each goal's pool figures", async () => {
    listGoals.mockResolvedValue([
      goalRow({}, { budgetPool: 1000, allocated: 600 }),
      goalRow({ id: "goal-2", title: "Nested hardening", budgetPool: 0, allocated: 0 }, { budgetPool: 0, allocated: 0 }),
    ]);
    allocationFindMany.mockResolvedValue([]);

    const html = renderToStaticMarkup(await ProjectGoals({ org: "acme", organisationId: "org-1", project: { id: "proj-1", slug: "orbit", ref: context.project.ref } }));

    expect(html).toContain("create-goal-form");
    expect(html).toContain("Ship the launch");
    expect(html).toContain("goal-budget-bar");
    expect(html).toContain("1,000");
    expect(html).toContain("600");
    expect(html).toContain("400");
    expect(html).toContain("Partially split");
    expect(html).toContain("No budget");
  });

  it("nests a goal funded from its parent's pool under that parent", async () => {
    listGoals.mockResolvedValue([
      goalRow(),
      goalRow({ id: "goal-2", title: "Nested hardening", budgetPool: 400, allocated: 300 }, { budgetPool: 400, allocated: 300 }),
    ]);
    allocationFindMany.mockResolvedValue([{ goalId: "goal-1", targetGoalId: "goal-2", amount: 300 }]);

    const html = renderToStaticMarkup(await ProjectGoals({ org: "acme", organisationId: "org-1", project: { id: "proj-1", slug: "orbit", ref: context.project.ref } }));

    expect(html).toContain("goal-tree");
    expect(html).toContain("funded 300 credits by");
    expect(html).toContain("Nested hardening");
    // Both cards still carry their own budgets.
    expect(html).toContain("400");
    expect(allocationFindMany).toHaveBeenCalled();
  });

  it("shows the empty state when the project has no goals yet", async () => {
    listGoals.mockResolvedValue([]);
    const html = renderToStaticMarkup(await ProjectGoals({ org: "acme", organisationId: "org-1", project: { id: "proj-1", slug: "orbit", ref: context.project.ref } }));
    expect(html).toContain("No goals yet");
    expect(allocationFindMany).not.toHaveBeenCalled();
  });

});

describe("goal detail page (#616)", () => {
  const liveRows = [
    {
      id: "alloc-1",
      goalId: "goal-1",
      targetType: "issue",
      targetBugId: "bug-1",
      targetGoalId: null,
      targetAgentId: null,
      label: null,
      method: "even",
      amount: 200,
      sourceKey: "split-goal-1-abc:0",
      releasedAt: null,
      createdAt: new Date("2026-11-08T12:00:00.000Z"),
    },
    {
      id: "alloc-2",
      goalId: "goal-1",
      targetType: "agent",
      targetBugId: null,
      targetGoalId: null,
      targetAgentId: "agent-1",
      label: "Security audit report",
      method: "manual",
      amount: 400,
      sourceKey: "split-goal-1-abc:1",
      releasedAt: null,
      createdAt: new Date("2026-11-08T12:05:00.000Z"),
    },
  ];

  it("shows the budget figures, the split wizard, and the ledger with sourceKeys", async () => {
    allocationFindMany.mockResolvedValue(liveRows);
    bugFindMany.mockResolvedValue([
      { id: "bug-1", number: 42, title: "Fix login redirect", status: "open" },
      { id: "bug-2", number: 43, title: "Harden session cookie", status: "in_progress" },
    ]);
    goalFindMany.mockResolvedValue([{ id: "goal-2", title: "Nested hardening" }]);
    agentFindMany.mockResolvedValue([{ id: "agent-1", name: "Atlas" }]);

    const html = renderToStaticMarkup(await GoalDetailPage({ params: detailParams }));

    // Figures: 1000 pool, 600 allocated, 400 remaining.
    expect(html).toContain("goal-figures");
    expect(html).toContain("1,000");
    expect(html).toContain("600");
    expect(html).toContain("400");
    // Wizard with every picker.
    expect(html).toContain("split-wizard");
    expect(html).toContain("issue-picker");
    expect(html).toContain("agent-picker");
    expect(html).toContain("Fix login redirect");
    expect(html).toContain("Nested hardening");
    expect(html).toContain("Atlas");
    // Ledger: both rows, targets resolved, sourceKeys provenanced.
    expect(html).toContain("allocation-ledger");
    expect(html).toContain("#42 Fix login redirect");
    expect(html).toContain("Security audit report");
    expect(html).toContain("split-goal-1-abc:0");
    expect(html).toContain("split-goal-1-abc:1");
    expect(html).toContain("goal-status-controls");
  });

  it("hides the wizard and explains when the goal is closed", async () => {
    goalFindFirst.mockResolvedValue(goalRow({ status: "completed" }));
    allocationFindMany.mockResolvedValue([]);

    const html = renderToStaticMarkup(await GoalDetailPage({ params: detailParams }));

    expect(html).not.toContain("split-wizard");
    expect(html).toContain("completed, so its pool cannot be split");
    expect(html).toContain("Reopen goal");
  });

  it("404s when the goal belongs to another project", async () => {
    goalFindFirst.mockResolvedValue(null);
    await expect(GoalDetailPage({ params: detailParams })).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
