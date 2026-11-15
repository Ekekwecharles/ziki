import { isFormerNameOf } from "@/lib/github/former-repos";
import { parsePullRequestUrl, sameRepo, type RepoRef } from "@/lib/github/pull-request-url";
import { MERGE_CONFLICT_MESSAGE } from "@/lib/agent-api/merge-conflict";
import { sameCommit } from "@/lib/github/commit-sha";

/**
 * The one rule over an issue's pull request (#pr-reports).
 *
 * Agents independent of the issue check the linked
 * pull request on GitHub and report what they saw
 * (`POST /api/v1/issues/{id}/pull-request-status`); the latest report for the
 * issue's current pull request is its state. Delivery, a merge review's accept,
 * resolving merged work, the work feed and triage all read this gate, so they
 * agree. It is pure: the caller loads the report (`latestPullRequestReport`).
 */

/**
 * How an issue's pull request link relates to the project's repository, from
 * the URL alone. `ok`: in it. `old_repository`: under a former name of it
 * (repair the link). `other_repository`: somewhere else, or not a pull request
 * address. `missing`: no link. `unknown`: the project names no repository.
 */
export type LinkState = "ok" | "old_repository" | "other_repository" | "missing" | "unknown";

/** `linkState` from the URL and the project's repository. */
export function linkStateFromUrl(pullRequestUrl: string | null | undefined, repo: RepoRef | null): LinkState {
  if (!pullRequestUrl) return "missing";
  if (!repo) return "unknown";
  const ref = parsePullRequestUrl(pullRequestUrl);
  if (!ref) return "other_repository";
  if (sameRepo(ref, repo)) return "ok";
  return isFormerNameOf(ref, repo) ? "old_repository" : "other_repository";
}

export type PullRequestStateValue = "open" | "closed" | "merged" | "not_found";
export type ChecksValue = "passing" | "failing" | "pending" | "none" | "unknown";

/** What the gate reads from a report. */
export type GateReport = {
  pullRequestUrl: string;
  state: PullRequestStateValue;
  mergedInto: string | null;
  inDefaultBranch: boolean | null;
  headSha: string | null;
  checks: string | null;
  mergeable: boolean | null;
};

/** What the gate reads from the issue. */
export type GateIssue = {
  /** The pull request being judged: the linked one, or the one being delivered. */
  pullRequestUrl: string | null;
  /** The head commit Ziki has for it (delivery, or the pull_request webhook). */
  pullRequestHeadSha?: string | null;
  /** The project's repository; null when it names none. */
  repo: RepoRef | null;
};

export type PrBroken = "not_found" | "closed_unmerged" | "old_repository" | "other_repository";

export type PrGate = {
  /** Work may be delivered on it (open, or not reported yet). */
  canDeliver: boolean;
  /** A merge review may accept it: open, checks passing (or none), no conflict, the reported head is Ziki's head. */
  canAccept: boolean;
  /** It is merged and the default branch contains it: resolve it (Live). */
  canReconcile: boolean;
  /** Merged into another branch (`mergedInto`) that isn't released to the default branch yet. */
  awaitingRelease: boolean;
  /** Why it can't go anywhere as linked; null when it can. */
  broken: PrBroken | null;
  /** An independent agent should check it on GitHub and report. */
  needsReport: boolean;
  /** Why the gate says what it says, in a sentence; null when everything is allowed that can be. */
  reason: string | null;
};

const CLOSED: Omit<PrGate, "broken" | "reason" | "needsReport"> = {
  canDeliver: false,
  canAccept: false,
  canReconcile: false,
  awaitingRelease: false,
};

const REPORT_HOW = "An agent independent of the issue checks it on GitHub and reports it (POST /api/v1/issues/{id}/pull-request-status).";

/** After this long, the work feed and triage ask an independent agent to check the pull request again. */
export const REPORT_STALE_HOURS = 6;

/**
 * Why an independent agent should check the pull request on GitHub and report
 * it now, or null when there is no need: nobody reported it, the gate needs a
 * new report (the head moved, checks still running, something left unsaid),
 * or the latest report is older than `REPORT_STALE_HOURS`. A link outside the
 * project's repository is repaired first; no report helps it.
 */
