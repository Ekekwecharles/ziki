import { beforeEach, describe, expect, it, vi } from "vitest";

const assertMarketingSettingsAccess = vi.hoisted(() => vi.fn());
const db = vi.hoisted(() => ({
  project: { findFirst: vi.fn() }, marketingPlan: { findFirst: vi.fn() },
  marketingPlanRevision: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  marketingPlanActivityRevision: { findUnique: vi.fn() },
  marketingPlanActivityDecision: { findUnique: vi.fn(), upsert: vi.fn() },
  marketingPlanActivityDecisionEvent: { create: vi.fn() },
  $queryRaw: vi.fn(), $transaction: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/marketing/settings", () => ({ assertMarketingSettingsAccess }));

import { decideMarketingActivity, finalizeMarketingPlanRevision } from "@/lib/marketing-plan-approval";

const user = { id: "owner", role: "user" } as never;
const transactionClient = {
  marketingPlan: db.marketingPlan, marketingPlanRevision: db.marketingPlanRevision,
  marketingPlanActivityRevision: db.marketingPlanActivityRevision,
  marketingPlanActivityDecision: db.marketingPlanActivityDecision,
  marketingPlanActivityDecisionEvent: db.marketingPlanActivityDecisionEvent,
  $queryRaw: db.$queryRaw,
};

beforeEach(() => {
  vi.clearAllMocks();
  db.project.findFirst.mockResolvedValue({ id: "project", organisationId: "org" });
  db.$transaction.mockImplementation((fn: (tx: typeof transactionClient) => unknown) => fn(transactionClient));
});

describe("Marketing plan approval", () => {
  it("uses organisation marketing-admin authorization before recording a decision", async () => {
    db.marketingPlan.findFirst.mockResolvedValue({ id: "plan", currentRevision: 1 });
    db.marketingPlanRevision.findFirst.mockResolvedValue({ id: "rev", version: 1, status: "draft" });
    db.marketingPlanRevision.findUnique.mockResolvedValue({ version: 1, status: "draft" });
    db.marketingPlanActivityRevision.findUnique.mockResolvedValue({ id: "activity-revision" });
    db.marketingPlanActivityDecision.findUnique.mockResolvedValue(null);
    db.marketingPlanActivityDecision.upsert.mockResolvedValue({ id: "decision" });
    const result = await decideMarketingActivity(user, "project", "plan", 1, "activity", "approved", 1);
    expect(assertMarketingSettingsAccess).toHaveBeenCalledWith(user, "org", "change");
    expect(db.marketingPlanActivityDecisionEvent.create).toHaveBeenCalledWith({ data: { decisionId: "decision", decision: "approved", actorId: "owner" } });
    expect(result).toMatchObject({ decision: "approved", idempotent: false });
  });

  it("requires at least one explicitly approved activity and confirms only approved items", async () => {
    db.marketingPlan.findFirst.mockResolvedValue({ id: "plan", currentRevision: 1 });
    db.marketingPlanRevision.findFirst.mockResolvedValue({ id: "rev", version: 1, status: "draft" });
    db.marketingPlanRevision.findUnique.mockResolvedValue({
      version: 1, status: "draft", approvedAt: null, approvedById: null,
      activities: [{ activityId: "a1" }, { activityId: "a2" }],
      decisions: [{ activityId: "a1", decision: "approved" }, { activityId: "a2", decision: "rejected" }],
    });
    const result = await finalizeMarketingPlanRevision(user, "project", "plan", 1, 1);
    expect(db.marketingPlanRevision.update).toHaveBeenCalledWith({ where: { id: "rev" }, data: expect.objectContaining({ status: "approved", approvedById: "owner" }) });
    expect(result).toMatchObject({ approvedActivities: ["a1"], idempotent: false });
  });

  it("rejects a stale approval request without updating the revision", async () => {
    db.marketingPlan.findFirst.mockResolvedValue({ id: "plan", currentRevision: 2 });
    db.marketingPlanRevision.findFirst.mockResolvedValue({ id: "rev", version: 1, status: "draft" });
    db.marketingPlanRevision.findUnique.mockResolvedValue({ version: 1, status: "draft", approvedAt: null, approvedById: null, activities: [{ activityId: "a1" }], decisions: [{ activityId: "a1", decision: "approved" }] });
    await expect(finalizeMarketingPlanRevision(user, "project", "plan", 1, 1)).rejects.toMatchObject({ status: 409 });
    expect(db.marketingPlanRevision.update).not.toHaveBeenCalled();
  });
});
