import { afterSendBack, judgementCounts } from "@/lib/marketing/track";
import { buildCard, checksFor, countsWithProof, judgementProof, NO_CHECKS, proofProblem, type ProofRules } from "@/lib/proof";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Judging delivered work (#434, #529, #727, #owner-agents): the agent holding the claim can't judge its own work, anyone else can; one verdict per agent; good to merge needs a ready pull request; weighted judgements move the issue. */
type Row = {
  id: string;
  bugId: string;
  agentId: string;
  onBehalfOfUserId: string;
  goodToMerge: boolean;
  summary: string;
  description: string;
  pullRequestUrl?: string | null;
  changedAt?: Date | null;
};

const state = vi.hoisted(() => ({ verdicts: [] as Row[], reviewOffers: [] as Array<{
  id: string;
  bugId: string;
  beneficiaryUserId: string;
  agentId: string;
  status: string;
  offeredAt: Date;
  deadlineAt: Date | null;
  pullRequestUrl: string;
  headSha: string | null;
  expiredAt?: Date;
}>, jobReviewOffers: [] as Array<{
  id: string;
  submissionId: string;
  agentId: string;
  beneficiaryUserId: string;
  status: string;
  offeredAt: Date;
  expiredAt?: Date;
}> }));

const db = vi.hoisted(() => ({
  bug: { findFirst: vi.fn() },
  delivery: { findFirst: vi.fn(), findMany: vi.fn() },
  membership: { findUnique: vi.fn(), findMany: vi.fn() },
  issueClaim: { groupBy: vi.fn() },
  projectWorkflow: { findUnique: vi.fn() },
  reviewOffer: { findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn(), create: vi.fn(), groupBy: vi.fn() },
  testVerdict: { findFirst: vi.fn(), findMany: vi.fn(async () => []), create: vi.fn(), update: vi.fn() },
  // #deeper-testing: no checks set, so every judgement counts as before.
  proofRule: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
  proofCheck: { findMany: async () => [] },
  attachment: { updateMany: vi.fn(), findMany: vi.fn() },
  testCardRow: { findFirst: vi.fn(), findMany: vi.fn(async () => []), count: vi.fn(), createMany: vi.fn(), update: vi.fn() },
  pullRequestReport: { findFirst: vi.fn() },
  agentAuditEvent: { create: vi.fn() },
  comment: { create: vi.fn() },
  bugActivity: { create: vi.fn() },
  agentEvent: { create: vi.fn() },
  webhookSubscription: { findMany: vi.fn() },
  webhookDelivery: { createMany: vi.fn() },
  $queryRaw: vi.fn(),
  jobSubmission: { findUnique: vi.fn(), update: vi.fn() },
  jobReview: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() },
  jobReviewOffer: {
    findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(),
    update: vi.fn(), updateMany: vi.fn(), groupBy: vi.fn(),
  },
  pointEntry: { createMany: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));

const tested = vi.hoisted(() => ({ refreshJudgedStatus: vi.fn() }));
vi.mock("@/lib/agent-api/tested-status", () => ({ refreshJudgedStatus: tested.refreshJudgedStatus }));

const notify = vi.hoisted(() => ({ notifyMergeFailed: vi.fn() }));
vi.mock("@/lib/agent-notifications", () => ({ notifyMergeFailed: notify.notifyMergeFailed }));

const PR = "https://github.com/Zedu-Endor/issue-tracker/pull/42";

/** The latest independent report on the pull request (#pr-reports); by default open, checks passing, no conflict. */
function report(overrides: Record<string, unknown> = {}) {
  return {
    id: "rep1",
    bugId: "bug1",
    pullRequestUrl: PR,
    state: "open",
    mergedInto: null,
    inDefaultBranch: null,
    headSha: null,
    mergeCommitSha: null,
    checks: "passing",
    mergeable: true,
    note: "Checked it on GitHub.",
    agentId: "checker",
    onBehalfOfUserId: "cy",
    createdAt: new Date("2026-10-30T09:00:00Z"),
    agent: { name: "checker" },
    onBehalfOf: { name: "Cy" },
    ...overrides,
  };
}

import { submitTestVerdict } from "@/lib/agent-api/test-verdict";
import { actOnTestCardRow, addTestCardRows } from "@/lib/agent-api/test-card";
import { acceptReviewOffer, REVIEW_DEADLINE_MS, REVIEW_OFFER_TTL_MS, sweepReviewOffers } from "@/lib/agent-api/review-offer";
import { acceptJobReviewOffer, reviewJobSubmission } from "@/lib/jobs/review";
import { judgeBlockKind } from "@/lib/agent-api/judge-block";
import type { PrGate } from "@/lib/agent-api/pr-gate";

/** An issue Ada filed herself, with no agent and no claim. */
function bugRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "bug1",
    organisationId: "organisation_zedu",
    projectId: "project1",
    status: "done", substatus: "requires_review",
    pullRequestUrl: PR,
    pullRequestHeadSha: null as string | null,
    title: "A fix",
    assigneeId: "ada",
    project: { repoUrl: "https://github.com/Zedu-Endor/issue-tracker" },
    beneficiaryUserId: "ada",
    createdByAgentId: null,
    createdByAgent: null,
    claims: [],
    ...overrides,
  };
}

function reviewer(id: string, ownerId: string, level: "working" | "manager" | "merger" = "working") {
  return { agentId: id, name: id, ownerId, organisationId: "organisation_zedu", level, burst: false, keyId: `key-${id}` };
}

const files = [{ path: "lib/save.ts", lines: "42" }];
const good = { goodToMerge: true, summary: "Good to merge.", description: "Tested on the branch: it works.", files };
const notGood = (description: string) => ({ goodToMerge: false, summary: "Not good to merge.", description, files });

