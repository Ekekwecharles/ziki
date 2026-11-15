import { beforeEach, describe, expect, it, vi } from "vitest";

/** Bids (#issue-bids, #745): who may bid, one open bid per agent, withdrawing and bidding again. */
const db = vi.hoisted(() => {
  const mock = {
    bug: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    bugActivity: { createMany: vi.fn(), create: vi.fn() },
    issueBid: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    issueClaim: { findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn(), create: vi.fn(), update: vi.fn() },
    pointEntry: { findMany: vi.fn() },
    bidVote: { findMany: vi.fn(), deleteMany: vi.fn() },
    agent: { findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() },
    projectWorkflow: { findUnique: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  mock.$transaction.mockImplementation((fn: (tx: typeof mock) => unknown) => fn(mock));
  return mock;
});
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/agent-api/confirmations", () => ({ isConfirmed: vi.fn(async () => true) }));
vi.mock("@/lib/redesigns", () => ({ assertRedesignOpen: vi.fn(async () => undefined) }));
vi.mock("@/lib/agent-api/events", () => ({ publish: vi.fn(async () => ({ id: "evt" })) }));
vi.mock("@/lib/watch", () => ({ ensureWatching: vi.fn(async () => undefined) }));
vi.mock("@/lib/agents/membership", () => ({ isAdminOfOrganisation: vi.fn(async () => false) }));
vi.mock("@/lib/agent-notifications", () => ({ notifyClaimOffered: vi.fn() }));
vi.mock("@/lib/agent-api/offer", async (original) => ({
  ...await original<typeof import("@/lib/agent-api/offer")>(),
  scheduleOfferExpiry: vi.fn(),
}));

import { isConfirmed } from "@/lib/agent-api/confirmations";
import { publish } from "@/lib/agent-api/events";
import { parseBid, placeBid, withdrawBid } from "@/lib/agent-api/bid";
import { bidderRecordsForBids } from "@/lib/bidder-record-data";
import { summarizeBidderRecord, type BidderOutcomeEvent } from "@/lib/bidder-record";
import { resetWorkflowCache } from "@/lib/workflow";

const caller = {
  agentId: "agent1",
  name: "Ada's Claude",
  ownerId: "ada",
  organisationId: "organisation",
  level: "working" as const,
  burst: false,
  keyId: "key1",
};

const plan = { summary: "I can fix the login.", description: "The session cookie is dropped on redirect; I will keep it and add a test." };
const placePlan = (c: Parameters<typeof placeBid>[0], project: string, ref: string) => placeBid(c, project, ref, plan);

beforeEach(() => {
  vi.clearAllMocks();
  resetWorkflowCache();
  db.$transaction.mockImplementation((fn: (tx: typeof db) => unknown) => fn(db));
  db.$queryRaw.mockResolvedValue([{ id: "issue1" }]);
  db.bug.findFirst.mockResolvedValue({ id: "issue1", projectId: "project", status: "open", substatus: "open", voteCount: 3, convertedToIssueAt: new Date("2026-10-01T00:00:00Z") });
  db.issueClaim.findFirst.mockResolvedValue(null);
  db.issueClaim.findMany.mockResolvedValue([]);
  db.issueClaim.count.mockResolvedValue(0);
  db.pointEntry.findMany.mockResolvedValue([]);
  db.agent.findMany.mockResolvedValue([]);
  db.projectWorkflow.findUnique.mockResolvedValue(null);
  db.agent.findFirst.mockResolvedValue(null);
  db.agent.findUnique.mockResolvedValue({ pausedAt: null });
  db.issueBid.updateMany.mockResolvedValue({ count: 1 });
  db.bug.updateMany.mockResolvedValue({ count: 1 });
  db.issueBid.findUnique.mockResolvedValue(null);
  db.issueBid.create.mockResolvedValue({ id: "bid1", beneficiaryUserId: "ada", summary: plan.summary });
  // By default a bid has one manager agent's vote: 3, the default awardThreshold.
  db.bidVote.findMany.mockResolvedValue([{ onBehalfOfUserId: "eve", agent: { activations: [{ organisationId: "organisation", level: "manager" }] } }]);
  vi.mocked(isConfirmed).mockResolvedValue(true);
});

describe("placeBid", () => {
  it("refuses to bid while the owner has paused the agent (#236)", async () => {
    db.agent.findUnique.mockResolvedValue({ pausedAt: new Date("2026-11-05T10:00:00Z") });
    await expect(placePlan(caller, "project", "issue1")).rejects.toMatchObject({ status: 409, message: expect.stringContaining("paused") });
    expect(db.issueBid.create).not.toHaveBeenCalled();
  });

  it("records a bid and does not claim the issue", async () => {
    const { bid, replaced } = await placeBid(caller, "project", "issue1", plan);
    expect(bid.id).toBe("bid1");
    expect(replaced).toBe(false);
    expect(db.issueClaim.create).not.toHaveBeenCalled();
    expect(db.bug.update).not.toHaveBeenCalled();
    expect(db.issueBid.create.mock.calls[0][0].data).toMatchObject({
      bugId: "issue1",
      agentId: "agent1",
      beneficiaryUserId: "ada",
      summary: plan.summary,
      description: plan.description,
      reason: null,
    });
    expect(publish).toHaveBeenCalledWith(db, expect.objectContaining({ type: "issue.bid" }));
  });

  it("takes bids on a Live · Broken issue, force-merged and judged faulty, and refuses them on other Live work (#force-merge)", async () => {
    db.bug.findFirst.mockResolvedValue({ id: "issue1", projectId: "project", status: "resolved", substatus: "merged_broken", voteCount: 3 });
    expect((await placeBid(caller, "project", "issue1", plan)).bid.id).toBe("bid1");
    db.issueBid.create.mockClear();
    for (const substatus of ["force_merged", "on_dev"]) {
      db.bug.findFirst.mockResolvedValue({ id: "issue1", projectId: "project", status: "resolved", substatus, voteCount: 3 });
      await expect(placeBid(caller, "project", "issue1", plan)).rejects.toMatchObject({ status: 409 });
    }
    expect(db.issueBid.create).not.toHaveBeenCalled();
  });

  it("bidding again replaces the agent's open bid instead of creating another", async () => {
    db.issueBid.findUnique.mockResolvedValue({ id: "bid1", awardedAt: null, withdrawnAt: null, summary: "Old.", description: "Old plan." });
    db.issueBid.update.mockResolvedValue({ id: "bid1", summary: "New plan.", description: "Better plan." });
    const result = await placeBid(caller, "project", "issue1", { summary: "New plan.", description: "Better plan." });
    expect(result).toMatchObject({ bid: { id: "bid1", summary: "New plan." }, replaced: true });
    expect(db.issueBid.update).toHaveBeenCalledWith({ where: { id: "bid1" }, data: { summary: "New plan.", description: "Better plan.", reason: null } });
    expect(db.issueBid.create).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("bidding after withdrawing reopens the same bid with the new text", async () => {
    db.issueBid.findUnique.mockResolvedValue({ id: "bid1", awardedAt: null, withdrawnAt: new Date(), summary: "Old.", description: "Old plan." });
    db.issueBid.update.mockResolvedValue({ id: "bid1", beneficiaryUserId: "ada", summary: plan.summary });
    const result = await placeBid(caller, "project", "issue1", plan);
    expect(result.replaced).toBe(false);
    expect(db.issueBid.update).toHaveBeenCalledWith({
      where: { id: "bid1" },
      data: { ...plan, reason: null, withdrawnAt: null, beneficiaryUserId: "ada" },
    });
    expect(publish).toHaveBeenCalledWith(db, expect.objectContaining({ type: "issue.bid" }));
  });

  it("bids afresh once an earlier award's hold has ended and the issue is Open again (#745)", async () => {
    const awardedAt = new Date("2026-10-30T10:00:00Z");
    db.issueBid.findUnique.mockResolvedValue({ id: "bid1", awardedAt, claimId: "old-claim", withdrawnAt: null });
    db.issueBid.update.mockResolvedValue({ id: "bid1", summary: plan.summary });
    // No live offer or claim on the issue: the old award's hold is over.
    db.issueClaim.findFirst.mockResolvedValue(null);
    const result = await placePlan(caller, "project", "issue1");
    expect(result).toMatchObject({ bid: { id: "bid1" }, replaced: false });
    expect(db.issueBid.update).toHaveBeenCalledWith({
      where: { id: "bid1" },
      data: expect.objectContaining({ awardedAt: null, claimId: null, withdrawnAt: null, summary: plan.summary }),
    });
    // The old round's votes don't carry over to the new bid.
    expect(db.bidVote.deleteMany).toHaveBeenCalledWith({ where: { bidId: "bid1" } });
    expect(db.issueBid.create).not.toHaveBeenCalled();
  });

  it("still refuses a rebid while the awarded offer or claim is live (#745)", async () => {
    db.issueBid.findUnique.mockResolvedValue({ id: "bid1", awardedAt: new Date(), claimId: "claim", withdrawnAt: null });
    db.issueClaim.findFirst.mockResolvedValue({ id: "claim", status: "active", offeredAt: null, bug: { organisationId: "organisation", projectId: "project" } });
    await expect(placePlan(caller, "project", "issue1")).rejects.toMatchObject({ status: 409 });
    db.issueClaim.findFirst.mockResolvedValue({ id: "claim", status: "offered", offeredAt: new Date(), bug: { organisationId: "organisation", projectId: "project" } });
    await expect(placePlan(caller, "project", "issue1")).rejects.toMatchObject({ status: 409 });
    expect(db.issueBid.update).not.toHaveBeenCalled();
    expect(db.bidVote.deleteMany).not.toHaveBeenCalled();
  });

  it("takes a bid while the issue awaits confirmation, and refuses one while it is already being worked", async () => {
    vi.mocked(isConfirmed).mockResolvedValue(false);
    await expect(placePlan(caller, "project", "issue1")).resolves.toMatchObject({ replaced: false });
    db.issueBid.create.mockClear();
    vi.mocked(isConfirmed).mockResolvedValue(true);
    db.issueClaim.findFirst.mockResolvedValue({ id: "claim", status: "active", offeredAt: null, bug: { organisationId: "organisation", projectId: "project" } });
    await expect(placePlan(caller, "project", "issue1")).rejects.toMatchObject({ status: 409 });
    db.issueClaim.findFirst.mockResolvedValue({ id: "offer", status: "offered", offeredAt: new Date(), bug: { organisationId: "organisation", projectId: "project" } });
    await expect(placePlan(caller, "project", "issue1")).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("pending offer"),
    });
    expect(db.issueBid.create).not.toHaveBeenCalled();
  });
});

describe("parseBid (#issue-bids)", () => {

  it.each([
    [{}, "summary"],
    [{ summary: "I will fix it." }, "description"],
    [{ description: "Plan." }, "summary"],
    [{ summary: "", description: "Plan." }, "summary"],
    [{ summary: "One. Two. Three.", description: "Plan." }, "summary"],
    [{ summary: "x".repeat(301), description: "Plan." }, "summary"],
    [{ summary: "S.", description: "x".repeat(10_001) }, "description"],
  ])("refuses a bare or oversized bid %j with a 400 naming %s", (body, field) => {
    expect(() => parseBid(body)).toThrow(expect.objectContaining({ status: 400, body: expect.objectContaining({ field }) }));
  });

  it("refuses an unknown field, naming summary and description", () => {
    expect(() => parseBid({ note: "I can fix it" })).toThrow(expect.objectContaining({
      status: 400,
      body: expect.objectContaining({ message: expect.stringContaining("summary") }),
    }));
  });

  it("stores a valid optional reason and refuses an oversized one", () => {
    expect(parseBid({ ...plan, reason: "I found the failing path." }).reason).toBe("I found the failing path.");
    expect(() => parseBid({ ...plan, reason: "x".repeat(141) })).toThrow(expect.objectContaining({ status: 400 }));
  });
});

describe("withdrawBid", () => {
  it("withdraws the caller's open bid", async () => {
    db.issueBid.findUnique.mockResolvedValue({
      id: "bid1",
      awardedAt: null,
      withdrawnAt: null,
      bug: { organisationId: "organisation", projectId: "project", isDeleted: false },
    });
    await withdrawBid(caller, "project", "issue1");
    expect(db.issueBid.updateMany.mock.calls[0][0].data.withdrawnAt).toBeInstanceOf(Date);
    expect(publish).toHaveBeenCalledWith(db, expect.objectContaining({ type: "issue.bid_withdrawn" }));
  });
});

describe("bidder records (#825)", () => {
  const at = (day: number) => new Date(`2026-10-${String(day).padStart(2, "0")}T12:00:00Z`);
  const event = (overrides: Partial<BidderOutcomeEvent>): BidderOutcomeEvent => ({
    issueId: "issue1",
    issueNumber: 1,
    title: "Fix login",
    path: "/zedu/ziki/1",
    outcome: "finished",
    at: at(1),
    areaId: "area-auth",
    agentId: "agent1",
    ...overrides,
  });
  const agents = [{ id: "agent1", name: "Ada's Claude", username: "adas-claude" }];

  it("counts each issue once, with finished beating a drop of the same issue", () => {
    const record = summarizeBidderRecord(
      [
        event({}),
        event({ outcome: "dropped", at: at(2) }),
        event({ issueId: "issue2", issueNumber: 2, path: "/zedu/ziki/2", outcome: "dropped", at: at(3) }),
        event({ issueId: "issue3", issueNumber: 3, path: "/zedu/ziki/3", outcome: "dropped", at: at(4) }),
      ],
      agents,
      { id: "area-auth", name: "Auth" },
    );
    expect(record.finished).toBe(1);
    expect(record.dropped).toBe(2);
    expect(record.finishRate).toBe(33);
    expect(record.newHere).toBe(false);
    expect(record.areaFixes).toBe(1);
  });

  it("shows only the last ten tasks, newest first, and counts the form from them", () => {
    const events = Array.from({ length: 12 }, (_, index) =>
      event({
        issueId: `issue${index}`,
        issueNumber: index + 1,
        path: `/zedu/ziki/${index + 1}`,
        outcome: index === 5 ? "dropped" : "finished",
        at: at(index + 1),
      }),
    );
    const record = summarizeBidderRecord(events, agents, null);
    expect(record.recent).toHaveLength(10);
    expect(record.recent[0]?.issueId).toBe("issue11");
    expect(record.recentFinished).toBe(9);
    expect(record.finished).toBe(11);
    expect(record.dropped).toBe(1);
  });

  it("says New here under three tasks", () => {
    const record = summarizeBidderRecord(
      [event({}), event({ issueId: "issue2", issueNumber: 2, path: "/zedu/ziki/2" })],
      agents,
      null,
    );
    expect(record.newHere).toBe(true);
  });

  it("loads every bid owner's record in organisation-scoped batched queries", async () => {
    db.pointEntry.findMany.mockResolvedValue([
      {
        userId: "ada",
        agentId: "agent1",
        createdAt: at(3),
        bug: { id: "bug1", number: 1, title: "Fix login", organisationId: "organisation", areaId: "area-auth", isDeleted: false, project: { slug: "ziki", organisation: { slug: "zedu" } } },
      },
      {
        userId: "ada",
        agentId: "agent1",
        createdAt: at(2),
        bug: { id: "foreign", number: 9, title: "Elsewhere", organisationId: "other", areaId: null, isDeleted: false, project: { slug: "ziki", organisation: { slug: "other" } } },
      },
    ]);
    db.issueClaim.findMany.mockResolvedValue([
      {
        beneficiaryUserId: "ada",
        agentId: "agent1",
        releasedAt: at(4),
        bug: { id: "bug2", number: 2, title: "Old task", areaId: "area-auth", project: { slug: "ziki", organisation: { slug: "zedu" } } },
      },
    ]);
    db.agent.findMany.mockResolvedValue([
      { id: "agent1", ownerUserId: "ada", name: "Ada's Claude", username: "adas-claude" },
    ]);

    const records = await bidderRecordsForBids(
      { organisationId: "organisation", areaId: "area-auth", areaName: "Auth" },
      [{ beneficiaryUserId: "ada" }, { beneficiaryUserId: "ada" }],
    );

    expect(db.pointEntry.findMany).toHaveBeenCalledTimes(1);
    expect(db.issueClaim.findMany).toHaveBeenCalledTimes(1);
    expect(db.agent.findMany).toHaveBeenCalledTimes(1);
    expect(db.pointEntry.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        organisationId: "organisation",
        userId: { in: ["ada"] },
        role: "solver",
        points: { gt: 0 },
        correctedAt: null,
        sourceKey: { not: { startsWith: "multiplier:" } },
      }),
    }));
    expect(db.issueClaim.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        releaseReason: { in: ["silence", "deadline", "abandoned"] },
        bug: { organisationId: "organisation", isDeleted: false },
      }),
    }));

    const record = records.get("ada")!;
    expect(record.finished).toBe(1);
    expect(record.dropped).toBe(1);
    expect(record.areaFixes).toBe(1);
    expect(record.recent.map((task) => task.path)).toEqual(["/zedu/ziki/2", "/zedu/ziki/1"]);
    expect(record.agents).toEqual([
      { id: "agent1", name: "Ada's Claude", username: "adas-claude", finished: 1, dropped: 1 },
    ]);
  });
});
