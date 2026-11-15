import type { Prisma, PrismaClient } from "@prisma/client";
import { weightedTally } from "@/lib/governance";
import { activeLevels, levelIn } from "@/lib/agents/active-in";
import { sameCommit } from "@/lib/github/commit-sha";

/**
 * Merge reviews as votes (#vote-governance). In a threshold-only project any
 * independent agent gives a Done issue a merge review, and its weighted
 * accepts (or rejects) reaching the project's `acceptThreshold` decide it
 * (lib/agent-api/merge.ts). Kept apart from merge.ts so the work feed can
 * count them without loading the GitHub merge code.
 */
type Db = PrismaClient | Prisma.TransactionClient;

type ReviewedPullRequest = { id: string; pullRequestUrl: string | null; pullRequestHeadSha: string | null };

export type MergeReviewVotes = {
  accepts: number;
  rejects: number;
  /** Everyone whose review on the pull request linked now counts. */
  reviewers: string[];
};

/**
 * The weighted merge reviews on the pull request (and head commit, when both
 * are known) linked now: one per person, their latest review being their
 * vote, at the highest weight any of their agents gave that verdict
 * (lib/governance.ts).
 */
export async function mergeReviewVotes(db: Db, bug: ReviewedPullRequest, managerVoteWeight: number): Promise<MergeReviewVotes> {
  if (!bug.pullRequestUrl) return { accepts: 0, rejects: 0, reviewers: [] };
  const rows = await db.mergeReview.findMany({
    where: { bugId: bug.id, pullRequestUrl: bug.pullRequestUrl },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    select: { verdict: true, headSha: true, onBehalfOfUserId: true, bug: { select: { organisationId: true } }, agent: { select: { activations: activeLevels } } },
  });
  const current = rows.filter((row) => !bug.pullRequestHeadSha || !row.headSha || sameCommit(row.headSha, bug.pullRequestHeadSha));
  const latest = new Map<string, string>();
  for (const row of current) if (!latest.has(row.onBehalfOfUserId)) latest.set(row.onBehalfOfUserId, row.verdict);
  const tally = (verdict: "accept" | "reject") =>
    weightedTally(
      current
        .filter((row) => row.verdict === verdict && latest.get(row.onBehalfOfUserId) === verdict)
        .map((row) => ({ ownerId: row.onBehalfOfUserId, level: levelIn(row.agent, row.bug.organisationId) })),
      managerVoteWeight,
    );
  return { accepts: tally("accept"), rejects: tally("reject"), reviewers: [...latest.keys()] };
}

/** The weighted reviews with one verdict. */
export async function mergeReviewTally(
  db: Db,
  bug: ReviewedPullRequest,
  verdict: "accept" | "reject",
  managerVoteWeight: number,
): Promise<number> {
  const votes = await mergeReviewVotes(db, bug, managerVoteWeight);
  return verdict === "accept" ? votes.accepts : votes.rejects;
}
