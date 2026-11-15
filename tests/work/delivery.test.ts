import { marketingDeliveryBodySchema } from "@/lib/validations/marketing";
import { trackRules } from "@/lib/marketing/track";
import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentContext } from "@/lib/agents/require-agent";

/** Delivering work (#pr-reports, #stranded-delivery, #owner-agents): only the claim holder delivers, or a manager agent on its behalf for a stranded pull request; a pull request reported merged, closed or missing can't be delivered. */
const PR = "https://github.com/emerjent/ziki/pull/615";

const db = vi.hoisted(() => {
  const project = { findFirst: vi.fn(), findUnique: vi.fn() };
  const outsideWorkImport = { findUnique: vi.fn(), create: vi.fn() };
  const expressImportGrant = { findUnique: vi.fn() };
  const tx = {
    project, outsideWorkImport, expressImportGrant,
    $queryRaw: vi.fn(),
    agent: { findUnique: vi.fn() },
    agentApiKey: { findUnique: vi.fn() },
    issueClaim: { findFirst: vi.fn() },
    agentActivation: { findUnique: vi.fn() },
    membership: { findUnique: vi.fn() },
    pullRequestReport: { create: vi.fn() },
    delivery: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    bug: { update: vi.fn(), updateMany: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
    agentAuditEvent: { update: vi.fn() },
    testVerdict: { updateMany: vi.fn() },
    bugActivity: { create: vi.fn() },
    attachment: { updateMany: vi.fn() },
  };
  return {
    tx,
    prisma: {
      agent: { findFirst: vi.fn() },
      project, outsideWorkImport, expressImportGrant,
      bug: { findFirst: vi.fn(), findUnique: vi.fn() },
      issueClaim: { findFirst: vi.fn() },
      reviewOffer: { findFirst: vi.fn() },
      agentAuditEvent: { findFirst: vi.fn() },
      pullRequestReport: { findFirst: vi.fn() },
      delivery: { findMany: vi.fn() },
      attachment: { count: vi.fn() },
      $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
    },
  };
});
vi.mock("@/lib/prisma", () => ({ prisma: db.prisma }));

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(), consumeBudget: vi.fn(), checkSecrets: vi.fn(),
  readPullRequest: vi.fn(),
  finalizeResolved: vi.fn(),
  audit: vi.fn(),
  publish: vi.fn(),
  createReviewOffers: vi.fn(async () => ({ offers: [] })),
  strandedDelivery: vi.fn(),
  refreshJudgedStatus: vi.fn(),
}));
vi.mock("@/lib/auth-helpers", () => ({ requireUser: mocks.requireUser }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/agents/rate-budget", () => ({ consumeAgentBudget: mocks.consumeBudget }));
vi.mock("@/lib/security/secret-guard", () => ({ checkPostForSecrets: mocks.checkSecrets, stringsIn: (value: unknown) => [{ field: "body", text: JSON.stringify(value) }] }));
vi.mock("@/lib/agents/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/agent-api/events", () => ({ publish: mocks.publish }));
vi.mock("@/lib/agent-api/review-offer", () => ({ createReviewOffers: mocks.createReviewOffers }));
vi.mock("@/lib/agent-api/stranded-delivery", () => ({ STRANDED_AFTER_MS: 2 * 60 * 60 * 1000, strandedDelivery: mocks.strandedDelivery }));
vi.mock("@/lib/agent-api/tested-status", () => ({ refreshJudgedStatus: mocks.refreshJudgedStatus }));
vi.mock("@/lib/github/client", () => ({ githubClientFor: vi.fn(async () => ({})), GitHubError: class extends Error {} }));
vi.mock("@/lib/github/pull-request-snapshot", () => ({ readPullRequest: mocks.readPullRequest }));
vi.mock("@/lib/agent-api/merge", () => ({ finalizeResolved: mocks.finalizeResolved }));

import { deliverWork } from "@/lib/agent-api/delivery";
import { importOutsideWork, outsideWorkSchema } from "@/lib/agent-api/outside-work";
import { outsideWorkPullRequest } from "@/lib/outside-work";
import { importOutsideWorkAction } from "@/app/actions/import-outside-work";

const agent = (level: AgentContext["level"], ownerId = "dana"): AgentContext => ({
  agentId: `agent-${ownerId}`,
  name: `${ownerId}'s agent`,
  ownerId,
  organisationId: "t1",
  level,
  burst: false,
  keyId: "k1",
});

const body = (pullRequestUrl = PR) => ({
  pullRequestUrl,
  summary: "Delivers the fix in pull request 615.",
  description: "The pull request was linked by hand before deliveries existed; its judgements say it is good to merge.",
  testResults: "Three independent judgements: good to merge.",
});

const stranded = { pullRequestUrl: PR, creditedUserId: "ada", linkedAt: new Date("2026-10-01T10:00:00Z"), goodVerdicts: 2, needed: 2 };

describe("outside-board imports (#788)", () => {
  const input = () => ({ title: "Fix Save", ...body() });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireUser.mockResolvedValue({ id: "ada", role: "user" });
    mocks.consumeBudget.mockResolvedValue({ allowed: true });
    mocks.checkSecrets.mockResolvedValue({ ok: true });
    const project = { organisationId: "t1", slug: "web", organisation: { slug: "acme" }, archivedAt: null, repoUrl: "https://github.com/emerjent/ziki", githubInstallationId: null, repositories: [] };
    db.prisma.project.findFirst.mockResolvedValue(project);
    db.prisma.project.findUnique.mockResolvedValue(project);
    db.prisma.expressImportGrant.findUnique.mockResolvedValue({ agentId: "agent-ada", projectId: "p1" });
    db.prisma.outsideWorkImport.findUnique.mockResolvedValue(null);
    db.tx.agent.findUnique.mockResolvedValue({ ownerUserId: "ada", revokedAt: null, pausedAt: null });
    db.tx.agentApiKey.findUnique.mockResolvedValue({ revokedAt: null });
    db.tx.agentActivation.findUnique.mockResolvedValue({ deactivatedAt: null });
    db.tx.membership.findUnique.mockResolvedValue({ id: "membership" });
    db.tx.bug.findMany.mockResolvedValue([]);
    db.tx.bug.create.mockResolvedValue({ id: "imported", number: 8, status: "done", substatus: "requires_review", pullRequestUrl: PR });
    db.prisma.agent.findFirst.mockResolvedValue({ id: "agent-ada", name: "Ada's agent", username: "adas-agent", tagline: "Review carefully", about: "I test changes", pausedAt: null, _count: { skills: 1 }, activations: [{ level: "working", burst: false, burstUntil: null }], apiKeys: [{ id: "k1" }] });
    mocks.readPullRequest.mockResolvedValue({
      state: "open", url: PR, headSha: "abc1234", fetchedAt: "2026-11-12T20:00:00Z",
      checksSummary: "passing", mergeable: true, inDefaultBranch: null, mergeCommitSha: null, baseRef: "main",
    });
  });

  it("creates an attributed delivery at Requires review and asks reviewers, without a claim", async () => {
    const result = await importOutsideWork(agent("working", "ada"), "p1", input(), "request-1");
    expect(result).toMatchObject({ replayed: false, issue: { substatus: "requires_review" } });
    expect(db.tx.bug.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      status: "done", substatus: "requires_review", assigneeId: "ada", createdByAgentId: "agent-ada", beneficiaryUserId: "ada",
    }) }));
    expect(db.tx.delivery.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ agentId: "agent-ada", beneficiaryUserId: "ada", headSha: "abc1234" }) }));
    expect(mocks.createReviewOffers).toHaveBeenCalledWith(db.prisma, expect.objectContaining({ agentId: "agent-ada" }), "imported", expect.objectContaining({ pullRequestUrl: PR }));
    expect(db.prisma.issueClaim.findFirst).not.toHaveBeenCalled();
    expect(mocks.finalizeResolved).not.toHaveBeenCalled();
  });
  it("imports through the platform form for the signed-in owner's own agent", async () => {
    expect(await importOutsideWorkAction("agent-ada", "p1", input(), "form-1")).toEqual({ ok: true, href: "/acme/web/8", number: 8 });
    expect(db.prisma.agent.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "agent-ada", ownerUserId: "ada", revokedAt: null } }));
  });
  it("returns useful form errors for missing evidence, unowned agents, denied grants and secrets", async () => {
    expect(await importOutsideWorkAction("agent-ada", "p1", { ...input(), testResults: undefined }, "form-2")).toMatchObject({ ok: false, error: expect.stringContaining("Include screenshots or test results") });
    db.prisma.agent.findFirst.mockResolvedValueOnce(null);
    expect(await importOutsideWorkAction("agent-other", "p1", input(), "form-3")).toMatchObject({ ok: false, error: expect.stringContaining("your own active agent") });
    db.prisma.expressImportGrant.findUnique.mockResolvedValue(null);
    expect(await importOutsideWorkAction("agent-ada", "p1", input(), "form-4")).toMatchObject({ ok: false, error: expect.stringContaining("must grant this agent") });
    mocks.checkSecrets.mockResolvedValue({ ok: false, message: "Remove the credential from this import." });
    expect(await importOutsideWorkAction("agent-ada", "p1", input(), "form-5")).toMatchObject({ ok: false, error: "Remove the credential from this import." });
    expect(db.tx.bug.create).not.toHaveBeenCalled();
  });

  it("imports a verified merged PR as Live through the held-payout path, without pre-merge testers", async () => {
    mocks.readPullRequest.mockResolvedValue({ state: "merged", url: PR, headSha: "abc1234", fetchedAt: "2026-11-12T20:00:00Z", inDefaultBranch: true, mergeCommitSha: "def5678", baseRef: "main" });
    const result = await importOutsideWork(agent("working", "ada"), "p1", input(), "request-2");
    expect(result.issue).toMatchObject({ status: "resolved", substatus: "on_dev" });
    expect(mocks.finalizeResolved).toHaveBeenCalledWith(db.tx, expect.objectContaining({
      claim: null, solverUserId: "ada", solverAgentId: "agent-ada", rewardedReviewerUserIds: [], mergeCommitSha: "def5678",
    }));
    expect(mocks.createReviewOffers).not.toHaveBeenCalled();
  });

  it.each([false, null])("keeps merged work in Merge when default-branch inclusion is %s", async (inDefaultBranch) => {
    mocks.readPullRequest.mockResolvedValue({ state: "merged", url: PR, fetchedAt: "2026-11-12T20:00:00Z", inDefaultBranch, baseRef: "staging" });
    await importOutsideWork(agent("working", "ada"), "p1", input(), "request-3");
    expect(db.tx.bug.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "merge", substatus: "ready_to_merge" }) }));
    expect(mocks.finalizeResolved).not.toHaveBeenCalled();
    expect(mocks.createReviewOffers).not.toHaveBeenCalled();
  });

  it("refuses an ungranted agent before querying GitHub", async () => {
    db.prisma.expressImportGrant.findUnique.mockResolvedValue(null);
    await expect(importOutsideWork(agent("merger", "ada"), "p1", input(), "request-4")).rejects.toMatchObject({ status: 403 });
    expect(mocks.readPullRequest).not.toHaveBeenCalled();
    expect(db.tx.bug.create).not.toHaveBeenCalled();
  });

  it("rechecks revocation after the GitHub request", async () => {
    db.prisma.expressImportGrant.findUnique.mockResolvedValueOnce({}).mockResolvedValueOnce(null);
    await expect(importOutsideWork(agent("working", "ada"), "p1", input(), "request-5")).rejects.toMatchObject({ status: 403 });
    expect(db.tx.bug.create).not.toHaveBeenCalled();
  });

  it("rejects a key revoked while GitHub was being read", async () => {
    db.tx.agentApiKey.findUnique.mockResolvedValue({ revokedAt: new Date() });
    await expect(importOutsideWork(agent("working", "ada"), "p1", input(), "revoked-key")).rejects.toMatchObject({ status: 403 });
    expect(db.tx.bug.create).not.toHaveBeenCalled();
  });

  it.each(["closed", "not_found"])("rejects a %s PR without creating an issue", async (state) => {
    mocks.readPullRequest.mockResolvedValue({ state });
    await expect(importOutsideWork(agent("working", "ada"), "p1", input(), "request-6")).rejects.toMatchObject({ status: 422 });
    expect(db.tx.bug.create).not.toHaveBeenCalled();
  });

  it("rejects an unrelated repository before making a GitHub request", async () => {
    await expect(importOutsideWork(agent("working", "ada"), "p1", { ...input(), pullRequestUrl: "https://github.com/another/repo/pull/1" }, "request-7")).rejects.toMatchObject({ status: 422 });
    expect(mocks.readPullRequest).not.toHaveBeenCalled();
  });

  it("replays identical submissions without another delivery, network request or payout", async () => {
    const { hashCreateRequest } = await import("@/lib/agent-api/create-policy");
    const requestHash = hashCreateRequest({ ...input(), projectId: "p1", screenshots: [] });
    db.prisma.outsideWorkImport.findUnique.mockResolvedValue({ requestHash, bug: { id: "existing", status: "resolved" } });
    expect(await importOutsideWork(agent("working", "ada"), "p1", input(), "request-8")).toMatchObject({ replayed: true, issue: { id: "existing" } });
    expect(mocks.readPullRequest).not.toHaveBeenCalled();
    expect(mocks.finalizeResolved).not.toHaveBeenCalled();
    expect(db.tx.bug.create).not.toHaveBeenCalled();
  });

  it("refuses changed payloads under a used key and PRs already recorded on the board", async () => {
    db.prisma.outsideWorkImport.findUnique.mockResolvedValueOnce({ requestHash: "different", bug: { id: "existing" } });
    await expect(importOutsideWork(agent("working", "ada"), "p1", input(), "request-9")).rejects.toMatchObject({ status: 409 });
    db.prisma.outsideWorkImport.findUnique.mockResolvedValue(null);
    db.tx.bug.findMany.mockResolvedValue([{ id: "board-issue", pullRequestUrl: "https://github.com/EMERJENT/ZIKI/pull/615/files#diff" }]);
    await expect(importOutsideWork(agent("working", "ada"), "p1", input(), "request-10")).rejects.toMatchObject({ status: 409 });
    expect(db.tx.bug.create).not.toHaveBeenCalled();
  });

  it("requires evidence and a retry key, and does not accept a caller-selected status", async () => {
    expect(outsideWorkSchema.safeParse({ ...input(), testResults: undefined }).success).toBe(false);
    expect(outsideWorkSchema.safeParse({ ...input(), status: "resolved" }).success).toBe(false);
    await expect(importOutsideWork(agent("working", "ada"), "p1", input(), null)).rejects.toMatchObject({ status: 400 });
    expect(outsideWorkPullRequest("https://github.com/EMERJENT/ZIKI/pull/615/files?x=1#diff")?.url).toBe(PR);
    expect(outsideWorkPullRequest("http://github.com/emerjent/ziki/pull/615")).toBeNull();
  });
});

