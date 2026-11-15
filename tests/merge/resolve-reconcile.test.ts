import { beforeEach, describe, expect, it, vi } from "vitest";

/** Resolving merged work (#515, #reconcile-merged): an issue goes Live only on a report that its linked pull request is merged into the default branch; the claim is released, and a status that changed meanwhile leaves everything as it was. Force-merge (#force-merge): the local coder's own merge goes Live without any gate, and judgements afterwards move it On dev or mark it Broken. */
const db = vi.hoisted(() => {
  const tx = {
    bug: { updateMany: vi.fn(), findUnique: vi.fn() },
    bugActivity: { create: vi.fn(), findFirst: vi.fn() },
    issueClaim: { updateMany: vi.fn(), update: vi.fn() },
    supportThread: { findMany: vi.fn(async () => []), updateMany: vi.fn() },
    notification: { createMany: vi.fn() },
  };
  return {
    bug: { findFirst: vi.fn(), findUnique: vi.fn() },
    pullRequestReport: { findFirst: vi.fn() },
    $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
    tx,
  };
});
const publish = vi.hoisted(() => vi.fn());
const audit = vi.hoisted(() => vi.fn());
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/agent-api/events", () => ({ publish }));
vi.mock("@/lib/agents/audit", () => ({ audit }));
const judged = vi.hoisted(() => ({ countedJudgements: vi.fn() }));
vi.mock("@/lib/agent-api/tested-status", () => judged);
const merge = vi.hoisted(() => ({ finalizeResolved: vi.fn(), countedReviewers: vi.fn(), creditedDeliveryUsers: vi.fn() }));
vi.mock("@/lib/agent-api/merge", async (original) => ({ ...(await original<object>()), ...merge }));

import type { AgentContext } from "@/lib/agents/require-agent";
import { resolveMergedFix } from "@/lib/agent-api/resolve";
import * as mergeDomain from "@/lib/agent-api/merge";
import { forceMerge, settleForceMerged } from "@/lib/agent-api/force-merge";

const PR = "https://github.com/acme/app/pull/12";
const scope = { organisationId: "t1", projectId: "p1" };
const agent = (ownerId = "owner", level: AgentContext["level"] = "working"): AgentContext =>
  ({ agentId: "a1", name: "Charles Xavier", ownerId, organisationId: "t1", level, burst: false, keyId: "k" });

function bug(over: Record<string, unknown> = {}) {
  return {
    id: "bug1", status: "in_progress", substatus: "in_progress", assigneeId: "owner", reporterId: "rep", pullRequestUrl: PR, pullRequestHeadSha: "abc1234",
    project: { repoUrl: "https://github.com/acme/app" },
    claims: [],
    ...over,
  };
}

/** The latest independent report on the linked pull request (#pr-reports): merged into main by default. */
function report(over: Record<string, unknown> = {}) {
  return {
    id: "rep1",
    bugId: "bug1",
    pullRequestUrl: PR,
    state: "merged",
    mergedInto: "main",
    inDefaultBranch: true,
    headSha: "abc1234",
    mergeCommitSha: "def5678",
    checks: "passing",
    mergeable: null,
    note: "Merged into main.",
    agentId: "a7",
    onBehalfOfUserId: "erin",
    createdAt: new Date("2026-10-30T09:00:00Z"),
    agent: { name: "erin's agent" },
    onBehalfOf: { name: "Erin" },
    ...over,
  };
}

const unmerged = { mergedInto: null, inDefaultBranch: null, mergeCommitSha: null };

beforeEach(() => {
  vi.clearAllMocks();
  db.tx.bug.updateMany.mockResolvedValue({ count: 1 });
  db.pullRequestReport.findFirst.mockResolvedValue(report());
});

