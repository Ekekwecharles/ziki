import type { PullRequestSnapshot, SnapshotCheck } from "@/lib/github/snapshot-types";
import { sameCommit } from "@/lib/github/commit-sha";

/**
 * Why GitHub won't merge a pull request, in plain words (#github-status).
 *
 * Pure: it reads a `PullRequestSnapshot` (lib/github/pull-request-snapshot.ts)
 * and says, for each thing in the way, what it is, who has to act, and what
 * can be done about it from Ziki:
 *
 * - `send_back`: the fixer has to change the code (conflicts, failing checks,
 *   requested changes, a draft, a closed or missing pull request). The issue
 *   goes back to In progress with the note `sendBackNote` drafts.
 * - `update_branch`: the branch is behind its base; GitHub can bring the base
 *   in without the fixer.
 * - `rerun_checks`: a GitHub Actions check failed; re-running it settles
 *   whether it was flaky before sending the fix back.
 * - `refresh`: GitHub hasn't decided yet (checks running, mergeability
 *   unknown); read it again shortly.
 */

export type BlockerAction = "send_back" | "update_branch" | "rerun_checks" | "refresh";

export type Blocker = {
  /** Stable within one diagnosis: "conflicts", "check:build", "review:octocat". */
  id: string;
  kind:
    | "not_found"
    | "closed"
    | "draft"
    | "conflicts"
    | "behind"
    | "check_failing"
    | "checks_pending"
    | "changes_requested"
    | "review_required"
    | "protected"
    | "mergeability_unknown"
    | "head_moved"
    | "not_released";
  /** `blocking`: GitHub won't merge it. `waiting`: GitHub hasn't decided. `warning`: it can merge, but look first. */
  level: "blocking" | "waiting" | "warning";
  title: string;
  detail: string;
  /** Who has to act. */
  who: "fixer" | "reviewer" | "merger";
  /** What Ziki can do about it, best first. */
  actions: BlockerAction[];
  links: { label: string; url: string }[];
};

export type Diagnosis = {
  /** `ready`: nothing in the way. `blocked`: something must change. `waiting`: GitHub is still working it out. */
  verdict: "ready" | "blocked" | "waiting" | "merged" | "closed" | "not_found";
  /** One sentence for the top of the panel. */
  headline: string;
  blockers: Blocker[];
  /** True when Ziki may ask GitHub to merge it now. */
  canMerge: boolean;
  /** A draft of what to tell the fixer, from the blockers that are theirs; null when none are. */
  sendBackNote: string | null;
};

export type DiagnosisContext = {
  /** The head commit the fix was delivered or accepted at, to flag commits pushed since. */
  reviewedHeadSha?: string | null;
  /** What `reviewedHeadSha` is, for the sentence: "accepted", "delivered". */
  reviewedAs?: string;
};

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : "");
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const fixerActions: BlockerAction[] = ["send_back"];

function checkBlocker(check: SnapshotCheck): Blocker {
  const why = check.conclusion && check.conclusion !== "failure" ? ` (${check.conclusion.replace(/_/g, " ")})` : "";
  return {
    id: `check:${check.name}`,
    kind: "check_failing",
    level: "blocking",
    title: `Check failing: ${check.name}${why}`,
    detail: check.summary
      ? `${check.summary.replace(/[.\s]+$/, "")}. Open the logs to see what failed.`
      : "Open the logs to see what failed.",
    who: "fixer",
    actions: check.actionsRunId ? ["rerun_checks", "send_back"] : fixerActions,
    links: check.url ? [{ label: "Logs", url: check.url }] : [],
  };
}