/** Issue #615: In progress, a pull request linked by hand, assigned to Ada, nobody holding a claim. */
describe("revising an imported delivery after manager rejection (#788)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.prisma.bug.findFirst.mockResolvedValue({ id: "bug1", projectId: "p1", status: "in_progress", substatus: "in_progress", pullRequestUrl: PR, outsideWork: { agentId: "agent-ada" }, project: { repoUrl: "https://github.com/emerjent/ziki" } });
    db.prisma.issueClaim.findFirst.mockResolvedValue(null);
    db.prisma.reviewOffer.findFirst.mockResolvedValue(null);
    db.prisma.agentAuditEvent.findFirst.mockResolvedValue(null);
    db.prisma.pullRequestReport.findFirst.mockResolvedValue(null);
    db.tx.bug.findUnique.mockResolvedValue({ status: "in_progress", pullRequestUrl: PR, assigneeId: "ada" });
    db.tx.issueClaim.findFirst.mockResolvedValue(null);
    db.tx.delivery.findUnique.mockResolvedValue({ id: "d1" });
    db.tx.delivery.update.mockResolvedValue({ id: "d1" });
    db.prisma.delivery.findMany.mockResolvedValue([{ id: "d1", agentId: "agent-ada", beneficiaryUserId: "ada", summary: body().summary, description: body().description, pullRequestUrl: PR, screenshots: [], testResults: "passed", agent: { name: "Ada's agent" }, beneficiary: { name: "Ada" }, replies: [] }]);
  });
  it("lets the original importer revise its unclaimed delivery and sends it through review again", async () => {
    expect(await deliverWork(agent("working", "ada"), "bug1", body())).toMatchObject({ status: 200, replaced: true, delivery: { agentId: "agent-ada" } });
    expect(db.tx.bug.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "done", substatus: "requires_review" }) }));
  });
  it("an on-call guest's delivery doesn't end its stay: guests stay (14 Nov plan, D2)", async () => {
    await deliverWork(agent("working", "ada"), "bug1", body());
    const asMember = db.prisma.$transaction.mock.calls.length;
    db.prisma.$transaction.mockClear();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await deliverWork({ ...agent("working", "ada"), guest: true }, "bug1", body())).toMatchObject({ status: 200 });
    // The same work as any agent's delivery, and nothing more: no extra transaction ends the stay.
    expect(db.prisma.$transaction.mock.calls.length).toBe(asMember);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
  it("does not let another unclaimed agent replace that delivery", async () => {
    expect(await deliverWork(agent("working", "bob"), "bug1", body())).toMatchObject({ status: 409, error: "no_claim" });
    expect(db.tx.delivery.update).not.toHaveBeenCalled();
  });
  it("refuses a revision if a new holder appeared before the transaction locked the issue", async () => {
    db.tx.issueClaim.findFirst.mockResolvedValue({ id: "new-holder" });
    await expect(deliverWork(agent("working", "ada"), "bug1", body())).rejects.toMatchObject({ status: 409 });
    expect(db.tx.delivery.update).not.toHaveBeenCalled();
  });
});

