import "server-only";
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { publish } from "@/lib/agent-api/events";
import { notifyAuthor, reportSelect } from "@/lib/agent-api/pull-request-report";
import { linkStateFromUrl } from "@/lib/agent-api/pr-gate";
import { statusChangedSummary } from "@/lib/activity-log";
import { moveTo } from "@/lib/issue-substatus";
import { GitHubError, githubClientFor } from "@/lib/github/client";
import { diagnose, diagnosisNote, type Diagnosis } from "@/lib/github/merge-blockers";
import { readPullRequest } from "@/lib/github/pull-request-snapshot";
import { parsePullRequestUrl } from "@/lib/github/pull-request-url";
import { installationIdForPullRequest, PROJECT_REPOSITORIES_SELECT, repoForPullRequest } from "@/lib/github/project-repositories";
import { asSnapshot, type PullRequestSnapshot } from "@/lib/github/snapshot-types";
import { followIssuePreviewBuilds, startPreviewBuildIfDue } from "@/lib/previews/builds";
import { sameCommit } from "@/lib/github/commit-sha";

/**
 * Ziki reads an issue's pull request on GitHub and records it (#github-status).
 *
 * What it read is a `PullRequestReport` with `source: ziki`, so every rule that
 * reads the latest report (lib/agent-api/pr-gate.ts: delivery, accept, resolve,
 * the work feed, triage) sees GitHub's answer without waiting for an agent.
 * Like an agent's report, it moves an issue in Merge between Ready to merge and
 * Error, and records a new head commit for an open pull request. When the read
 * says the same as the latest report, only that report's `checkedAt` moves, so
 * rereading every minute doesn't pile up rows.
 *
 * Reads come from the issue page (on open and on "Check GitHub"), GitHub's
 * webhooks (app/api/github/webhook/route.ts), the cron sweep
 * (`refreshMergeQueue`) and agents (`GET /api/v1/issues/{id}/github`).
 */

/** A read younger than this is reused rather than asking GitHub again. */
export const FRESH_FOR_MS = 60_000;

const syncBugSelect = {
  id: true,
  organisationId: true,
  projectId: true,
  title: true,
  status: true,
  substatus: true,
  pullRequestUrl: true,
  pullRequestHeadSha: true,
  isDeleted: true,
  reporterId: true,
  project: { select: { repoUrl: true, githubInstallationId: true, ...PROJECT_REPOSITORIES_SELECT } },
  claims: {
    where: { status: { in: ["active", "released"] } },
    orderBy: { claimedAt: "desc" },
    take: 1,
    select: { beneficiaryUserId: true, agent: { select: { name: true } } },
  },
} satisfies Prisma.BugSelect;

export type GitHubStatus = {
  pullRequestUrl: string;
  snapshot: PullRequestSnapshot;
  diagnosis: Diagnosis;
  /** When Ziki last asked GitHub and got this answer. */
  checkedAt: Date;
  /** Ziki's report row. */
  reportId: string;
};

export type SyncResult =
  | { ok: true; status: GitHubStatus; moved: { from: string; to: string } | null; cached: boolean }
  | { ok: false; error: "no_pull_request" | "not_github" | "other_repository" | "github"; message: string };

/**
 * Where Ziki's read puts an issue in Merge (#substatus): Error while GitHub
 * won't merge it (something must change, or the pull request is closed or
 * gone), else Ready to merge. Checks still running leave it Ready to merge,
 * as an agent's report does.
 */
export function mergeStepFor(diagnosis: Pick<Diagnosis, "verdict">): "ready_to_merge" | "error" {
  return diagnosis.verdict === "blocked" || diagnosis.verdict === "closed" || diagnosis.verdict === "not_found" ? "error" : "ready_to_merge";
}

/** What the snapshot says, without when it was read: equal fingerprints mean nothing changed. */
function fingerprint(snapshot: PullRequestSnapshot): string {
  return createHash("sha256").update(JSON.stringify({ ...snapshot, fetchedAt: null })).digest("hex").slice(0, 16);
}

