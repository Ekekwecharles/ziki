import { entrySubstatus, trackRules } from "@/lib/marketing/track";
import type { AgentLevel } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** The manager's merge review (#434, #493, #526, #owner-agents): only a manager or merger agent accepts or rejects, never the claim holder; an accept needs confirmation, enough judgements on the linked pull request and a report that it can merge at the tested head. */
type VerdictRow = {
  id: string;
  bugId: string;
  goodToMerge: boolean;
  onBehalfOfUserId: string;
  pullRequestUrl: string | null;
  headSha?: string | null;
  createdAt: Date;
  updatedAt: Date;
  agent: { id: string; ownerUserId: string; activations: { organisationId: string; level: "working" | "manager" | "merger" }[] };
};

const state = vi.hoisted(() => ({
  verdicts: [] as VerdictRow[],
  confirmations: [] as { id: string; bugId: string; verdict: "confirm"; duplicateOfId: null; updatedAt: Date; agentId: string; onBehalfOfUserId: string; agent: { ownerUserId: string } }[],
}));

const db = vi.hoisted(() => ({
  bug: { findFirst: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  bugActivity: { create: vi.fn() },
  comment: { create: vi.fn() },
  testVerdict: { findMany: vi.fn() },
  // #deeper-testing: no checks set, so every judgement counts as before.
  proofRule: { findMany: async () => [] },
  proofCheck: { findMany: async () => [] },
  // #plan-review: the accept looks for the delivering claim's approved plan; none here.
  plan: { findFirst: vi.fn(async () => null) },
  mergeReview: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  pullRequestReport: { findFirst: vi.fn() },
  issueConfirmation: { findMany: vi.fn() },
  pointEntry: { createMany: vi.fn() },
  agentAuditEvent: { create: vi.fn(), findMany: vi.fn() },
  agentEvent: { create: vi.fn() },
  webhookSubscription: { findMany: vi.fn() },
  webhookDelivery: { createMany: vi.fn() },
  issueClaim: { updateMany: vi.fn(), update: vi.fn() },
  delivery: { findMany: vi.fn(), findFirst: vi.fn() },
  projectWorkflow: { findUnique: vi.fn() },
  project: { findFirst: vi.fn() },
  agentMistake: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), findMany: vi.fn() },
  supportThread: { findMany: vi.fn(async () => []), updateMany: vi.fn() },
  notification: { createMany: vi.fn() },
  $queryRaw: vi.fn(),
  $transaction: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));

const redesign = vi.hoisted(() => ({ assertRedesignOpen: vi.fn() }));
vi.mock("@/lib/redesigns", () => ({ assertRedesignOpen: redesign.assertRedesignOpen }));

const notify = vi.hoisted(() => ({ notifyMergeFailed: vi.fn() }));
vi.mock("@/lib/agent-notifications", () => ({ notifyMergeFailed: notify.notifyMergeFailed }));

import { acceptFix as acceptFixRaw, marketingAcceptAwards } from "@/lib/agent-api/merge";
import { award } from "@/lib/points/award";
import { resetWorkflowCache } from "@/lib/workflow";

const PR = "https://github.com/Zedu-Endor/issue-tracker/pull/42";

/** A written merge review (#review-entries): every call to /merge carries one. */
const REVIEW = { verdict: "accept", summary: "Accept: small and tested.", description: "Two independent testers verified it on the linked commit." };

/** `acceptFix` with a written accept unless the test sends its own body. */
function acceptFix(
  agent: Parameters<typeof acceptFixRaw>[0],
  bugId: string,
  body: Record<string, unknown> = {},
) {
  return acceptFixRaw(agent, bugId, { ...REVIEW, ...body });
}

function bugRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "bug1",
    title: "Session cookie dropped on redirect",
    organisationId: "organisation_zedu",
    pullRequestUrl: PR,
    pullRequestHeadSha: "linked-sha",
    revisionCount: 0,
    status: "open", substatus: "open",
    assigneeId: "ada",
    beneficiaryUserId: "ada",
    createdByAgentId: null,
    createdByAgent: null,
    // The pull request link is in the project's repository (#pr-reports gate).
    project: { repoUrl: "https://github.com/Zedu-Endor/issue-tracker" },
    claims: [{
      id: "claim1",
      status: "active",
      releasedAt: null,
      agentId: "solver-agent",
      beneficiaryUserId: "ada",
      agent: { ownerUserId: "ada" },
    }],
    ...overrides,
  };
}