describe("resolveMergedFix (Ziki #515, #pr-reports)", () => {
  it("holds normal awards when the owner resolves imported work instead of taking the legacy no-payout path", async () => {
    const imported = { ...bug(), outsideWork: { agentId: "importing-agent" }, organisationId: "t1", projectId: "p1" };
    db.bug.findFirst.mockResolvedValue(imported);
    db.bug.findUnique.mockResolvedValue(imported);
    const credited = vi.spyOn(mergeDomain, "creditedDeliveryUsers").mockResolvedValue(["owner"]);
    const counted = vi.spyOn(mergeDomain, "countedReviewers").mockResolvedValue({ reviewers: ["tester"], weight: 3, acceptedHeadSha: "abc1234" });
    const finalize = vi.spyOn(mergeDomain, "finalizeResolved").mockResolvedValue();
    try {
      expect(await resolveMergedFix(agent(), scope, "bug1")).toMatchObject({ status: 200, body: { resolved: true } });
      expect(finalize).toHaveBeenCalledWith(db.tx, expect.objectContaining({ solverUserId: "owner", solverAgentId: "importing-agent", claim: null, rewardedReviewerUserIds: ["tester"] }));
    } finally {
      credited.mockRestore(); counted.mockRestore(); finalize.mockRestore();
    }
  });
  it("lets an agent of any class resolve a fix reported merged into the default branch, and writes no points", async () => {
    db.bug.findFirst.mockResolvedValue(bug());
    for (const level of ["working", "manager", "merger"] as const) {
      db.tx.bug.updateMany.mockClear();
      const result = await resolveMergedFix(agent("owner", level), scope, "bug1", PR);
      expect(result).toEqual({ status: 200, body: { resolved: true, issueId: "bug1", previousStatus: "in_progress", previousSubstatus: "in_progress", status: "resolved", substatus: "on_dev", pullRequestUrl: PR } });
      expect(db.tx.bug.updateMany).toHaveBeenCalledWith({
        // Only if nobody relinked it or moved it since the read.
        where: { id: "bug1", substatus: "in_progress", pullRequestUrl: PR },
        data: { status: "resolved", substatus: "on_dev" },
      });
    }
    expect(db.pullRequestReport.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { bugId: "bug1", pullRequestUrl: PR } }));
    expect(db.bug.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "bug1", ...scope, isDeleted: false } }));
  });

  it("releases an active claim and publishes the release", async () => {
    db.bug.findFirst.mockResolvedValue(bug({ assigneeId: null, claims: [{ id: "c1", agentId: "a9", beneficiaryUserId: "owner" }] }));
    expect((await resolveMergedFix(agent(), scope, "bug1", PR)).status).toBe(200);
    expect(db.tx.issueClaim.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "released", releaseReason: "resolved" }) }));
    expect(publish.mock.calls.map((c) => c[1].type)).toEqual(["claim.released", "issue.updated"]);
  });

  it("refuses an agent whose owner isn't connected to the issue", async () => {
    db.bug.findFirst.mockResolvedValue(bug({ assigneeId: "someone", reporterId: "rep" }));
    const result = await resolveMergedFix(agent("stranger"), scope, "bug1", PR);
    expect(result).toMatchObject({ status: 403, body: { error: "not_connected" } });
    expect(db.pullRequestReport.findFirst).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("hands a manager not connected to the issue to the reconcile path, with its stricter rules (#reconcile-merged)", async () => {
    // Open is not a step merged work is left at, so the reconcile refuses it; the connected path would have resolved it.
    db.bug.findFirst.mockResolvedValue(bug({ assigneeId: "someone", reporterId: "rep", status: "open", substatus: "open" }));
    const result = await resolveMergedFix(agent("stranger", "manager"), scope, "bug1", PR);
    expect(result).toMatchObject({ status: 409, body: { error: "not_in_review" } });
    expect(db.pullRequestReport.findFirst).not.toHaveBeenCalled();
    expect(db.tx.bug.updateMany).not.toHaveBeenCalled();
  });

  it("uses the linked pull request when none is sent, and refuses when none is linked, even with one sent", async () => {
    db.bug.findFirst.mockResolvedValue(bug());
    expect((await resolveMergedFix(agent(), scope, "bug1")).status).toBe(200);
    db.bug.findFirst.mockResolvedValue(bug({ pullRequestUrl: null }));
    expect(await resolveMergedFix(agent(), scope, "bug1")).toMatchObject({ status: 409, body: { error: "no_pull_request" } });
    // A sent pull request is not linked onto an issue that has none.
    expect(await resolveMergedFix(agent(), scope, "bug1", PR)).toMatchObject({ status: 409, body: { error: "no_pull_request" } });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["not a PR URL", "https://github.com/acme/app/issues/12", bug(), report(), 422, "invalid_url"],
    ["an issue outside the key's project", PR, null, report(), 404, "not_found"],
    ["an issue already resolved", PR, bug({ status: "resolved", substatus: "on_dev" }), report(), 409, "already_resolved"],
    ["an issue already closed", PR, bug({ status: "closed", substatus: "closed" }), report(), 409, "already_resolved"],
    ["a different PR than the linked one", PR, bug({ pullRequestUrl: "https://github.com/acme/app/pull/99" }), report(), 409, "pr_mismatch"],
    ["a linked PR in another repo", "https://github.com/other/app/pull/12", bug({ pullRequestUrl: "https://github.com/other/app/pull/12" }), report({ pullRequestUrl: "https://github.com/other/app/pull/12" }), 409, "pr_broken"],
    ["a PR nobody has reported", PR, bug(), null, 409, "needs_pr_report"],
    ["a merge not yet in the default branch", PR, bug(), report({ mergedInto: "staging", inDefaultBranch: false }), 409, "awaiting_release"],
    ["a PR reported closed without merging", PR, bug(), report({ state: "closed", ...unmerged }), 409, "pr_broken"],
    ["a PR reported missing", PR, bug(), report({ state: "not_found", ...unmerged }), 409, "pr_broken"],
    ["a PR reported open", PR, bug(), report({ state: "open", ...unmerged }), 409, "not_merged"],
  ])("refuses %s and changes nothing", async (_name, url, found, latest, status, error) => {
    db.bug.findFirst.mockResolvedValue(found);
    db.pullRequestReport.findFirst.mockResolvedValue(latest);
    const result = await resolveMergedFix(agent(), scope, "bug1", url as string);
    expect(result).toMatchObject({ status, body: { error } });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("records and publishes nothing when the status changed after it was read", async () => {
    db.bug.findFirst.mockResolvedValue(bug({ claims: [{ id: "c1", agentId: "a9", beneficiaryUserId: "owner" }] }));
    db.tx.bug.updateMany.mockResolvedValue({ count: 0 });
    expect(await resolveMergedFix(agent(), scope, "bug1", PR)).toMatchObject({ status: 409, body: { error: "status_changed" } });
    expect(db.tx.bugActivity.create).not.toHaveBeenCalled();
    expect(db.tx.issueClaim.updateMany).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
});

describe("forceMerge (#force-merge)", () => {
  const held = (over: Record<string, unknown> = {}) =>
    bug({ track: "product", isBoosted: false, claims: [{ id: "c1", agentId: "a1", beneficiaryUserId: "owner" }], ...over });

  it("moves the holder's own merged work straight to Live · Force-merged, with no report, review or judgement, and releases the claim", async () => {
    db.bug.findFirst.mockResolvedValue(held({ status: "done", substatus: "requires_review" }));
    const result = await forceMerge(agent(), scope, "bug1", { summary: "Merged locally." });
    expect(result).toEqual({
      status: 200,
      body: { forceMerged: true, issueId: "bug1", previousStatus: "done", previousSubstatus: "requires_review", status: "resolved", substatus: "force_merged", pullRequestUrl: PR },
    });
    expect(db.tx.bug.updateMany).toHaveBeenCalledWith({
      where: { id: "bug1", substatus: "requires_review", pullRequestUrl: PR },
      data: { status: "resolved", substatus: "force_merged", pullRequestUrl: PR },
    });
    expect(db.tx.issueClaim.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "c1" }, data: expect.objectContaining({ status: "released", releaseReason: "force_merge" }) }));
    expect(db.pullRequestReport.findFirst).not.toHaveBeenCalled();
  });

  it("links the merged pull request when the work was never delivered", async () => {
    db.bug.findFirst.mockResolvedValue(held({ pullRequestUrl: null }));
    expect(await forceMerge(agent(), scope, "bug1", { summary: "Merged locally." })).toMatchObject({ status: 409, body: { error: "no_pull_request" } });
    expect((await forceMerge(agent(), scope, "bug1", { summary: "Merged locally.", pullRequestUrl: PR })).status).toBe(200);
    expect(db.tx.bug.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ pullRequestUrl: PR }) }));
  });

  it.each([
    ["an agent that doesn't hold the issue, its owner's other agents included", held({ claims: [{ id: "c1", agentId: "a2", beneficiaryUserId: "owner" }] }), 403, "not_holder"],
    ["an issue still Open", held({ status: "open", substatus: "open" }), 409, "not_force_mergeable"],
    ["an issue already Live", held({ status: "resolved", substatus: "on_dev" }), 409, "not_force_mergeable"],
  ])("refuses %s and changes nothing", async (_name, found, status, error) => {
    db.bug.findFirst.mockResolvedValue(found);
    expect(await forceMerge(agent(), scope, "bug1", { summary: "Merged locally." })).toMatchObject({ status, body: { error } });
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});