function issue(overrides: { reporterId?: string } = {}) {
  db.prisma.bug.findFirst.mockResolvedValue({
    id: "bug1",
    projectId: "p1",
    status: "in_progress", substatus: "in_progress",
    pullRequestUrl: PR,
    project: { repoUrl: "https://github.com/emerjent/ziki" },
  });
  db.prisma.bug.findUnique.mockResolvedValue({
    beneficiaryUserId: "rex",
    reporterId: overrides.reporterId ?? "rex",
    assigneeId: "ada",
    createdByAgent: null,
    claims: [],
  });
}

describe("deliverWork: a manager agent delivers a stranded pull request on the holder's behalf (#stranded-delivery)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    issue();
    db.prisma.issueClaim.findFirst.mockResolvedValue(null);
    db.prisma.reviewOffer.findFirst.mockResolvedValue(null);
    db.prisma.agentAuditEvent.findFirst.mockResolvedValue(null);
    db.prisma.pullRequestReport.findFirst.mockResolvedValue(null);
    db.prisma.delivery.findMany.mockResolvedValue([
      {
        id: "d1",
        agentId: "agent-dana",
        beneficiaryUserId: "ada",
        summary: body().summary,
        description: body().description,
        pullRequestUrl: PR,
        headSha: null,
        screenshots: [],
        testResults: body().testResults,
        createdAt: new Date(),
        updatedAt: new Date(),
        agent: { name: "dana's agent" },
        beneficiary: { name: "Ada" },
        replies: [],
      },
    ]);
    db.tx.delivery.findUnique.mockResolvedValue(null);
    db.tx.delivery.create.mockResolvedValue({ id: "d1" });
    mocks.strandedDelivery.mockResolvedValue(stranded);
    mocks.refreshJudgedStatus.mockResolvedValue("accepted");
  });

  it("files the delivery as the manager agent, credits the holder, marks it on their behalf and evaluates the judgements at once", async () => {
    const result = await deliverWork(agent("manager"), "bug1", body());
    expect(result).toMatchObject({ status: 201, replaced: false });
    expect(db.tx.delivery.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ bugId: "bug1", agentId: "agent-dana", beneficiaryUserId: "ada", pullRequestUrl: PR }) }),
    );
    expect(db.tx.bug.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "done", substatus: "requires_review" }) }));
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      "issue.delivered",
      "bug:bug1",
      expect.objectContaining({ onBehalfOf: true, filedBy: "agent-dana", creditedUserId: "ada" }),
      expect.anything(),
    );
    expect(mocks.refreshJudgedStatus).toHaveBeenCalledWith(db.prisma, "bug1", "dana");
    // Already Done on the existing judgements: no reviewers are asked for more.
    expect(mocks.createReviewOffers).not.toHaveBeenCalled();
  });

  it("keeps 409 no_claim for a working agent without a claim, even on a stranded issue", async () => {
    expect(await deliverWork(agent("working"), "bug1", body())).toMatchObject({ status: 409, error: "no_claim" });
    expect(mocks.strandedDelivery).not.toHaveBeenCalled();
  });

  it("lets the credited person's own manager agent deliver it too (#owner-agents)", async () => {
    expect(await deliverWork(agent("manager", "ada"), "bug1", body())).toMatchObject({ status: 201 });
  });

  it("answers 409 wrong_pull_request unless it delivers the linked pull request", async () => {
    const result = await deliverWork(agent("manager"), "bug1", body("https://github.com/emerjent/ziki/pull/700"));
    expect(result).toMatchObject({ status: 409, error: "wrong_pull_request", field: "pullRequestUrl" });
    expect(db.prisma.$transaction).not.toHaveBeenCalled();
  });

});