/** The latest independent report on the pull request (#pr-reports): open, passing, at the bug's head. */
function reportRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "report-1",
    bugId: "bug1",
    pullRequestUrl: PR,
    state: "open",
    mergedInto: null,
    inDefaultBranch: null,
    headSha: "linked-sha",
    mergeCommitSha: null,
    checks: "passing",
    mergeable: true,
    note: "Open, checks green, no conflict.",
    agentId: "reporter-agent",
    onBehalfOfUserId: "kim",
    createdAt: new Date("2026-10-30T10:00:00Z"),
    agent: { name: "reporter-agent" },
    onBehalfOf: { name: "Kim" },
    ...overrides,
  };
}

function merger(id: string, ownerId: string, level: AgentLevel = "manager") {
  return { agentId: id, name: id, ownerId, organisationId: "organisation_zedu", level, burst: false, keyId: `key-${id}` };
}

/** The two independent confirmation entries that confirm an issue (#issue-confirmations). */
function confirmWith(ownerA: string, ownerB: string) {
  const entry = (owner: string) => ({
    id: `c-${owner}`, bugId: "bug1", verdict: "confirm" as const, duplicateOfId: null, updatedAt: new Date("2026-10-20T10:00:00Z"),
    agentId: `a-${owner}`, onBehalfOfUserId: owner, agent: { ownerUserId: owner },
  });
  // Three confirms of weight 1 reach the default threshold of 3 (#confirmation-weights).
  state.confirmations = [entry(ownerA), entry(ownerB), entry(`${ownerB}-third`)];
}

function verdict(
  agentId: string,
  ownerId: string,
  onBehalfOfUserId = ownerId,
  pullRequestUrl: string | null = PR,
  headSha: string | null = "linked-sha",
) {
  state.verdicts.push({
    id: `v-${agentId}`,
    bugId: "bug1",
    goodToMerge: true,
    pullRequestUrl,
    headSha,
    onBehalfOfUserId,
    createdAt: new Date(),
    updatedAt: new Date(),
    agent: { id: agentId, ownerUserId: ownerId, activations: [] },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetWorkflowCache();
  state.verdicts = [];
  state.confirmations = [];
  db.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(db));
  db.$queryRaw.mockResolvedValue([{ id: "bug1" }]);
  db.bug.findFirst.mockResolvedValue(bugRow());
  db.bug.findUnique.mockResolvedValue(bugRow());
  // No delivery filed on the claim holder's behalf unless a test adds one.
  db.delivery.findMany.mockResolvedValue([]);
  db.delivery.findFirst.mockResolvedValue(null);
  db.bug.findUniqueOrThrow.mockResolvedValue({ reward: 5, reporterId: "ada" });
  db.issueClaim.updateMany.mockResolvedValue({ count: 1 });
  db.bug.update.mockResolvedValue({});
  db.bugActivity.create.mockResolvedValue({});
  db.comment.create.mockResolvedValue({ id: "merge-comment-1" });
  db.mergeReview.findUnique.mockResolvedValue(null);
  db.mergeReview.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "review-1", createdAt: new Date(), updatedAt: new Date(), headSha: null, ...data,
  }));
  db.mergeReview.update.mockImplementation(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
    id: where.id, createdAt: new Date(), updatedAt: new Date(), headSha: null, ...data,
  }));
  // The pull request is reported open, checks passing, mergeable, at the bug's head.
  db.pullRequestReport.findFirst.mockResolvedValue(reportRow());
  db.pointEntry.createMany.mockResolvedValue({ count: 1 });
  db.agentEvent.create.mockResolvedValue({ id: "e1" });
  db.webhookSubscription.findMany.mockResolvedValue([]);
  db.agentAuditEvent.findMany.mockResolvedValue([]);
  redesign.assertRedesignOpen.mockResolvedValue(undefined);
  db.testVerdict.findMany.mockImplementation(async ({ where }: { where: { pullRequestUrl?: string } }) =>
    state.verdicts.filter(
      (v) => v.bugId === "bug1" && v.goodToMerge && (where.pullRequestUrl === undefined || v.pullRequestUrl === where.pullRequestUrl),
    ),
  );
  db.bug.findMany.mockImplementation(async () => [{ ...bugRow(), projectId: "p1", reporterId: "ada" }]);
  db.issueConfirmation.findMany.mockImplementation(async () => state.confirmations);
  db.projectWorkflow.findUnique.mockResolvedValue(null);
});