/** The commit the fix was last accepted or delivered at, for the "new commits since" warning. */
async function reviewedHead(bugId: string, pullRequestUrl: string): Promise<{ sha: string; as: string } | null> {
  const [accepted, delivered] = await Promise.all([
    prisma.mergeReview.findFirst({
      where: { bugId, pullRequestUrl, verdict: "accept", headSha: { not: null } },
      orderBy: { updatedAt: "desc" },
      select: { headSha: true },
    }),
    prisma.delivery.findFirst({
      where: { bugId, pullRequestUrl, headSha: { not: null } },
      orderBy: { updatedAt: "desc" },
      select: { headSha: true },
    }),
  ]);
  if (accepted?.headSha) return { sha: accepted.headSha, as: "accepted" };
  if (delivered?.headSha) return { sha: delivered.headSha, as: "delivered" };
  return null;
}

export async function diagnoseFor(bugId: string, snapshot: PullRequestSnapshot): Promise<Diagnosis> {
  const reviewed = await reviewedHead(bugId, snapshot.url);
  return diagnose(snapshot, { reviewedHeadSha: reviewed?.sha, reviewedAs: reviewed?.as });
}

/** Ziki's latest stored read of the issue's current pull request, or null. Never calls GitHub. */
export async function storedGitHubStatus(bug: { id: string; pullRequestUrl: string | null }): Promise<GitHubStatus | null> {
  if (!bug.pullRequestUrl) return null;
  const report = await prisma.pullRequestReport.findFirst({
    where: { bugId: bug.id, pullRequestUrl: bug.pullRequestUrl, source: "ziki" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, details: true, checkedAt: true, createdAt: true },
  });
  const snapshot = asSnapshot(report?.details);
  if (!report || !snapshot) return null;
  return {
    pullRequestUrl: bug.pullRequestUrl,
    snapshot,
    diagnosis: await diagnoseFor(bug.id, snapshot),
    checkedAt: report.checkedAt ?? report.createdAt,
    reportId: report.id,
  };
}

/**
 * Read the issue's linked pull request on GitHub now and record it. With
 * `maxAgeMs`, a stored read younger than that is returned instead.
 */