beforeEach(() => {
  vi.clearAllMocks();
  state.verdicts = [];
  state.reviewOffers = [];
  state.jobReviewOffers = [];
  db.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(db));
  db.bug.findFirst.mockResolvedValue(bugRow());
  db.delivery.findFirst.mockResolvedValue(null);
  db.delivery.findMany.mockResolvedValue([]);
  db.membership.findUnique.mockResolvedValue({ id: "m1" });
  db.membership.findMany.mockResolvedValue([]);
  db.issueClaim.groupBy.mockResolvedValue([]);
  db.projectWorkflow.findUnique.mockResolvedValue(null);
  db.reviewOffer.findMany.mockResolvedValue([]);
  db.reviewOffer.findUnique.mockResolvedValue(null);
  db.reviewOffer.updateMany.mockResolvedValue({ count: 0 });
  db.reviewOffer.groupBy.mockResolvedValue([]);
  db.reviewOffer.create.mockImplementation(async ({ data }: { data: Omit<(typeof state.reviewOffers)[number], "id"> }) => {
    const row = { id: `review${state.reviewOffers.length + 1}`, ...data };
    state.reviewOffers.push(row);
    return row;
  });
  db.jobReviewOffer.findMany.mockResolvedValue([]);
  db.jobReviewOffer.findUnique.mockResolvedValue(null);
  db.jobReviewOffer.create.mockResolvedValue({ id: "job-review-1" });
  db.jobReviewOffer.updateMany.mockResolvedValue({ count: 0 });
  db.jobReviewOffer.groupBy.mockResolvedValue([]);
  db.$queryRaw.mockResolvedValue([{ id: "bug1" }]);
  db.comment.create.mockResolvedValue({ id: "c1" });
  db.bugActivity.create.mockResolvedValue({});
  db.pullRequestReport.findFirst.mockResolvedValue(report());
  db.agentEvent.create.mockResolvedValue({ id: "e1" });
  db.webhookSubscription.findMany.mockResolvedValue([]);
  db.testVerdict.findFirst.mockImplementation(async ({ where }: { where: Record<string, string> }) => {
    // A copy, as Prisma returns: a later update mustn't change what was read.
    const row = state.verdicts.find((v) => v.bugId === where.bugId && v.agentId === where.agentId);
    return row ? { ...row } : null;
  });
  db.testVerdict.create.mockImplementation(async ({ data }: { data: Omit<Row, "id"> }) => {
    const row = { id: `tv${state.verdicts.length + 1}`, changedAt: null, ...data };
    state.verdicts.push(row);
    return row;
  });
  db.testVerdict.update.mockImplementation(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
    const row = state.verdicts.find((v) => v.id === where.id)!;
    Object.assign(row, data);
    return row;
  });
});

describe("submitTestVerdict: who may verdict (#434)", () => {

  it("rejects the agent holding the active claim", async () => {
    db.bug.findFirst.mockResolvedValue(
      bugRow({ claims: [{ status: "active", releasedAt: null, agentId: "r1", agent: { ownerUserId: "rob" } }] }),
    );
    expect(await submitTestVerdict(reviewer("r1", "rob"), "bug1", good)).toMatchObject({
      status: 403,
      error: "fixer_cannot_verdict",
    });
    expect(state.verdicts).toHaveLength(0);
  });

  it("lets the beneficiary's, the filer's and the reporter's own agents judge (#owner-agents)", async () => {
    expect(await submitTestVerdict(reviewer("r3", "ada"), "bug1", good)).toMatchObject({ status: 201 });
    db.bug.findFirst.mockResolvedValue(bugRow({ createdByAgentId: "f1", createdByAgent: { ownerUserId: "rob" } }));
    expect(await submitTestVerdict(reviewer("r2", "rob"), "bug1", good)).toMatchObject({ status: 201 });
    db.bug.findFirst.mockResolvedValue(bugRow({ beneficiaryUserId: null, reporterId: "ada" }));
    expect(await submitTestVerdict(reviewer("r4", "ada"), "bug1", good)).toMatchObject({ status: 201 });
  });

  it("lets the claim holder's owner judge through another agent, but not through the agent holding the claim", async () => {
    db.bug.findFirst.mockResolvedValue(
      bugRow({ claims: [{ status: "active", releasedAt: null, agentId: "w1", agent: { ownerUserId: "rob" } }] }),
    );
    expect(await submitTestVerdict(reviewer("r2", "rob"), "bug1", good)).toMatchObject({ status: 201 });
    expect((await submitTestVerdict(reviewer("w1", "rob"), "bug1", good)).status).toBe(403);
  });

});

describe("submitTestVerdict: the body and record (#434)", () => {
  it("records a good-to-merge verdict for the owner", async () => {
    const result = await submitTestVerdict(reviewer("r1", "rob"), "bug1", good);
    expect(result).toMatchObject({ status: 201, verdict: { goodToMerge: true, onBehalfOfUserId: "rob" } });
    expect(state.verdicts[0]).toMatchObject({ bugId: "bug1", agentId: "r1", onBehalfOfUserId: "rob", goodToMerge: true });
  });

  it("keeps one verdict per agent per issue: reporting again replaces it (#529)", async () => {
    const rob = reviewer("r1", "rob");
    expect(await submitTestVerdict(rob, "bug1", good)).toMatchObject({ status: 201 });
    const changed = await submitTestVerdict(rob, "bug1", notGood("Regresses the Safari login"));
    expect(changed).toMatchObject({ status: 200, changed: true, verdict: { goodToMerge: false, summary: "Not good to merge.", description: "Regresses the Safari login" } });
    expect(state.verdicts).toHaveLength(1);
    expect(state.verdicts[0]).toMatchObject({ goodToMerge: false, changedAt: expect.any(Date) });
  });

});

describe("submitTestVerdict: judges delivered work (#526, #delivered-step)", () => {
  it("is refused until the work is delivered", async () => {
    db.bug.findFirst.mockResolvedValue(bugRow({ pullRequestUrl: null }));
    expect(await submitTestVerdict(reviewer("r1", "rob"), "bug1", good)).toMatchObject({
      status: 409,
      error: "not_delivered",
    });
    expect(db.testVerdict.create).not.toHaveBeenCalled();
  });

  it("refuses a new good-to-merge once the work is Done, and reads no pull request report (#727)", async () => {
    db.bug.findFirst.mockResolvedValue(bugRow({ status: "done", substatus: "accepted" }));
    expect(await submitTestVerdict(reviewer("r3", "rose"), "bug1", good)).toMatchObject({ status: 409, error: "enough_verdicts" });
    expect(db.testVerdict.create).not.toHaveBeenCalled();
    expect(db.pullRequestReport.findFirst).not.toHaveBeenCalled();
    expect(tested.refreshJudgedStatus).not.toHaveBeenCalled();
  });

});

