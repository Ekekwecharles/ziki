import type { Prisma, PrismaClient } from "@prisma/client";
import type { ReviewedBug } from "@/lib/agents/independence";
import { countedMergeVerdicts, deliveredClaim } from "@/lib/agent-api/merge-verdicts";
import { publish } from "@/lib/agent-api/events";
import { workflowFor } from "@/lib/workflow";
import { moveTo } from "@/lib/issue-substatus";
import { afterSendBack, judgementCounts } from "@/lib/marketing/track";
import { activeLevels, levelIn } from "@/lib/agents/active-in";
import { checksFor, countsWithProof, loadCard, loadProofRules, NO_CHECKS, type IssueChecks, type TestCard } from "@/lib/proof";

/**
 * The Delivered step's rule (#delivered-step). Once the agent holding the
 * claim delivers its work, independent agents judge it (test verdicts on the
 * delivered pull request):
 *
 * - When the project's required number of them, each with a different owner
 *   and none on the delivering side, say it is good to merge, it is Done.
 * - Otherwise, when that many say it is not good to merge, it goes back to
 *   Open: the claim is released and the pull request is cleared, so someone
 *   (the same agent or another) can take it again.
 * - Otherwise it stays Delivered.
 *
 * Both counts use the merge gate's rule (`countedMergeVerdicts`), so Done and
 * the manager's accept always agree. Where the organisation has checks
 * (lib/proof.ts), only judgements with proof count, and a proven fail or a test
 * card square nobody has proven holds the issue from Done · Accepted.
 */

type Db = PrismaClient | Prisma.TransactionClient;

/** What the Delivered step's count reads about an issue. */
export const judgedBugSelect = {
  outsideWork: { select: { agentId: true } },
  id: true,
  organisationId: true,
  projectId: true,
  status: true,
  substatus: true,
  track: true,
  revisionCount: true,
  pullRequestUrl: true,
  pullRequestHeadSha: true,
  typeId: true,
  areaId: true,
  priority: true,
  assigneeId: true,
  beneficiaryUserId: true,
  reporterId: true,
  createdByAgentId: true,
  createdByAgent: { select: { ownerUserId: true } },
  claims: {
    select: {
      id: true,
      status: true,
      claimedAt: true,
      releasedAt: true,
      agentId: true,
      beneficiaryUserId: true,
      dispatcherUserId: true,
      agent: { select: { ownerUserId: true } },
    },
  },
} satisfies Prisma.BugSelect;

export type JudgedBug = Prisma.BugGetPayload<{ select: typeof judgedBugSelect }>;

/** The judgements on the delivered pull request, oldest first, as the count reads them. */
export const judgementSelect = {
  goodToMerge: true,
  headSha: true,
  proof: true,
  onBehalfOfUserId: true,
  agent: { select: { id: true, ownerUserId: true, activations: activeLevels } },
} satisfies Prisma.TestVerdictSelect;

export type Judgement = Prisma.TestVerdictGetPayload<{ select: typeof judgementSelect }>;

/**
 * Count judgements as the Delivered step does. Work delivered with no claim
 * behind it (a manager agent filed it on the holder's behalf,
 * lib/agent-api/stranded-delivery.ts) has no claim holder to leave out, so the
 * people the delivery credits stand in that place: nothing from their agents,
 * and nothing given on their behalf, counts. Where the organisation has checks,
 * only judgements with proof count (lib/proof.ts).
 */
export function countJudgements(
  verdicts: readonly Judgement[],
  bug: JudgedBug,
  creditedUserIds: readonly string[],
  checks: IssueChecks,
): { good: number; notGood: number } {
  const claim = deliveredClaim(bug);
  const proven = verdicts.filter((v) => countsWithProof(v, checks, bug.pullRequestHeadSha));
  const counted = claim
    ? proven
    : proven.filter((v) => !creditedUserIds.includes(v.agent.ownerUserId) && !creditedUserIds.includes(v.onBehalfOfUserId));
  const reviewed = bug as unknown as ReviewedBug;
  return {
    good: countedMergeVerdicts(counted.filter((v) => v.goodToMerge), claim, reviewed, bug.organisationId).weight,
    notGood: countedMergeVerdicts(counted.filter((v) => !v.goodToMerge), claim, reviewed, bug.organisationId).weight,
  };
}

