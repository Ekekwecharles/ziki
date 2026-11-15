import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Human control over every step (#owner-control). The organisation's owner
 * moves an issue by hand only to the steps listed for where it is, with a
 * reason to close it; nobody else can. A person acting through their agent
 * gets the agent's own refusals, never a silent success.
 */

const bugFindUnique = vi.hoisted(() => vi.fn());
const bugFindUniqueOrThrow = vi.hoisted(() => vi.fn());
const bugFindFirst = vi.hoisted(() => vi.fn());
const bugUpdate = vi.hoisted(() => vi.fn());
const claimFindMany = vi.hoisted(() => vi.fn());
const claimUpdateMany = vi.hoisted(() => vi.fn());
const activityCreateMany = vi.hoisted(() => vi.fn());
const ideaFindFirst = vi.hoisted(() => vi.fn());
const organisationAccessFor = vi.hoisted(() => vi.fn());
const submitTestVerdict = vi.hoisted(() => vi.fn());
const webAgentFor = vi.hoisted(() => vi.fn());
const checkPostForSecrets = vi.hoisted(() => vi.fn());
const heldByMyAgent = vi.hoisted(() => vi.fn());
const deliverWork = vi.hoisted(() => vi.fn());

const tx = {
  $queryRaw: vi.fn(),
  bug: { findUniqueOrThrow: bugFindUniqueOrThrow, update: bugUpdate },
  issueClaim: { findMany: claimFindMany, updateMany: claimUpdateMany },
  bugActivity: { createMany: activityCreateMany },
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    bug: { findUnique: bugFindUnique, findFirst: bugFindFirst },
    idea: { findFirst: ideaFindFirst },
    $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
  },
}));
vi.mock("@/lib/auth-helpers", () => ({ requireUser: vi.fn(async () => ({ id: "user-1", name: "Babs", role: "user" })) }));
vi.mock("@/lib/organisation-access", () => ({ organisationAccessFor }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/revalidate-issue", () => ({ revalidateIssue: vi.fn() }));
vi.mock("@/lib/notify", () => ({ notifyLater: vi.fn() }));
vi.mock("@/lib/agent-api/events", () => ({ publish: vi.fn() }));
vi.mock("@/lib/agent-api/web-events", () => ({ publishWebEvent: vi.fn(), issueChangePayload: vi.fn(() => ({})) }));
vi.mock("@/lib/points/award", () => ({ solverAwardFor: vi.fn(async () => null) }));
vi.mock("@/lib/points/payout", () => ({ holdPayout: vi.fn() }));
vi.mock("@/lib/agent-api/test-verdict", () => ({ submitTestVerdict }));
vi.mock("@/lib/web-agent", () => ({ webAgentFor, heldByMyAgent }));
vi.mock("@/lib/agent-api/delivery", () => ({ deliverWork }));
vi.mock("@/lib/security/secret-guard", () => ({ checkPostForSecrets }));

import { ownerMove } from "@/lib/owner-moves";
import { ownerAcceptIdeaAction, ownerMoveIssueAction } from "@/app/actions/owner-moves";
import { deliverForMyAgentAction, giveTestVerdictAction } from "@/app/actions/human-steps";

const inProgress = {
  id: "bug-1",
  title: "Search is slow",
  status: "in_progress",
  substatus: "in_progress",
  isDeleted: false,
  organisationId: "org-1",
  assigneeId: "worker-1",
  reporterId: "reporter-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  bugFindUnique.mockResolvedValue(inProgress);
  bugFindUniqueOrThrow.mockResolvedValue({ substatus: "in_progress" });
  claimFindMany.mockResolvedValue([{ id: "claim-1", agentId: "agent-9", beneficiaryUserId: "worker-1" }]);
  organisationAccessFor.mockResolvedValue({ admin: true });
});

describe("owner moves (#owner-control)", () => {
  it("offers only the moves listed for the current step", () => {
    expect(ownerMove("in_progress", "open")).not.toBeNull();
    expect(ownerMove("on_dev", "on_prod")).not.toBeNull();
    // Nothing jumps an issue from Live back into review, or from Open straight to Live.
    expect(ownerMove("on_prod", "requires_review")).toBeNull();
    expect(ownerMove("open", "on_dev")).toBeNull();
    // Force-merged work: the owner can judge it working or broken without waiting for agents.
    expect(ownerMove("force_merged", "on_dev")).not.toBeNull();
    expect(ownerMove("force_merged", "merged_broken")).not.toBeNull();
    expect(ownerMove("merged_broken", "on_dev")).not.toBeNull();
  });

  it("refuses someone who isn't an owner or admin, and changes nothing", async () => {
    organisationAccessFor.mockResolvedValue({ admin: false });
    const result = await ownerMoveIssueAction("bug-1", "closed", "Not planned");
    expect(result).toEqual({ error: expect.stringContaining("owner or admin") });
    expect(bugUpdate).not.toHaveBeenCalled();
  });

  it("won't close without a reason", async () => {
    const result = await ownerMoveIssueAction("bug-1", "closed", "  ");
    expect("error" in result).toBe(true);
    expect(bugUpdate).not.toHaveBeenCalled();
  });

  it("taking it off the agent reopens it, releases the claim and records the owner", async () => {
    const result = await ownerMoveIssueAction("bug-1", "open", "");
    expect(result).toEqual({ ok: true });
    expect(bugUpdate).toHaveBeenCalledWith({
      where: { id: "bug-1" },
      data: expect.objectContaining({ status: "open", substatus: "open", assigneeId: null }),
    });
    expect(claimUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ["claim-1"] } },
      data: expect.objectContaining({ status: "released", releaseReason: "owner" }),
    });
    const [[{ data }]] = activityCreateMany.mock.calls;
    expect(data[0].summary).toMatch(/as the owner$/);
  });

  it("refuses a move when someone else moved the issue first", async () => {
    bugFindUniqueOrThrow.mockResolvedValue({ substatus: "requires_review" });
    const result = await ownerMoveIssueAction("bug-1", "open", "");
    expect("error" in result).toBe(true);
    expect(bugUpdate).not.toHaveBeenCalled();
  });

  it("only an owner or admin accepts an idea by hand", async () => {
    ideaFindFirst.mockResolvedValue({ id: "idea-1", organisationId: "org-1", projectId: "project-1" });
    organisationAccessFor.mockResolvedValue({ admin: false });
    const result = await ownerAcceptIdeaAction("idea-1");
    expect("error" in result).toBe(true);
  });
});

