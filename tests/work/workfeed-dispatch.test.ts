import { describe, expect, it, vi } from "vitest";
import type { AgentContext } from "@/lib/agents/require-agent";

type RecordedQuery = { model: string; method: string; args: { where?: Record<string, unknown> } | undefined };
const queries = vi.hoisted(() => [] as RecordedQuery[]);
vi.mock("@/lib/prisma", () => {
  const delegate = (model: string) =>
    new Proxy({}, {
      get: (_target, method: string) => async (args: RecordedQuery["args"]) => {
        queries.push({ model, method, args });
        return method === "findMany" || method === "groupBy" ? [] : method === "count" ? 0 : null;
      },
    });
  const prisma = new Proxy({}, {
    get: (_target, model: string) => (model.startsWith("$") ? async () => [] : model === "then" ? undefined : delegate(model)),
  });
  return { prisma };
});

import { clearWorkCache, itemsFor, projectWork, workEtag, workFeed, type AgentWork, type ProjectWork, type WorkFeed } from "@/lib/agent-api/work";
import { parseTrackFilter } from "@/lib/marketing/track";
import { parseEventFilters } from "@/lib/agent-api/events";
import { webhookBody } from "@/lib/webhooks/deliver";
import { prGate } from "@/lib/agent-api/pr-gate";
import type { StoredPullRequestReport } from "@/lib/agent-api/pull-request-report";

/** The work feed (#work-feed, #owner-agents): each agent sees the work it can act on, manager and merger work is shown but not actionable below those classes, and the feed's ETag follows its content. */
const REPO = { owner: "emerjent", repo: "ziki" };
const PR = "https://github.com/emerjent/ziki/pull/552";
const REPORTED_AT = new Date("2026-10-31T11:00:00Z");

/** Erin's agent's report on a pull request: open, checks passing, can merge, at head-sha. */
const prReport = (overrides: Partial<StoredPullRequestReport> = {}): StoredPullRequestReport => ({
  id: "rep1",
  bugId: "b2",
  pullRequestUrl: PR,
  state: "open",
  mergedInto: null,
  inDefaultBranch: null,
  headSha: "head-sha",
  mergeCommitSha: null,
  checks: "passing",
  mergeable: true,
  note: "Checked on GitHub.",
  agentId: "agent-owner-erin",
  onBehalfOfUserId: "owner-erin",
  createdAt: REPORTED_AT,
  agent: { name: "Erin's agent" },
  onBehalfOf: { name: "Erin" },
  ...overrides,
}) as StoredPullRequestReport;

/** An issue In progress or later with its pull request and latest report, through the real gate (#pr-reports). */
const prIssue = (id: string, number: number, pullRequestUrl: string, status: string, report: StoredPullRequestReport | null = null) => ({
  id,
  number,
  title: "Fix",
  status,
  pullRequestUrl,
  report,
  gate: prGate(report, { pullRequestUrl, pullRequestHeadSha: "head-sha", repo: REPO }),
});

const agent = (level: AgentContext["level"], ownerId = "owner-bob"): AgentContext => ({
  agentId: `agent-${ownerId}`,
  name: "bob",
  ownerId,
  organisationId: "t1",
  level,
  burst: false,
  keyId: "k1",
});

const facts = (overrides: Partial<ProjectWork["facts"] extends Map<string, infer F> ? F : never> = {}) => ({
  reporterId: "owner-ada",
  beneficiaryUserId: "owner-ada",
  assigneeId: null,
  createdByAgentId: "agent-owner-ada",
  createdByAgent: { ownerUserId: "owner-ada" },
  pullRequestUrl: null,
  claims: [],
  confirmerOwners: [],
  deliveryAgentIds: [],
  testerOwners: [],
  ...overrides,
});

/** Who filed an idea and who already judged it (#idea-table): ideas are not issues. */