describe("settleForceMerged (#force-merge)", () => {
  const forced = { ...bug({ status: "resolved", substatus: "force_merged", organisationId: "t1", projectId: "p1" }), claims: [] };

  it("marks force-merged work Live · Broken once enough judgements say it is not good, so it takes bids for a fix", async () => {
    db.bug.findUnique.mockResolvedValue(forced);
    judged.countedJudgements.mockResolvedValue({ good: 0, notGood: 3, needed: 3 });
    expect(await settleForceMerged(agent("tester"), "bug1")).toBe("merged_broken");
    expect(db.tx.bug.updateMany).toHaveBeenCalledWith({ where: { id: "bug1", substatus: "force_merged" }, data: { status: "resolved", substatus: "merged_broken", assigneeId: null } });
    expect(merge.finalizeResolved).not.toHaveBeenCalled();
  });

  it("moves it On dev with the points once enough judgements say it is good", async () => {
    db.bug.findUnique.mockResolvedValue(forced);
    db.tx.bug.findUnique.mockResolvedValue({ substatus: "force_merged", pullRequestUrl: PR });
    judged.countedJudgements.mockResolvedValue({ good: 3, notGood: 0, needed: 3 });
    merge.creditedDeliveryUsers.mockResolvedValue(["owner"]);
    merge.countedReviewers.mockResolvedValue({ reviewers: ["erin"], weight: 3, acceptedHeadSha: "abc1234" });
    expect(await settleForceMerged(agent("tester"), "bug1")).toBe("on_dev");
    expect(merge.finalizeResolved).toHaveBeenCalledWith(db.tx, expect.objectContaining({ solverUserId: "owner", rewardedReviewerUserIds: ["erin"] }));
  });

  it("leaves it Force-merged while the judgements are short, and never moves an issue that isn't force-merged", async () => {
    db.bug.findUnique.mockResolvedValue(forced);
    judged.countedJudgements.mockResolvedValue({ good: 2, notGood: 1, needed: 3 });
    expect(await settleForceMerged(agent("tester"), "bug1")).toBeNull();
    db.bug.findUnique.mockResolvedValue({ ...forced, substatus: "merged_broken" });
    judged.countedJudgements.mockResolvedValue({ good: 3, notGood: 0, needed: 3 });
    expect(await settleForceMerged(agent("tester"), "bug1")).toBeNull();
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});
