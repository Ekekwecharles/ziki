import { trackRules } from "@/lib/marketing/track";
import {
  clearLeaderboardCache,
  leaderboardPeriodStart,
  paginatedOrganisationLeaderboard,
} from "@/lib/points/leaderboard";
import { describe, expect, it, vi } from "vitest";

// #pr-reports: whether a pull request was closed without merging is the latest
// agent report on it; Ziki never asks GitHub.
/** Who gets which points (#428, #642): the solver, the dispatcher and reviewers each get the right award, and nobody is paid for work that wasn't merged. */
const reports = vi.hoisted(() => ({
  reportedClosedUnmerged: vi.fn(async (_bugId: string, url?: string | null) => url?.includes("closed") ?? false),
}));
vi.mock("@/lib/agent-api/pull-request-report", () => ({
  reportedClosedUnmerged: reports.reportedClosedUnmerged,
}));

vi.mock("@/lib/agent-api/events", () => ({ publish: vi.fn(async () => ({ id: "evt" })) }));

import { awardDispatcher, solverAward, solverAwardFor } from "@/lib/points/award";
import { holdPayout, releasePayoutIfLive } from "@/lib/points/payout";
import { planPayoutFor } from "@/lib/agent-api/plan";
import { marketingAcceptAwards } from "@/lib/agent-api/merge";
import { PLAN_POINTS } from "@/lib/points/rules";
import { backfillEntries } from "@/lib/points/backfill";
import {
  confirmationReviewerSourceKey,
  CONFIRMATION_REVIEWER_POINTS,
  diminishedReviewerPoints,
  MIN_POINT_AWARD,
  pointSourceKey,
  reviewerPointsAt,
} from "@/lib/points/rules";

/** An in-memory ledger with the unique `sourceKey` the database enforces. */
function fakeLedger() {
  const rows: Array<Record<string, unknown>> = [];
  const createMany = vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
    let count = 0;
    for (const row of data) {
      if (rows.some((r) => r.sourceKey === row.sourceKey)) continue;
      rows.push(row);
      count++;
    }
    return { count };
  });
  return { rows, db: { pointEntry: { createMany } } as never, createMany };
}

/** A database whose issues have a reward and a pull request (#rewards). */
function issueDb(bugs: Record<string, { reward: number; pullRequestUrl?: string | null }>) {
  return {
    bug: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (bugs[where.id] ? { pullRequestUrl: null, ...bugs[where.id] } : null)) },
  } as never;
}

const issue = { id: "bug-1", organisationId: "organisation-zedu", assigneeId: "user-1" };

describe("points ledger (#428)", () => {

  it("does not pay a dispatcher for unattributed work", async () => {
    const { db, rows } = fakeLedger();
    expect(await awardDispatcher(db, issue, null)).toBe(false);
    expect(rows).toEqual([]);
  });

  it("pays the solver the issue's reward, in $, $1 before any estimate (#rewards)", () => {
    expect(solverAward({ ...issue, reward: 6.5 })).toEqual({
      organisationId: "organisation-zedu",
      userId: "user-1",
      bugId: "bug-1",
      role: "solver",
      points: 6.5,
      sourceKey: "solver:bug-1:user-1",
    });
    expect(solverAward(issue)?.points).toBe(1);
    // Never outside $1–$10.
    expect(solverAward({ ...issue, reward: 40 })?.points).toBe(10);
  });

  it("awards nobody when the issue has no assignee", async () => {
    expect(solverAward({ ...issue, assigneeId: null })).toBeNull();
    expect(await solverAwardFor(issueDb({ "bug-1": { reward: 5 } }), { ...issue, assigneeId: null })).toBeNull();
  });

  it("reads each issue's own reward", async () => {
    const db = issueDb({ "bug-2": { reward: 2 }, "bug-3": { reward: 9.25 } });
    expect((await solverAwardFor(db, { ...issue, id: "bug-2" }))?.points).toBe(2);
    expect((await solverAwardFor(db, { ...issue, id: "bug-3" }))?.points).toBe(9.25);
  });

  it("does not award the solver when the linked pull request is reported closed without being merged (#642)", async () => {
    const db = issueDb({ "bug-1": { reward: 5, pullRequestUrl: "https://github.com/zedu/web/pull/closed-1" } });
    expect(await solverAwardFor(db, issue)).toBeNull();
  });
});