function work(overrides: Partial<ProjectWork> = {}): ProjectWork {
  return {
    organisationId: "t1",
    project: { id: "p1", slug: "ziki", name: "Ziki", orgSlug: "zedu" },
    importance: [],
    deployments: [],
    contests: [],
    rewards: [],
    ideas: [],
    toConvert: [],
    toReject: [],
    toReclaim: [],
    toSenseCheck: [],
    toReviewIdle: [],
    toClose: [],
    toDeliverStranded: [],
    toReconcile: [],
    toAwaitRelease: [],
    toRepair: [],
    toReportPr: [],
    prGates: new Map(),
    judgeBlocks: new Map(),
    toConfirm: [],
    ideaThreshold: 3,
    tests: [],
    ready: [],
    bids: [],
    toAward: [],
    toInvestigate: [],
    comments: [],
    toAccept: [],
    toMerge: [],
    jobs: [],
    facts: new Map(),
    ideaFacts: new Map(),
    offerWindowSeconds: 1800,
    capacity: 2,
    governance: { thresholdOnly: false, managerVoteWeight: 3, closeThreshold: 3, awardThreshold: 3, acceptThreshold: 3 },
    ...overrides,
  };
}

const nothingMine: AgentWork = { offers: [], reviewOffers: [], jobReviewOffers: [], claims: [], unread: 0, planning: [], unproven: new Map(), testsToAdd: [] };

/** #plan-review: a complex issue's award held by this agent, with where its plan is. */
const planningClaim = (plan: AgentWork["planning"][number]["plan"]): AgentWork["planning"][number] => ({
  id: "claim-plan", offeredAt: new Date("2026-11-05T10:00:00Z"), createdAt: new Date("2026-11-05T10:00:00Z"),
  bug: { id: "b5", number: 5, title: "Learners drop off" },
  plan,
});

/** One open bid on issue #1 (#bid-votes). */
const openBid = (overrides: Partial<ProjectWork["bids"][number]> = {}): ProjectWork["bids"][number] => ({
  id: "bid-ada",
  issue: { id: "b1", number: 1, title: "x" },
  agentName: "Ada's Claude",
  ownerIds: ["owner-ada"],
  by: "Ada",
  summary: "I will fix the redirect.",
  weightedVotes: 0,
  voters: [],
  load: 0,
  createdAt: new Date("2026-10-29T10:00:00Z"),
  ...overrides,
});

describe("itemsFor: plan review (#plan-review)", () => {
  it("asks the awarded agent for its plan, with the window from the award, and nobody else", () => {
    const mine = { ...nothingMine, planning: [planningClaim(null)] };
    const [item] = itemsFor(agent("working"), work({ planReviewSeconds: 7200 }), mine);
    expect(item).toMatchObject({ kind: "write_plan", key: "write_plan:claim-plan", canAct: true, issue: { id: "b5" }, dueAt: "2026-11-05T12:00:00.000Z" });
    expect(item.actions.map((a) => a.name)).toEqual(["read_plan", "plan"]);
    expect(item.actions[1].path).toContain("/api/v1/issues/b5/plan");
    expect(itemsFor(agent("working"), work(), nothingMine)).toEqual([]);
  });

  it("waits on the owner once the plan is submitted, and offers refuse_plan after a send-back", () => {
    const waiting = itemsFor(agent("working"), work(), { ...nothingMine, planning: [planningClaim({ id: "plan1", round: 1, decision: null, reviewBy: new Date("2026-11-05T12:00:00Z"), decisionNote: null })] });
    expect(waiting[0]).toMatchObject({ kind: "plan_waiting", canAct: false });
    const sentBack = itemsFor(agent("working"), work(), { ...nothingMine, planning: [planningClaim({ id: "plan1", round: 1, decision: "sent_back", reviewBy: new Date("2026-11-05T13:00:00Z"), decisionNote: "Skip the flag." })] });
    expect(sentBack[0]).toMatchObject({ kind: "write_plan", canAct: true, dueAt: "2026-11-05T13:00:00.000Z" });
    expect(sentBack[0].detail).toContain("Skip the flag.");
    expect(sentBack[0].actions.map((a) => a.name)).toEqual(["read_plan", "plan", "refuse_plan"]);
  });
});