describe("acceptFix: who may merge (#434)", () => {
  it("refuses a working agent in a manager-governed project and writes nothing: accepting needs a manager", async () => {
    expect(await acceptFix(merger("c1", "cara", "working"), "bug1")).toMatchObject({
      status: 403,
      error: "insufficient_level",
    });
    expect(await acceptFix(merger("r1", "rob", "working"), "bug1")).toMatchObject({
      status: 403,
      error: "insufficient_level",
    });
    // The issue may be read (threshold-only projects let working agents review), but nothing is written.
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.mergeReview.create).not.toHaveBeenCalled();
    expect(db.mergeReview.update).not.toHaveBeenCalled();
    expect(db.bug.update).not.toHaveBeenCalled();
    expect(db.bugActivity.create).not.toHaveBeenCalled();
    expect(db.pointEntry.createMany).not.toHaveBeenCalled();
    expect(db.agentEvent.create).not.toHaveBeenCalled();
  });

});

describe("acceptFix: who may accept (#493, #owner-agents)", () => {
  it.each([
    ["the assigned solver's", { assigneeId: "ada" }],
    ["the claim beneficiary's", { claims: [{ status: "active", releasedAt: null, agentId: "w1", beneficiaryUserId: "ada", agent: { ownerUserId: "ada" } }] }],
    ["the reporter's", { reporterId: "ada", beneficiaryUserId: "zoe" }],
    ["the filer's", { createdByAgent: { ownerUserId: "ada" }, beneficiaryUserId: "zoe" }],
    ["the claim holder's owner's", { claims: [{ status: "active", releasedAt: null, agentId: "w1", beneficiaryUserId: "zoe", agent: { ownerUserId: "ada" } }] }],
  ])("lets %s own manager agent accept the work: nothing is gated to other people", async (_label, over) => {
    confirmWith("rob", "sam");
    verdict("r1", "rob");
    verdict("r2", "sam");
    verdict("r3", "tia");
    db.bug.findFirst.mockResolvedValue(bugRow(over));
    expect(await acceptFix(merger("m1", "ada", "manager"), "bug1")).toMatchObject({ status: 200, accepted: true });
  });

  it("refuses the agent holding the claim: it can't accept its own work", async () => {
    confirmWith("rob", "sam");
    verdict("r1", "rob");
    verdict("r2", "sam");
    verdict("r3", "tia");
    db.bug.findFirst.mockResolvedValue(
      bugRow({ claims: [{ status: "active", releasedAt: null, agentId: "w1", beneficiaryUserId: "ada", agent: { ownerUserId: "ada" } }] }),
    );
    expect(await acceptFix(merger("w1", "ada", "manager"), "bug1")).toMatchObject({ status: 403, error: "not_independent" });
    expect(db.bug.update).not.toHaveBeenCalled();
    expect(db.pointEntry.createMany).not.toHaveBeenCalled();
  });

});

describe("acceptFix: the gate (#434)", () => {

  it("names the missing condition: not confirmed", async () => {
    expect(await acceptFix(merger("m1", "mo", "manager"), "bug1")).toMatchObject({ status: 409, missing: "confirmation" });
    expect(db.bug.update).not.toHaveBeenCalled();
  });

  it("names the missing condition: good judgements weighing less than needed", async () => {
    confirmWith("rob", "sam");
    verdict("r1", "rob");
    expect(await acceptFix(merger("m1", "mo", "manager"), "bug1")).toMatchObject({ status: 409, missing: "verdicts" });
  });

});

