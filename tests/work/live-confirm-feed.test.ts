import { describe, expect, it, vi } from "vitest";
import type { AgentContext } from "@/lib/agents/require-agent";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { itemsFor, type AgentWork, type ProjectWork } from "@/lib/agent-api/work";

/** Asking agents to check prod (#live-confirm): each says how many have confirmed, and nobody is asked who can't count. */
const agent = (ownerId: string): AgentContext => ({
  agentId: `agent-${ownerId}`, name: ownerId, ownerId, organisationId: "t1", level: "working", burst: false, keyId: "k1",
});
const nothingMine: AgentWork = { offers: [], reviewOffers: [], jobReviewOffers: [], claims: [], unread: 0, planning: [], unproven: new Map(), testsToAdd: [] };
/** #151, On prod from before the rule, reported on prod by Erin, solved by Cara. */
const deployment = (overrides: Partial<ProjectWork["deployments"][number]> = {}): ProjectWork["deployments"][number] => ({
  id: "b151", number: 151, title: "Keyboard focus", substatus: "on_prod",
  confirmedBy: ["owner-erin"],
  solverUserId: "owner-cara",
  ...overrides,
});
const work = (deployments: ProjectWork["deployments"]): ProjectWork => ({
  organisationId: "t1", project: { id: "p1", slug: "zedu", name: "Zedu", orgSlug: "zedu" }, importance: [], deployments,
  ideas: [], toConvert: [], toReject: [], toReclaim: [], toSenseCheck: [], toReviewIdle: [], toClose: [], toDeliverStranded: [],
  toReconcile: [], toAwaitRelease: [], toRepair: [], toReportPr: [], prGates: new Map(), judgeBlocks: new Map(), toConfirm: [], ideaThreshold: 3, tests: [],
  ready: [], bids: [], toAward: [], toInvestigate: [], comments: [], toAccept: [], toMerge: [], jobs: [], facts: new Map(),
  ideaFacts: new Map(), offerWindowSeconds: 1800, capacity: 2,
  rewards: [], contests: [],
  governance: { thresholdOnly: false, managerVoteWeight: 3, closeThreshold: 3, awardThreshold: 3, acceptThreshold: 3 },
});
const deploymentItems = (ownerId: string, deployments: ProjectWork["deployments"]) =>
  itemsFor(agent(ownerId), work(deployments), nothingMine).filter((item) => item.kind === "report_deployment");

describe("report_deployment items (#live-confirm)", () => {
  it("asks another agent to check an issue marked On prod that is short of confirmations", () => {
    const [item] = deploymentItems("owner-femi", [deployment()]);
    expect(item.title).toBe("Check #151 is really on prod");
    expect(item.detail).toContain("only 1 of 3 agents have found it there");
  });

  it("says where the count is on an issue still on its way", () => {
    const [item] = deploymentItems("owner-femi", [deployment({ substatus: "on_staging", confirmedBy: ["owner-erin", "owner-goke"] })]);
    expect(item.detail).toContain("2 of 3 agents have found it on prod; yours would be number 3");
  });

  it("doesn't ask an owner who already reported prod, or the solver, whose reports don't count", () => {
    expect(deploymentItems("owner-erin", [deployment()])).toEqual([]);
    expect(deploymentItems("owner-cara", [deployment()])).toEqual([]);
  });
});