describe("submitTestVerdict: good to merge needs a ready pull request, as reported (#255, #pr-reports)", () => {
  const tester = () => reviewer("r1", "rob");
  const recorded = () => db.testVerdict.create.mock.calls.length + db.testVerdict.update.mock.calls.length;
  /** What the caller is told: the reason, then what the author has to do. Nothing is posted (#review-entries). */
  const refusal = (result: unknown) => {
    expect(db.comment.create).not.toHaveBeenCalled();
    expect(db.bugActivity.create).not.toHaveBeenCalled();
    const { message, todo } = result as { message: string; todo: string };
    return `${message} What to do: ${todo}`;
  };

  it("records nothing while the reported checks are failing, and says what the author has to do", async () => {
    db.pullRequestReport.findFirst.mockResolvedValue(report({ checks: "failing" }));

    const result = await submitTestVerdict(tester(), "bug1", good);

    expect(result).toMatchObject({ status: 409, error: "not_ready", missing: "deployment_verification" });
    expect(recorded()).toBe(0);
    expect(refusal(result)).toMatch(/^The latest report says its checks are failing.*What to do: The author opens the pull request's Checks tab/);
    expect(notify.notifyMergeFailed).toHaveBeenCalledWith(expect.objectContaining({ recipientId: "ada" }));
  });

  it("always records a not-good-to-merge verdict, even when the pull request isn't ready", async () => {
    db.pullRequestReport.findFirst.mockResolvedValue(report({ checks: "failing" }));

    expect(await submitTestVerdict(tester(), "bug1", notGood("It breaks the tab bar."))).toMatchObject({ status: 201 });
    expect(db.comment.create).not.toHaveBeenCalled();
  });
});

describe("submitTestVerdict: a verdict is an entry with a summary and a description (#review-entries)", () => {
  it("refuses a bare verdict with 400, naming the missing field, before touching the issue", async () => {
    const rob = reviewer("r1", "rob");
    expect(await submitTestVerdict(rob, "bug1", { goodToMerge: true })).toMatchObject({ status: 400, error: "invalid_request", field: "summary", message: "Add a summary." });
    expect(await submitTestVerdict(rob, "bug1", { goodToMerge: true, summary: "Good." })).toMatchObject({ status: 400, field: "description" });
    expect(await submitTestVerdict(rob, "bug1", { goodToMerge: true, summary: "One. Two. Three.", description: "x" })).toMatchObject({
      status: 400,
      field: "summary",
      message: "Keep the summary to two sentences.",
    });
    expect(db.bug.findFirst).not.toHaveBeenCalled();
    expect(state.verdicts).toHaveLength(0);
  });
});

describe("submitTestVerdict: marketing work", () => {
  it("records a verdict on delivered marketing work without pull request or files", async () => {
    db.bug.findFirst.mockResolvedValue(
      bugRow({
        track: "marketing",
        pullRequestUrl: null,
        pullRequestHeadSha: null,
      }),
    );
    db.delivery.findFirst.mockResolvedValue({ id: "del-1", updatedAt: new Date() });

    const result = await submitTestVerdict(reviewer("r1", "rob"), "bug1", {
      goodToMerge: true,
      summary: "Looks great.",
      description: "Tested the deliverable copy and links.",
    });

    expect(result).toMatchObject({
      status: 201,
      verdict: {
        goodToMerge: true,
        summary: "Looks great.",
        pullRequestUrl: null,
        headSha: null,
      },
    });
    expect(state.verdicts[0]).toMatchObject({
      goodToMerge: true,
      pullRequestUrl: null,
      headSha: null,
      files: [],
    });
  });

  it("refuses marketing work that has no delivery record", async () => {
    db.bug.findFirst.mockResolvedValue(
      bugRow({
        track: "marketing",
        pullRequestUrl: null,
      }),
    );
    db.delivery.findFirst.mockResolvedValue(null);

    const result = await submitTestVerdict(reviewer("r1", "rob"), "bug1", {
      goodToMerge: true,
      summary: "Looks great.",
      description: "Tested the deliverable copy and links.",
    });

    expect(result).toMatchObject({
      status: 409,
      error: "not_delivered",
    });
  });

  it("requires files for product work", async () => {
    db.bug.findFirst.mockResolvedValue(bugRow({ track: "product" }));

    const result = await submitTestVerdict(reviewer("r1", "rob"), "bug1", {
      goodToMerge: true,
      summary: "Looks great.",
      description: "Tested it.",
    });

    expect(result).toMatchObject({
      status: 400,
      error: "invalid_request",
      field: "files",
    });
  });
});

describe("the Delivered rule after each judgement (#delivered-step)", () => {
  const judged = async () => (await vi.importActual<typeof import("@/lib/agent-api/tested-status")>("@/lib/agent-api/tested-status")).refreshJudgedStatus;
  const PULL = "https://github.com/emerjent/ziki/pull/9";
  function judgedDb(opts: {
    track?: "product" | "marketing";
    revisionCount?: number;
    substatus?: string;
    delivery?: { updatedAt: Date };
    verdicts: { owner: string; good?: boolean; agent?: string; level?: string; updatedAt?: Date }[];
  }) {
    const isMarketing = opts.track === "marketing";
    const bug = {
      id: "bug1",
      organisationId: "t1",
      projectId: "p1",
      status: "done",
      substatus: opts.substatus ?? "requires_review",
      track: opts.track ?? "product",
      revisionCount: opts.revisionCount ?? 0,
      pullRequestUrl: isMarketing ? null : PULL,
      assigneeId: "ada",
      beneficiaryUserId: "ada",
      reporterId: "rex",
      createdByAgentId: null,
      createdByAgent: null,
      claims: [{ id: "claim1", status: "active", claimedAt: new Date(), releasedAt: null, agentId: "solver", beneficiaryUserId: "ada", dispatcherUserId: null, agent: { ownerUserId: "ada" } }],
    };
    const delivery = opts.delivery ?? (isMarketing ? { id: "d1", updatedAt: new Date("2026-11-04T10:00:00Z"), pullRequestUrl: null, beneficiaryUserId: "ada" } : null);
    return {
      bug: { findUnique: vi.fn(async () => bug), update: vi.fn(async () => ({})) },
      delivery: {
        findFirst: vi.fn(async () => delivery),
        findMany: vi.fn(async () => (delivery ? [delivery] : [])),
      },
      testVerdict: {
        findMany: vi.fn(async () =>
          opts.verdicts.map((v, i) => ({
            goodToMerge: v.good ?? true,
            headSha: null,
            pullRequestUrl: isMarketing ? null : PULL,
            updatedAt: v.updatedAt ?? new Date("2026-11-04T12:00:00Z"),
            onBehalfOfUserId: v.owner,
            agent: { id: v.agent ?? `agent-${i}`, ownerUserId: v.owner, activations: [{ organisationId: "t1", level: v.level ?? "working" }] },
          })),
        ),
      },
      proofRule: { findMany: async () => [] },
      proofCheck: { findMany: async () => [] },
      issueClaim: { update: vi.fn(async () => ({})) },
      bugActivity: { create: vi.fn(async () => ({})) },
      agentEvent: { create: vi.fn(async () => ({ id: "e1" })) },
      webhookSubscription: { findMany: vi.fn(async () => []) },
      webhookDelivery: { createMany: vi.fn(async () => ({ count: 0 })) },
    };
  }

  it("moves delivered work to Accepted once good judgements weigh 3, and never on one agent alone", async () => {
    const refresh = await judged();
    const three = judgedDb({ verdicts: [{ owner: "rob" }, { owner: "sam" }, { owner: "tia" }] });
    expect(await refresh(three as never, "bug1", "sam")).toBe("accepted");
    expect(three.bug.update).toHaveBeenCalledWith({ where: { id: "bug1" }, data: { status: "done", substatus: "accepted" } });
    expect(await refresh(judgedDb({ verdicts: [{ owner: "rob" }, { owner: "sam" }] }) as never, "bug1", "sam")).toBeNull();
    // A manager agent's judgement weighs 2: not enough alone, enough with one working agent, the same owner's included.
    expect(await refresh(judgedDb({ verdicts: [{ owner: "ada", agent: "ada-manager", level: "manager" }] }) as never, "bug1", "ada")).toBeNull();
    expect(await refresh(judgedDb({ verdicts: [{ owner: "ada", agent: "ada-manager", level: "manager" }, { owner: "ada", agent: "ada-worker" }] }) as never, "bug1", "ada")).toBe("accepted");
  });

  it("sends it back to Open, releasing the claim and clearing the pull request, once as many say not good", async () => {
    const db = judgedDb({ verdicts: [{ owner: "rob", good: false }, { owner: "sam", good: false }, { owner: "tia", good: false }] });
    expect(await (await judged())(db as never, "bug1", "sam")).toBe("open");
    expect(db.issueClaim.update).toHaveBeenCalledWith({ where: { id: "claim1" }, data: { status: "released", releasedAt: expect.any(Date), releaseReason: "judged_not_good" } });
    expect(db.bug.update).toHaveBeenCalledWith({ where: { id: "bug1" }, data: { status: "open", substatus: "open", assigneeId: null, pullRequestUrl: null, pullRequestHeadSha: null } });
  });

  it("marketing track: 3 good judgements move delivered work to Accepted without a pull request", async () => {
    const refresh = await judged();
    const db = judgedDb({
      track: "marketing",
      verdicts: [{ owner: "rob" }, { owner: "sam" }, { owner: "tia" }],
    });
    expect(await refresh(db as never, "bug1", "sam")).toBe("accepted");
    expect(db.bug.update).toHaveBeenCalledWith({ where: { id: "bug1" }, data: { status: "done", substatus: "accepted" } });
  });

  it("marketing track: not good judgements use up a revision round and return to in_progress (same claim)", async () => {
    const refresh = await judged();
    const db = judgedDb({
      track: "marketing",
      revisionCount: 0,
      verdicts: [{ owner: "rob", good: false }, { owner: "sam", good: false }, { owner: "tia", good: false }],
    });
    expect(await refresh(db as never, "bug1", "sam")).toBe("in_progress");
    expect(db.bug.update).toHaveBeenCalledWith({
      where: { id: "bug1" },
      data: { status: "in_progress", substatus: "in_progress", revisionCount: 1 },
    });
    expect(db.issueClaim.update).not.toHaveBeenCalled();
  });

  it("marketing track: reaching revision limit reopens issue for bids and releases claim", async () => {
    const refresh = await judged();
    const db = judgedDb({
      track: "marketing",
      revisionCount: 2,
      verdicts: [{ owner: "rob", good: false }, { owner: "sam", good: false }, { owner: "tia", good: false }],
    });
    expect(await refresh(db as never, "bug1", "sam")).toBe("open");
    expect(db.bug.update).toHaveBeenCalledWith({
      where: { id: "bug1" },
      data: { status: "open", substatus: "open", assigneeId: null, revisionCount: 0 },
    });
    expect(db.issueClaim.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "claim1" },
        data: expect.objectContaining({ status: "released", releaseReason: "judged_not_good" }),
      }),
    );
  });

  it("counts a person's working agents once, and never the agent holding the claim", async () => {
    const refresh = await judged();
    expect(await refresh(judgedDb({ verdicts: [{ owner: "rob", agent: "a1" }, { owner: "rob", agent: "a2" }, { owner: "sam" }] }) as never, "bug1", "rob")).toBeNull();
    expect(await refresh(judgedDb({ verdicts: [{ owner: "ada", agent: "solver" }, { owner: "rob" }, { owner: "sam" }] }) as never, "bug1", "rob")).toBeNull();
    expect(await refresh(judgedDb({ verdicts: [{ owner: "rob" }, { owner: "sam" }, { owner: "ada" }] }) as never, "bug1", "rob")).toBe("accepted");
  });

  it("returns Accepted to Requires review when a judgement changes and the good count drops", async () => {
    const db = judgedDb({ substatus: "accepted", verdicts: [{ owner: "rob" }, { owner: "sam" }] });
    expect(await (await judged())(db as never, "bug1", "sam")).toBe("requires_review");
  });
});

