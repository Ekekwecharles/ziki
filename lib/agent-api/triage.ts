import { PRODUCT_TRACK } from "@/lib/marketing/track";
import type { AgentLevel, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { AgentContext } from "@/lib/agents/require-agent";
import { hasLevel, requireLevel } from "@/lib/agents/levels";
import { reviewerConflict, ReviewerNotIndependentError } from "@/lib/agents/independence";
import { IssueApiError } from "@/lib/agent-api/errors";
import { cursorOrderBy, cursorWhere, decodeCursor, MAX_PAGE_SIZE, toPage, type IssueCursor } from "@/lib/agent-api/create-policy";
import { deliveredClaim } from "@/lib/agent-api/merge-verdicts";
import { countJudgements, judgedBugSelect, judgementSelect, type Judgement } from "@/lib/agent-api/tested-status";
import { checksFor, loadProofRules } from "@/lib/proof";
import { strandedDelivery, type StrandedDelivery } from "@/lib/agent-api/stranded-delivery";
import { idleInProgress } from "@/lib/agent-api/idle";
import { staleHold, type StaleHold } from "@/lib/agent-api/stale-hold";
import { currentHold, type IssueHold } from "@/lib/issue-holders";
import { OPEN_BID_WHERE } from "@/lib/open-bids";
import { isThresholdOnly, weightedTally } from "@/lib/governance";
import { workflowFor } from "@/lib/workflow";
import { parsePullRequestUrl, type RepoRef } from "@/lib/github/pull-request-url";
import { PROJECT_REPOSITORIES_SELECT, repoForPullRequest } from "@/lib/github/project-repositories";
import { linkStateFromUrl, prGate, reportWanted, type LinkState, type PrGate } from "@/lib/agent-api/pr-gate";
import {
  gateReport,
  latestPullRequestReports,
  pullRequestStateView,
  type PullRequestStateView,
  type StoredPullRequestReport,
} from "@/lib/agent-api/pull-request-report";
import { absoluteUrl } from "@/lib/site-url";
import { issuePath } from "@/lib/issue-ref";
import { refOf } from "@/lib/project-paths";
import { activeLevels, levelIn } from "@/lib/agents/active-in";
import { sameCommit } from "@/lib/github/commit-sha";

/**
 * The manager's triage view (#triage): one read that says, for every issue in
 * the project that is moving, where it stands and what the caller may do next.
 *
 * A manager on production had to open each issue, its test verdicts and its
 * pull request on GitHub separately to decide what to do. This puts them in
 * one list: every issue In progress, Delivered, Done or Ready to Merge, and
 * every Open issue with open bids, each with
 *
 * - who holds it (the claim, `lib/issue-holders.ts`), and whether an Open
 *   issue's assignee is stale;
 * - its pull request: whether the link points at the project's repository
 *   (`linkState`), and the latest report on it from an agent independent of
 *   the issue (#pr-reports: state, the branch it was merged into, whether the
 *   default branch contains it, checks, conflicts), with who reported it and
 *   how long ago, and what the gate (lib/agent-api/pr-gate.ts) makes of it;
 * - its judgements on the linked pull request (the Delivered step's count);
 * - its open bids;
 * - `nextActions`: what the caller may do now, under the same rules the write
 *   routes enforce, each with `canAct` and, when blocked, why.
 *
 * It only reads, and never asks GitHub: an issue whose pull request needs
 * checking gets a `report_pr_status` action instead.
 */

/** The statuses triage lists (and Open issues with open bids). */
export const TRIAGE_STATUSES = ["in_progress", "done", "merge"] as const;

export const TRIAGE_DEFAULT_LIMIT = 50;

export type TriagePullRequest = {
  url: string | null;
  linkState: LinkState;
  /** From the latest report; `unreported` when no agent reported this pull request yet. */
  state: "open" | "closed" | "merged" | "not_found" | "unreported";
  /** The branch it was merged into, once reported merged. */
  mergedInto: string | null;
  /** Reported merged and contained in the default branch; null when not merged or not said. */
  inDefaultBranch: boolean | null;
  /** The head commit: the reported one, else the one Ziki has. */
  headSha: string | null;
  mergeCommitSha: string | null;
  checks: string | null;
  mergeable: boolean | null;
  /** The latest report, with who filed it and its age; null when none. */
  report: PullRequestStateView | null;
  /** What the rules make of it (lib/agent-api/pr-gate.ts). */
  gate: PrGate;
  /** Why an independent agent should check it on GitHub and report it now; null when not needed. */
  reportWanted: string | null;
};

export type TriageHolder = {
  state: "active_claim" | "live_offer" | "none";
  agentName: string | null;
  personName: string | null;
  via: IssueHold["via"] | null;
  offeredAt: string | null;
  claimedAt: string | null;
  assignee: { id: string; name: string | null } | null;
  /** An Open issue's assignee with no active claim or live offer behind it (#stale-assignee). */
  staleAssignee: boolean;
};

export type TriageAction = {
  action: string;
  method: "POST";
  route: string;
  minimumRole: AgentLevel;
  canAct: boolean;
  blockedReason?: string;
  /** Something to know before acting. */
  note?: string;
};

export type TriageItem = {
  issue: { id: string; number: number; title: string; status: string; substatus: string; url: string };
  holder: TriageHolder;
  pullRequest: TriagePullRequest;
  /** Judgements on the linked pull request; null with no pull request. */
  judgements: { good: number; notGood: number; needed: number; goodAtHead: number | null; headSha: string | null } | null;
  /** Open bids on an Open issue; null otherwise. */
  bids: { open: number } | null;
  nextActions: TriageAction[];
};

export type TriagePage = { items: TriageItem[]; nextCursor: string | null };

// ---------------------------------------------------------------------------
// The pull request, from its latest report
// ---------------------------------------------------------------------------

/** Everything triage says about one pull request link, from the link and its latest report. */
export function pullRequestFacts(
  url: string | null,
  repo: RepoRef | null,
  report: StoredPullRequestReport | null,
  issueHeadSha: string | null,
  now = Date.now(),
): TriagePullRequest {
  const current = report && report.pullRequestUrl === url ? report : null;
  const gate = prGate(gateReport(current), { pullRequestUrl: url, pullRequestHeadSha: issueHeadSha, repo });
  return {
    url,
    linkState: linkStateFromUrl(url, repo),
    state: current?.state ?? "unreported",
    mergedInto: current?.mergedInto ?? null,
    inDefaultBranch: current?.inDefaultBranch ?? null,
    headSha: current?.headSha ?? issueHeadSha,
    mergeCommitSha: current?.mergeCommitSha ?? null,
    checks: current?.checks ?? null,
    mergeable: current?.mergeable ?? null,
    report: pullRequestStateView(current, now),
    gate,
    reportWanted: reportWanted(gate, current, now),
  };
}

// ---------------------------------------------------------------------------
// What the caller may do: one pure rule over facts already read
// ---------------------------------------------------------------------------

export type TriageCaller = { agentId: string; ownerId: string; level: AgentLevel };

export type TriageFacts = {
  bug: Prisma.BugGetPayload<{ select: typeof triageBugSelect }>;
  projectId: string;
  repo: RepoRef | null;
  thresholdOnly: boolean;
  /** The project's awardThreshold: a bid whose weighted votes reach it may be awarded by any agent (#bid-votes). */
  awardThreshold: number;
  pullRequest: TriagePullRequest;
  judgements: TriageItem["judgements"];
  /** Open bids, most voted first: the bid id, its weighted votes and the owners it is from. */
  bids: { id: string; votes: number; ownerIds: string[] }[];
  hold: IssueHold | null;
  stranded: StrandedDelivery | null;
  /** Idle In progress work: whether a claim holds it, and its holder's owners. */
  idle: { held: boolean; holderOwners: string[]; idleHours: number } | null;
  stale: StaleHold["kind"] | null;
  /** The caller's owner already judged the linked pull request. */
  judgedByCaller: boolean;
};

const STALE_WHY: Record<StaleHold["kind"], string> = {
  offer_expired: "its offer was not accepted within the offer window",
  overdue: "its work was not delivered by the deadline",
  silent: "its agent stopped checking in and has delivered nothing",
};

/** The actions the caller may take on one issue now, with why each blocked one is blocked. */
export function nextActions(caller: TriageCaller, facts: TriageFacts): TriageAction[] {
  const { bug, pullRequest: pr, projectId } = facts;
  const prGateNow = pr.gate;
  const actions: TriageAction[] = [];
  const route = (tail: string) => `/api/v1/issues/${bug.id}/${tail}?projectId=${projectId}`;
  const conflict = reviewerConflict({ id: caller.agentId, ownerUserId: caller.ownerId }, bug);
  const notIndependent = conflict ? `Not independent: ${new ReviewerNotIndependentError(conflict).message}` : null;
  const gate = (role: AgentLevel, why: (string | null | undefined)[] = [], independence = true): Pick<TriageAction, "canAct" | "blockedReason"> => {
    if (!hasLevel(caller.level, role)) return { canAct: false, blockedReason: `Needs a ${role} agent.` };
    if (independence && notIndependent) return { canAct: false, blockedReason: notIndependent };
    const first = why.find((reason): reason is string => Boolean(reason));
    return first ? { canAct: false, blockedReason: first } : { canAct: true };
  };
  const push = (action: string, path: string, minimumRole: AgentLevel, result: Pick<TriageAction, "canAct" | "blockedReason">, note?: string) => {
    actions.push({ action, method: "POST", route: path, minimumRole, ...result, ...(note ? { note } : {}) });
  };
  const repoName = facts.repo ? `${facts.repo.owner}/${facts.repo.repo}` : "the project's repository";
  const ref = parsePullRequestUrl(pr.url);
  // Why a pull request can't be judged or accepted as linked.
  const linkProblem = prGateNow.broken ? prGateNow.reason : pr.linkState === "missing" ? "No pull request is linked." : null;

  // 1. A link to repair, or a pull request the author must replace.
  if (bug.substatus !== "open" && prGateNow.broken) {
    const number = ref ? `#${ref.number}` : "That number";
    const note = prGateNow.broken === "old_repository"
      ? `Leave pullRequestUrl out to link ${number} in ${repoName}; nobody has reported that one yet, so report it after.`
      : prGateNow.broken === "other_repository"
        ? `The link points outside ${repoName}; check that ${number} there is the same work, or send pullRequestUrl.`
        : `Only once the author has opened a new pull request in ${repoName}: send its pullRequestUrl.`;
    push("repair_pull_request", route("pull-request"), "manager", gate("manager"), note);
  }

  // 2. A pull request someone should check on GitHub and report.
  if (bug.substatus !== "open" && pr.reportWanted) {
    push("report_pr_status", route("pull-request-status"), "working", gate("working"), pr.reportWanted);
  }

  // 3. Merged already: resolve it, or wait for the release.
  if (pr.state === "merged" && bug.substatus !== "open") {
    if (prGateNow.awaitingRelease) {
      push("awaiting_release", route("resolve"), "manager", { canAct: false, blockedReason: prGateNow.reason ?? "Waiting for the release to the default branch." });
    } else {
      push("resolve", route("resolve"), "manager", gate("manager", [prGateNow.canReconcile ? null : prGateNow.reason]));
    }
    return actions;
  }

  // 4. The step's own move.
  switch (bug.substatus) {
    case "in_progress": {
      if (facts.stranded) {
        const broken = prGateNow.broken ? `${prGateNow.reason} Nothing to deliver; reclaim it if it is idle.` : null;
        push("deliver_stranded", route("delivery"), "manager", gate("manager", [broken]),
          `${facts.stranded.goodVerdicts} of ${facts.stranded.needed} good-to-merge judgements are on the linked pull request.`);
      }
      // A stranded delivery is asked once, as deliver_stranded, not also as idle work (as in the work feed),
      // unless its pull request is broken: then reclaiming it is the way on.
      const idle = facts.stranded && !prGateNow.broken ? null : facts.idle;
      if (idle && !idle.held) {
        push("review_idle", route("reclaim"), "manager", gate("manager"),
          `No update for ${idle.idleHours}h and nobody holds it: reclaim it if it was abandoned, or leave it if work is visibly ongoing.`);
      }
      if (idle?.held) {
        const own = idle.holderOwners.includes(caller.ownerId) ? "Your owner holds this claim." : null;
        push("vote_abandoned", route("abandon-votes"), "working", gate("working", [own], false),
          `No update for ${idle.idleHours}h while a claim holds it.`);
      }
      break;
    }
    case "requires_review": {
      const judged = facts.judgedByCaller ? "Your owner already judged this pull request." : null;
      push("submit_test_result", route("test-results"), "working", gate("working", [linkProblem, judged]));
      break;
    }
    case "accepted": {
      const j = facts.judgements;
      const short = j && j.good < j.needed ? `${j.good} of ${j.needed} good-to-merge judgements on the linked pull request.` : null;
      const head = j && j.goodAtHead !== null && j.goodAtHead < j.needed
        ? `Only ${j.goodAtHead} of ${j.needed} judgements are on the current head${j.headSha ? ` (${j.headSha.slice(0, 7)})` : ""}; later commits weren't judged.`
        : undefined;
      const role: AgentLevel = facts.thresholdOnly ? "working" : "manager";
      push("accept_fix", route("merge"), role, gate(role, [prGateNow.canAccept ? null : prGateNow.reason, short]), head);
      break;
    }
    case "ready_to_merge":
    case "error": {
      // Ziki doesn't merge: the merger merges on GitHub, reports it merged here, then resolves it.
      push("merge_on_github", route("pull-request-status"), "merger", gate("merger", [prGateNow.canAccept ? null : prGateNow.reason]),
        `Merge ${pr.url ?? "the pull request"} on GitHub yourself, then report it merged (state "merged", inDefaultBranch) and resolve it (POST ${route("resolve")}).`);
      break;
    }
    case "open": {
      const live = facts.hold
        ? `${facts.hold.agentName} for ${facts.hold.personName} ${facts.hold.status === "active" ? "holds it" : "has a live offer on it"}.`
        : null;
      // Bids are awarded by votes (#bid-votes): a bid at the threshold may be
      // awarded by any agent; below it, the best bid the caller may vote for
      // (a working agent not its own owner's; a manager or merger agent any).
      const threshold = facts.awardThreshold;
      const top = facts.bids[0];
      if (top && top.votes >= threshold) {
        push("award_bid", `/api/v1/bids/${top.id}/award?projectId=${projectId}`, "working", gate("working", [live], false),
          `The most voted bid (${top.votes} of ${threshold} votes) reached the threshold, so any agent may award it.`);
      } else if (top) {
        const votable = hasLevel(caller.level, "manager") ? facts.bids : facts.bids.filter((bid) => !bid.ownerIds.includes(caller.ownerId));
        const ownOnly = !votable.length ? "Every bid on it is from your owner." : null;
        const best = votable[0] ?? top;
        push("vote_bid", `/api/v1/bids/${best.id}/votes?projectId=${projectId}`, "working", gate("working", [ownOnly], false),
          `The most voted bid you may vote for (${best.votes} of ${threshold} votes); once a bid has ${threshold}, any agent can award it.`);
      }
      break;
    }
  }

  // 5. A stale hold, for anyone to ask the site to take back (#reclaim).
  if (facts.stale) {
    push("reclaim", route("reclaim"), "working", gate("working", [], false), `Stale: ${STALE_WHY[facts.stale]}.`);
  }
  return actions;
}

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------

export const triageBugSelect = {
  ...judgedBugSelect,
  number: true,
  title: true,
  createdAt: true,
  pullRequestHeadSha: true,
  assignee: { select: { id: true, name: true } },
} satisfies Prisma.BugSelect;

/** `?limit=` (default 50, at most 100) and `?cursor=`. */
export function parseTriageQuery(params: URLSearchParams): { limit: number; cursor: IssueCursor | null } {
  const raw = params.get("limit");
  let limit = TRIAGE_DEFAULT_LIMIT;
  if (raw !== null && raw.trim() !== "") {
    const value = raw.trim();
    if (!/^\d+$/.test(value) || Number(value) < 1) {
      throw new IssueApiError(422, `limit must be a whole number between 1 and ${MAX_PAGE_SIZE}; the default is ${TRIAGE_DEFAULT_LIMIT}.`);
    }
    limit = Math.min(Number(value), MAX_PAGE_SIZE);
  }
  const cursorRaw = params.get("cursor");
  const cursor = decodeCursor(cursorRaw);
  if (cursorRaw !== null && !cursor) throw new IssueApiError(400, "Invalid cursor.");
  return { limit, cursor };
}

/** One page of the project's triage, oldest issue first, for a manager or merger agent. */
export async function triageQueue(
  agent: AgentContext,
  scope: { organisationId: string; projectId: string },
  query: { limit: number; cursor: IssueCursor | null },
  deps: { now?: number } = {},
): Promise<TriagePage> {
  requireLevel(agent, "manager");
  const now = deps.now ?? Date.now();
  const project = await prisma.project.findFirst({
    where: { id: scope.projectId, organisationId: scope.organisationId },
    select: { id: true, slug: true, repoUrl: true, ...PROJECT_REPOSITORIES_SELECT, organisation: { select: { slug: true } } },
  });
  if (!project) throw new IssueApiError(404, "Project not found.");
  const workflow = await workflowFor(project.id);
  const thresholdOnly = isThresholdOnly(workflow);

  const rows = await prisma.bug.findMany({
    where: {
      organisationId: scope.organisationId,
      projectId: project.id,
      ...PRODUCT_TRACK,
      isDeleted: false,
      AND: [
        { OR: [{ status: { in: [...TRIAGE_STATUSES] } }, { substatus: "open", bids: { some: OPEN_BID_WHERE } }] },
        cursorWhere(query.cursor, "asc"),
      ],
    },
    orderBy: cursorOrderBy("asc"),
    take: query.limit + 1,
    select: triageBugSelect,
  });
  const page = toPage(rows, query.limit);
  const caller: TriageCaller = { agentId: agent.agentId, ownerId: agent.ownerId, level: agent.level };
  const reports = await latestPullRequestReports(page.items);

  const items = await Promise.all(page.items.map(async (bug): Promise<TriageItem> => {
    // The repository this pull request is in: the main one or one the project lists (#2).
    const repo = repoForPullRequest(project, bug.pullRequestUrl);
    const pullRequest = pullRequestFacts(bug.pullRequestUrl, repo, reports.get(bug.id) ?? null, bug.pullRequestHeadSha ?? null, now);
    const [hold, judged, bids, stranded, idle, stale] = await Promise.all([
      currentHold(bug.id),
      bug.pullRequestUrl ? judgementsOn(bug, pullRequest.headSha, workflow.verdictsNeeded, caller.ownerId) : Promise.resolve(null),
      bug.substatus === "open" ? openBidsOn(bug.id, workflow.managerVoteWeight) : Promise.resolve([]),
      bug.status === "in_progress" ? strandedDelivery(bug.id, prisma, new Date(now)) : Promise.resolve(null),
      bug.status === "in_progress" ? idleInProgress(bug.id, prisma, now) : Promise.resolve(null),
      bug.substatus === "open" || bug.status === "in_progress" ? staleHold(bug.id, new Date(now)) : Promise.resolve(null),
    ]);
    const facts: TriageFacts = {
      bug,
      projectId: project.id,
      repo,
      thresholdOnly,
      awardThreshold: workflow.awardThreshold,
      pullRequest,
      judgements: judged?.counts ?? null,
      bids,
      hold,
      stranded,
      idle: idle
        ? {
          held: Boolean(idle.claim),
          holderOwners: idle.claim ? [idle.claim.beneficiaryUserId, idle.claim.agent.ownerUserId] : [],
          idleHours: Math.floor((now - idle.lastUpdate.getTime()) / 3_600_000),
        }
        : null,
      stale: stale?.kind ?? null,
      judgedByCaller: judged?.byCaller ?? false,
    };
    return {
      issue: { id: bug.id, number: bug.number, title: bug.title, status: bug.status, substatus: bug.substatus, url: absoluteUrl(issuePath(refOf(project), bug.number)) },
      holder: holderOf(bug, hold),
      pullRequest,
      judgements: facts.judgements,
      bids: bug.substatus === "open" ? { open: bids.length } : null,
      nextActions: nextActions(caller, facts),
    };
  }));
  return { items, nextCursor: page.nextCursor };
}

/** Who holds the issue, in triage's words. */
export function holderOf(
  bug: { substatus: string; assignee: { id: string; name: string | null } | null },
  hold: IssueHold | null,
): TriageHolder {
  return {
    state: !hold ? "none" : hold.status === "active" ? "active_claim" : "live_offer",
    agentName: hold?.agentName ?? null,
    personName: hold?.personName ?? null,
    via: hold?.via ?? null,
    offeredAt: hold?.offeredAt?.toISOString() ?? null,
    claimedAt: hold?.claimedAt?.toISOString() ?? null,
    assignee: bug.assignee,
    staleAssignee: bug.substatus === "open" && Boolean(bug.assignee) && !hold,
  };
}

/** The Delivered step's count on the linked pull request, the good ones at `headSha`, and whether the caller's owner judged it. */
async function judgementsOn(
  bug: Prisma.BugGetPayload<{ select: typeof triageBugSelect }>,
  headSha: string | null,
  needed: number,
  callerOwnerId: string,
): Promise<{ counts: NonNullable<TriageItem["judgements"]>; byCaller: boolean }> {
  const verdicts: Judgement[] = await prisma.testVerdict.findMany({
    where: { bugId: bug.id, pullRequestUrl: bug.pullRequestUrl! },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: judgementSelect,
  });
  // With no claim, whoever the deliveries on this pull request credit can't judge it (tested-status.ts).
  const credited = deliveredClaim(bug)
    ? []
    : (await prisma.delivery.findMany({ where: { bugId: bug.id, pullRequestUrl: bug.pullRequestUrl! }, select: { beneficiaryUserId: true } }))
      .map((delivery) => delivery.beneficiaryUserId);
  const checks = checksFor(await loadProofRules(prisma, bug.organisationId), bug);
  const { good, notGood } = countJudgements(verdicts, bug, credited, checks);
  const goodAtHead = headSha ? countJudgements(verdicts.filter((v) => sameCommit(v.headSha, headSha)), bug, credited, checks).good : null;
  const byCaller = verdicts.some((v) => v.agent.ownerUserId === callerOwnerId || v.onBehalfOfUserId === callerOwnerId);
  return { counts: { good, notGood, needed, goodAtHead, headSha }, byCaller };
}

/** Open bids on an issue, most weighted votes first, then oldest. */
async function openBidsOn(bugId: string, managerVoteWeight: number): Promise<TriageFacts["bids"]> {
  const rows = await prisma.issueBid.findMany({
    where: { bugId, ...OPEN_BID_WHERE },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true, beneficiaryUserId: true, agent: { select: { ownerUserId: true } },
      bug: { select: { organisationId: true } },
      votes: { select: { onBehalfOfUserId: true, agent: { select: { activations: activeLevels } } } },
    },
  });
  return rows
    .map((row) => ({
      id: row.id,
      votes: weightedTally(row.votes.map((vote) => ({ ownerId: vote.onBehalfOfUserId, level: levelIn(vote.agent, row.bug.organisationId) })), managerVoteWeight),
      ownerIds: [row.beneficiaryUserId, row.agent.ownerUserId],
    }))
    .sort((a, b) => b.votes - a.votes);
}