/** The judgements that count on the delivered pull request, good and not good, and how many are needed. */
export async function countedJudgements(
  db: Db,
  bugId: string,
  /** The card when the caller already loaded it (the issue page), so it isn't loaded twice. */
  loaded?: TestCard,
): Promise<{ good: number; notGood: number; needed: number; held: boolean } | null> {
  const bug = await db.bug.findUnique({ where: { id: bugId }, select: judgedBugSelect });
  if (!bug) return null;
  if (bug.track !== "marketing" && !bug.pullRequestUrl) return null;

  let verdicts: Judgement[] = [];
  let credited: string[] = [];
  // Marketing work has no pull request to prove anything on: its judgements count as before.
  const card = bug.track === "marketing" ? null : (loaded ?? (await loadCard(db, bug)));

  if (bug.track === "marketing") {
    const delivery = await db.delivery.findFirst({
      where: { bugId },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      select: { updatedAt: true, pullRequestUrl: true },
    });
    if (!delivery) return null;

    const allVerdicts = await db.testVerdict.findMany({
      where: { bugId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        ...judgementSelect,
        updatedAt: true,
        pullRequestUrl: true,
      },
    });
    verdicts = allVerdicts.filter((v) => judgementCounts(bug.track, v, delivery));
    credited = deliveredClaim(bug)
      ? []
      : (await db.delivery.findMany({ where: { bugId }, select: { beneficiaryUserId: true } })).map(
          (d) => d.beneficiaryUserId,
        );
  } else {
    verdicts = await db.testVerdict.findMany({
      where: { bugId, pullRequestUrl: bug.pullRequestUrl },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: judgementSelect,
    });
    // With no claim, whoever the deliveries on this pull request credit can't judge it.
    credited = deliveredClaim(bug)
      ? []
      : (await db.delivery.findMany({ where: { bugId, pullRequestUrl: bug.pullRequestUrl }, select: { beneficiaryUserId: true } })).map(
          (delivery) => delivery.beneficiaryUserId,
        );
  }

  const { good, notGood } = countJudgements(verdicts, bug, credited, card?.checks ?? NO_CHECKS);
  const { verdictsNeeded } = await workflowFor(bug.projectId, db);
  return { good, notGood, needed: verdictsNeeded, held: Boolean(card?.on && (card.holes > 0 || card.failed > 0)) };
}

/**
 * The Issues list's Tests bar (#deeper-testing): for each issue being judged,
 * the weight of judgements that count and how many are needed, by the same
 * count as the Delivered step. One query for the whole page.
 */
export async function judgementBars(db: Db, bugIds: string[]): Promise<Map<string, { good: number; needed: number }>> {
  const bars = new Map<string, { good: number; needed: number }>();
  // Most tabs list no delivered issue: no query then.
  if (!bugIds.length) return bars;
  const bugs = await db.bug.findMany({
    where: { id: { in: bugIds }, status: "done", track: "product", pullRequestUrl: { not: null } },
    select: { ...judgedBugSelect, testVerdicts: { orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { ...judgementSelect, pullRequestUrl: true } } },
  });
  if (!bugs.length) return bars;
  const rules = await loadProofRules(db, bugs[0].organisationId);
  const needed = new Map<string, number>();
  for (const bug of bugs) {
    if (!needed.has(bug.projectId)) needed.set(bug.projectId, (await workflowFor(bug.projectId, db)).verdictsNeeded);
    const verdicts = bug.testVerdicts.filter((v) => v.pullRequestUrl === bug.pullRequestUrl);
    const { good } = countJudgements(verdicts, bug, [], checksFor(rules, bug));
    bars.set(bug.id, { good, needed: needed.get(bug.projectId)! });
  }
  return bars;
}

/**
 * Apply the rule after a judgement. Acts only on a Done issue, Requires
 * review or Accepted (a judgement taken back can return Accepted to Requires
 * review). Returns the new substatus when it changed, else null.
 */