/** The latest independent report on the pull request (#pr-reports). */
const report = (state: "open" | "closed" | "merged" | "not_found", overrides: Record<string, unknown> = {}) => ({
  id: "r1",
  bugId: "bug1",
  pullRequestUrl: PR,
  state,
  mergedInto: state === "merged" ? "main" : null,
  inDefaultBranch: state === "merged" ? true : null,
  headSha: null,
  mergeCommitSha: null,
  checks: null,
  mergeable: null,
  note: "Checked it on GitHub.",
  agentId: "agent-rex",
  onBehalfOfUserId: "rex",
  createdAt: new Date("2026-10-30T09:00:00Z"),
  agent: { name: "rex's agent" },
  onBehalfOf: { name: "Rex" },
  ...overrides,
});

describe("deliverWork: the latest pull request report decides whether it can be delivered (#pr-reports)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    issue();
    db.prisma.issueClaim.findFirst.mockResolvedValue({ id: "c1", beneficiaryUserId: "ada" });
    db.prisma.reviewOffer.findFirst.mockResolvedValue(null);
    db.prisma.agentAuditEvent.findFirst.mockResolvedValue(null);
    db.prisma.pullRequestReport.findFirst.mockResolvedValue(null);
    db.prisma.delivery.findMany.mockResolvedValue([
      {
        id: "d1",
        agentId: "agent-ada",
        beneficiaryUserId: "ada",
        summary: body().summary,
        description: body().description,
        pullRequestUrl: PR,
        headSha: "abc1234",
        screenshots: [],
        testResults: body().testResults,
        createdAt: new Date(),
        updatedAt: new Date(),
        agent: { name: "ada's agent" },
        beneficiary: { name: "Ada" },
        replies: [],
      },
    ]);
    db.tx.delivery.findUnique.mockResolvedValue(null);
    db.tx.delivery.create.mockResolvedValue({ id: "d1" });
  });

  it("refuses a pull request reported merged, closed or missing, naming who reported it", async () => {
    for (const [state, error] of [
      ["merged", "pull_request_merged"],
      ["closed", "pull_request_closed"],
      ["not_found", "pull_request_not_found"],
    ] as const) {
      db.prisma.pullRequestReport.findFirst.mockResolvedValueOnce(report(state));
      const result = await deliverWork(agent("working", "ada"), "bug1", body());
      expect(result).toMatchObject({ status: 422, error });
      expect((result as { message: string }).message).toContain("rex's agent");
    }
    expect(db.prisma.pullRequestReport.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { bugId: "bug1", pullRequestUrl: PR } }));
    expect(db.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("delivers when nobody has reported the pull request yet, recording the head commit the deliverer sent", async () => {
    const result = await deliverWork(agent("working", "ada"), "bug1", { ...body(), headSha: "abc1234" });
    expect(result).toMatchObject({ status: 201 });
    expect(db.tx.delivery.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ headSha: "abc1234" }) }));
    expect(db.tx.bug.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ pullRequestHeadSha: "abc1234", status: "done", substatus: "requires_review" }) }));
    expect(mocks.publish).toHaveBeenCalledWith(db.tx, expect.objectContaining({ type: "issue.delivered", payload: expect.objectContaining({ headSha: "abc1234" }) }));
  });

  it("refuses a head commit that isn't a hexadecimal SHA", async () => {
    expect(await deliverWork(agent("working", "ada"), "bug1", { ...body(), headSha: "not-a-sha" })).toMatchObject({ status: 400, field: "headSha" });
  });
});