export async function syncPullRequestStatus(
  bugId: string,
  options: { maxAgeMs?: number; /** The person who asked, for the activity log; else the issue's reporter. */ actorUserId?: string } = {},
): Promise<SyncResult> {
  const bug = await prisma.bug.findUnique({ where: { id: bugId }, select: syncBugSelect });
  if (!bug || bug.isDeleted || !bug.pullRequestUrl) {
    return { ok: false, error: "no_pull_request", message: "This issue has no linked pull request." };
  }
  const pullRequestUrl = bug.pullRequestUrl;
  const ref = parsePullRequestUrl(pullRequestUrl);
  if (!ref) return { ok: false, error: "not_github", message: "The linked pull request isn't a GitHub pull request address." };
  const link = linkStateFromUrl(pullRequestUrl, repoForPullRequest(bug.project, pullRequestUrl));
  if (link === "other_repository") {
    return { ok: false, error: "other_repository", message: "The linked pull request isn't in the project's repository, so Ziki won't read it there." };
  }

  if (options.maxAgeMs) {
    const stored = await storedGitHubStatus(bug);
    if (stored && Date.now() - stored.checkedAt.getTime() < options.maxAgeMs) {
      return { ok: true, status: stored, moved: null, cached: true };
    }
  }

  let snapshot: PullRequestSnapshot;
  try {
    // The installation of the repository the pull request is in (#2), else the project's.
    const client = await githubClientFor({ githubInstallationId: installationIdForPullRequest(bug.project, pullRequestUrl) });
    snapshot = await readPullRequest(client, ref);
  } catch (error) {
    const message = error instanceof GitHubError ? error.message : "Ziki couldn't read the pull request on GitHub.";
    if (!(error instanceof GitHubError)) console.error("[github-status] read failed", error);
    return { ok: false, error: "github", message };
  }

  const diagnosis = await diagnoseFor(bug.id, snapshot);
  const print = fingerprint(snapshot);
  const now = new Date(snapshot.fetchedAt);
  const details = { ...snapshot, fingerprint: print } as unknown as Prisma.InputJsonObject;
  const fields = {
    state: snapshot.state,
    mergedInto: snapshot.state === "merged" ? snapshot.baseRef : null,
    inDefaultBranch: snapshot.state === "merged" ? snapshot.inDefaultBranch ?? false : null,
    headSha: snapshot.headSha,
    mergeCommitSha: snapshot.mergeCommitSha,
    checks: snapshot.state === "not_found" ? null : snapshot.checksSummary,
    mergeable: snapshot.mergeable,
    note: diagnosisNote(diagnosis),
  } as const;

  const outcome = await prisma.$transaction(async (tx) => {
    const latest = await tx.pullRequestReport.findFirst({
      where: { bugId: bug.id, pullRequestUrl },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, source: true, details: true },
    });
    const unchanged = latest?.source === "ziki" && (latest.details as { fingerprint?: string } | null)?.fingerprint === print;
    const report = unchanged
      ? await tx.pullRequestReport.update({ where: { id: latest!.id }, data: { checkedAt: now, details }, select: reportSelect })
      : await tx.pullRequestReport.create({
          data: { bugId: bug.id, pullRequestUrl, source: "ziki", ...fields, details, checkedAt: now },
          select: reportSelect,
        });
    if (unchanged) return { reportId: report.id, moved: null, changed: false };

    const headMoved = snapshot.state === "open" && snapshot.headSha !== null && !sameCommit(snapshot.headSha, bug.pullRequestHeadSha);
    if (headMoved) {
      await tx.bug.updateMany({ where: { id: bug.id, pullRequestUrl }, data: { pullRequestHeadSha: snapshot.headSha } });
    }
    // Ziki's read knows more than an agent's report (a branch that must be up to date,
    // requested changes, a draft, branch protection), so Error follows the diagnosis.
    const mergeStep = bug.status === "merge" ? mergeStepFor(diagnosis) : null;
    let moved: { from: string; to: string } | null = null;
    if (mergeStep && mergeStep !== bug.substatus) {
      const result = await tx.bug.updateMany({ where: { id: bug.id, status: "merge", pullRequestUrl }, data: moveTo(mergeStep) });
      if (result.count) {
        moved = { from: bug.substatus, to: mergeStep };
        await tx.bugActivity.create({
          data: {
            bugId: bug.id,
            actorId: options.actorUserId ?? bug.reporterId,
            type: "status_changed",
            summary: `${statusChangedSummary(bug.substatus, mergeStep)} (GitHub: ${diagnosis.headline})`,
            metadata: { field: "status", from: bug.substatus, to: mergeStep, via: "github_status", automatic: !options.actorUserId, pullRequestReportId: report.id },
          },
        });
      }
    }
    await publish(tx, {
      organisationId: bug.organisationId,
      type: "issue.pull_request_reported",
      payload: {
        issueId: bug.id,
        projectId: bug.projectId,
        reportId: report.id,
        source: "ziki",
        pullRequestUrl,
        state: fields.state,
        headSha: fields.headSha,
        checks: fields.checks,
        mergeable: fields.mergeable,
        verdict: diagnosis.verdict,
        note: fields.note,
        blockers: diagnosis.blockers.map((blocker) => ({ kind: blocker.kind, level: blocker.level, title: blocker.title, who: blocker.who })),
        ...(moved ? { substatus: moved } : {}),
        ...(headMoved ? { headMoved: { from: bug.pullRequestHeadSha, to: snapshot.headSha } } : {}),
      },
      actorAgentId: null,
      bugId: bug.id,
    });
    return { reportId: report.id, moved, changed: true };
  });

  // #previews: build the new commit, and follow the builds already started.
  await previewsAfterRead(bug, pullRequestUrl, snapshot);

  // Tell the person the fix is for, once, when it stops being mergeable.
  if (outcome.moved?.to === "error") {
    const claim = bug.claims[0];
    notifyAuthor({
      bug: { id: bug.id, title: bug.title },
      recipientId: claim?.beneficiaryUserId,
      reason: diagnosis.headline,
      fromAgentName: "GitHub",
    });
  }

  return {
    ok: true,
    status: { pullRequestUrl, snapshot, diagnosis, checkedAt: now, reportId: outcome.reportId },
    moved: outcome.moved,
    cached: false,
  };
}