describe("itemsFor", () => {
  it("does not ask an imported delivery's agent or its owner's other agents to judge that work (#788)", () => {
    const project = work({
      tests: [{ id: "imported", number: 788, title: "Outside work", pullRequestUrl: PR }],
      facts: new Map([["imported", facts({ outsideWork: { agentId: "agent-owner-ada" }, pullRequestUrl: PR })]]),
    });
    for (const actor of [agent("working", "owner-ada"), { ...agent("manager", "owner-ada"), agentId: "sibling-agent" }]) {
      expect(itemsFor(actor, project, nothingMine).some((item) => item.kind === "test_fix")).toBe(false);
    }
    expect(itemsFor(agent("working", "owner-bob"), project, nothingMine).some((item) => item.kind === "test_fix")).toBe(true);
  });

  it("asks to confirm a converted issue at the confirmations route, and drops it once the owner gave an entry", () => {
    const issue = { id: "b1", number: 7, title: "x", confirmations: 1, needed: 2, confirmed: false };
    const items = itemsFor(agent("working"), work({ toConfirm: [issue], facts: new Map([["b1", facts()]]) }), nothingMine);
    expect(items[0]).toMatchObject({ kind: "confirm_issue", canAct: true });
    expect(items[0].detail).toContain("1 of 2 confirmations");
    expect(items[0].actions.map((a) => a.name)).toEqual(["confirm_issue"]);
    expect(items[0].actions[0].path).toContain("/api/v1/issues/b1/confirmations");
    expect(items[0].actions[0].cli).toContain("confirm-issue --id b1 --verdict confirm|reject|neutral --summary");

    // A worker agent's owner gave a working-class entry: not asked again (a manager agent still may give one).
    const done = facts({ confirmerOwners: ["owner-bob:working"] });
    expect(itemsFor(agent("working"), work({ toConfirm: [issue], facts: new Map([["b1", done]]) }), nothingMine)).toEqual([]);
  });

  it("leaves out fixes the owner already judged at this pull request with this class, not the other class (#owner-agents)", () => {
    const pr = "https://github.com/emerjent/ziki/pull/1";
    const tested = facts({ pullRequestUrl: pr, testerOwners: [{ ownerUserId: "owner-bob", verdictClass: "working", pullRequestUrl: pr }] });
    const project = work({ tests: [{ id: "b1", number: 7, title: "x", pullRequestUrl: pr }], facts: new Map([["b1", tested]]) });
    expect(itemsFor(agent("working"), project, nothingMine)).toEqual([]);
    expect(itemsFor(agent("manager"), project, nothingMine).some((i) => i.kind === "test_fix")).toBe(true);
  });

  it("lists a fix whose pull request can't merge as not actionable, with the reason (#864)", () => {
    const pr = "https://github.com/emerjent/ziki/pull/2";
    const row = { id: "b1", number: 7, title: "x", pullRequestUrl: pr };
    const base = { tests: [row], facts: new Map([["b1", facts({ pullRequestUrl: pr })]]) };
    const blocked = itemsFor(agent("working"), work({ ...base, judgeBlocks: new Map([["b1", "The pull request has merge conflicts with its base branch."]]) }), nothingMine).find((i) => i.kind === "test_fix");
    expect(blocked).toMatchObject({ canAct: false, blockedReason: "The pull request has merge conflicts with its base branch." });
    expect(blocked!.detail).toContain("List the changed files you judged");
    // A pull request nothing blocks stays actionable.
    const open = itemsFor(agent("working"), work(base), nothingMine).find((i) => i.kind === "test_fix");
    expect(open).toMatchObject({ canAct: true });
    expect(open).not.toHaveProperty("blockedReason");
  });

  it("lists manager and merger work for a working agent without letting it act", () => {
    const project = work({
      ready: [{ id: "b1", number: 1, title: "x", importance: 3 }],
      toAward: [{ id: "b4", number: 4, title: "w", bids: [openBid({ issue: { id: "b4", number: 4, title: "w" }, weightedVotes: 3 })] }],
      toClose: [{ id: "b5", number: 5, title: "v", reason: "superseded", votes: 3, tallies: [{ reason: "superseded", votes: 3 }], threshold: 3, suggestions: 1, summaries: ["#2 covers it."], suggesters: ["owner-cara"], duplicateOfNumber: null }],
      toAccept: [{ id: "b2", number: 2, title: "y" }],
      toMerge: [{ id: "b3", number: 3, title: "z" }],
      facts: new Map([["b2", facts()], ["b3", facts()]]),
    });
    const items = itemsFor(agent("working"), project, nothingMine);
    const byKind = Object.fromEntries(items.map((item) => [item.kind, item]));
    expect(byKind.ready_issue).toMatchObject({ canAct: true, minimumRole: "working" });
    expect(byKind).not.toHaveProperty("dispatch");
    // A bid at the threshold is any agent's to award (#bid-votes).
    expect(byKind.award_bid).toMatchObject({ canAct: true, minimumRole: "working" });
    expect(byKind.close_issue).toMatchObject({ canAct: false, minimumRole: "manager", blockedReason: "Needs a manager agent." });
    expect(byKind.accept_fix).toMatchObject({ canAct: false, minimumRole: "manager" });
    expect(byKind.merge_fix).toMatchObject({ canAct: false, minimumRole: "merger", blockedReason: "Needs a merger agent." });

    const merger = Object.fromEntries(itemsFor(agent("merger"), project, nothingMine).map((item) => [item.kind, item]));
    expect(merger.award_bid.canAct).toBe(true);
    expect(merger.close_issue.canAct).toBe(true);
    expect(merger.accept_fix.canAct).toBe(true);
    expect(merger.merge_fix.canAct).toBe(true);
  });

  it("asks to stake or bid on a ready issue, with no offer request (#stakes)", () => {
    const [item] = itemsFor(agent("working"), work({ ready: [{ id: "b1", number: 1, title: "x", importance: 3 }] }), nothingMine);
    expect(item).toMatchObject({ kind: "ready_issue", title: "Bid on #1", canAct: true });
    expect(item.actions.map((a) => a.name)).toEqual(["stake", "bid"]);
    expect(item.actions[0]).toMatchObject({ method: "POST", path: "/api/v1/issues/b1/stake?projectId=p1" });
    expect(item.actions[1]).toMatchObject({ method: "POST", path: "/api/v1/issues/b1/bid?projectId=p1" });
  });

  it("asks agents to vote for an open bid, not a working agent of its own owner, nor a past voter (#bid-votes)", () => {
    const bid = openBid({ weightedVotes: 1, voters: ["owner-cara"] });
    const items = itemsFor(agent("working"), work({ bids: [bid] }), nothingMine).filter((item) => item.kind === "review_bid");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: "review_bid:bid-ada", minimumRole: "working", canAct: true, issue: { id: "b1", number: 1 } });
    expect(items[0].detail).toContain("It has 1 vote");
    expect(items[0].detail).toContain("Any agent may award it now");
    expect(items[0].actions).toEqual([
      { name: "vote_bid", minimumRole: "working", method: "POST", path: "/api/v1/bids/bid-ada/votes?projectId=p1", cli: "vote-bid --id bid-ada" },
    ]);

    for (const ownerId of ["owner-ada", "owner-cara"]) {
      expect(itemsFor(agent("working", ownerId), work({ bids: [bid] }), nothingMine).some((item) => item.kind === "review_bid")).toBe(false);
    }
  });

  it("shows each bidder's load and offers no award for a bid at capacity (#bidder-capacity)", () => {
    const issue = { id: "b1", number: 1, title: "x" };
    const bids = [
      openBid({ id: "bid-pixel", agentName: "Pixel", ownerIds: ["owner-pix"], by: "Pix", weightedVotes: 5, load: 2 }),
      openBid({ id: "bid-cara", agentName: "Cara's Claude", ownerIds: ["owner-cara"], by: "Cara", weightedVotes: 3, load: 1 }),
    ];
    const item = itemsFor(agent("working", "owner-eli"), work({ toAward: [{ ...issue, bids }] }), nothingMine).find((i) => i.kind === "award_bid");
    expect(item).toMatchObject({ canAct: true, title: "Award #1: 2 bids waiting, nobody holds it" });
    expect(item!.detail).toContain("Pixel: 2 of 2 — at capacity");
    expect(item!.detail).toContain("Cara's Claude: 1 of 2");
    expect(item!.actions.map((a) => a.cli)).toEqual(["award-bid --id bid-cara"]);
  });

  it("lets a manager accept its own owner's fix (#owner-agents)", () => {
    const own = facts({ reporterId: "owner-dana", beneficiaryUserId: "owner-dana" });
    const items = itemsFor(agent("manager", "owner-dana"), work({ toAccept: [{ id: "b2", number: 2, title: "y" }], facts: new Map([["b2", own]]) }), nothingMine);
    expect(items[0]).toMatchObject({ kind: "accept_fix", canAct: true });
  });

  it("asks an independent agent to check a pull request on GitHub and report it, not the issue's own side (#pr-reports)", () => {
    const pr9 = "https://github.com/emerjent/ziki/pull/9";
    const unreported = prIssue("b3", 9, pr9, "delivered");
    const project = (report: StoredPullRequestReport | null, why: string) => work({
      toReportPr: [{ ...prIssue("b3", 9, pr9, "delivered", report), why }],
      prGates: new Map([["b3", unreported.gate]]),
      facts: new Map([["b3", facts({ pullRequestUrl: pr9, assigneeId: "owner-cara", deliveryAgentIds: ["agent-finn-worker"] })]]),
    });
    const fresh = project(null, "Nobody has reported this pull request's state yet.");
    const item = itemsFor(agent("working", "owner-eli"), fresh, nothingMine).find((i) => i.kind === "report_pr_status");
    expect(item).toMatchObject({
      key: `report_pr_status:b3:${pr9}:none`,
      title: "Check PR #9 on GitHub and report its state",
      minimumRole: "working",
      canAct: true,
      issue: { id: "b3", number: 9 },
    });
    expect(item!.detail).toContain(`#9 links ${pr9}. Nobody has reported this pull request's state yet.`);
    expect(item!.actions).toEqual([expect.objectContaining({ name: "report_pr_status", minimumRole: "working", method: "POST", path: "/api/v1/issues/b3/pull-request-status?projectId=p1" })]);
    expect(item!.actions[0].cli).toContain(`report-pr-status --id b3 --pull-request-url ${pr9}`);

    // The filer's, the assignee's and the deliverer's other agents may report too (#owner-agents).
    for (const ownerId of ["owner-ada", "owner-cara", "owner-finn"]) {
      expect(itemsFor(agent("manager", ownerId), fresh, nothingMine).some((i) => i.kind === "report_pr_status")).toBe(true);
    }
    // Only the agent that delivered it is not asked.
    const deliverer = { ...agent("working", "owner-finn"), agentId: "agent-finn-worker" };
    expect(itemsFor(deliverer, fresh, nothingMine).some((i) => i.kind === "report_pr_status")).toBe(false);

    // An old report: the key moves with it, and the detail names it.
    const old = project(prReport({ id: "rep9", bugId: "b3", pullRequestUrl: pr9 }), "The latest report is 7 hours old.");
    const again = itemsFor(agent("working", "owner-eli"), old, nothingMine).find((i) => i.kind === "report_pr_status");
    expect(again!.key).toBe(`report_pr_status:b3:${pr9}:rep9`);
    expect(again!.detail).toContain(`The latest report (open) is from Erin's agent at ${REPORTED_AT.toISOString()}.`);
  });

  it("puts offers addressed to the agent first, with their deadline", () => {
    const offeredAt = new Date("2026-10-29T10:00:00Z");
    const mine: AgentWork = {
      ...nothingMine,
      offers: [{ id: "o1", offeredAt, bug: { id: "b9", number: 9, title: "Offered" } }],
    };
    const items = itemsFor(agent("working"), work({ ready: [{ id: "b1", number: 1, title: "x", importance: 3 }] }), mine);
    expect(items[0]).toMatchObject({ kind: "offer", key: "offer:o1", dueAt: "2026-10-29T10:30:00.000Z" });
    expect(items[0].actions[0]).toMatchObject({ name: "accept_offer", path: "/api/v1/offers/o1/accept", cli: "accept-offer --id o1" });
  });
});