export function reportWanted(gate: PrGate, report: { createdAt: Date; checkedAt?: Date | null } | null, now = Date.now()): string | null {
  if (gate.broken === "old_repository" || gate.broken === "other_repository") return null;
  if (!report) return gate.needsReport ? "Nobody has reported this pull request's state yet." : null;
  if (gate.needsReport) return gate.reason;
  // Ziki's own reads (#github-status) move checkedAt while GitHub says the same.
  const hours = Math.floor((now - (report.checkedAt ?? report.createdAt).getTime()) / 3_600_000);
  return hours >= REPORT_STALE_HOURS ? `The latest report is ${hours} hours old.` : null;
}

/** The gate over `issue`'s pull request and its latest report (null: none yet). */
export function prGate(report: GateReport | null, issue: GateIssue): PrGate {
  const url = issue.pullRequestUrl;
  const link = linkStateFromUrl(url, issue.repo);
  if (link === "missing") {
    return { ...CLOSED, broken: null, needsReport: false, reason: "No pull request is linked." };
  }
  if (link === "old_repository") {
    return { ...CLOSED, broken: "old_repository", needsReport: false, reason: "The pull request link uses an old name of the project's repository: repair it first (POST /api/v1/issues/{id}/pull-request)." };
  }
  if (link === "other_repository") {
    return { ...CLOSED, broken: "other_repository", needsReport: false, reason: "The pull request link is not in the project's repository: repair the link, or the author must submit a new pull request there." };
  }

  // A report on another address says nothing about this one.
  if (!report || report.pullRequestUrl !== url) {
    return { ...CLOSED, canDeliver: true, broken: null, needsReport: true, reason: `No agent has reported this pull request's state yet. ${REPORT_HOW}` };
  }

  switch (report.state) {
    case "not_found":
      return { ...CLOSED, broken: "not_found", needsReport: false, reason: "The latest report says the pull request doesn't exist on GitHub (404): the author must submit a new one, and a manager repairs the link." };
    case "closed":
      return { ...CLOSED, broken: "closed_unmerged", needsReport: false, reason: "The latest report says the pull request was closed without being merged: the author reopens it or submits a new one." };
    case "merged": {
      if (report.inDefaultBranch === true) {
        return { ...CLOSED, canReconcile: true, broken: null, needsReport: false, reason: null };
      }
      if (report.inDefaultBranch === false) {
        const into = report.mergedInto ? `"${report.mergedInto}"` : "another branch";
        return {
          ...CLOSED,
          awaitingRelease: true,
          broken: null,
          needsReport: false,
          reason: `Merged into ${into}, which isn't released to the default branch yet: resolve it once the default branch contains it, and report again then.`,
        };
      }
      return { ...CLOSED, broken: null, needsReport: true, reason: `The latest report says it is merged but not whether the default branch contains it. ${REPORT_HOW}` };
    }
    case "open": {
      const open = { ...CLOSED, canDeliver: true, broken: null };
      if (report.headSha && issue.pullRequestHeadSha && !sameCommit(report.headSha, issue.pullRequestHeadSha)) {
        return { ...open, needsReport: true, reason: `The head moved since the last report (reported ${report.headSha.slice(0, 7)}, now ${issue.pullRequestHeadSha.slice(0, 7)}). ${REPORT_HOW}` };
      }
      if (report.mergeable === false) {
        return { ...open, needsReport: false, reason: `The latest report says it can't merge: ${MERGE_CONFLICT_MESSAGE} The author resolves it and pushes.` };
      }
      if (report.checks === "failing") {
        return { ...open, needsReport: false, reason: "The latest report says its checks are failing: the author fixes them and pushes." };
      }
      if (report.checks === "pending") {
        return { ...open, needsReport: true, reason: `The latest report says its checks are still running. ${REPORT_HOW}` };
      }
      if (report.checks !== "passing" && report.checks !== "none") {
        return { ...open, needsReport: true, reason: `The latest report doesn't say whether its checks pass. ${REPORT_HOW}` };
      }
      return { ...open, canAccept: true, needsReport: false, reason: null };
    }
  }
}