describe("shared leaderboard periods (M-API-10)", () => {
  it("uses UTC week and month boundaries, with no boundary for all time", () => {
    const now = new Date("2026-11-05T18:30:00.000Z");
    expect(leaderboardPeriodStart("week", now)?.toISOString()).toBe("2026-11-02T00:00:00.000Z");
    expect(leaderboardPeriodStart("month", now)?.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(leaderboardPeriodStart("all", now)).toBeNull();
  });

  it("ranks the shared PointEntry total for the selected period without separating marketing rewards", async () => {
    clearLeaderboardCache();
    const now = new Date("2026-11-05T18:30:00.000Z");
    const periodStart = new Date("2026-11-02T00:00:00.000Z");
    const groupBy = vi.fn(async ({ where }: { where: { role?: string } }) =>
      where.role === "solver"
        ? [{ userId: "worker", _count: { _all: 2 } }]
        // PointEntry has no track split: this total can contain both product and marketing awards.
        : [{ userId: "worker", _sum: { points: 12 } }],
    );
    const db = {
      pointEntry: { groupBy },
      user: {
        findMany: vi.fn(async () => [{ id: "worker", name: "Worker", image: null }]),
      },
    } as never;

    const result = await paginatedOrganisationLeaderboard(db, "organisation-zedu", {
      period: "week",
      now,
    });

    expect(result).toMatchObject({
      period: "week",
      periodStart: periodStart.toISOString(),
      entries: [{ userId: "worker", points: 12, solvedTasks: 2, rank: 1 }],
    });
    expect(groupBy).toHaveBeenCalledTimes(2);
    for (const [query] of groupBy.mock.calls) {
      expect(query.where).toMatchObject({
        organisationId: "organisation-zedu",
        createdAt: { gte: periodStart },
      });
      expect(query.where).not.toHaveProperty("bug.track");
      expect(query.where).not.toHaveProperty("track");
    }
  });
});

describe("point rules (#428)", () => {
  it("pays every later reviewer a little less, and never stops paying", () => {
    expect([0, 1, 2, 3, 4, 5].map((index) => reviewerPointsAt(index, 5))).toEqual([
      5, 4.5, 4.05, 3.645, 3.2805, 2.9525,
    ]);
    expect(reviewerPointsAt(1, 5)).toBe(diminishedReviewerPoints(5));
    expect([0, 1, 2, 3, 4, 5].map((index) => reviewerPointsAt(index, 10))).toEqual([
      10, 9, 8.1, 7.29, 6.561, 5.9049,
    ]);
    expect([0, 1, 2, 3].map((index) => reviewerPointsAt(index, CONFIRMATION_REVIEWER_POINTS))).toEqual([
      0.9, 0.81, 0.729, 0.6561,
    ]);
    expect(diminishedReviewerPoints(1)).toBe(0.9);
    expect(diminishedReviewerPoints(0.05)).toBe(0.045);
    expect(diminishedReviewerPoints(MIN_POINT_AWARD)).toBe(MIN_POINT_AWARD);

    const tail = Array.from({ length: 200 }, (_, index) => reviewerPointsAt(index, 5));
    for (let index = 1; index < tail.length; index += 1) {
      expect(tail[index]).toBeGreaterThan(0);
      expect(tail[index]).toBeLessThanOrEqual(tail[index - 1]);
    }
    expect(tail[5]).toBeGreaterThan(2);
    expect(tail.at(-1)).toBe(MIN_POINT_AWARD);
    expect(reviewerPointsAt(-1, 5)).toBe(0);
    expect(reviewerPointsAt(0, 0)).toBe(0);
  });

  it("builds one source key per role, issue and person", () => {
    expect(pointSourceKey("solver", "bug-1", "user-1")).toBe("solver:bug-1:user-1");
    expect(pointSourceKey("reporter", "bug-1", "user-1")).toBe("reporter:bug-1:user-1");
    expect(pointSourceKey("reviewer", "bug-1", "user-1")).toBe("reviewer:bug-1:user-1");
    expect(pointSourceKey("solver", "bug-1", "user-2")).not.toBe(pointSourceKey("solver", "bug-1", "user-1"));
    expect(confirmationReviewerSourceKey("bug-1", "user-1")).toBe("reviewer-confirm:bug-1:user-1");
    expect(confirmationReviewerSourceKey("bug-1", "user-1")).not.toBe(pointSourceKey("reviewer", "bug-1", "user-1"));
  });

});

/** One issue, its held payout and its deployment reports, with an in-memory ledger. */
function payoutDb(reporters: string[]) {
    const ledger = fakeLedger();
    const bug = { id: "bug-1", number: 1, organisationId: "organisation-zedu", projectId: "p1", assigneeId: "solver", heldPayout: null as unknown, payoutReleasedAt: null as Date | null };
    const db = {
      pointEntry: (ledger.db as unknown as { pointEntry: unknown }).pointEntry,
      bug: {
        findUniqueOrThrow: vi.fn(async () => ({ ...bug })),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => Object.assign(bug, data)),
      },
      deploymentReport: { findMany: vi.fn(async () => reporters.map((onBehalfOfUserId) => ({ onBehalfOfUserId }))) },
      // An issue nobody funded: its escrow is empty, so releasing the payout moves no Ziks.
      coinEntry: { aggregate: vi.fn(async () => ({ _sum: { amount: 0 } })) },
      $queryRaw: vi.fn(async () => []),
    };
    return { db: db as never, bug, rows: ledger.rows, reporters };
}
const solver = { organisationId: "organisation-zedu", userId: "solver", bugId: "bug-1", role: "solver" as const, points: 6, sourceKey: "solver:bug-1:solver" };
const tester = { organisationId: "organisation-zedu", userId: "tester", bugId: "bug-1", role: "reviewer" as const, points: 3, sourceKey: "reviewer:bug-1:tester" };

