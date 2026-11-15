import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { PRODUCT_STEP_ONLY_MESSAGE, trackRules } from "@/lib/marketing/track";
import { audit } from "@/lib/agents/audit";
import type { AgentContext } from "@/lib/agents/require-agent";
import { reviewerConflict, ReviewerNotIndependentError } from "@/lib/agents/independence";
import { publish } from "@/lib/agent-api/events";
import { notifyMergeFailed } from "@/lib/agent-notifications";
import { issueIdFor } from "@/lib/issue-ref";
import { pullRequestReportSchema, checkRunsSchema, pullRequestChecksSummary, type PullRequestCheck } from "@/lib/validations/pull-request-report";
import type { GateReport } from "@/lib/agent-api/pr-gate";
import { moveTo } from "@/lib/issue-substatus";
import { statusChangedSummary } from "@/lib/activity-log";
import { sameCommit } from "@/lib/github/commit-sha";

/**
 * Pull request reports (#pr-reports).
 *
 * Agents check an issue's linked pull request on GitHub and report what they
 * saw, and Ziki reads it on GitHub itself too (#github-status,
 * lib/github/sync.ts: `source: ziki`). A report says its state (open, closed
 * without merging, merged, or 404), the branch it was merged into and whether the
 * default branch contains it, its head and merge commits, its checks and
 * whether it can merge. Any agent may report, the owner's own included
 * (#owner-agents), except the agent holding the claim or the one that
 * delivered the pull request (lib/agents/independence.ts). The latest report for
 * the issue's current pull request is its state, shown with who reported it
 * and when, so a wrong report is corrected by the next one. The rules read it
 * through one gate (lib/agent-api/pr-gate.ts).
 */

type Db = PrismaClient | Prisma.TransactionClient;

export const reportSelect = {
  id: true,
  bugId: true,
  pullRequestUrl: true,
  state: true,
  mergedInto: true,
  inDefaultBranch: true,
  headSha: true,
  mergeCommitSha: true,
  checks: true,
  checkRuns: true,
  mergeable: true,
  note: true,
  source: true,
  checkedAt: true,
  agentId: true,
  onBehalfOfUserId: true,
  createdAt: true,
  agent: { select: { name: true } },
  onBehalfOf: { select: { name: true } },
} satisfies Prisma.PullRequestReportSelect;

export type StoredPullRequestReport = Prisma.PullRequestReportGetPayload<{ select: typeof reportSelect }>;

/** The pull request's state: the latest report on `pullRequestUrl` for issue `bugId`, or null when nobody reported it. */
export async function latestPullRequestReport(
  bugId: string,
  pullRequestUrl: string | null | undefined,
  db: Db = prisma,
): Promise<StoredPullRequestReport | null> {
  if (!pullRequestUrl) return null;
  return db.pullRequestReport.findFirst({
    where: { bugId, pullRequestUrl },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: reportSelect,
  });
}

