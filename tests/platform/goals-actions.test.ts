import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The web goals server actions (#616): project access, Zod validation
 * surfaces, and the IssueApiError → { ok:false, status } mapping the forms
 * display. The service layer's pool guardrails are covered in
 * goal-split-service.test.ts.
 */
const requireProject = vi.hoisted(() => vi.fn());
const createGoalForPerson = vi.hoisted(() => vi.fn());
const splitGoalPoolForPerson = vi.hoisted(() => vi.fn());
const updateGoalStatusForPerson = vi.hoisted(() => vi.fn());
const goalFindFirst = vi.hoisted(() => vi.fn());

vi.mock("@/lib/project-route", () => ({ requireProject }));
vi.mock("@/lib/goals/service", () => ({
  createGoalForPerson,
  splitGoalPoolForPerson,
  updateGoalStatusForPerson,
}));
vi.mock("@/lib/prisma", () => ({ prisma: { goal: { findFirst: goalFindFirst } } }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));

import { revalidatePath } from "next/cache";
import { createGoalAction, splitGoalAction, updateGoalStatusAction } from "@/app/actions/goals";
import { IssueApiError } from "@/lib/agent-api/errors";

const context = {
  user: { id: "user-1", role: "member" },
  organisationId: "org-1",
  project: { id: "proj-1", slug: "orbit", name: "Orbit" },
  canContribute: true,
};

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

const splitPayload = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    method: "even",
    sourceKey: "ui-test-1",
    targets: [{ targetType: "issue", targetBugId: "bug-1" }],
    ...overrides,
  });

beforeEach(() => {
  vi.clearAllMocks();
  requireProject.mockResolvedValue({ ...context });
  goalFindFirst.mockResolvedValue({ id: "goal-1" });
  createGoalForPerson.mockResolvedValue({ id: "goal-1", title: "Ship the launch", budgetPool: 1200 });
  splitGoalPoolForPerson.mockResolvedValue({
    goal: { id: "goal-1", budgetPool: 1000, allocated: 600, budget: { remaining: 400 } },
    allocations: [],
  });
  updateGoalStatusForPerson.mockResolvedValue({ id: "goal-1", status: "completed" });
});