/** #replacement-pr: an accepted fix is bound to its pull request unless that one is reported closed without merging. */
describe("deliverWork: a replacement for an accepted pull request that was closed unmerged (#replacement-pr)", () => {
  const OLD = "https://github.com/emerjent/ziki/pull/600";
  const NEW = "https://github.com/emerjent/ziki/pull/615";

  /** The latest report per pull request address; none for an address not listed. */
  function reports(byUrl: Record<string, ReturnType<typeof report> | null>) {
    db.prisma.pullRequestReport.findFirst.mockImplementation(async ({ where }: { where: { pullRequestUrl: string } }) => byUrl[where.pullRequestUrl] ?? null);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // Done · Accepted, the accepted pull request #600 linked.
    db.prisma.bug.findFirst.mockResolvedValue({
      id: "bug1",
      projectId: "p1",
      status: "merge",
      substatus: "error",
      pullRequestUrl: OLD,
      project: { repoUrl: "https://github.com/emerjent/ziki" },
    });
    db.prisma.issueClaim.findFirst.mockResolvedValue({ id: "c1", beneficiaryUserId: "ada" });
    db.prisma.reviewOffer.findFirst.mockResolvedValue(null);
    db.prisma.agentAuditEvent.findFirst.mockResolvedValue({ id: "accept1", payload: { pullRequestUrl: OLD } });
    db.prisma.delivery.findMany.mockResolvedValue([
      {
        id: "d1", agentId: "agent-ada", beneficiaryUserId: "ada", summary: body().summary, description: body().description,
        pullRequestUrl: NEW, headSha: null, screenshots: [], testResults: body().testResults,
        createdAt: new Date(), updatedAt: new Date(), agent: { name: "ada's agent" }, beneficiary: { name: "Ada" }, replies: [],
      },
    ]);
    db.tx.delivery.findUnique.mockResolvedValue(null);
    db.tx.delivery.create.mockResolvedValue({ id: "d1" });
  });

  it("delivers the replacement when the accepted pull request is reported closed, and restarts review", async () => {
    reports({ [OLD]: report("closed", { pullRequestUrl: OLD }), [NEW]: null });
    const result = await deliverWork(agent("working", "ada"), "bug1", body(NEW));
    expect(result).toMatchObject({ status: 201 });
    // The acceptance is cleared, so it gates nothing and the new pull request is judged afresh.
    expect(db.tx.agentAuditEvent.update).toHaveBeenCalledWith({ where: { id: "accept1" }, data: { undoneAt: expect.any(Date) } });
    expect(db.tx.bug.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "done", substatus: "requires_review" }) }));
    expect(db.tx.bug.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "done", substatus: "requires_review", pullRequestUrl: NEW }) }));
    // It records what it replaces, on the activity, the audit row and the event.
    expect(db.tx.bugActivity.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ metadata: expect.objectContaining({ replacesPullRequestUrl: OLD }) }) }),
    );
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), "issue.delivered", "bug:bug1", expect.objectContaining({ replacesPullRequestUrl: OLD, pullRequestUrl: NEW }), expect.anything());
    expect(mocks.publish).toHaveBeenCalledWith(db.tx, expect.objectContaining({ type: "issue.delivered", payload: expect.objectContaining({ replacesPullRequestUrl: OLD }) }));
    // New reviewers are asked for the new code.
    expect(mocks.createReviewOffers).toHaveBeenCalled();
  });

  it("answers 409 accepted_pull_request while the accepted pull request is reported open", async () => {
    reports({ [OLD]: report("open", { pullRequestUrl: OLD }) });
    expect(await deliverWork(agent("working", "ada"), "bug1", body(NEW))).toMatchObject({ status: 409, error: "accepted_pull_request" });
    expect(db.prisma.$transaction).not.toHaveBeenCalled();
    expect(db.tx.agentAuditEvent.update).not.toHaveBeenCalled();
  });

  it("answers 409 accepted_pull_request when the accepted pull request is reported merged", async () => {
    reports({ [OLD]: report("merged", { pullRequestUrl: OLD }) });
    expect(await deliverWork(agent("working", "ada"), "bug1", body(NEW))).toMatchObject({ status: 409, error: "accepted_pull_request" });
    expect(db.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("answers 409 accepted_pull_request when nobody has reported the accepted pull request", async () => {
    reports({});
    expect(await deliverWork(agent("working", "ada"), "bug1", body(NEW))).toMatchObject({ status: 409, error: "accepted_pull_request" });
    expect(db.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("still refuses a replacement that is itself reported closed", async () => {
    reports({ [OLD]: report("closed", { pullRequestUrl: OLD }), [NEW]: report("closed", { pullRequestUrl: NEW }) });
    expect(await deliverWork(agent("working", "ada"), "bug1", body(NEW))).toMatchObject({ status: 422, error: "pull_request_closed" });
    expect(db.tx.agentAuditEvent.update).not.toHaveBeenCalled();
  });

  it("changes nothing for the accepted pull request itself, even when it is closed", async () => {
    reports({ [OLD]: report("closed", { pullRequestUrl: OLD }) });
    expect(await deliverWork(agent("working", "ada"), "bug1", body(OLD))).toMatchObject({ status: 422, error: "pull_request_closed" });
    expect(db.tx.agentAuditEvent.update).not.toHaveBeenCalled();
  });

  it("does not restart review when there is no standing acceptance", async () => {
    db.prisma.agentAuditEvent.findFirst.mockResolvedValue(null);
    reports({ [OLD]: report("closed", { pullRequestUrl: OLD }) });
    expect(await deliverWork(agent("working", "ada"), "bug1", body(NEW))).toMatchObject({ status: 201 });
    expect(db.tx.agentAuditEvent.update).not.toHaveBeenCalled();
    expect(db.tx.bug.updateMany).not.toHaveBeenCalled();
  });
});

describe("a marketing delivery", () => {
  const body = { summary: "Wrote the launch post.", description: "Published it and checked its links.", deliverableUrls: ["https://example.com/post"] };

  it("needs no pull request, and product work still does", () => {
    expect(trackRules("marketing").needsPullRequest).toBe(false);
    expect(trackRules("product").needsPullRequest).toBe(true);
    expect(marketingDeliveryBodySchema.safeParse(body).success).toBe(true);
  });

  it("takes files alongside links, and needs at least one of them", () => {
    expect(marketingDeliveryBodySchema.safeParse({ summary: body.summary, description: body.description, attachmentIds: ["att_1"] }).success).toBe(true);
    expect(marketingDeliveryBodySchema.safeParse({ summary: body.summary, description: body.description }).success).toBe(false);
  });

  it("takes the work itself as Markdown, without a link or file, up to the limit", () => {
    const written = { summary: body.summary, description: body.description, deliverableText: "# The post\n\nIt went out." };
    expect(marketingDeliveryBodySchema.safeParse(written).success).toBe(true);
    expect(marketingDeliveryBodySchema.safeParse({ ...written, deliverableText: "   " }).success).toBe(false);
    expect(marketingDeliveryBodySchema.safeParse({ ...written, deliverableText: "x".repeat(50_001) }).success).toBe(false);
  });

  it("refuses no link, a link that isn't http or https, and a pull request", () => {
    expect(marketingDeliveryBodySchema.safeParse({ ...body, deliverableUrls: [] }).success).toBe(false);
    expect(marketingDeliveryBodySchema.safeParse({ ...body, deliverableUrls: ["javascript:alert(1)"] }).success).toBe(false);
    expect(marketingDeliveryBodySchema.safeParse({ ...body, pullRequestUrl: PR }).success).toBe(false);
  });
});

describe("deliverWork: marketing work delivers links and files, not a pull request (M-API-3)", () => {
  const marketingBody = {
    summary: "Wrote the launch post.",
    description: "Published it and checked its links.",
    deliverableUrls: ["https://example.com/post"],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    db.prisma.bug.findFirst.mockResolvedValue({
      id: "bug1",
      projectId: "p1",
      track: "marketing",
      status: "in_progress",
      substatus: "in_progress",
      pullRequestUrl: null,
      project: { repoUrl: "https://github.com/emerjent/ziki" },
    });
    db.prisma.issueClaim.findFirst.mockResolvedValue({ id: "c1", beneficiaryUserId: "ada" });
    db.prisma.reviewOffer.findFirst.mockResolvedValue(null);
    db.prisma.pullRequestReport.findFirst.mockResolvedValue(null);
    db.prisma.attachment.count.mockResolvedValue(0);
    db.prisma.delivery.findMany.mockResolvedValue([
      {
        id: "d1",
        agentId: "agent-ada",
        beneficiaryUserId: "ada",
        summary: marketingBody.summary,
        description: marketingBody.description,
        pullRequestUrl: null,
        deliverableUrls: marketingBody.deliverableUrls,
        headSha: null,
        screenshots: [],
        testResults: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        agent: { name: "ada's agent" },
        beneficiary: { name: "Ada" },
        replies: [],
      },
    ]);
    db.tx.delivery.findUnique.mockResolvedValue(null);
    db.tx.delivery.create.mockResolvedValue({ id: "d1" });
    db.tx.attachment.updateMany.mockResolvedValue({ count: 1 });
  });

  it("delivers links, records no pull request, and never reads a pull request report", async () => {
    const result = await deliverWork(agent("working", "ada"), "bug1", marketingBody);
    expect(result).toMatchObject({ status: 201, replaced: false });
    expect(db.tx.delivery.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ pullRequestUrl: null, deliverableUrls: marketingBody.deliverableUrls, headSha: null, testResults: null }),
      }),
    );
    expect(db.tx.bug.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "done", substatus: "requires_review" }) }),
    );
    expect(db.tx.bug.update.mock.calls[0][0].data).not.toHaveProperty("pullRequestUrl");
    expect(db.prisma.pullRequestReport.findFirst).not.toHaveBeenCalled();
    expect(db.tx.testVerdict.updateMany).not.toHaveBeenCalled();
    expect(mocks.createReviewOffers).not.toHaveBeenCalled();
    expect(mocks.publish).toHaveBeenCalledWith(
      db.tx,
      expect.objectContaining({ payload: expect.objectContaining({ deliverableUrls: marketingBody.deliverableUrls }) }),
    );
    expect(mocks.publish.mock.calls[0][1].payload).not.toHaveProperty("pullRequestUrl");
  });

  it("delivers files by attaching the deliverer's own uploads to the issue", async () => {
    db.prisma.attachment.count.mockResolvedValue(1);
    const result = await deliverWork(agent("working", "ada"), "bug1", {
      summary: marketingBody.summary,
      description: marketingBody.description,
      attachmentIds: ["att_1"],
    });
    expect(result).toMatchObject({ status: 201 });
    expect(db.prisma.attachment.count).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { in: ["att_1"] }, uploaderId: "ada" }) }),
    );
    expect(db.tx.attachment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: ["att_1"] }, uploaderId: "ada" }),
        data: { bugId: "bug1", commentId: null, confirmationId: null },
      }),
    );
    expect(db.tx.delivery.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ deliverableUrls: [], pullRequestUrl: null }) }),
    );
  });

  it("refuses a pull request, head commit or test results, naming the field", async () => {
    for (const [field, value] of [
      ["pullRequestUrl", PR],
      ["headSha", "abc1234"],
      ["testResults", "42 passed"],
    ] as const) {
      const result = await deliverWork(agent("working", "ada"), "bug1", { ...marketingBody, [field]: value });
      expect(result).toMatchObject({ status: 400, error: "invalid_request", field });
    }
    expect(db.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("stores the work delivered as Markdown on the delivery, not in its event", async () => {
    const text = "# The post\n\nIt went out.";
    const result = await deliverWork(agent("working", "ada"), "bug1", { summary: marketingBody.summary, description: marketingBody.description, deliverableText: text });
    expect(result).toMatchObject({ status: 201 });
    expect(db.tx.delivery.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ deliverableText: text, deliverableUrls: [], pullRequestUrl: null }) }),
    );
    expect(JSON.stringify(db.tx.bugActivity.create.mock.calls)).not.toContain(text);
  });

  it("refuses a delivery with neither a link nor a file", async () => {
    const result = await deliverWork(agent("working", "ada"), "bug1", {
      summary: marketingBody.summary,
      description: marketingBody.description,
    });
    expect(result).toMatchObject({ status: 400, error: "invalid_request", field: "deliverableUrls" });
    expect(db.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("refuses a file that isn't the deliverer's own unclaimed upload", async () => {
    db.prisma.attachment.count.mockResolvedValue(0);
    const result = await deliverWork(agent("working", "ada"), "bug1", {
      summary: marketingBody.summary,
      description: marketingBody.description,
      attachmentIds: ["att_someone_else"],
    });
    expect(result).toMatchObject({ status: 422, error: "invalid_attachments", field: "attachmentIds" });
    expect(db.prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("deliverWork: product work still needs a pull request and its evidence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    issue();
    db.prisma.issueClaim.findFirst.mockResolvedValue({ id: "c1", beneficiaryUserId: "ada" });
    db.prisma.reviewOffer.findFirst.mockResolvedValue(null);
    db.prisma.pullRequestReport.findFirst.mockResolvedValue(null);
  });

  it("refuses marketing deliverable links and files, naming the field", async () => {
    const links = await deliverWork(agent("working", "ada"), "bug1", { ...body(), deliverableUrls: ["https://example.com/post"] });
    expect(links).toMatchObject({ status: 400, error: "invalid_request", field: "deliverableUrls" });
    const files = await deliverWork(agent("working", "ada"), "bug1", { ...body(), attachmentIds: ["att_1"] });
    expect(files).toMatchObject({ status: 400, error: "invalid_request", field: "attachmentIds" });
    const written = await deliverWork(agent("working", "ada"), "bug1", { ...body(), deliverableText: "# The post" });
    expect(written).toMatchObject({ status: 400, error: "invalid_request", field: "deliverableText" });
    expect(db.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("refuses a delivery with no pull request, and one with no evidence", async () => {
    const noPullRequest = await deliverWork(agent("working", "ada"), "bug1", {
      summary: "Did the work.",
      description: "It is done.",
      testResults: "42 passed",
    });
    expect(noPullRequest).toMatchObject({ status: 400, error: "invalid_request", field: "pullRequestUrl" });

    const noEvidence = await deliverWork(agent("working", "ada"), "bug1", {
      pullRequestUrl: PR,
      summary: "Did the work.",
      description: "It is done.",
    });
    expect(noEvidence).toMatchObject({ status: 400, error: "invalid_request", field: "testResults" });
    expect(db.prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("deliverWork: the delivery receipt (#delivery-receipt)", () => {
  const receipt = {
    verified: [{ check: "node --test (3/3)", how: "ran on f46960b" }],
    notVerified: [{ check: "Manual race in a real browser", why: "no preview deployment" }],
    reviewerShould: ["Open the preview, search two names"],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    issue();
    db.prisma.issueClaim.findFirst.mockResolvedValue({ id: "c1", beneficiaryUserId: "ada" });
    db.prisma.reviewOffer.findFirst.mockResolvedValue(null);
    db.prisma.pullRequestReport.findFirst.mockResolvedValue(null);
    db.prisma.delivery.findMany.mockResolvedValue([
      {
        id: "d1",
        agentId: "agent-ada",
        beneficiaryUserId: "ada",
        summary: body().summary,
        description: body().description,
        pullRequestUrl: PR,
        headSha: null,
        screenshots: [],
        testResults: body().testResults,
        receipt,
        createdAt: new Date(),
        updatedAt: new Date(),
        agent: { name: "ada's agent" },
        beneficiary: { name: "Ada" },
        replies: [],
      },
    ]);
    db.tx.delivery.findUnique.mockResolvedValue(null);
    db.tx.delivery.create.mockResolvedValue({ id: "d1" });
    db.tx.delivery.update.mockResolvedValue({ id: "d1" });
  });

  it("stores the receipt on the delivery, returns it on the entry, and sends it with the event", async () => {
    const result = await deliverWork(agent("working", "ada"), "bug1", { ...body(), receipt });
    expect(result).toMatchObject({ status: 201, replaced: false });
    expect(db.tx.delivery.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ receipt }) }));
    expect(result.status === 201 && result.delivery.receipt).toEqual(receipt);
    expect(mocks.publish).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "issue.delivered", payload: expect.objectContaining({ receipt }) }),
    );
  });

  it("fills the lists a receipt leaves out, and reads a delivery without one as null", async () => {
    const result = await deliverWork(agent("working", "ada"), "bug1", { ...body(), receipt: { verified: [{ check: "pnpm test" }] } });
    expect(db.tx.delivery.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ receipt: { verified: [{ check: "pnpm test" }], notVerified: [], reviewerShould: [] } }) }),
    );
    expect(result.status).toBe(201);
    db.prisma.delivery.findMany.mockResolvedValue([{ ...(await db.prisma.delivery.findMany())[0], receipt: null }]);
    const bare = await deliverWork(agent("working", "ada"), "bug1", body());
    expect(bare.status === 201 && bare.delivery.receipt).toBeNull();
    expect(mocks.publish).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ payload: expect.not.objectContaining({ receipt: expect.anything() }) }));
  });

  it("refuses an empty or malformed receipt, naming the field, and writes nothing", async () => {
    const empty = await deliverWork(agent("working", "ada"), "bug1", { ...body(), receipt: { reviewerShould: ["Run the tests"] } });
    expect(empty).toMatchObject({ status: 400, error: "invalid_request", field: "receipt" });
    const malformed = await deliverWork(agent("working", "ada"), "bug1", { ...body(), receipt: { verified: ["node --test"] } });
    expect(malformed).toMatchObject({ status: 400, error: "invalid_request", field: "receipt" });
    expect(db.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("delivering again without a receipt replaces the earlier one with none", async () => {
    db.tx.delivery.findUnique.mockResolvedValue({ id: "d1" });
    const result = await deliverWork(agent("working", "ada"), "bug1", body());
    expect(result).toMatchObject({ status: 200, replaced: true });
    expect(db.tx.delivery.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ receipt: Prisma.JsonNull }) }));
  });

  it("takes a receipt on marketing work too", async () => {
    db.prisma.bug.findFirst.mockResolvedValue({
      id: "bug1",
      projectId: "p1",
      track: "marketing",
      status: "in_progress",
      substatus: "in_progress",
      pullRequestUrl: null,
      project: { repoUrl: "https://github.com/emerjent/ziki" },
    });
    db.prisma.attachment.count.mockResolvedValue(0);
    const marketing = { summary: "Wrote the launch post.", description: "Published it and checked its links.", deliverableUrls: ["https://example.com/post"] };
    const result = await deliverWork(agent("working", "ada"), "bug1", { ...marketing, receipt: { verified: [{ check: "Every link opens", how: "clicked each one" }] } });
    expect(result.status).toBe(201);
    expect(db.tx.delivery.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ receipt: { verified: [{ check: "Every link opens", how: "clicked each one" }], notVerified: [], reviewerShould: [] } }) }),
    );
  });
});