/** Previews never hold up or fail a GitHub read. */
async function previewsAfterRead(
  bug: { id: string; projectId: string; status: string; project: { repoUrl: string | null } },
  pullRequestUrl: string,
  snapshot: PullRequestSnapshot,
): Promise<void> {
  try {
    await startPreviewBuildIfDue({
      bugId: bug.id,
      projectId: bug.projectId,
      issueStatus: bug.status,
      repoUrl: bug.project.repoUrl,
      pullRequestUrl,
      state: snapshot.state,
      headSha: snapshot.headSha,
    });
    await followIssuePreviewBuilds(bug.id);
  } catch (error) {
    console.error("[previews] after GitHub read", error);
  }
}

/**
 * The cron sweep (lib/cron/runner.ts): re-read the pull requests of issues
 * waiting to merge (Done · Accepted and Merge), oldest read first, a few per
 * run so a big queue stays inside GitHub's rate limit. Webhooks keep them
 * current between sweeps when GitHub is set up to send them.
 */
export async function refreshMergeQueue(options: { limit?: number; staleMs?: number } = {}): Promise<{ checked: number; moved: number; failed: number }> {
  const limit = options.limit ?? 10;
  const staleMs = options.staleMs ?? 5 * 60_000;
  const bugs = await prisma.bug.findMany({
    where: {
      isDeleted: false,
      pullRequestUrl: { not: null },
      OR: [{ status: "merge" }, { substatus: "accepted" }],
    },
    select: { id: true, pullRequestUrl: true },
    take: 200,
  });
  if (!bugs.length) return { checked: 0, moved: 0, failed: 0 };
  const reads = await prisma.pullRequestReport.groupBy({
    by: ["bugId"],
    where: { bugId: { in: bugs.map((bug) => bug.id) }, source: "ziki" },
    _max: { checkedAt: true },
  });
  const lastRead = new Map(reads.map((row) => [row.bugId, row._max.checkedAt?.getTime() ?? 0]));
  const due = bugs
    .map((bug) => ({ id: bug.id, at: lastRead.get(bug.id) ?? 0 }))
    .filter((bug) => Date.now() - bug.at >= staleMs)
    .sort((a, b) => a.at - b.at)
    .slice(0, limit);

  let moved = 0;
  let failed = 0;
  for (const bug of due) {
    const result = await syncPullRequestStatus(bug.id);
    if (!result.ok) failed++;
    else if (result.moved) moved++;
  }
  return { checked: due.length, moved, failed };
}

/** Issues whose linked pull request is `owner/repo#number`, for webhooks. */
export async function issuesForPullRequest(owner: string, repo: string, number: number): Promise<string[]> {
  const rows = await prisma.bug.findMany({
    where: {
      isDeleted: false,
      pullRequestUrl: { startsWith: `https://github.com/${owner}/${repo}/pull/${number}`, mode: "insensitive" },
    },
    select: { id: true, pullRequestUrl: true },
  });
  return rows.filter((row) => parsePullRequestUrl(row.pullRequestUrl)?.number === number).map((row) => row.id);
}
