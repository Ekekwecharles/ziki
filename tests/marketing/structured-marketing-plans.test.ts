import { beforeEach, describe, expect, it, vi } from "vitest";

const allowed = vi.hoisted(() => vi.fn());
const db = vi.hoisted(() => ({
  project: { findFirst: vi.fn() },
  marketingPlan: { create: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  marketingPlanRevision: { create: vi.fn(), update: vi.fn() },
  marketingPlanActivity: { create: vi.fn(), findMany: vi.fn() },
  marketingPlanActivityRevision: { create: vi.fn(), deleteMany: vi.fn() },
  $queryRaw: vi.fn(),
  $transaction: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/project-permissions", () => ({ canContributeToProject: allowed }));

import { createMarketingPlan, getMarketingPlan, MarketingPlanStoreError, saveMarketingPlanDraft } from "@/lib/structured-marketing-plans";
import { marketingPlanStrategySchema, type MarketingPlanStrategyInput } from "@/lib/validations/structured-marketing-plan";
import type { SessionAppUser } from "@/lib/auth-helpers";

const user = { id: "member", role: "user" } as SessionAppUser;
const channelId = "3e3c95a0-a332-4c89-a17e-9d09dfb0890e";
const activityId = "5a3b76a5-af68-4d36-92f9-996e95617750";
const strategy = {
  businessSummary: { text: "A local bakery.", basis: "customer_input" as const },
  assumptions: [],
  objectives: [{ id: "d7e67193-8a47-44f9-9d20-8220ed13bd38", text: "Increase visits.", basis: "customer_input" as const }],
  audiences: [{ id: "466bbab3-c5c8-44b5-bc4c-c6c9c5c25b5d", description: "Nearby residents.", basis: "customer_input" as const }],
  channels: [{ id: channelId, name: "Email", rationale: "Reach returning customers.", basis: "recommendation" as const }],
  activities: [{
    id: activityId, channelId, title: "Monthly newsletter", description: "Send a seasonal update.", basis: "recommendation" as const, priority: "medium" as const,
    budget: { amount: null, currency: null }, suggestedStart: null, suggestedEnd: null,
    dependencies: [], expectedOutcome: "More repeat visits.", measurements: ["Redemptions"],
  }],
};
const draft = { title: "Bakery marketing plan", source: { contextId: "bishop-context-1", revision: "4" }, strategy };

beforeEach(() => {
  vi.resetAllMocks();
  allowed.mockResolvedValue(true);
  db.project.findFirst.mockResolvedValue({ id: "project", organisationId: "org" });
  db.$transaction.mockImplementation(async (run) => run(db));
  db.marketingPlan.create.mockResolvedValue({ id: "plan-1" });
  db.marketingPlanRevision.create.mockImplementation(async ({ data }) => ({
    id: `revision-${data.revision}`, revision: data.revision, version: data.version, status: data.status,
    sourceContextId: data.sourceContextId, sourceContextRevision: data.sourceContextRevision, strategy: data.strategy,
  }));
  db.marketingPlanRevision.update.mockResolvedValue({ version: 2 });
  db.marketingPlanActivity.create.mockImplementation(async ({ data }) => ({ id: data.id }));
  db.marketingPlanActivity.findMany.mockResolvedValue([{ id: activityId }]);
  db.marketingPlanActivityRevision.create.mockResolvedValue({});
  db.marketingPlanActivityRevision.deleteMany.mockResolvedValue({ count: 1 });
  db.marketingPlan.update.mockResolvedValue({});
});

describe("structured marketing plan draft persistence", () => {
  it("stores a project-scoped draft, its source reference, and stable activity ids", async () => {
    const input = structuredClone(draft);
    delete (input.strategy.activities[0] as { id?: string }).id;
    const result = await createMarketingPlan(user, "project", input);
    expect(result).toMatchObject({ planId: "plan-1", revision: 1, version: 1, source: input.source, status: "draft" });
    expect(result.strategy.activities[0].id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(db.marketingPlan.create).toHaveBeenCalledWith({ data: { projectId: "project", creatorId: "member", title: input.title }, select: { id: true } });
    expect(db.marketingPlanRevision.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      planId: "plan-1", revision: 1, status: "draft", sourceContextId: "bishop-context-1", sourceContextRevision: "4",
    }), select: expect.any(Object) });
    expect(db.marketingPlanActivityRevision.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      revisionId: "revision-1", activityId: result.strategy.activities[0].id, position: 0,
    }) }));
  });

  it("rejects a user without project access before any write", async () => {
    allowed.mockResolvedValue(false);
    await expect(createMarketingPlan(user, "project", draft)).rejects.toMatchObject({ status: 404 });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("updates a draft with optimistic versioning and retains the activity identity", async () => {
    db.marketingPlan.findFirst.mockResolvedValue({ id: "plan-1", currentRevision: 1, revisions: [{ id: "revision-1", revision: 1, version: 1, status: "draft", activities: [{ activityId }] }] });
    const result = await saveMarketingPlanDraft(user, "project", "plan-1", { ...draft, expectedRevision: 1, expectedVersion: 1 });
    expect(result).toMatchObject({ planId: "plan-1", revision: 1, version: 2, status: "draft" });
    expect(result.strategy.activities[0].id).toBe(activityId);
    expect(db.marketingPlanRevision.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "revision-1" }, data: expect.objectContaining({ version: { increment: 1 } }) }));
    expect(db.marketingPlanActivityRevision.deleteMany).toHaveBeenCalledWith({ where: { revisionId: "revision-1" } });
  });

  it("rejects stale writes without changing the revision", async () => {
    db.marketingPlan.findFirst.mockResolvedValue({ id: "plan-1", currentRevision: 1, revisions: [{ id: "revision-1", revision: 1, version: 2, status: "draft", activities: [] }] });
    await expect(saveMarketingPlanDraft(user, "project", "plan-1", { ...draft, expectedRevision: 1, expectedVersion: 1 }))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining("changed") });
    expect(db.marketingPlanRevision.update).not.toHaveBeenCalled();
    expect(db.marketingPlanActivityRevision.create).not.toHaveBeenCalled();
  });

  it("starts a new draft revision after approval and leaves the approved revision intact", async () => {
    db.marketingPlan.findFirst.mockResolvedValue({ id: "plan-1", currentRevision: 2, revisions: [{ id: "revision-2", revision: 2, version: 3, status: "approved", activities: [{ activityId }] }] });
    const result = await saveMarketingPlanDraft(user, "project", "plan-1", { ...draft, expectedRevision: 2, expectedVersion: 3 });
    expect(result).toMatchObject({ revision: 3, version: 1, status: "draft" });
    expect(db.marketingPlanRevision.create).toHaveBeenCalledWith({ data: expect.objectContaining({ revision: 3, status: "draft", createdById: "member" }), select: expect.any(Object) });
    expect(db.marketingPlan.update).toHaveBeenCalledWith({ where: { id: "plan-1" }, data: { title: draft.title, currentRevision: 3 } });
    expect(db.marketingPlanActivityRevision.deleteMany).not.toHaveBeenCalled();
  });

  it("does not let a draft attach an activity identity from another plan", async () => {
    db.marketingPlan.findFirst.mockResolvedValue({ id: "plan-1", currentRevision: 1, revisions: [{ id: "revision-1", revision: 1, version: 1, status: "draft", activities: [] }] });
    db.marketingPlanActivity.findMany.mockResolvedValue([]);
    await expect(saveMarketingPlanDraft(user, "project", "plan-1", { ...draft, expectedRevision: 1, expectedVersion: 1 }))
      .rejects.toMatchObject({ status: 422 });
    expect(db.marketingPlanActivityRevision.create).not.toHaveBeenCalled();
  });

  it("scopes reads to the project and preserves revision snapshots", async () => {
    db.marketingPlan.findFirst.mockResolvedValue({
      id: "plan-1", title: draft.title, currentRevision: 2, createdAt: new Date(), updatedAt: new Date(),
      revisions: [{ id: "revision-2", revision: 2, version: 1, status: "draft", sourceContextId: "ctx", sourceContextRevision: "5", strategy, createdAt: new Date(), updatedAt: new Date(), activities: [{ activityId, position: 0, content: {
        channelId, title: "Monthly newsletter", description: "Send a seasonal update.", priority: "medium",
        budget: { amount: null, currency: null }, suggestedStart: null, suggestedEnd: null,
        dependencies: [], expectedOutcome: "More repeat visits.", measurements: ["Redemptions"],
      } }] }],
    });
    const result = await getMarketingPlan(user, "project", "plan-1");
    expect(db.marketingPlan.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "plan-1", projectId: "project" } }));
    expect(result.revisions[0].strategy.activities[0].id).toBe(activityId);
  });
});