describe("reviewJobSubmission: concurrent accepts (#584)", () => {
  it("serializes verdicts so the last accept sees the first and accepts the row once", async () => {
    const submission = {
      id: "submission-1",
      jobId: "job-1",
      agentId: "submitter-agent",
      beneficiaryUserId: "submitter",
      reviewsNeeded: 2,
      status: "pending",
      reviewedAt: null as Date | null,
      job: { id: "job-1", organisationId: "organisation_zedu", projectId: "p1", pointsPerAccepted: 25 },
    };
    const committedReviews: Array<Record<string, unknown>> = [];
    let awardCount = 0;
    let lockTail = Promise.resolve();

    db.$transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => {
      let releaseLock: (() => void) | undefined;
      const pendingReviews: Array<Record<string, unknown>> = [];
      const tx = {
        $queryRaw: async () => {
          const previous = lockTail;
          lockTail = new Promise<void>((resolve) => { releaseLock = resolve; });
          await previous;
          return [{ id: submission.id }];
        },
        jobSubmission: {
          findUnique: async () => ({ ...submission }),
          update: async ({ data }: { data: Partial<typeof submission> }) => {
            Object.assign(submission, data);
            return { ...submission };
          },
        },
        jobReview: {
          findFirst: async ({ where }: { where: { agentId: string } }) =>
            [...committedReviews, ...pendingReviews].find((row) => row.agentId === where.agentId) ?? null,
          findMany: async () => [...committedReviews, ...pendingReviews],
          create: async ({ data }: { data: Record<string, unknown> }) => {
            const row = { id: `review-${committedReviews.length + pendingReviews.length + 1}`, ...data };
            pendingReviews.push(row);
            return row;
          },
        },
        jobReviewOffer: {
          findFirst: async ({ where }: { where: { agentId: string } }) => ({
            id: `offer-${where.agentId}`,
            deadlineAt: new Date(Date.now() + 60_000),
          }),
          update: async () => ({}),
        },
        pointEntry: {
          createMany: async () => ({ count: ++awardCount === 1 ? 1 : 0 }),
        },
        agentAuditEvent: { create: async () => ({}) },
        agentEvent: { create: async () => ({ id: "job-review-event" }) },
        webhookSubscription: { findMany: async () => [] },
        webhookDelivery: { createMany: async () => ({ count: 0 }) },
      };

      try {
        const result = await callback(tx);
        committedReviews.push(...pendingReviews);
        return result;
      } finally {
        releaseLock?.();
      }
    });

    const [first, second] = await Promise.all([
      reviewJobSubmission(reviewer("reviewer-agent-1", "owner-1"), submission.id, { verdict: "accept" }),
      reviewJobSubmission(reviewer("reviewer-agent-2", "owner-2"), submission.id, { verdict: "accept" }),
    ]);

    expect([first.submission.status, second.submission.status].sort()).toEqual(["accepted", "pending"]);
    expect(submission.status).toBe("accepted");
    expect(committedReviews).toHaveLength(2);
    expect(awardCount).toBe(1);
  });
});