describe("createGoalAction (#616)", () => {
  it("rejects a bad pool with 400 and per-field messages, without touching the service", async () => {
    const result = await createGoalAction(undefined, form({
      org: "acme", slug: "orbit",
      title: "", // too short
      budgetPool: "lots", // not an integer
    }));
    expect(result).toMatchObject({ ok: false, status: 400 });
    if (!result.ok) {
      expect(result.fieldErrors?.title).toBeTruthy();
      expect(result.fieldErrors?.budgetPool).toBeTruthy();
    }
    expect(createGoalForPerson).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("creates the goal in the URL's project and revalidates the goals pages", async () => {
    const result = await createGoalAction(undefined, form({
      org: "acme", slug: "orbit",
      title: "Ship the launch", description: "Everything launch week.", budgetPool: "1200",
    }));
    expect(result).toMatchObject({ ok: true, goalId: "goal-1" });
    expect(createGoalForPerson).toHaveBeenCalledWith(
      { userId: "user-1", organisationId: "org-1" },
      expect.objectContaining({ title: "Ship the launch", budgetPool: 1200, projectId: "proj-1" }),
    );
    expect(revalidatePath).toHaveBeenCalledWith("/projects/[slug]/settings", "page");
  });

  it("refuses anyone who is not a project or organisation member", async () => {
    requireProject.mockResolvedValue({ ...context, canContribute: false });
    const result = await createGoalAction(undefined, form({
      org: "acme", slug: "orbit", title: "Ship the launch", budgetPool: "1200",
    }));
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toMatch(/members/i);
    expect(createGoalForPerson).not.toHaveBeenCalled();
  });

  it("maps the service's 404 onto the result", async () => {
    createGoalForPerson.mockRejectedValue(new IssueApiError(404, "Project not found."));
    const result = await createGoalAction(undefined, form({
      org: "acme", slug: "orbit", title: "Ship the launch", budgetPool: "1200",
    }));
    expect(result).toMatchObject({ ok: false, status: 404, error: "Project not found." });
  });
});

describe("splitGoalAction (#616)", () => {
  it("answers 400 for a malformed payload", async () => {
    const result = await splitGoalAction(undefined, form({
      org: "acme", slug: "orbit", goalId: "goal-1", payload: "{not json",
    }));
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(splitGoalPoolForPerson).not.toHaveBeenCalled();
  });

  it("answers 400 with field errors when the payload fails the schema", async () => {
    const result = await splitGoalAction(undefined, form({
      org: "acme", slug: "orbit", goalId: "goal-1",
      payload: splitPayload({ targets: [] }), // must have at least one target
    }));
    expect(result).toMatchObject({ ok: false, status: 400 });
    if (!result.ok) expect(result.fieldErrors?.targets).toBeTruthy();
    expect(splitGoalPoolForPerson).not.toHaveBeenCalled();
  });

  it("answers 404 when the goal is not in the URL's project", async () => {
    goalFindFirst.mockResolvedValue(null);
    const result = await splitGoalAction(undefined, form({
      org: "acme", slug: "orbit", goalId: "goal-elsewhere", payload: splitPayload(),
    }));
    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(splitGoalPoolForPerson).not.toHaveBeenCalled();
  });

  it("surfaces the service's 409 pool conflict verbatim", async () => {
    splitGoalPoolForPerson.mockRejectedValue(
      new IssueApiError(409, "Split of 601 would over-allocate: only 600 of the 1000-credit pool is unallocated."),
    );
    const result = await splitGoalAction(undefined, form({
      org: "acme", slug: "orbit", goalId: "goal-1", payload: splitPayload(),
    }));
    expect(result).toMatchObject({ ok: false, status: 409 });
    if (!result.ok) expect(result.error).toContain("only 600 of the 1000-credit pool");
  });

  it("applies the split and reports the new allocated total", async () => {
    const result = await splitGoalAction(undefined, form({
      org: "acme", slug: "orbit", goalId: "goal-1", payload: splitPayload(),
    }));
    expect(result).toMatchObject({ ok: true, goalId: "goal-1" });
    if (result.ok) expect(result.message).toContain("600 of 1000");
    expect(splitGoalPoolForPerson).toHaveBeenCalledWith(
      { userId: "user-1", organisationId: "org-1" },
      "goal-1",
      expect.objectContaining({ method: "even", sourceKey: "ui-test-1" }),
    );
    expect(revalidatePath).toHaveBeenCalledWith("/[org]/[project]/goals/[id]", "page");
  });
});

describe("updateGoalStatusAction (#616)", () => {
  it("rejects a status outside active/completed/cancelled with 400", async () => {
    const result = await updateGoalStatusAction(undefined, form({
      org: "acme", slug: "orbit", goalId: "goal-1", status: "paused",
    }));
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(updateGoalStatusForPerson).not.toHaveBeenCalled();
  });

  it("moves the goal and revalidates both pages", async () => {
    const result = await updateGoalStatusAction(undefined, form({
      org: "acme", slug: "orbit", goalId: "goal-1", status: "completed",
    }));
    expect(result).toMatchObject({ ok: true, goalId: "goal-1" });
    expect(updateGoalStatusForPerson).toHaveBeenCalledWith(
      { userId: "user-1", organisationId: "org-1" },
      "goal-1",
      { status: "completed" },
    );
    expect(revalidatePath).toHaveBeenCalledWith("/projects/[slug]/settings", "page");
    expect(revalidatePath).toHaveBeenCalledWith("/[org]/[project]/goals/[id]", "page");
  });

  it("maps a missing goal onto 404", async () => {
    goalFindFirst.mockResolvedValue(null);
    const result = await updateGoalStatusAction(undefined, form({
      org: "acme", slug: "orbit", goalId: "goal-gone", status: "active",
    }));
    expect(result).toMatchObject({ ok: false, status: 404 });
  });
});
