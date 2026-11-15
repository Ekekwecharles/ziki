import { linkStateFromUrl, REPORT_STALE_HOURS, type GateReport } from "@/lib/agent-api/pr-gate";
import type { RepoRef } from "@/lib/github/pull-request-url";
import { reportedAt } from "@/lib/agent-api/pull-request-report";
import { sameCommit } from "@/lib/github/commit-sha";

/**
 * The ready-to-merge checklist (#merge-checklist).
 *
 * Before a tester says "good to merge" or a manager accepts, the pull request
 * has to pass the same few checks every time: it is in the project's
 * repository, open, reported on the commit that was delivered, its checks are
 * green and it has no merge conflicts, and someone looked recently. Ziki never
 * calls GitHub, so every line comes from the latest pull request report
 * (lib/agent-api/pull-request-report.ts), the same evidence the gate reads
 * (lib/agent-api/pr-gate.ts). This turns it into one list a person can read at
 * a glance on the issue page. It is pure: the caller loads the report.
 */

export type ChecklistState = "pass" | "fail" | "wait";

export type ChecklistItem = {
  key: "repository" | "open" | "head" | "checks" | "conflicts" | "fresh";
  label: string;
  state: ChecklistState;
  /** Why it is not a pass, in a few words; null on a pass. */
  detail: string | null;
};

export type MergeChecklist = {
  items: ChecklistItem[];
  passed: number;
  total: number;
  /** ready: every line passes. blocked: a line fails. waiting: nothing fails, something is still unknown. */
  verdict: "ready" | "blocked" | "waiting";
  /** One sentence for the top of the card. */
  headline: string;
  /** When the latest report was made or refreshed, for "checked . ago"; null when nobody reported. */
  reportedAt: Date | null;
};

export type ChecklistIssue = {
  pullRequestUrl: string | null;
  /** The head commit Ziki has for the delivered pull request. */
  pullRequestHeadSha: string | null;
  /** The project's repository; null when it names none. */
  repo: RepoRef | null;
};

const short = (sha: string) => sha.slice(0, 7);

/** The checklist for `issue`'s pull request, from its latest report (null: none yet). */
export function mergeChecklist(
  report: (GateReport & { createdAt: Date; checkedAt?: Date | null }) | null,
  issue: ChecklistIssue,
  now = Date.now(),
): MergeChecklist {
  // A report on another address says nothing about this pull request.
  const current = report && issue.pullRequestUrl && report.pullRequestUrl === issue.pullRequestUrl ? report : null;
  const noReport = "Not reported yet";

  const link = linkStateFromUrl(issue.pullRequestUrl, issue.repo);
  const repository: ChecklistItem = {
    key: "repository",
    label: "Pull request is in the project's repository",
    state: link === "ok" ? "pass" : link === "unknown" ? "wait" : "fail",
    detail:
      link === "ok"
        ? null
        : link === "missing"
          ? "No pull request is linked"
          : link === "unknown"
            ? "The project names no repository"
            : link === "old_repository"
              ? "Uses an old name of the repository"
              : "Points somewhere else",
  };

  const open: ChecklistItem = {
    key: "open",
    label: "Open on GitHub",
    state: !current ? "wait" : current.state === "open" ? "pass" : "fail",
    detail: !current
      ? noReport
      : current.state === "open"
        ? null
        : current.state === "merged"
          ? "Already merged"
          : current.state === "closed"
            ? "Closed without merging"
            : "Not found (404)",
  };

  const delivered = issue.pullRequestHeadSha;
  const head: ChecklistItem = {
    key: "head",
    label: "Checked on the delivered commit",
    state: !current?.headSha || !delivered ? "wait" : sameCommit(current.headSha, delivered) ? "pass" : "fail",
    detail: !current
      ? noReport
      : !current.headSha || !delivered
        ? "Commit not reported"
        : sameCommit(current.headSha, delivered)
          ? null
          : `Head moved: checked ${short(current.headSha)}, delivered ${short(delivered)}`,
  };

  const checks: ChecklistItem = {
    key: "checks",
    label: "All checks green",
    state: !current
      ? "wait"
      : current.checks === "passing" || current.checks === "none"
        ? "pass"
        : current.checks === "failing"
          ? "fail"
          : "wait",
    detail: !current
      ? noReport
      : current.checks === "passing"
        ? null
        : current.checks === "none"
          ? null
          : current.checks === "failing"
            ? "Checks are failing"
            : current.checks === "pending"
              ? "Checks still running"
              : "Checks not reported",
  };

  const conflicts: ChecklistItem = {
    key: "conflicts",
    label: "No merge conflicts",
    state: !current || current.mergeable === null ? "wait" : current.mergeable ? "pass" : "fail",
    detail: !current ? noReport : current.mergeable === null ? "Not reported" : current.mergeable ? null : "Conflicts with its base branch",
  };

  const timestamp = current ? reportedAt(current) : null;
  const ageHours = timestamp ? Math.floor((now - timestamp.getTime()) / 3_600_000) : null;
  const fresh: ChecklistItem = {
    key: "fresh",
    label: `Checked in the last ${REPORT_STALE_HOURS} hours`,
    state: ageHours === null ? "wait" : ageHours < REPORT_STALE_HOURS ? "pass" : "wait",
    detail: ageHours === null ? noReport : ageHours < REPORT_STALE_HOURS ? null : `Last checked ${ageHours} hours ago`,
  };

  const items = [repository, open, head, checks, conflicts, fresh];
  const passed = items.filter((item) => item.state === "pass").length;
  const firstFail = items.find((item) => item.state === "fail");
  const verdict: MergeChecklist["verdict"] = firstFail ? "blocked" : passed === items.length ? "ready" : "waiting";
  const waiting = items.length - passed;
  const headline =
    verdict === "ready"
      ? "Ready for a good-to-merge judgement."
      : verdict === "blocked"
        ? `Not ready: ${firstFail!.detail ?? firstFail!.label}.`
        : !current
          ? "Waiting for an agent to check the pull request on GitHub."
          : `Waiting on ${waiting} ${waiting === 1 ? "check" : "checks"}.`;

  return { items, passed, total: items.length, verdict, headline, reportedAt: timestamp };
}