describe("workEtag", () => {
  it("changes with the feed and stays the same for an equal one", () => {
    const feed = { items: [], ask: [] } as unknown as WorkFeed;
    expect(workEtag(feed)).toBe(workEtag({ ...feed }));
    expect(workEtag(feed)).not.toBe(workEtag({ ...feed, ask: ["new"] }));
    expect(workEtag(feed)).toMatch(/^W\/"[\w-]+"$/);
  });
});

describe("keeping marketing work out of the work feed", () => {
  it("reads only product work into a project's feed", async () => {
    clearWorkCache();
    queries.length = 0;
    await projectWork("t1", { id: "p1", slug: "acme", name: "Acme", orgSlug: "acme" });

    const lists = queries.filter((q) => (q.model === "bug" || q.model === "idea") && q.method === "findMany" && q.args?.where?.projectId === "p1");
    expect(lists.length).toBeGreaterThan(5);
    for (const query of lists) expect(query.args?.where?.track, JSON.stringify(query.args?.where)).toBe("product");

    const bids = queries.find((q) => q.model === "issueBid" && q.method === "findMany");
    expect(bids?.args?.where?.bug).toMatchObject({ projectId: "p1", track: "product" });
  });

  it("reads marketing work when track is marketing", async () => {
    clearWorkCache();
    queries.length = 0;
    const marketingWork = await projectWork("t1", { id: "p1", slug: "acme", name: "Acme", orgSlug: "acme" }, "marketing");

    const lists = queries.filter((q) => (q.model === "bug" || q.model === "idea") && q.method === "findMany" && q.args?.where?.projectId === "p1");
    expect(lists.length).toBeGreaterThan(0);
    for (const query of lists) expect(query.args?.where?.track, JSON.stringify(query.args?.where)).toBe("marketing");

    // Marketing feed excludes product-specific queries:
    expect(marketingWork.toConfirm).toEqual([]);
    expect(marketingWork.toMerge).toEqual([]);
    expect(marketingWork.toDeliverStranded).toEqual([]);
    expect(marketingWork.deployments).toEqual([]);
    expect(marketingWork.jobs).toEqual([]);
    expect(marketingWork.toReconcile).toEqual([]);
    expect(marketingWork.toAwaitRelease).toEqual([]);
    expect(marketingWork.toRepair).toEqual([]);
    expect(marketingWork.toReportPr).toEqual([]);
  });
});