describe("payouts wait for the work to be live (#live-payout)", () => {

  it("holds what resolving earned until three people other than the solver report it deployed", async () => {
    const { db, rows, reporters } = payoutDb(["solver", "a", "b"]);
    expect(await holdPayout(db, "bug-1", [solver, tester])).toEqual({ held: 2, paid: false });
    expect(rows).toEqual([]);
    // The solver's own report doesn't count: two independent reports are not enough.
    expect(await releasePayoutIfLive(db, "bug-1")).toBe(false);
    reporters.push("c");
    expect(await releasePayoutIfLive(db, "bug-1")).toBe(true);
    expect(rows.map((row) => [row.userId, row.points])).toEqual([["solver", 6], ["tester", 3]]);
    // Paid once: a later report pays nothing more.
    expect(await releasePayoutIfLive(db, "bug-1")).toBe(false);
    expect(rows).toHaveLength(2);
  });
});

describe("the plan's award on a complex issue (#plan-review rule 13)", () => {
  const bug = { id: "bug-1", organisationId: "organisation-zedu" };
  const approved = { ownerId: "bob", agentId: "agent-bob" };
  const planDb = (plan: typeof approved | null) => ({ plan: { findFirst: vi.fn(async () => plan) } }) as never;

  it("is the owner's, for the claim that delivered the work under an approved plan, and nothing for a claim without one", async () => {
    await expect(planPayoutFor(planDb(approved), bug, { id: "claim-1" })).resolves.toEqual({
      organisationId: "organisation-zedu", userId: "bob", bugId: "bug-1", role: "plan", points: PLAN_POINTS, sourceKey: "plan:bug-1:bob", agentId: "agent-bob",
    });
    // The delivering claim never had a plan approved (a plan that was sent back, or an easy issue): nothing.
    await expect(planPayoutFor(planDb(null), bug, { id: "claim-2" })).resolves.toBeNull();
    // No claim delivered it (a person resolved it by hand): nothing.
    await expect(planPayoutFor(planDb(approved), bug, null)).resolves.toBeNull();
  });

  it("pays nothing to an owner whose agent got its plan approved and then released the claim, even when someone else finishes the issue", async () => {
    // The approved plan belongs to claim-1, which was released; claim-2 delivered the work with no plan of its own.
    const db = { plan: { findFirst: vi.fn(async ({ where }: { where: { claimId: string } }) => (where.claimId === "claim-1" ? approved : null)) } } as never;
    await expect(planPayoutFor(db, bug, { id: "claim-2" })).resolves.toBeNull();
  });

  it("is held with the solver's reward at resolve and paid only once enough people report the work deployed", async () => {
    const { db, rows, reporters } = payoutDb(["a", "b"]);
    const plan = (await planPayoutFor(planDb(approved), bug, { id: "claim-1" }))!;
    expect(await holdPayout(db, "bug-1", [solver, plan])).toEqual({ held: 2, paid: false });
    expect(rows).toEqual([]);
    expect(await releasePayoutIfLive(db, "bug-1")).toBe(false);
    reporters.push("c");
    expect(await releasePayoutIfLive(db, "bug-1")).toBe(true);
    expect(rows.map((row) => [row.userId, row.role, row.points])).toEqual([["solver", "solver", 6], ["bob", "plan", PLAN_POINTS]]);
  });

  it("goes with the marketing accept awards, direct, when the claim ran under an approved plan", () => {
    const base = { bug: { id: "bug-1", organisationId: "organisation-zedu", reporterId: "ada" }, claim: null, solverUserId: "bob", rewardedReviewerUserIds: [], reward: 4, reporterPoints: 1.5, reviewerPoints: 3, dispatcherPoints: 0.6 };
    const plan = { organisationId: "organisation-zedu", userId: "bob", bugId: "bug-1", role: "plan" as const, points: PLAN_POINTS, sourceKey: "plan:bug-1:bob", agentId: "agent-bob" };
    expect(marketingAcceptAwards({ ...base, planAward: plan }).map((award) => award.role)).toEqual(["solver", "reporter", "plan"]);
    expect(marketingAcceptAwards({ ...base, planAward: null }).map((award) => award.role)).toEqual(["solver", "reporter"]);
  });
});

describe("when the reporter is paid", () => {
  it("does not invent reporter rewards for an outside-board delivery, even though confirmation was waived", () => {
    const awards = backfillEntries({ id: "imported", organisationId: "org", status: "resolved", isDeleted: false, assigneeId: "solver", reporterId: "solver", beneficiaryUserId: "solver", reward: 5, duplicateOfId: null, createdByAgentId: "filer", isConfirmed: true, outsideWork: { id: "import" } });
    expect(awards.map((award) => award.role)).toEqual(["solver"]);
  });
  it("is at conversion for marketing, which has no confirmation, and at confirmation for product", () => {
    expect(trackRules("marketing").reporterPaidOn).toBe("conversion");
    expect(trackRules("product").reporterPaidOn).toBe("confirmation");
  });
});