describe("sending marketing work back", () => {
  const marketing = (revisionCount: number) => ({ track: "marketing" as const, revisionCount });

  it("returns it to the same worker until the rounds are used up, then reopens it with a fresh count", () => {
    expect(afterSendBack(marketing(0), 2, "judgement")).toEqual({ substatus: "in_progress", keepsClaim: true, revisionCount: 1 });
    expect(afterSendBack(marketing(1), 2, "judgement")).toEqual({ substatus: "in_progress", keepsClaim: true, revisionCount: 2 });
    expect(afterSendBack(marketing(2), 2, "judgement")).toEqual({ substatus: "open", keepsClaim: false, revisionCount: 0 });
  });

  it("uses up a round when a manager rejects it too", () => {
    expect(afterSendBack(marketing(0), 2, "manager_reject")).toEqual({ substatus: "in_progress", keepsClaim: true, revisionCount: 1 });
    expect(afterSendBack(marketing(2), 2, "manager_reject")).toEqual({ substatus: "open", keepsClaim: false, revisionCount: 0 });
  });

  it("leaves product work as it is: judgements reopen it, a reject returns it", () => {
    const product = { track: "product" as const, revisionCount: 0 };
    expect(afterSendBack(product, 2, "judgement")).toEqual({ substatus: "open", keepsClaim: false, revisionCount: 0 });
    expect(afterSendBack(product, 2, "manager_reject")).toEqual({ substatus: "in_progress", keepsClaim: true, revisionCount: 0 });
  });

  it("counts only judgements since the latest marketing delivery, and product judgements by pull request", () => {
    const delivered = new Date("2026-11-04T10:00:00Z");
    const before = new Date("2026-11-04T09:00:00Z");
    const after = new Date("2026-11-04T11:00:00Z");
    const delivery = { updatedAt: delivered, pullRequestUrl: null };
    expect(judgementCounts("marketing", { updatedAt: before, pullRequestUrl: null }, delivery)).toBe(false);
    expect(judgementCounts("marketing", { updatedAt: after, pullRequestUrl: null }, delivery)).toBe(true);
    const pr = "https://github.com/emerjent/ziki/pull/1";
    expect(judgementCounts("product", { updatedAt: before, pullRequestUrl: pr }, { updatedAt: delivered, pullRequestUrl: pr })).toBe(true);
    expect(judgementCounts("product", { updatedAt: after, pullRequestUrl: "other" }, { updatedAt: delivered, pullRequestUrl: pr })).toBe(false);
  });
});

/** What stops testers judging a delivered pull request (#864). */
const blockGate = (overrides: Partial<PrGate> = {}): PrGate => ({
  canDeliver: true, canAccept: true, canReconcile: false, awaitingRelease: false, broken: null, needsReport: false, reason: null, ...overrides,
});
const blockReport = (overrides: Record<string, unknown> = {}) => ({ state: "open", mergeable: true, checks: "passing", ...overrides }) as Parameters<typeof judgeBlockKind>[1];

describe("judgeBlockKind", () => {
  it("is null for an open, mergeable pull request with passing checks, or none reported", () => {
    expect(judgeBlockKind(blockGate(), blockReport())).toBeNull();
    expect(judgeBlockKind(blockGate(), null)).toBeNull();
  });
  it("names a merge conflict, failing checks and a broken link", () => {
    expect(judgeBlockKind(blockGate(), blockReport({ mergeable: false }))).toBe("merge_conflict");
    expect(judgeBlockKind(blockGate(), blockReport({ checks: "failing" }))).toBe("deployment_verification");
    expect(judgeBlockKind(blockGate({ broken: "other_repository" }), blockReport())).toBe("pull_request");
  });
  it("waits for a fresh report before blocking on a stale one", () => {
    expect(judgeBlockKind(blockGate({ needsReport: true }), blockReport({ mergeable: false }))).toBeNull();
  });
});

describe("durable PR review offer expiry (#592)", () => {
  beforeEach(() => {
    db.reviewOffer.findMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
      if (Array.isArray(where.OR)) {
        const now = Date.now();
        return state.reviewOffers
          .filter((offer) =>
            (offer.status === "offered" && now - offer.offeredAt.getTime() >= REVIEW_OFFER_TTL_MS) ||
            (offer.status === "accepted" && (offer.deadlineAt === null || offer.deadlineAt.getTime() <= now)),
          )
          .map(({ id }) => ({ id }));
      }
      if (where.status && typeof where.status === "object" && "in" in where.status) {
        const statuses = (where.status as { in: string[] }).in;
        return state.reviewOffers
          .filter((offer) => statuses.includes(offer.status))
          .map(({ beneficiaryUserId, status, offeredAt, deadlineAt }) => ({ beneficiaryUserId, status, offeredAt, deadlineAt }));
      }
      if (where.beneficiaryUserId) {
        return state.reviewOffers.map(({ beneficiaryUserId, offeredAt }) => ({ beneficiaryUserId, offeredAt }));
      }
      return [];
    });
    db.reviewOffer.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
      const row = state.reviewOffers.find((offer) => offer.id === where.id);
      return row ? { ...row } : null;
    });
    db.reviewOffer.updateMany.mockImplementation(async ({ where, data }: {
      where: { id: string; status: string };
      data: Partial<(typeof state.reviewOffers)[number]>;
    }) => {
      const row = state.reviewOffers.find((offer) => offer.id === where.id && offer.status === where.status);
      if (!row) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    });
  });

  it("expires persisted offered and accepted rows once after their in-process timers are gone", async () => {
    const now = Date.now();
    state.reviewOffers = [
      {
        id: "offered-during-restart", bugId: "bug1", beneficiaryUserId: "reviewer-1", agentId: "agent-1",
        status: "offered", offeredAt: new Date(now - REVIEW_OFFER_TTL_MS - 1), deadlineAt: null,
        pullRequestUrl: PR, headSha: "head1",
      },
      {
        id: "accepted-during-restart", bugId: "bug1", beneficiaryUserId: "reviewer-2", agentId: "agent-2",
        status: "accepted", offeredAt: new Date(now - REVIEW_OFFER_TTL_MS * 2), deadlineAt: new Date(now - REVIEW_DEADLINE_MS - 1),
        pullRequestUrl: PR, headSha: "head1",
      },
    ];
    db.bug.findFirst.mockResolvedValue(bugRow({ status: "closed" }));

    await expect(sweepReviewOffers()).resolves.toEqual({ expired: 2 });
    expect(state.reviewOffers.map(({ status }) => status)).toEqual(["expired", "expired"]);
    await expect(sweepReviewOffers()).resolves.toEqual({ expired: 0 });
  });

  it("offers a replacement reviewer as part of the durable expiry transition", async () => {
    state.reviewOffers = [{
      id: "expired-accepted", bugId: "bug1", beneficiaryUserId: "reviewer-1", agentId: "agent-1",
      status: "accepted", offeredAt: new Date(Date.now() - REVIEW_OFFER_TTL_MS * 2),
      deadlineAt: new Date(Date.now() - REVIEW_DEADLINE_MS - 1), pullRequestUrl: PR, headSha: "head1",
    }];
    db.membership.findMany.mockResolvedValue([
      { userId: "reviewer-2", user: { agents: [{ id: "agent-2" }] } },
    ]);

    await expect(sweepReviewOffers()).resolves.toEqual({ expired: 1 });
    expect(state.reviewOffers.map(({ status }) => status)).toEqual(["expired", "offered"]);
    expect(db.reviewOffer.create).toHaveBeenCalledTimes(1);
    await expect(sweepReviewOffers()).resolves.toEqual({ expired: 0 });
    expect(db.reviewOffer.create).toHaveBeenCalledTimes(1);
  });
});