describe("workFeed marketing track response shape and items", () => {
  it("returns product work feed with track: product and no brief by default", async () => {
    clearWorkCache();
    const feed = await workFeed(agent("working"), { id: "p1", slug: "acme", name: "Acme", orgSlug: "acme" }, "product");
    expect(feed.track).toBe("product");
    expect(feed.brief).toBeUndefined();
    expect(feed.workUrl).not.toContain("track=marketing");
  });

  it("returns marketing work feed with track: marketing, no brief until one is written, and marketing workUrl", async () => {
    clearWorkCache();
    const feed = await workFeed(agent("working"), { id: "p1", slug: "acme", name: "Acme", orgSlug: "acme" }, "marketing");
    expect(feed.track).toBe("marketing");
    expect(feed.brief).toBeNull();
    expect(feed.workUrl).toContain("?track=marketing");
  });

  it("excludes product-only items from marketing feed", () => {
    const marketingWork = work({
      toConfirm: [],
      toMerge: [],
      toDeliverStranded: [],
      deployments: [],
      jobs: [],
      toReconcile: [],
      toAwaitRelease: [],
      toRepair: [],
      toReportPr: [],
    });
    const items = itemsFor(agent("working"), marketingWork, nothingMine);
    const kinds = items.map((i) => i.kind);
    expect(kinds).not.toContain("confirm_issue");
    expect(kinds).not.toContain("open_issue");
    expect(kinds).not.toContain("report_pr_status");
    expect(kinds).not.toContain("merge_fix");
    expect(kinds).not.toContain("reconcile_merged");
    expect(kinds).not.toContain("await_release");
    expect(kinds).not.toContain("repair_pull_request");
    expect(kinds).not.toContain("report_deployment");
    expect(kinds).not.toContain("deliver_stranded");
    expect(kinds).not.toContain("research_job");
    expect(kinds).not.toContain("job_review_offer");
  });

  it("includes marketing items with correct roles and actions", () => {
    const marketingWork = work({
      ideas: [{ id: "i1", number: 1, title: "Marketing Idea", score: 1 }],
      toConvert: [{ id: "i2", number: 2, title: "Convertible Idea", score: 3 }],
      toReject: [{ id: "i3", number: 3, title: "Bad Idea", totalVotes: 5, goodVotes: 0 }],
      ready: [{ id: "b1", number: 1, title: "Ready Marketing Task", importance: 2 }],
      tests: [{ id: "b2", number: 2, title: "Test Fix", pullRequestUrl: null }],
      toAccept: [{ id: "b3", number: 3, title: "Accept Fix" }],
      facts: new Map([["b2", facts()], ["b3", facts()]]),
    });
    const items = itemsFor(agent("manager"), marketingWork, nothingMine);
    const byKind = Object.fromEntries(items.map((i) => [i.kind, i]));

    expect(byKind.idea).toMatchObject({ minimumRole: "working", canAct: true });
    expect(byKind.convert_idea).toMatchObject({ minimumRole: "working", canAct: true });
    expect(byKind.reject_idea).toMatchObject({ minimumRole: "manager", canAct: true });
    expect(byKind.ready_issue).toMatchObject({ minimumRole: "working", canAct: true });
    expect(byKind.test_fix).toMatchObject({ minimumRole: "working", canAct: true });
    expect(byKind.accept_fix).toMatchObject({ minimumRole: "manager", canAct: true });
  });
});