describe("acceptFix: a successful accept (#434)", () => {

  it("a manager accepts the fix and marks it ready to merge without resolving or awarding points", async () => {
    confirmWith("rob", "sam");
    verdict("r1", "rob");
    verdict("r2", "sam");
    verdict("r3", "tia");
    const result = await acceptFix(merger("m1", "mo", "manager"), "bug1");
    expect(result).toMatchObject({ status: 200, accepted: true, readyToMerge: true });
    expect(db.pointEntry.createMany).not.toHaveBeenCalled();
    expect(db.bugActivity.create).toHaveBeenCalledWith({
      data: {
        bugId: "bug1",
        actorId: "mo",
        type: "status_changed",
        summary: "Fix accepted by a manager agent and marked ready to merge",
        metadata: { field: "status", readyToMerge: true, headSha: "linked-sha", mergeReviewId: "review-1", pullRequestReportId: "report-1" },
      },
    });
  });

  it("rejecting a fix records a merge review with the feedback, sends it back to In progress and records the mistake", async () => {
    db.bug.findFirst.mockResolvedValue(bugRow());
    db.project.findFirst.mockResolvedValue({ id: "proj-1" });
    db.agentMistake.findFirst.mockResolvedValue(null);
    db.agentMistake.create.mockResolvedValue({ id: "m-1", title: "Missing unit tests", category: "correctness", recurrenceCount: 1 });

    const result = await acceptFix(merger("m1", "mo", "manager"), "bug1", {
      verdict: "reject",
      summary: "Reject: tests are missing.",
      description: "Tests missing for edge case.",
      mistake: {
        title: "Missing unit tests",
        antiPattern: "PR was submitted without edge case tests for boundary conditions.",
        remediation: "Always add tests covering empty and single-element collections.",
      },
    });

    expect(result).toMatchObject({
      status: 200,
      accepted: false,
      replaced: false,
      review: { id: "review-1", verdict: "reject", summary: "Reject: tests are missing.", description: "Tests missing for edge case.", pullRequestUrl: PR, headSha: "linked-sha" },
    });
    expect(db.mergeReview.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ bugId: "bug1", agentId: "m1", onBehalfOfUserId: "mo", verdict: "reject", pullRequestUrl: PR }),
      }),
    );
    expect(db.bug.update).toHaveBeenCalledWith({
      where: { id: "bug1" },
      data: { status: "in_progress", substatus: "in_progress" },
    });
    expect(db.agentMistake.create).toHaveBeenCalled();
    // #review-entries: the review is the record; no comment narrates it.
    expect(db.comment.create).not.toHaveBeenCalled();
    expect(db.bugActivity.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "status_changed", metadata: expect.objectContaining({ to: "in_progress", rejected: true, mergeReviewId: "review-1" }) }),
      }),
    );
    // #1429: the audit log keeps every merge decision.
    expect(db.agentAuditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        agentId: "m1",
        action: "issue.merge_rejected",
        target: "bug:bug1",
        bugId: "bug1",
        payload: expect.objectContaining({ status: "in_progress", substatus: "in_progress", rejected: true, mergeReviewId: "review-1", notes: "Tests missing for edge case." }),
      }),
    });
  });

  it("reviewing again replaces the agent's review", async () => {
    db.bug.findFirst.mockResolvedValue(bugRow());
    db.mergeReview.findUnique.mockResolvedValue({ id: "review-0" });

    const result = await acceptFix(merger("m1", "mo", "manager"), "bug1", {
      verdict: "reject",
      summary: "Reject again.",
      description: "The redirect still drops the session cookie.",
    });

    expect(result).toMatchObject({ status: 200, accepted: false, replaced: true, review: { id: "review-0", verdict: "reject" } });
    expect(db.mergeReview.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { bugId_agentId: { bugId: "bug1", agentId: "m1" } } }));
    expect(db.mergeReview.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "review-0" } }));
    expect(db.mergeReview.create).not.toHaveBeenCalled();
  });

});

describe("acceptFix counts verdicts on the linked pull request only (#526)", () => {
  it("ignores good-to-merge verdicts on an earlier pull request, or none", async () => {
    confirmWith("rob", "sam");
    verdict("r-rob", "rob", "rob", "https://github.com/Zedu-Endor/issue-tracker/pull/41");
    verdict("r-sam", "sam", "sam", null);
    const result = await acceptFix(merger("m1", "mo"), "bug1");
    expect(result).toMatchObject({ status: 409, missing: "verdicts" });
    expect(db.testVerdict.findMany.mock.calls[0][0].where).toMatchObject({ pullRequestUrl: PR });
  });
});