describe("late review-offer acceptance commits expiry (#532)", () => {
  function useRollbackAwareTransactions() {
    db.$transaction.mockImplementation(async (run: (tx: unknown) => unknown) => {
      const snapshot = {
        reviewOffers: structuredClone(state.reviewOffers),
        jobReviewOffers: structuredClone(state.jobReviewOffers),
      };
      try {
        return await run(db);
      } catch (error) {
        state.reviewOffers = snapshot.reviewOffers;
        state.jobReviewOffers = snapshot.jobReviewOffers;
        throw error;
      }
    });
  }

  it("keeps a PR offer expired and reoffers only once across repeated late accepts", async () => {
    const expiredOffer = {
      id: "late-pr-offer",
      bugId: "bug1",
      beneficiaryUserId: "reviewer-owner-1",
      agentId: "reviewer-agent-1",
      status: "offered",
      offeredAt: new Date(Date.now() - REVIEW_OFFER_TTL_MS - 1),
      deadlineAt: null,
      pullRequestUrl: PR,
      headSha: "head1",
    };
    state.reviewOffers = [expiredOffer];
    db.reviewOffer.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
      const row = state.reviewOffers.find((offer) => offer.id === where.id);
      return row ? { ...row, bug: bugRow({ organisationId: "organisation_zedu", projectId: "project1" }) } : null;
    });
    db.reviewOffer.updateMany.mockImplementation(async ({ where, data }: {
      where: { id: string; status: string };
      data: Partial<(typeof state.reviewOffers)[number]>;
    }) => {
      const row = state.reviewOffers.find((offer) => offer.id === where.id && offer.status === where.status);
      if (!row) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    });
    db.reviewOffer.findMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
      let offers = state.reviewOffers;
      const statusFilter = where.status;
      if (typeof statusFilter === "string") {
        offers = offers.filter((offer) => offer.status === statusFilter);
      } else if (statusFilter && typeof statusFilter === "object" && "in" in statusFilter) {
        const statuses = (statusFilter as { in?: unknown }).in;
        if (Array.isArray(statuses)) offers = offers.filter((offer) => statuses.includes(offer.status));
      }
      const beneficiaries = where.beneficiaryUserId as { in?: string[] } | undefined;
      if (beneficiaries?.in) offers = offers.filter((offer) => beneficiaries.in!.includes(offer.beneficiaryUserId));
      return offers.map(({ beneficiaryUserId, status, offeredAt, deadlineAt }) => ({ beneficiaryUserId, status, offeredAt, deadlineAt }));
    });
    db.membership.findMany.mockResolvedValue([
      { userId: "reviewer-owner-2", user: { agents: [{ id: "reviewer-agent-2" }] } },
    ]);
    useRollbackAwareTransactions();

    const agent = reviewer("reviewer-agent-1", "reviewer-owner-1");
    await expect(acceptReviewOffer(agent, expiredOffer.id)).rejects.toMatchObject({ status: 410 });
    expect(state.reviewOffers.map(({ status }) => status)).toEqual(["expired", "offered"]);

    await expect(acceptReviewOffer(agent, expiredOffer.id)).rejects.toMatchObject({ status: 410 });
    expect(state.reviewOffers.map(({ status }) => status)).toEqual(["expired", "offered"]);
    expect(db.reviewOffer.updateMany).toHaveBeenCalledTimes(1);
    expect(db.reviewOffer.create).toHaveBeenCalledTimes(1);
    expect(db.agentEvent.create).toHaveBeenCalledTimes(1);
  });

  it("keeps a job offer expired and creates no duplicate replacement on repeated late accepts", async () => {
    const expiredOffer = {
      id: "late-job-offer",
      submissionId: "submission1",
      agentId: "reviewer-agent-1",
      beneficiaryUserId: "reviewer-owner-1",
      status: "offered",
      offeredAt: new Date(Date.now() - REVIEW_OFFER_TTL_MS - 1),
    };
    const submission = {
      id: "submission1",
      jobId: "job1",
      agentId: "submitter-agent",
      beneficiaryUserId: "submitter-owner",
      reviewsNeeded: 1,
      status: "pending",
      job: { id: "job1", organisationId: "organisation_zedu", projectId: "project1", pointsPerAccepted: 1 },
    };
    state.jobReviewOffers = [expiredOffer];
    db.jobReviewOffer.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
      const row = state.jobReviewOffers.find((offer) => offer.id === where.id);
      return row ? { ...row, submission: { id: submission.id, job: { organisationId: "organisation_zedu" } } } : null;
    });
    db.jobReviewOffer.updateMany.mockImplementation(async ({ where, data }: {
      where: { id: string; status: string };
      data: Partial<(typeof state.jobReviewOffers)[number]>;
    }) => {
      const row = state.jobReviewOffers.find((offer) => offer.id === where.id && offer.status === where.status);
      if (!row) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    });
    db.jobReviewOffer.findMany.mockImplementation(async ({ where }: { where: { submissionId: string } }) =>
      state.jobReviewOffers
        .filter((offer) => offer.submissionId === where.submissionId)
        .map(({ beneficiaryUserId, status }) => ({ beneficiaryUserId, status })),
    );
    db.jobReviewOffer.create.mockImplementation(async ({ data }: { data: Omit<(typeof state.jobReviewOffers)[number], "id"> }) => {
      const row = { id: `job-review-${state.jobReviewOffers.length + 1}`, ...data };
      state.jobReviewOffers.push(row);
      return row;
    });
    db.jobReview.findMany.mockResolvedValue([]);
    db.jobSubmission.findUnique.mockResolvedValue(submission);
    db.membership.findMany.mockResolvedValue([
      { userId: "reviewer-owner-2", user: { agents: [{ id: "reviewer-agent-2" }] } },
    ]);
    useRollbackAwareTransactions();

    const agent = reviewer("reviewer-agent-1", "reviewer-owner-1");
    await expect(acceptJobReviewOffer(agent, expiredOffer.id)).rejects.toMatchObject({ status: 410 });
    expect(state.jobReviewOffers.map(({ status }) => status)).toEqual(["expired", "offered"]);

    await expect(acceptJobReviewOffer(agent, expiredOffer.id)).rejects.toMatchObject({ status: 410 });
    expect(state.jobReviewOffers.map(({ status }) => status)).toEqual(["expired", "offered"]);
    expect(db.jobReviewOffer.updateMany).toHaveBeenCalledTimes(1);
    expect(db.jobReviewOffer.create).toHaveBeenCalledTimes(1);
    expect(db.agentEvent.create).toHaveBeenCalledTimes(1);
  });
});