describe("structured marketing plan validation", () => {
  it("rejects duplicate activity ids, unknown channels, invalid budgets, and reversed dates", () => {
    const duplicate = structuredClone(strategy);
    duplicate.activities.push({ ...duplicate.activities[0] });
    expect(marketingPlanStrategySchema.safeParse(duplicate).success).toBe(false);
    const unknownChannel = structuredClone(strategy);
    unknownChannel.activities[0].channelId = "46d9657a-c486-4b3c-9cf1-0c2b1d3a10c7";
    expect(marketingPlanStrategySchema.safeParse(unknownChannel).success).toBe(false);
    const invalidBudget = structuredClone(strategy) as MarketingPlanStrategyInput;
    invalidBudget.activities[0].budget = { amount: 10, currency: null };
    expect(marketingPlanStrategySchema.safeParse(invalidBudget).success).toBe(false);
    const reversed = structuredClone(strategy) as MarketingPlanStrategyInput;
    reversed.activities[0].suggestedStart = "2026-05-10";
    reversed.activities[0].suggestedEnd = "2026-05-01";
    expect(marketingPlanStrategySchema.safeParse(reversed).success).toBe(false);
  });

  it("uses a distinct store error for missing plans", () => {
    expect(new MarketingPlanStoreError("missing", 404)).toMatchObject({ status: 404, message: "missing" });
  });
});