describe("acceptFix: the latest pull request report must say it can merge (#pr-reports)", () => {
  function readyToAccept() {
    confirmWith("rob", "sam");
    verdict("r1", "rob");
    verdict("r2", "sam");
    verdict("r3", "tia");
    db.bug.findFirst.mockResolvedValue(bugRow());
  }
  const acceptsNothing = () => {
    expect(db.bug.update).not.toHaveBeenCalled();
    expect(db.agentAuditEvent.create).not.toHaveBeenCalled();
    // #review-entries: nothing is posted or recorded on the issue.
    expect(db.comment.create).not.toHaveBeenCalled();
    expect(db.bugActivity.create).not.toHaveBeenCalled();
    expect(db.mergeReview.create).not.toHaveBeenCalled();
    expect(db.pointEntry.createMany).not.toHaveBeenCalled();
  };

  it("refuses with needs_pr_report when nobody has reported the pull request", async () => {
    readyToAccept();
    db.pullRequestReport.findFirst.mockResolvedValue(null);

    const result = await acceptFix(merger("m1", "mo", "manager"), "bug1");

    expect(result).toMatchObject({ status: 409, error: "needs_pr_report", todo: expect.stringContaining("pull-request-status") });
    acceptsNothing();
    expect(notify.notifyMergeFailed).not.toHaveBeenCalled();
  });

  it("does not accept when the reported head commit moved after the testers approved it", async () => {
    readyToAccept();
    // Ziki and the report agree on the new head; the testers approved linked-sha.
    db.bug.findFirst.mockResolvedValue(bugRow({ pullRequestHeadSha: "newer-sha" }));
    db.pullRequestReport.findFirst.mockResolvedValue(reportRow({ headSha: "newer-sha" }));

    const result = await acceptFix(merger("m1", "mo", "manager"), "bug1");

    expect(result).toMatchObject({ status: 409, error: "not_ready", missing: "pull_request", message: expect.stringContaining("head commit") });
    acceptsNothing();
  });

});

describe("accepting marketing work", () => {
  it("goes straight to Live as Published, skipping Merge, and product work still goes to Merge", () => {
    expect(trackRules("marketing").acceptMovesTo).toBe("published");
    expect(trackRules("product").acceptMovesTo).toBe("ready_to_merge");
  });

  it("goes Live as Published when a person moves it there, and product work as On dev", () => {
    expect(entrySubstatus("marketing", "resolved")).toBe("published");
    expect(entrySubstatus("product", "resolved")).toBe("on_dev");
    expect(entrySubstatus("marketing", "open")).toBe("open");
  });
});