describe("deeper testing: what counts (#deeper-testing)", () => {
  const rules: ProofRules = {
    rules: [
      { id: "every", projectId: null, issueTypeId: null, projectAreaId: null, checks: ["fixed"] },
      { id: "fix", projectId: null, issueTypeId: "type-fix", projectAreaId: null, checks: ["repro"] },
      { id: "web", projectId: "p1", issueTypeId: null, projectAreaId: "area-web", checks: ["phone", "guide"] },
    ],
    custom: [{ id: "guide", name: "Keyboard only", instructions: "Tab through it.", required: false }],
  };
  const fixInWeb = { projectId: "p1", typeId: "type-fix", areaId: "area-web" };
  const pass = (attachmentId = "att") => ({ result: "pass" as const, attachmentId, shows: "It works on the delivered commit." });

  it("needs the organisation's checks for every issue and its type, and the project's for its area; guidance never holds a yes", () => {
    expect(checksFor(rules, fixInWeb)).toEqual({ on: true, required: ["fixed", "repro", "phone"], guidance: ["guide"] });
    expect(checksFor(rules, { projectId: "p2", typeId: null, areaId: "area-web" }).required).toEqual(["fixed"]);
    expect(checksFor({ rules: [], custom: [] }, fixInWeb)).toEqual({ on: false, required: [], guidance: [] });
  });

  it("counts every judgement, as before, where the organisation has no checks", () => {
    expect(countsWithProof({ goodToMerge: true, headSha: "abc1234", proof: null }, NO_CHECKS, "abc1234")).toBe(true);
    expect(countsWithProof({ goodToMerge: false, headSha: "abc1234", proof: null }, NO_CHECKS, "abc1234")).toBe(true);
  });

  it("counts a good-to-merge only with proof for every required check, on the delivered commit", () => {
    const checks = checksFor(rules, fixInWeb);
    const full = { checks: { fixed: pass(), repro: pass(), phone: { result: "na", reason: "No phone layout changed." } } };
    expect(countsWithProof({ goodToMerge: true, headSha: "abc1234", proof: null }, checks, "abc1234")).toBe(false);
    expect(judgementProof({ goodToMerge: true, headSha: "abc1234", proof: { checks: { fixed: pass() } } }, checks.required, "abc1234")).toEqual({ state: "no_proof", missing: ["repro", "phone"] });
    expect(countsWithProof({ goodToMerge: true, headSha: "abc1234", proof: full }, checks, "abc1234")).toBe(true);
    expect(countsWithProof({ goodToMerge: true, headSha: "0ld0000", proof: full }, checks, "abc1234")).toBe(false);
  });

  it("counts a not-good-to-merge only with proof of what fails, and never a yes that proves a fail", () => {
    const checks = checksFor(rules, fixInWeb);
    const fails = { checks: { phone: { result: "fail", attachmentId: "att", shows: "It fails on the delivered commit." } } };
    expect(countsWithProof({ goodToMerge: false, headSha: "abc1234", proof: null }, checks, "abc1234")).toBe(false);
    expect(countsWithProof({ goodToMerge: false, headSha: "abc1234", proof: fails }, checks, "abc1234")).toBe(true);
    expect(judgementProof({ goodToMerge: true, headSha: "abc1234", proof: fails }, checks.required, "abc1234").state).toBe("contradicts");
  });

  it("holds the issue while a square is unproven or proven to fail; risky rows need two; routed and benched rows never hold it", () => {
    const row = (id: string, extra: Partial<{ envs: string[]; needsTwo: boolean; source: "criteria" | "beyond"; route: "ci" | "env" }> = {}) => ({
      id,
      text: id,
      why: null,
      kind: null,
      proof: "screen" as const,
      envs: [],
      needsTwo: false,
      source: "criteria" as const,
      route: null,
      proofAttachmentId: null,
      decision: null,
      agent: null,
      ...extra,
    });
    const card = (verdicts: { id: string; proof: unknown }[], priority = "high") =>
      buildCard({
        rules,
        checks: { on: true, required: ["fixed"], guidance: [] },
        priority,
        deliveredSha: "abc1234",
        receipt: null,
        rows: [row("r1", { envs: ["Phone", "Desktop"] }), row("r2", { needsTwo: true }), row("r3", { route: "env" })],
        verdicts: verdicts.map((v) => ({ ...v, agent: { name: v.id }, goodToMerge: true, headSha: "abc1234" })),
      });
    expect(card([]).holes).toBe(4); // the check, two squares of r1, r2
    const proven = { checks: { fixed: pass() }, squares: { "r1@Phone": pass(), "r1@Desktop": pass(), r2: pass() } };
    expect(card([{ id: "Ivy", proof: proven }]).holes).toBe(1); // r2 needs a second tester
    expect(card([{ id: "Ivy", proof: proven }, { id: "Fern", proof: { squares: { r2: pass() } } }]).holes).toBe(0);
    expect(card([{ id: "Ivy", proof: { ...proven, squares: { ...proven.squares, "r1@Phone": { result: "fail", attachmentId: "att", shows: "It fails on the delivered commit." } } } }]).failed).toBe(1);
    // #921: a judgement sent with the full ID of the short delivered commit is on the same code.
    const full = "abc1234def5678abc1234def5678abc1234def56";
    const onFull = buildCard({
      rules,
      checks: { on: true, required: ["fixed"], guidance: [] },
      priority: "high",
      deliveredSha: "abc1234",
      receipt: null,
      rows: [row("r1", { envs: ["Phone", "Desktop"] }), row("r2", { needsTwo: true }), row("r3", { route: "env" })],
      verdicts: [{ id: "Ivy", proof: proven, agent: { name: "Ivy" }, goodToMerge: true, headSha: full }],
    });
    expect(onFull.holes).toBe(1);
    expect(judgementProof({ goodToMerge: true, headSha: full, proof: proven }, ["fixed"], "abc1234").state).not.toBe("earlier_code");
    expect(judgementProof({ goodToMerge: true, headSha: "fedcba98", proof: proven }, ["fixed"], "abc1234").state).toBe("earlier_code");

    const wild = Array.from({ length: 8 }, (_, i) => row(`w${i}`, { source: "beyond" }));
    const low = buildCard({ rules, checks: { on: true, required: [], guidance: [] }, priority: "low", deliveredSha: null, receipt: null, rows: wild, verdicts: [] });
    expect(low.rows.filter((r) => r.bench)).toHaveLength(2); // a low-priority card holds 6 squares
    expect(low.holes).toBe(6);
    // Criteria rows too: an author's 12 rows across 4 environments still hold no more than the card's size.
    const crit = Array.from({ length: 12 }, (_, i) => row(`c${i}`, { source: "criteria", envs: ["A", "B", "C", "D"] }));
    expect(buildCard({ rules, checks: { on: true, required: [], guidance: [] }, priority: "urgent", deliveredSha: null, receipt: null, rows: crit, verdicts: [] }).holes).toBe(12);
  });
});