describe("acting through your agent (#owner-control)", () => {
  it("shows the agent's refusal instead of reporting success", async () => {
    bugFindFirst.mockResolvedValue({ id: "bug-1", organisationId: "org-1", projectId: "project-1" });
    webAgentFor.mockResolvedValue({ agentId: "agent-1", name: "Builder", ownerId: "user-1", organisationId: "org-1", level: "working", burst: false, keyId: "web" });
    checkPostForSecrets.mockResolvedValue({ ok: true });
    submitTestVerdict.mockResolvedValue({ status: 403, error: "fixer_cannot_verdict", message: "The agent that delivered can't judge its own work." });
    const result = await giveTestVerdictAction("bug-1", { goodToMerge: true, summary: "Works.", description: "Tried it.", files: "app/page.tsx" });
    expect(result).toEqual({ error: "The agent that delivered can't judge its own work." });
  });

  it("needs an agent: a person without one can't judge", async () => {
    bugFindFirst.mockResolvedValue({ id: "bug-1", organisationId: "org-1", projectId: "project-1" });
    webAgentFor.mockResolvedValue(null);
    const result = await giveTestVerdictAction("bug-1", { goodToMerge: true, summary: "Works.", description: "Tried it.", files: "" });
    expect("error" in result).toBe(true);
    expect(submitTestVerdict).not.toHaveBeenCalled();
  });

  it("delivers only while my agent holds the work, with the agent's own checks", async () => {
    const work = { pullRequestUrl: "https://github.com/emerjent/ziki/pull/1", summary: "Done.", description: "Changed it.", proof: "Tests pass." };
    heldByMyAgent.mockResolvedValue(null);
    expect("error" in (await deliverForMyAgentAction("bug-1", work))).toBe(true);
    expect(deliverWork).not.toHaveBeenCalled();

    const agent = { agentId: "agent-1", name: "Builder" };
    heldByMyAgent.mockResolvedValue({ claimId: "claim-1", status: "active", projectId: "project-1", agent });
    bugFindFirst.mockResolvedValue({ id: "bug-1", organisationId: "org-1", projectId: "project-1" });
    checkPostForSecrets.mockResolvedValue({ ok: true });
    deliverWork.mockResolvedValue({ status: 400, error: "invalid_request", message: "That is not a GitHub pull request URL." });
    expect(await deliverForMyAgentAction("bug-1", work)).toEqual({ error: "That is not a GitHub pull request URL." });
    expect(deliverWork).toHaveBeenCalledWith(agent, "bug-1", expect.objectContaining({ pullRequestUrl: work.pullRequestUrl, testResults: "Tests pass." }));
  });
});