/** Everything in the way of merging `snapshot`, and what to do about each. */
export function diagnose(snapshot: PullRequestSnapshot, context: DiagnosisContext = {}): Diagnosis {
  const pr = `#${snapshot.number}`;
  const prLink = [{ label: `Pull request ${pr}`, url: snapshot.url }];

  if (snapshot.state === "not_found") {
    const blocker: Blocker = {
      id: "not_found",
      kind: "not_found",
      level: "blocking",
      title: "GitHub can't find this pull request",
      detail: "It was deleted, the link is wrong, or the repository is private to Ziki. The fixer opens a new pull request and delivers it again.",
      who: "fixer",
      actions: fixerActions,
      links: [],
    };
    return result("not_found", `GitHub has no pull request at ${snapshot.url}.`, [blocker], false);
  }

  if (snapshot.state === "closed") {
    const blocker: Blocker = {
      id: "closed",
      kind: "closed",
      level: "blocking",
      title: "Closed without merging",
      detail: "Someone closed the pull request on GitHub. The fixer reopens it, or opens a new one and delivers it again.",
      who: "fixer",
      actions: fixerActions,
      links: prLink,
    };
    return result("closed", `Pull request ${pr} was closed without being merged.`, [blocker], false);
  }

  if (snapshot.state === "merged") {
    const blockers: Blocker[] = [];
    if (snapshot.inDefaultBranch === false) {
      blockers.push({
        id: "not_released",
        kind: "not_released",
        level: "warning",
        title: `Merged into ${snapshot.baseRef ?? "another branch"}, not ${snapshot.defaultBranch ?? "the default branch"} yet`,
        detail: "It goes Live once the default branch contains it.",
        who: "merger",
        actions: [],
        links: prLink,
      });
    }
    const by = snapshot.mergedBy ? ` by ${snapshot.mergedBy}` : "";
    return result("merged", `Merged${by} into ${snapshot.baseRef ?? "its base branch"}.`, blockers, false);
  }

  const blockers: Blocker[] = [];

  if (snapshot.draft) {
    blockers.push({
      id: "draft",
      kind: "draft",
      level: "blocking",
      title: "Still a draft",
      detail: "GitHub won't merge a draft. The fixer marks it ready for review once it is done.",
      who: "fixer",
      actions: fixerActions,
      links: prLink,
    });
  }

  const conflicting = snapshot.mergeable === false || snapshot.mergeableState === "dirty";
  if (conflicting) {
    blockers.push({
      id: "conflicts",
      kind: "conflicts",
      level: "blocking",
      title: `Merge conflicts with ${snapshot.baseRef ?? "the base branch"}`,
      detail: `The branch and ${snapshot.baseRef ?? "its base"} changed the same lines. The fixer merges ${snapshot.baseRef ?? "the base"} into ${snapshot.headRef ?? "the branch"}, resolves the conflicting files and pushes.`,
      who: "fixer",
      actions: fixerActions,
      links: [{ label: "Conflicts", url: `${snapshot.url}/conflicts` }],
    });
  }

  if (!conflicting && (snapshot.behindBy ?? 0) > 0) {
    const required = snapshot.mergeableState === "behind";
    const forkLocked = snapshot.headRepo !== null && snapshot.maintainerCanModify === false;
    blockers.push({
      id: "behind",
      kind: "behind",
      level: required ? "blocking" : "warning",
      title: `${plural(snapshot.behindBy ?? 0, "commit")} behind ${snapshot.baseRef ?? "the base branch"}`,
      detail: required
        ? "Branch protection needs the branch up to date before it merges. Updating it brings the base in and the checks run again."
        : "GitHub can still merge it, but the checks ran without the newest base. Updating the branch reruns them on the combined code.",
      who: forkLocked ? "fixer" : "merger",
      actions: forkLocked ? fixerActions : ["update_branch"],
      links: [],
    });
  }

  const failing = snapshot.checks.filter((check) => check.status === "failing");
  blockers.push(...failing.map(checkBlocker));

  const pending = snapshot.checks.filter((check) => check.status === "pending");
  if (pending.length > 0) {
    blockers.push({
      id: "checks_pending",
      kind: "checks_pending",
      level: "waiting",
      title: `${plural(pending.length, "check")} still running`,
      detail: pending.map((check) => check.name).join(", "),
      who: "merger",
      actions: ["refresh"],
      links: pending.flatMap((check) => (check.url ? [{ label: check.name, url: check.url }] : [])).slice(0, 3),
    });
  }

  for (const review of snapshot.reviews.filter((r) => r.state === "CHANGES_REQUESTED")) {
    blockers.push({
      id: `review:${review.login}`,
      kind: "changes_requested",
      level: "blocking",
      title: `${review.login} requested changes`,
      detail: review.body ?? "Open the review to see what they asked for.",
      who: "fixer",
      actions: fixerActions,
      links: [{ label: "Review", url: review.url }],
    });
  }

  const explained = blockers.some((blocker) => blocker.level === "blocking");
  if (snapshot.mergeableState === "blocked" && !explained) {
    if (snapshot.requestedReviewers.length > 0) {
      blockers.push({
        id: "review_required",
        kind: "review_required",
        level: "blocking",
        title: "Waiting for a required review",
        detail: `GitHub is waiting on ${snapshot.requestedReviewers.join(", ")}.`,
        who: "reviewer",
        actions: [],
        links: prLink,
      });
    } else if (pending.length === 0) {
      blockers.push({
        id: "protected",
        kind: "protected",
        level: "blocking",
        title: "Branch protection blocks the merge",
        detail: `A rule on ${snapshot.baseRef ?? "the base branch"} isn't met: usually an approving review, a required check that never ran, or signed commits. The repository's branch rules say which.`,
        who: "merger",
        actions: [],
        links: prLink,
      });
    }
  }

  if (snapshot.mergeable === null && !conflicting) {
    blockers.push({
      id: "mergeability_unknown",
      kind: "mergeability_unknown",
      level: "waiting",
      title: "GitHub is still working out whether it can merge",
      detail: "This takes a few seconds after a push. Check again shortly.",
      who: "merger",
      actions: ["refresh"],
      links: [],
    });
  }

  if (context.reviewedHeadSha && snapshot.headSha && !sameCommit(context.reviewedHeadSha, snapshot.headSha)) {
    blockers.push({
      id: "head_moved",
      kind: "head_moved",
      level: "warning",
      title: "New commits since it was " + (context.reviewedAs ?? "reviewed"),
      detail: `It was ${context.reviewedAs ?? "reviewed"} at ${short(context.reviewedHeadSha)}; the branch is now at ${short(snapshot.headSha)}. Look at what changed before merging.`,
      who: "merger",
      actions: [],
      links: [{ label: "What changed", url: `${snapshot.url}/files/${context.reviewedHeadSha}..${snapshot.headSha}` }],
    });
  }

  const blocking = blockers.filter((blocker) => blocker.level === "blocking");
  const waiting = blockers.filter((blocker) => blocker.level === "waiting");
  if (blocking.length > 0) {
    const headline = blocking.length === 1
      ? `GitHub won't merge ${pr}: ${lowerFirst(blocking[0].title)}.`
      : `GitHub won't merge ${pr}: ${plural(blocking.length, "thing")} in the way.`;
    return result("blocked", headline, blockers, false);
  }
  if (waiting.length > 0) return result("waiting", `${pr} is waiting on GitHub: ${lowerFirst(waiting[0].title)}.`, blockers, false);
  return result("ready", `${pr} can merge into ${snapshot.baseRef ?? "its base branch"}.`, blockers, true);

  function result(verdict: Diagnosis["verdict"], headline: string, list: Blocker[], canMerge: boolean): Diagnosis {
    return { verdict, headline, blockers: list, canMerge, sendBackNote: sendBackNote(snapshot, list) };
  }
}

