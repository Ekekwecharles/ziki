import { describe, expect, it } from "vitest";
import {
  assertIndependentReviewer,
  ReviewerNotIndependentError,
  reviewerConflict,
  type ReviewedBug,
} from "@/lib/agents/independence";
import { countedMergeVerdicts, type CountableVerdict } from "@/lib/agent-api/merge-verdicts";

describe("reviewing imported work without a claim (#788)", () => {
  it("also excludes the current solver's owning side after an imported issue is reassigned", () => {
    const imported: ReviewedBug = { beneficiaryUserId: "alice", assigneeId: "bob", createdByAgent: { ownerUserId: "alice" }, outsideWork: { agentId: "alice-filer" }, claims: [] };
    expect(reviewerConflict({ id: "bob-tester", ownerUserId: "bob" }, imported)).toBe("own-import");
    expect(reviewerConflict({ id: "carol-tester", ownerUserId: "carol" }, imported)).toBeNull();
  });
  it("keeps the filing agent and its owner's other agents out, while allowing another owner", () => {
    const imported: ReviewedBug = { beneficiaryUserId: "alice", createdByAgent: { ownerUserId: "alice" }, outsideWork: { agentId: "alice-filer" }, claims: [] };
    expect(reviewerConflict({ id: "alice-filer", ownerUserId: "alice" }, imported)).toBe("own-import");
    expect(reviewerConflict({ id: "alice-tester", ownerUserId: "alice" }, imported)).toBe("own-import");
    expect(reviewerConflict({ id: "bob-tester", ownerUserId: "bob" }, imported)).toBeNull();
  });
});

const alice = "user-alice";
const aliceWorker = { id: "agent-alice-worker", ownerUserId: alice };
const aliceManager = { id: "agent-alice-manager", ownerUserId: alice };
const bobAgent = { id: "agent-bob", ownerUserId: "user-bob" };

/**
 * Independence (#owner-agents): an owner's agents may review the owner's own
 * work; only the agent holding the claim can't review its own, and verdicts
 * count once per person per class.
 */

/** Alice's own ticket: she filed it, it is for her, and her worker agent holds the claim. */
const alicesOwnWork: ReviewedBug = {
  beneficiaryUserId: alice,
  reporterId: alice,
  assigneeId: alice,
  createdByAgent: { ownerUserId: alice },
  claims: [{ status: "active", releasedAt: null, agentId: aliceWorker.id, beneficiaryUserId: alice, dispatcherUserId: alice, agent: { ownerUserId: alice } }],
};

describe("reviewer independence (#owner-agents)", () => {
  it("lets the owner's other agents review the owner's own work: nothing is gated to other people", () => {
    expect(reviewerConflict(aliceManager, alicesOwnWork)).toBeNull();
    expect(() => assertIndependentReviewer(aliceManager, alicesOwnWork)).not.toThrow();
    expect(reviewerConflict(bobAgent, alicesOwnWork)).toBeNull();
  });

  it("refuses only the agent holding the claim, reviewing its own work", () => {
    expect(reviewerConflict(aliceWorker, alicesOwnWork)).toBe("own-claim");
    expect(() => assertIndependentReviewer(aliceWorker, alicesOwnWork)).toThrow(ReviewerNotIndependentError);
  });

  it("ignores claims that are released or only offered", () => {
    const released: ReviewedBug = { ...alicesOwnWork, claims: [{ ...alicesOwnWork.claims![0], releasedAt: new Date() }] };
    const offered: ReviewedBug = { ...alicesOwnWork, claims: [{ ...alicesOwnWork.claims![0], status: "offered" }] };
    expect(reviewerConflict(aliceWorker, released)).toBeNull();
    expect(reviewerConflict(aliceWorker, offered)).toBeNull();
  });
});

const reviewed = { reporterId: "ada", beneficiaryUserId: "ada", createdByAgentId: null, claims: [] };
const verdict = (owner: string, headSha: string | null = null, agentId = `agent-${owner}`, level = "working"): CountableVerdict => ({
  headSha,
  onBehalfOfUserId: owner,
  agent: { id: agentId, ownerUserId: owner, activations: [{ organisationId: "t1", level: level as "working" | "manager" | "merger" }] },
});

describe("countedMergeVerdicts: one verdict rule for the merge gate and the merge queue", () => {
  it("counts one verdict per person per class and names the last counted commit", () => {
    const { reviewers, weight, acceptedHeadSha } = countedMergeVerdicts(
      [verdict("bob", "sha-1"), verdict("bob", "sha-2", "agent-bob-2"), verdict("cara", "sha-3")],
      null,
      reviewed,
      "t1",
      "linked-sha",
    );
    expect(reviewers).toEqual(["bob", "cara"]);
    expect(weight).toBe(2);
    expect(acceptedHeadSha).toBe("sha-3");
  });

  it("weighs a manager or merger agent's verdict 2 and a working agent's 1, so one owner with both gives 3 (#owner-agents)", () => {
    const { reviewers, weight } = countedMergeVerdicts(
      [verdict("ada", null, "ada-manager", "manager"), verdict("ada", null, "ada-worker", "working")],
      null,
      reviewed,
      "t1",
    );
    expect(weight).toBe(3);
    expect(reviewers).toEqual(["ada"]);
    expect(countedMergeVerdicts([verdict("bob", null, "bob-merger", "merger")], null, reviewed, "t1").weight).toBe(2);
  });

  it("leaves out only the agent holding the claim; the owner's other agents count (#owner-agents)", () => {
    const claim = { agentId: "agent-dan", agent: { ownerUserId: "dan" } };
    const { reviewers, weight } = countedMergeVerdicts(
      [verdict("dan"), verdict("dan", null, "agent-dan-manager", "manager"), verdict("bob")],
      claim,
      reviewed,
      "t1",
    );
    expect(reviewers).toEqual(["dan", "bob"]);
    expect(weight).toBe(3);
  });

});