describe("track parameter parsing and event/webhook payloads", () => {
  it("parses valid and invalid track filters", () => {
    expect(parseTrackFilter(null)).toEqual({ ok: true, track: "product" });
    expect(parseTrackFilter(undefined)).toEqual({ ok: true, track: "product" });
    expect(parseTrackFilter("")).toEqual({ ok: true, track: "product" });
    expect(parseTrackFilter("product")).toEqual({ ok: true, track: "product" });
    expect(parseTrackFilter("marketing")).toEqual({ ok: true, track: "marketing" });
    expect(parseTrackFilter("other")).toEqual({ ok: false, message: "track must be product or marketing." });
  });

  it("parses track in event filters", () => {
    const marketing = parseEventFilters(new URLSearchParams("track=marketing"));
    expect("error" in marketing).toBe(false);
    if (!("error" in marketing)) {
      expect(marketing.track).toBe("marketing");
    }

    const product = parseEventFilters(new URLSearchParams("track=product"));
    expect("error" in product).toBe(false);
    if (!("error" in product)) {
      expect(product.track).toBe("product");
    }

    const empty = parseEventFilters(new URLSearchParams());
    expect("error" in empty).toBe(false);
    if (!("error" in empty)) {
      expect(empty.track).toBeUndefined();
    }
  });

  it("includes track in webhook delivery payloads", () => {
    const event = {
      id: "ev1",
      type: "issue.created",
      organisationId: "t1",
      projectId: "p1",
      actorAgentId: null,
      bugId: "b1",
      createdAt: new Date(),
      payload: { bugId: "b1", title: "Marketing Campaign", track: "marketing" },
    };
    const body = webhookBody(event);
    expect(body.track).toBe("marketing");
  });
});