describe("acceptFix: marketing work goes Live (#M-API-5)", () => {
  function marketingBug(overrides: Record<string, unknown> = {}) {
    return bugRow({
      track: "marketing",
      status: "done",
      substatus: "accepted",
      pullRequestUrl: null,
      pullRequestHeadSha: null,
      reporterId: "poster",
      claims: [{
        id: "claim1",
        status: "active",
        claimedAt: new Date("2026-10-20T10:00:00Z"),
        releasedAt: null,
        agentId: "solver-agent",
        beneficiaryUserId: "ada",
        dispatcherUserId: null,
        agent: { ownerUserId: "ada", name: "solver-agent" },
      }],
      ...overrides,
    });
  }

  function marketingReady() {
    db.bug.findFirst.mockResolvedValue(marketingBug());
    db.bug.findUniqueOrThrow.mockResolvedValue({ reward: 6, reporterId: "poster" });
    verdict("r1", "rob", "rob", null, null);
    verdict("r2", "sam", "sam", null, null);
    verdict("r3", "tia", "tia", null, null);
  }

  it("moves Done · Accepted to Live · Published, skipping Merge and the PR gate", async () => {
    marketingReady();

    const result = await acceptFix(merger("m1", "mo", "manager"), "bug1");

    expect(result).toMatchObject({ status: 200, accepted: true, published: true });
    expect(db.bug.update).toHaveBeenCalledWith({
      where: { id: "bug1" },
      data: { status: "resolved", substatus: "published" },
    });
    // No pull request, confirmation, redesign or PR report gate is consulted.
    expect(db.pullRequestReport.findFirst).not.toHaveBeenCalled();
    expect(redesign.assertRedesignOpen).not.toHaveBeenCalled();
    expect(db.issueConfirmation.findMany).not.toHaveBeenCalled();
    expect(db.issueClaim.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ releaseReason: "accepted" }) }),
    );
  });

  it("pays the worker, poster and reviewers directly, once each by source key", async () => {
    marketingReady();

    await acceptFix(merger("m1", "mo", "manager"), "bug1");

    const awards = db.pointEntry.createMany.mock.calls.flatMap(
      ([arg]) => arg.data as Array<Record<string, unknown>>,
    );
    expect(awards).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: "ada", role: "solver", points: 6, sourceKey: "solver:bug1:ada" }),
      expect.objectContaining({ userId: "poster", role: "reporter", sourceKey: "reporter:bug1:poster" }),
      expect.objectContaining({ userId: "rob", role: "reviewer", sourceKey: "reviewer:bug1:rob" }),
      expect.objectContaining({ userId: "sam", role: "reviewer", sourceKey: "reviewer:bug1:sam" }),
      expect.objectContaining({ userId: "tia", role: "reviewer", sourceKey: "reviewer:bug1:tia" }),
    ]));
  });

  it("records the accept as an audit row and an issue.accepted event", async () => {
    marketingReady();

    await acceptFix(merger("m1", "mo", "manager"), "bug1");

    expect(db.agentAuditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "issue.accepted",
        target: "bug:bug1",
        payload: expect.objectContaining({
          published: true,
          track: "marketing",
          status: "resolved",
          substatus: "published",
        }),
      }),
    });
    expect(db.agentEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        type: "issue.accepted",
        payload: expect.objectContaining({
          published: true,
          track: "marketing",
          status: "resolved",
          substatus: "published",
        }),
      }),
    }));
  });

  it("refuses marketing work its reviewers haven't approved", async () => {
    db.bug.findFirst.mockResolvedValue(marketingBug({ status: "done", substatus: "requires_review" }));

    expect(await acceptFix(merger("m1", "mo", "manager"), "bug1")).toMatchObject({
      status: 409,
      error: "not_ready",
      missing: "verdicts",
    });
    expect(db.bug.update).not.toHaveBeenCalled();
    expect(db.pointEntry.createMany).not.toHaveBeenCalled();
  });

  it("refuses a working agent: marketing acceptance is a manager's review", async () => {
    marketingReady();

    expect(await acceptFix(merger("w1", "wes", "working"), "bug1")).toMatchObject({
      status: 403,
      error: "insufficient_level",
    });
    expect(db.pointEntry.createMany).not.toHaveBeenCalled();
  });

  it("pays each award once when the same awards are written twice (#sourceKey)", async () => {
    const rows: Array<Record<string, unknown>> = [];
    const createMany = vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
      let count = 0;
      for (const row of data) {
        if (rows.some((existing) => existing.sourceKey === row.sourceKey)) continue;
        rows.push(row);
        count += 1;
      }
      return { count };
    });
    const awards = marketingAcceptAwards({
      bug: { id: "bug1", organisationId: "organisation_zedu", reporterId: "poster" },
      claim: {
        id: "claim1",
        status: "active",
        claimedAt: new Date("2026-10-20T10:00:00Z"),
        releasedAt: null,
        agentId: "solver-agent",
        beneficiaryUserId: "ada",
        dispatcherUserId: null,
        agent: { ownerUserId: "ada", name: "solver-agent" },
      },
      solverUserId: "ada",
      rewardedReviewerUserIds: ["rob", "sam"],
      reward: 6,
      reporterPoints: 1.5,
      reviewerPoints: 3,
      dispatcherPoints: 0.6,
    });

    for (const entry of awards) await award({ pointEntry: { createMany } } as never, entry);
    for (const entry of awards) await award({ pointEntry: { createMany } } as never, entry);

    expect(rows.map((row) => row.sourceKey)).toEqual([
      "solver:bug1:ada",
      "reporter:bug1:poster",
      "reviewer:bug1:rob",
      "reviewer:bug1:sam",
    ]);
  });

  it("rejecting marketing work uses up a revision round and keeps the claim", async () => {
    db.bug.findFirst.mockResolvedValue(marketingBug({ status: "done", substatus: "accepted", revisionCount: 0 }));

    const result = await acceptFix(merger("m1", "mo", "manager"), "bug1", {
      verdict: "reject",
      summary: "Needs copy changes.",
      description: "Headline is unclear.",
    });

    expect(result).toMatchObject({ status: 200, accepted: false, rejected: true });
    expect(db.bug.update).toHaveBeenCalledWith({
      where: { id: "bug1" },
      data: { status: "in_progress", substatus: "in_progress", revisionCount: 1 },
    });
    expect(db.issueClaim.update).not.toHaveBeenCalled();
  });

  it("rejecting marketing work past the revision limit reopens for bids and releases the claim", async () => {
    db.bug.findFirst.mockResolvedValue(marketingBug({ status: "done", substatus: "accepted", revisionCount: 2 }));

    const result = await acceptFix(merger("m1", "mo", "manager"), "bug1", {
      verdict: "reject",
      summary: "Still not good.",
      description: "Revision limit reached.",
    });

    expect(result).toMatchObject({ status: 200, accepted: false, rejected: true });
    expect(db.bug.update).toHaveBeenCalledWith({
      where: { id: "bug1" },
      data: { status: "open", substatus: "open", assigneeId: null, revisionCount: 0 },
    });
    expect(db.issueClaim.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "released", releaseReason: "manager_rejected" }),
      }),
    );
  });

  it("does not reject marketing work before peer reviewers approve it", async () => {
    db.bug.findFirst.mockResolvedValue(marketingBug({ status: "done", substatus: "requires_review", revisionCount: 0 }));

    const result = await acceptFix(merger("m1", "mo", "manager"), "bug1", {
      verdict: "reject",
      summary: "Reject early.",
      description: "Should be blocked.",
    });

    expect(result).toMatchObject({ status: 409, error: "not_ready", missing: "verdicts" });
    expect(db.bug.update).not.toHaveBeenCalled();
  });

  it("refuses reject if concurrent change moved marketing work away from accepted before tx commits", async () => {
    // 1st call outside tx returns accepted; 2nd call inside tx returns in_progress (e.g. concurrent reject won the race)
    db.bug.findFirst
      .mockResolvedValueOnce(marketingBug({ status: "done", substatus: "accepted", revisionCount: 0 }))
      .mockResolvedValueOnce(marketingBug({ status: "in_progress", substatus: "in_progress", revisionCount: 1 }));

    const result = await acceptFix(merger("m1", "mo", "manager"), "bug1", {
      verdict: "reject",
      summary: "Concurrent reject.",
      description: "Should fail in tx.",
    });

    expect(result).toMatchObject({ status: 409, error: "not_ready", missing: "verdicts" });
    expect(db.bug.update).not.toHaveBeenCalled();
  });

  it("locks the issue row so concurrent rejections race safely and do not duplicate a revision round", async () => {
    const liveBug = marketingBug({ status: "done", substatus: "accepted", revisionCount: 0 });
    let lockTail = Promise.resolve();

    db.bug.findFirst.mockImplementation(async () => ({ ...liveBug }));
    db.bug.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      Object.assign(liveBug, data);
      return { ...liveBug };
    });

    db.$transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => {
      let releaseLock: (() => void) | undefined;
      const tx = {
        ...db,
        $queryRaw: async () => {
          const previous = lockTail;
          lockTail = new Promise<void>((resolve) => { releaseLock = resolve; });
          await previous;
          return [{ id: liveBug.id }];
        },
      };
      try {
        return await callback(tx);
      } finally {
        releaseLock?.();
      }
    });

    const [first, second] = await Promise.all([
      acceptFix(merger("m1", "mo1", "manager"), "bug1", { verdict: "reject", summary: "First reject", description: "Reason 1" }),
      acceptFix(merger("m2", "mo2", "manager"), "bug1", { verdict: "reject", summary: "Second reject", description: "Reason 2" }),
    ]);

    const results = [first, second];
    const success = results.find((r) => r.status === 200);
    const blocked = results.find((r) => r.status === 409);

    expect(success).toMatchObject({ status: 200, rejected: true });
    expect(blocked).toMatchObject({ status: 409, error: "not_ready", missing: "verdicts" });
    expect(liveBug.substatus).toBe("in_progress");
    expect(liveBug.revisionCount).toBe(1);
  });
});