describe("deeper testing: proof is your own (#deeper-testing)", () => {
  const pass = (attachmentId: string) => ({ result: "pass" as const, attachmentId, shows: "It works on the delivered commit." });

  it("refuses proof that cites someone else's upload on the issue, and stores nothing", async () => {
    db.attachment.updateMany.mockResolvedValue({ count: 0 });
    // att-ada is on the issue already, but Ada uploaded it, not Rob.
    db.attachment.findMany.mockImplementation(async ({ where }: { where: { uploaderId?: string } }) => (where.uploaderId === "rob" ? [] : [{ id: "att-ada", contentType: "image/png", size: 40_000 }]));
    const result = await submitTestVerdict(reviewer("r1", "rob"), "bug1", { ...good, proof: { checks: { fixed: pass("att-ada") } } });
    expect(result).toMatchObject({ status: 400, error: "invalid_request", field: "proof" });
    expect(db.attachment.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ uploaderId: "rob" }) }));
    expect(state.verdicts).toHaveLength(0);
  });

  it("doesn't let the card's author rate its own card", async () => {
    db.testCardRow.findFirst.mockResolvedValue({ agentId: "r1" });
    const result = await submitTestVerdict(reviewer("r1", "rob"), "bug1", { ...good, proof: { rating: "thorough" } });
    expect(result).toMatchObject({ status: 400, field: "proof" });
    expect(state.verdicts).toHaveLength(0);
  });
});

describe("deeper testing: nobody buries or dodges a card (#deeper-testing)", () => {
  const delivered = bugRow({ track: "product", priority: "high", typeId: null, areaId: null, claims: [] });
  const wildRow = { text: "Two tabs at once", source: "beyond", kind: "two_at_once" };
  const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { status: number; body: { error: string } }) => ({ status: error.status, error: error.body.error }));

  beforeEach(() => {
    db.bug.findFirst.mockResolvedValue(delivered);
    db.proofRule.findMany.mockResolvedValue([{ id: "every", projectId: null, issueTypeId: null, projectAreaId: null, checks: ["fixed"] }]);
    // Kestrel (k1) drew up the card.
    db.testCardRow.findFirst.mockImplementation(async ({ where }: { where: { id?: string } }) => (where.id ? { id: where.id, text: "Keyboard open", route: null, agentId: "k1" } : { agentId: "k1" }));
    db.testCardRow.count.mockResolvedValue(0);
  });
  afterEach(() => db.proofRule.findMany.mockImplementation(async () => []));

  it("lets only the card's author write criteria rows; others add wild rows", async () => {
    expect(await refusal(addTestCardRows(reviewer("f1", "fay"), "bug1", { rows: [{ text: "Composer stays up", source: "criteria" }] }))).toEqual({ status: 403, error: "not_card_author" });
    expect(db.testCardRow.createMany).not.toHaveBeenCalled();
  });

  it("caps the rows one tester adds, so nobody buries an issue in squares", async () => {
    db.testCardRow.count.mockResolvedValue(3);
    expect(await refusal(addTestCardRows(reviewer("f1", "fay"), "bug1", { rows: [wildRow] }))).toEqual({ status: 409, error: "too_many_rows" });
    expect(db.testCardRow.createMany).not.toHaveBeenCalled();
  });

  it("doesn't let a tester route away a row someone else wrote", async () => {
    expect(await refusal(actOnTestCardRow(reviewer("f1", "fay"), "bug1", "row1", { action: "cant_prove" }))).toEqual({ status: 403, error: "not_row_author" });
    expect(db.testCardRow.update).not.toHaveBeenCalled();
  });
});

describe("deeper testing: a file must show what it proves (#deeper-testing)", () => {
  const FILES: Record<string, { contentType: string; size: number }> = {
    shot: { contentType: "image/png", size: 48_000 },
    blank: { contentType: "image/png", size: 70 },
    log: { contentType: "text/plain", size: 900 },
  };
  const lookup = { file: (id: string) => FILES[id], rowProof: (id: string) => (id === "race" ? ("test" as const) : undefined), changed: ["tests/composer.test.ts"] };
  const entry = (attachmentId: string, test?: string) => ({ result: "pass" as const, attachmentId, shows: "What the tester saw on the commit.", test });

  it("takes a real screenshot for what you see, and a test's output with its file for a test", () => {
    expect(proofProblem({ checks: { phone: entry("shot"), regression: entry("log", "tests/composer.test.ts") }, squares: { race: entry("log", "tests/composer.test.ts") } }, lookup)).toBeNull();
  });

  it("refuses a blank image, a picture of a test, a log for a screenshot, and a test that isn't among the changed files", () => {
    expect(proofProblem({ checks: { phone: entry("blank") } }, lookup)).toMatch(/too small/);
    expect(proofProblem({ checks: { regression: entry("shot", "tests/composer.test.ts") } }, lookup)).toMatch(/picture can't prove a test/);
    expect(proofProblem({ squares: { "race@Phone": entry("shot") } }, lookup)).toMatch(/picture can't prove a test/);
    expect(proofProblem({ checks: { phone: entry("log") } }, lookup)).toMatch(/attach a screenshot/);
    expect(proofProblem({ checks: { regression: entry("log", "tests/other.test.ts") } }, lookup)).toMatch(/name the test/);
  });
});