/** The latest report on each issue's current pull request, for many issues in one read (the work feed, triage). */
export async function latestPullRequestReports(
  bugs: readonly { id: string; pullRequestUrl: string | null }[],
  db: Db = prisma,
): Promise<Map<string, StoredPullRequestReport>> {
  const linked = bugs.filter((bug): bug is { id: string; pullRequestUrl: string } => Boolean(bug.pullRequestUrl));
  if (!linked.length) return new Map();
  const rows = await db.pullRequestReport.findMany({
    where: { OR: linked.map((bug) => ({ bugId: bug.id, pullRequestUrl: bug.pullRequestUrl })) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: reportSelect,
  });
  const latest = new Map<string, StoredPullRequestReport>();
  for (const row of rows) if (!latest.has(row.bugId)) latest.set(row.bugId, row);
  return latest;
}

/** Who a report is from, for a sentence: the agent, or Ziki for its own reads (#github-status). */
export function reporterName(report: { agent: { name: string } | null }): string {
  return report.agent?.name ?? "Ziki (read on GitHub)";
}

/** When a report last held: Ziki's own reads move `checkedAt` while GitHub says the same. */
export function reportedAt(report: { createdAt: Date; checkedAt?: Date | null }): Date {
  return report.checkedAt ?? report.createdAt;
}

/** A stored report as the gate reads it. */
export function gateReport(report: StoredPullRequestReport | null | undefined): GateReport | null {  if (!report) return null;
  return {
    pullRequestUrl: report.pullRequestUrl,
    state: report.state,
    mergedInto: report.mergedInto,
    inDefaultBranch: report.inDefaultBranch,
    headSha: report.headSha,
    checks: report.checks,
    mergeable: report.mergeable,
  };
}

/**
 * The checks stored on a report, or null when it carries only the summary.
 * Anything unrecognisable reads as no detail rather than as a pass (#pr-checks):
 * the card then falls back to `checks`, which is what the gate already trusts.
 */
export function storedCheckRuns(value: unknown): PullRequestCheck[] | null {
  if (!Array.isArray(value)) return null;
  const parsed = checkRunsSchema.safeParse(value);
  return parsed.success && parsed.data.length ? parsed.data : null;
}

/** A report as the API shows it: what was seen, who saw it and how long ago. */
export type PullRequestStateView = {
  id: string;
  pullRequestUrl: string;
  state: StoredPullRequestReport["state"];
  mergedInto: string | null;
  inDefaultBranch: boolean | null;
  headSha: string | null;
  mergeCommitSha: string | null;
  checks: string | null;
  /** Each check by name, when the reporter sent them (#pr-checks). */
  checkRuns: PullRequestCheck[] | null;
  mergeable: boolean | null;
  note: string;
  /** When it was reported; for Ziki's own reads, when GitHub last said this. */
  reportedAt: Date;
  /** Whole minutes since it was reported. */
  ageMinutes: number;
  /** `agent`: an agent checked and reported. `ziki`: Ziki read it on GitHub itself (#github-status). */
  source: "agent" | "ziki";
  /** The agent and its owner; null for Ziki's own reads. */
  reportedBy: { agentId: string; agentName: string; userId: string; name: string } | null;
};

export function pullRequestStateView(report: StoredPullRequestReport | null | undefined, now = Date.now()): PullRequestStateView | null {
  if (!report) return null;
  const reportedAt = report.checkedAt ?? report.createdAt;
  return {
    id: report.id,
    pullRequestUrl: report.pullRequestUrl,
    state: report.state,
    mergedInto: report.mergedInto,
    inDefaultBranch: report.inDefaultBranch,
    headSha: report.headSha,
    mergeCommitSha: report.mergeCommitSha,
    checks: report.checks,
    checkRuns: storedCheckRuns(report.checkRuns),
    mergeable: report.mergeable,
    note: report.note,
    reportedAt,
    ageMinutes: Math.max(0, Math.floor((now - reportedAt.getTime()) / 60_000)),
    source: report.source,
    reportedBy: report.agentId && report.agent && report.onBehalfOfUserId
      ? {
          agentId: report.agentId,
          agentName: report.agent.name,
          userId: report.onBehalfOfUserId,
          name: report.onBehalfOf?.name ?? "A member",
        }
      : null,
  };
}

/** True when the latest report on the issue's pull request says it was closed without being merged (#642). */
export async function reportedClosedUnmerged(bugId: string, pullRequestUrl: string | null | undefined, db: Db = prisma): Promise<boolean> {
  const report = await latestPullRequestReport(bugId, pullRequestUrl, db);
  return report?.state === "closed";
}

/** Tell the person the claim was for what is holding their fix up. */
export function notifyAuthor(input: {
  bug: { id: string; title: string };
  recipientId: string | null | undefined;
  reason: string;
  fromAgentName: string;
}): void {
  if (!input.recipientId) return;
  notifyMergeFailed({
    bugId: input.bug.id,
    bugTitle: input.bug.title,
    recipientId: input.recipientId,
    reason: input.reason,
    agent: { name: input.fromAgentName },
  });
}

export type ReportResult =
  | { status: 201; body: { report: PullRequestStateView } }
  | { status: 400 | 403 | 404 | 409; body: { error: string; message: string; field?: string } };

const fail = (status: 400 | 403 | 404 | 409, error: string, message: string, field?: string): ReportResult =>
  ({ status, body: { error, message, ...(field ? { field } : {}) } });

/**
 * `POST /api/v1/issues/{id}/pull-request-status`: an agent other than the one
 * holding the claim or that delivered the pull request reports what it saw on GitHub for the issue's linked pull request.
 * Each report is a new row; the latest one counts. An open pull request
 * reported at a head commit other than the one Ziki has records that head on
 * the issue (as the pull_request webhook does), so judgements and the accept
 * bind to the code that is there now.
 */
/**
 * Where a report puts an issue in Merge (#substatus): Error when its
 * pull request can't merge as it is (closed without merging, missing,
 * conflicting or with failing checks), else Ready to merge. A merged report
 * leaves it Ready to merge: the merger resolves it.
 */
export function mergeSubstatusFor(report: { state: string; mergeable?: boolean | null; checks?: string | null }): "ready_to_merge" | "error" {
  if (report.state === "closed" || report.state === "not_found") return "error";
  if (report.state === "open" && (report.mergeable === false || report.checks === "failing")) return "error";
  return "ready_to_merge";
}

export async function reportPullRequestStatus(
  agent: AgentContext,
  scope: { organisationId: string; projectId: string },
  issueRef: string,
  rawBody: unknown,
): Promise<ReportResult> {
  const parsed = pullRequestReportSchema.safeParse(rawBody ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = typeof issue?.path[0] === "string" ? issue.path[0] : undefined;
    return fail(400, "invalid_request", issue?.message ?? "Invalid pull request report.", field);
  }
  const body = parsed.data;

  // #pr-checks: the per-check detail decides the summary. Sent together, they
  // must agree, so a report can never say "passing" next to a failed check.
  const reportedChecks = body.checkRuns ? pullRequestChecksSummary(body.checkRuns) : body.checks;
  if (body.checkRuns && body.checks && body.checks !== reportedChecks) {
    return fail(
      400,
      "checks_mismatch",
      `checks "${body.checks}" does not match checkRuns, which amount to "${reportedChecks}". Send one, or both in agreement.`,
      "checks",
    );
  }

  const bugId = await issueIdFor(prisma, issueRef, scope.organisationId);
  if (!bugId) return fail(404, "not_found", "No such issue in this project.");
  const bug = await prisma.bug.findFirst({
    where: { id: bugId, ...scope, isDeleted: false },
    select: {
      id: true,
      organisationId: true,
      projectId: true,
      status: true,
      substatus: true,
      track: true,
      pullRequestUrl: true,
      pullRequestHeadSha: true,
      beneficiaryUserId: true,
      reporterId: true,
      assigneeId: true,
      outsideWork: { select: { agentId: true } },
      createdByAgent: { select: { ownerUserId: true } },
      claims: { select: { status: true, releasedAt: true, beneficiaryUserId: true, agentId: true, dispatcherUserId: true, agent: { select: { ownerUserId: true } } } },
    },
  });
  if (!bug) return fail(404, "not_found", "No such issue in this project.");
  if (!trackRules(bug.track).hasProductSteps) return fail(409, "wrong_track", PRODUCT_STEP_ONLY_MESSAGE);
  if (!bug.pullRequestUrl) return fail(409, "no_pull_request", "This issue has no linked pull request to report on.");
  if (body.pullRequestUrl !== bug.pullRequestUrl) {
    return fail(409, "pr_mismatch", `Report on the issue's linked pull request: ${bug.pullRequestUrl}.`, "pullRequestUrl");
  }

  // The same rule as reviewers: nobody reports on their own owner's work.
  const conflict = reviewerConflict({ id: agent.agentId, ownerUserId: agent.ownerId }, bug);
  if (conflict) return fail(403, "not_independent", new ReviewerNotIndependentError(conflict).message);
  const delivered = await prisma.delivery.findFirst({
    where: {
      bugId: bug.id,
      pullRequestUrl: bug.pullRequestUrl,
      // #owner-agents: only the agent that delivered it is left out; the owner's other agents may report.
      agentId: agent.agentId,
    },
    select: { id: true },
  });
  if (delivered) return fail(403, "not_independent", "This agent delivered this pull request, so another agent reports on it, your owner's other agents included.");

  const headMoved = body.state === "open" && body.headSha !== undefined && !sameCommit(body.headSha, bug.pullRequestHeadSha);
  const pullRequestUrl = bug.pullRequestUrl;

  const saved = await prisma.$transaction(async (tx) => {
    const report = await tx.pullRequestReport.create({
      data: {
        bugId: bug.id,
        pullRequestUrl,
        state: body.state,
        mergedInto: body.mergedInto ?? null,
        inDefaultBranch: body.inDefaultBranch ?? null,
        headSha: body.headSha ?? null,
        mergeCommitSha: body.mergeCommitSha ?? null,
        checks: reportedChecks ?? null,
        checkRuns: body.checkRuns ? (body.checkRuns as unknown as Prisma.InputJsonValue) : undefined,
        mergeable: body.mergeable ?? null,
        note: body.note,
        agentId: agent.agentId,
        onBehalfOfUserId: agent.ownerId,
      },
      select: reportSelect,
    });
    if (headMoved) {
      await tx.bug.updateMany({ where: { id: bug.id, pullRequestUrl }, data: { pullRequestHeadSha: body.headSha } });
    }
    // In Merge, the latest report decides Ready to merge or Error (#substatus).
    const mergeStep = bug.status === "merge" ? mergeSubstatusFor({ ...body, checks: reportedChecks }) : null;
    if (mergeStep && mergeStep !== bug.substatus) {
      const moved = await tx.bug.updateMany({ where: { id: bug.id, status: "merge", pullRequestUrl }, data: moveTo(mergeStep) });
      if (moved.count) {
        await tx.bugActivity.create({
          data: {
            bugId: bug.id,
            actorId: agent.ownerId,
            type: "status_changed",
            summary: statusChangedSummary(bug.substatus, mergeStep),
            metadata: { field: "status", from: bug.substatus, to: mergeStep, via: "pull_request_report", pullRequestReportId: report.id },
          },
        });
      }
    }
    const payload: Prisma.InputJsonObject = {
      issueId: bug.id,
      projectId: bug.projectId,
      reportId: report.id,
      pullRequestUrl,
      state: body.state,
      mergedInto: body.mergedInto ?? null,
      inDefaultBranch: body.inDefaultBranch ?? null,
      headSha: body.headSha ?? null,
      mergeCommitSha: body.mergeCommitSha ?? null,
      checks: reportedChecks ?? null,
      mergeable: body.mergeable ?? null,
      note: body.note,
      ...(mergeStep && mergeStep !== bug.substatus ? { substatus: { from: bug.substatus, to: mergeStep } } : {}),
      ...(headMoved ? { headMoved: { from: bug.pullRequestHeadSha, to: body.headSha ?? null } } : {}),
    };
    await audit(agent, "issue.pull_request_reported", `bug:${bug.id}`, payload, { bugId: bug.id, db: tx });
    await publish(tx, { organisationId: bug.organisationId, type: "issue.pull_request_reported", payload, actorAgentId: agent.agentId, bugId: bug.id });
    return report;
  });

  return { status: 201, body: { report: pullRequestStateView(saved)! } };
}