function lowerFirst(text: string): string {
  return /^[A-Z][a-z]/.test(text) ? text[0].toLowerCase() + text.slice(1) : text;
}

/** What to tell the fixer: the blockers that are theirs, each with where to look. */
export function sendBackNote(snapshot: PullRequestSnapshot, blockers: readonly Blocker[]): string | null {
  const theirs = blockers.filter((blocker) => blocker.who === "fixer" && blocker.level !== "warning");
  if (theirs.length === 0) return null;
  const lines = theirs.map((blocker) => {
    const link = blocker.links[0] ? ` (${blocker.links[0].url})` : "";
    return `- ${blocker.title}${link}${blocker.kind === "changes_requested" && blocker.detail ? `: ${blocker.detail}` : ""}`;
  });
  return [
    `GitHub can't merge pull request #${snapshot.number} yet:`,
    ...lines,
    "",
    "Fix these on the same branch and push. Ziki checks GitHub again on its own, and the fix goes back for testing once it is delivered.",
  ].join("\n");
}

/** The short form the report row keeps in `note`. */
export function diagnosisNote(diagnosis: Diagnosis): string {
  const rest = diagnosis.blockers.filter((blocker) => blocker.level !== "warning").length;
  return rest > 1 ? `${diagnosis.headline} (${rest} items)` : diagnosis.headline;
}