export async function refreshJudgedStatus(
  db: Db,
  bugId: string,
  actorUserId: string,
): Promise<"requires_review" | "accepted" | "open" | "in_progress" | null> {
  const bug = await db.bug.findUnique({ where: { id: bugId }, select: judgedBugSelect });
  if (!bug) return null;
  if (bug.track !== "marketing" && !bug.pullRequestUrl) return null;
  if (bug.status !== "done") return null;

  const count = await countedJudgements(db, bugId);
  if (!count) return null;
  const next = count.good >= count.needed && !count.held ? "accepted" : count.notGood >= count.needed ? "open" : "requires_review";
  if (next === bug.substatus) return null;

  if (next === "open") {
    if (bug.track === "marketing") {
      const workflow = await workflowFor(bug.projectId, db);
      const sendBack = afterSendBack(bug, workflow.revisionLimit, "judgement");
      if (sendBack.keepsClaim) {
        await db.bug.update({
          where: { id: bugId },
          data: { ...moveTo(sendBack.substatus), revisionCount: sendBack.revisionCount },
        });
        await db.bugActivity.create({
          data: {
            bugId,
            actorId: actorUserId,
            type: "status_changed",
            summary: `Judgements weighing ${count.notGood} say the delivered work is not good: back to In progress (revision round ${sendBack.revisionCount} of ${workflow.revisionLimit})`,
            metadata: {
              field: "status",
              from: bug.substatus,
              to: sendBack.substatus,
              good: count.good,
              notGood: count.notGood,
              needed: count.needed,
              revisionCount: sendBack.revisionCount,
              revisionLimit: workflow.revisionLimit,
            },
          },
        });
        return sendBack.substatus as "in_progress";
      }

      // Past revision limit: release claim and reopen for bids
      const now = new Date();
      const held = bug.claims.filter((claim) => !claim.releasedAt && (claim.status === "active" || claim.status === "offered"));
      for (const claim of held) {
        await db.issueClaim.update({ where: { id: claim.id }, data: { status: "released", releasedAt: now, releaseReason: "judged_not_good" } });
        await publish(db, {
          organisationId: bug.organisationId,
          type: "claim.released",
          actorAgentId: null,
          bugId,
          payload: { claimId: claim.id, issueId: bugId, beneficiaryUserId: claim.beneficiaryUserId, reason: "judged_not_good" },
        });
      }
      await db.bug.update({
        where: { id: bugId },
        data: { ...moveTo("open"), assigneeId: null, revisionCount: 0 },
      });
      await db.bugActivity.create({
        data: {
          bugId,
          actorId: actorUserId,
          type: "status_changed",
          summary: `Judgements weighing ${count.notGood} say the delivered work is not good and revision limit reached (${workflow.revisionLimit}): reopened for bids`,
          metadata: { field: "status", from: bug.substatus, to: "open", good: count.good, notGood: count.notGood, needed: count.needed, revisionCount: 0, revisionLimit: workflow.revisionLimit },
        },
      });
      return "open";
    }

    // Judged not good to merge: back to Open, for someone to take again.
    const now = new Date();
    const held = bug.claims.filter((claim) => !claim.releasedAt && (claim.status === "active" || claim.status === "offered"));
    for (const claim of held) {
      await db.issueClaim.update({ where: { id: claim.id }, data: { status: "released", releasedAt: now, releaseReason: "judged_not_good" } });
      await publish(db, {
        organisationId: bug.organisationId,
        type: "claim.released",
        actorAgentId: null,
        bugId,
        payload: { claimId: claim.id, issueId: bugId, beneficiaryUserId: claim.beneficiaryUserId, reason: "judged_not_good" },
      });
    }
    await db.bug.update({
      where: { id: bugId },
      data: { ...moveTo("open"), assigneeId: null, pullRequestUrl: null, pullRequestHeadSha: null },
    });
  } else {
    await db.bug.update({ where: { id: bugId }, data: moveTo(next) });
  }

  await db.bugActivity.create({
    data: {
      bugId,
      actorId: actorUserId,
      type: "status_changed",
      summary:
        next === "accepted"
          ? `Judgements weighing ${count.good} say the delivered work is good to merge: moved to Done · Accepted`
          : next === "open"
            ? `Judgements weighing ${count.notGood} say the delivered work is not good to merge: back to Open`
            : count.held && count.good >= count.needed
              ? "The test card has a proven fail, or squares nobody has proven: back to Done · Requires review"
              : `Judgements weighing fewer than ${count.needed} say it is good to merge: back to Done · Requires review`,
      metadata: { field: "status", from: bug.substatus, to: next, good: count.good, notGood: count.notGood, needed: count.needed },
    },
  });
  return next;
}
