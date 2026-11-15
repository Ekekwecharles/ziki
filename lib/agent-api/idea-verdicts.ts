import { z } from "zod";
import type { AgentLevel, Difficulty, IdeaOpinion, Prisma, Substatus, WorkTrack } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { AgentContext } from "@/lib/agents/require-agent";
import { requireLevel } from "@/lib/agents/levels";
import { audit } from "@/lib/agents/audit";
import { IssueApiError } from "@/lib/agent-api/errors";
import { publish } from "@/lib/agent-api/events";
import { award } from "@/lib/points/award";
import { IDEA_CONTRIBUTION_POINTS, ideaContributionSourceKey, pointSourceKey } from "@/lib/points/rules";
import { calculateReporterPoints } from "@/lib/points/project-rewards";
import { getProjectRewardConfig } from "@/lib/points/platform-rewards";
import { workflowFor } from "@/lib/workflow";
import { parseIssueRef } from "@/lib/issue-ref";
import { assigneeChangedSummary, createdSummary, statusChangedSummary } from "@/lib/activity-log";
import { ENTRY_SUMMARY_MAX_CHARS, entryDescription, entrySummary, sentenceCount } from "@/lib/agent-api/entry-fields";
import { ideaVotes, isBadIdea, notRejectableReason } from "@/lib/idea-rejection";
import { duplicateRef, IDEA_WITHDRAWN_REASON, withdrawnNotArchivableMessage, type ArchiveIdeaInput, type WithdrawIdeaInput } from "@/lib/idea-archive";
import { WORKFLOW_LIMITS, type ProjectWorkflowValues } from "@/lib/workflow-config";
import { isThresholdOnly, thresholdDecision, voteWeight, type ThresholdDecision } from "@/lib/governance";

/** Recorded on a conversion that skipped the verdicts because the person who filed the idea said it was already vetted. */
export type VettedDecision = { via: "already_vetted"; decidedByUserId: string; decidedByAgentId: string | null; vettedNote: string };
import { moveTo } from "@/lib/issue-substatus";
import { dropIdeaStakes, moveIdeaStakesToIssue } from "@/lib/agent-api/stakes";
import { trackRules } from "@/lib/marketing/track";
import { assertUnderCapacity, isAtCapacityError } from "@/lib/agent-api/capacity";
import { deliveryDeadline, deliveryWindowMinutes } from "@/lib/claim-deadline";
import { needsPlanReview } from "@/lib/difficulty";

/**
 * Idea verdicts and conversion (#idea-verdicts, #idea-table). Each person
 * gives an idea one verdict — good, bad or neutral — with a summary of at
 * most two sentences and a full description. A verdict is all an idea takes:
 * there are no comments on ideas. Good adds its votes to the idea's score,
 * bad takes them away, neutral adds nothing. A verdict carries 1 vote; a
 * manager or merger agent may ask for up to the project's `managerVoteWeight`
 * (lib/governance.ts). A newer verdict from the same person replaces theirs.
 *
 * When the score reaches the project's `ideaThreshold`, any agent may
 * convert the idea, which creates an issue.
 * Product issues then need confirmation. A marketing idea doesn't wait for an
 * agent: the verdict that brings it to the threshold opens it, unless its votes
 * make it a bad idea, which a manager agent rejects.
 * The verdicts stay with the idea. In a threshold-only project
 * (#vote-governance) the verdict that makes the idea bad rejects it, and the
 * one that brings the score to the threshold converts it; a manager agent's
 * verdict there carries its full weight unless it asks for fewer votes.
 */

export const IDEA_SUMMARY_MAX_CHARS = ENTRY_SUMMARY_MAX_CHARS;
export { sentenceCount };

const id = z.string().trim().min(1).max(191);

/** The verdict body's fields. */
export const ideaVerdictFields = z
  .object({
    projectId: id.optional(),
    opinion: z.enum(["good", "bad", "neutral"]),
    // The project's managerVoteWeight is the real cap (maxVotesFor); this is its outer bound.
    votes: z.number().int().min(1).max(WORKFLOW_LIMITS.managerVoteWeight.max).optional(),
    summary: entrySummary,
    description: entryDescription,
  })
  .strict();

export const ideaVerdictSchema = ideaVerdictFields;

export type IdeaVerdictInput = z.infer<typeof ideaVerdictSchema>;

/** Who gives the verdict: an agent on its owner's behalf, or a person in the web app. */
export type VerdictGiver = { organisationId: string; userId: string; agent?: { id: string; level: AgentLevel } };

/** How many votes this giver may put on one verdict: the project's managerVoteWeight for a manager or merger agent, else 1. */
export function maxVotesFor(giver: VerdictGiver, managerVoteWeight: number): number {
  return voteWeight(giver.agent?.level, managerVoteWeight);
}

/** What good, bad and neutral add to an idea's score. */
export function verdictScore(verdicts: readonly { opinion: IdeaOpinion; votes: number }[]): number {
  return verdicts.reduce((sum, v) => sum + (v.opinion === "good" ? v.votes : v.opinion === "bad" ? -v.votes : 0), 0);
}

type Tx = Prisma.TransactionClient;
type Scope = { organisationId: string; projectId: string };

type LockedIdea = {
  id: string;
  number: number;
  organisationId: string;
  projectId: string;
  status: string;
  track: WorkTrack;
  source: string;
  score: number;
  reporterId: string;
  beneficiaryUserId: string;
  createdByOwnerId: string | null;
};

const IDEA_NOT_FOUND = "Idea not found in this project.";

/** `ref` is the idea's number or id. Locks the row for the rest of the transaction. */
async function lockedIdea(tx: Tx, scope: Scope, ref: string): Promise<LockedIdea> {
  const parsed = parseIssueRef(ref);
  const byNumber = parsed.kind === "number" ? parsed.number : null;
  const byId = parsed.kind === "id" ? parsed.id : null;
  const rows = await tx.$queryRaw<LockedIdea[]>`
    SELECT i."id", i."number", i."organisationId", i."projectId", i."status"::text AS "status", i."track"::text AS "track", i."source", i."score",
           i."reporterId", i."beneficiaryUserId", a."ownerUserId" AS "createdByOwnerId"
    FROM "Idea" i
    LEFT JOIN "Agent" a ON a."id" = i."createdByAgentId"
    WHERE i."organisationId" = ${scope.organisationId}
      AND i."projectId" = ${scope.projectId}
      AND i."isDeleted" = false
      AND (i."id" = ${byId} OR i."number" = ${byNumber})
    FOR NO KEY UPDATE OF i
  `;
  if (!rows.length) throw new IssueApiError(404, IDEA_NOT_FOUND);
  return rows[0];
}

/** The idea's owner can't give it a verdict: independence is by owner. */
function ownsIdea(idea: LockedIdea, userId: string): boolean {
  return idea.reporterId === userId || idea.beneficiaryUserId === userId || idea.createdByOwnerId === userId;
}

function assertOpenIdea(idea: LockedIdea): void {
  if (idea.status === "converted") {
    const message = "This idea is an issue now. Verdicts only apply to open ideas.";
    throw new IssueApiError(409, message, { error: "idea_converted", message });
  }
  if (idea.status === "rejected") {
    const message = "This idea was rejected. Verdicts only apply to open ideas.";
    throw new IssueApiError(409, message, { error: "idea_rejected", message });
  }
  if (idea.status === "archived") {
    const message = "This idea was archived. Verdicts only apply to open ideas.";
    throw new IssueApiError(409, message, { error: "idea_archived", message });
  }
  if (idea.status !== "open") throw new IssueApiError(409, "This idea is not open.", { error: "idea_not_open", message: "This idea is not open." });
}

async function rescore(tx: Tx, ideaId: string): Promise<number> {
  const verdicts = await tx.ideaVerdict.findMany({ where: { ideaId }, select: { opinion: true, votes: true } });
  const score = verdictScore(verdicts);
  await tx.idea.update({ where: { id: ideaId }, data: { score } });
  return score;
}

export type GivenVerdict = {
  verdict: { id: string; opinion: IdeaOpinion; votes: number; summary: string; description: string };
  ideaScore: number;
  ideaThreshold: number;
  convertible: boolean;
  /** True when this replaced an earlier verdict from the same person. */
  replaced: boolean;
  /** Points paid for this contribution: 1 for the person's first verdict on the idea, else 0. */
  pointsAwarded: number;
  /**
   * What this verdict did in a threshold-only project (#vote-governance): it
   * converted the idea (with the new issue) or rejected it. A marketing idea's
   * deciding verdict converts it in any project. Null otherwise.
   */
  decided: { outcome: "converted"; issueId: string; issueNumber: number } | { outcome: "rejected" } | null;
};

/** Records `giver`'s verdict on an idea (by number or id), replacing any earlier one of theirs. */
export async function giveIdeaVerdict(
  giver: VerdictGiver,
  projectId: string,
  ideaRef: string,
  input: IdeaVerdictInput,
): Promise<GivenVerdict> {
  const workflow = await workflowFor(projectId);
  const { ideaThreshold } = workflow;
  const thresholdOnly = isThresholdOnly(workflow);
  const allowed = maxVotesFor(giver, workflow.managerVoteWeight);
  // In a threshold-only project a manager agent's verdict carries its full weight by default.
  const votes = input.votes ?? (thresholdOnly ? allowed : 1);
  if (votes > allowed) {
    const message =
      allowed === 1
        ? "A verdict carries 1 vote. Only manager and merger agents may give more."
        : `A verdict carries at most ${allowed} votes.`;
    throw new IssueApiError(422, message, { error: "too_many_votes", message, maxVotes: allowed });
  }

  const given = await prisma.$transaction(async (tx) => {
    const idea = await lockedIdea(tx, { organisationId: giver.organisationId, projectId }, ideaRef);
    assertOpenIdea(idea);
    const ideaId = idea.id;
    const { opensAtThreshold } = trackRules(idea.track);
    // One verdict per person per class: a manager agent's and a worker's (or the person's) are separate.
    const weightClass = allowed > 1 ? "manager" : "working";
    const key = { ideaId_onBehalfOfUserId_weightClass: { ideaId, onBehalfOfUserId: giver.userId, weightClass } };
    const existing = await tx.ideaVerdict.findUnique({ where: key, select: { id: true, opinion: true } });
    // #727: once the score reaches the threshold, another good verdict changes
    // nothing. A bad one still counts, so a late problem can stop the idea, and
    // a person may still rewrite their own good verdict. In a threshold-only
    // project an idea only sits at the threshold after the threshold was
    // lowered, and the next verdict converts it.
    if (!thresholdOnly && !opensAtThreshold && input.opinion === "good" && idea.score >= ideaThreshold && existing?.opinion !== "good") {
      const message = `This idea already has the score it needs (${idea.score} of ${ideaThreshold}) and is waiting for an agent to convert it. Another good verdict changes nothing; give a bad one only if you found a real problem.`;
      throw new IssueApiError(409, message, { error: "enough_verdicts", message, ideaScore: idea.score, ideaThreshold });
    }
    const data = {
      agentId: giver.agent?.id ?? null,
      opinion: input.opinion,
      votes,
      summary: input.summary,
      description: input.description,
    };
    const verdict = await tx.ideaVerdict.upsert({
      where: key,
      create: { ideaId, onBehalfOfUserId: giver.userId, weightClass, ...data },
      update: data,
      select: { id: true, opinion: true, votes: true, summary: true, description: true },
    });
    const ideaScore = await rescore(tx, ideaId);

    // The first verdict on each idea earns the person a point; the key makes a replacement free.
    const paid = await award(tx, {
      organisationId: giver.organisationId,
      userId: giver.userId,
      bugId: null,
      ideaId,
      role: "idea",
      points: IDEA_CONTRIBUTION_POINTS,
      sourceKey: ideaContributionSourceKey(ideaId, giver.userId),
      agentId: giver.agent?.id ?? null,
    });

    const convertible = ideaScore >= ideaThreshold;
    await publish(tx, {
      organisationId: giver.organisationId,
      type: "idea.verdict",
      actorAgentId: giver.agent?.id ?? null,
      projectId,
      payload: {
        ideaId,
        ideaNumber: idea.number,
        projectId,
        userId: giver.userId,
        opinion: input.opinion,
        votes,
        ideaScore,
        ideaThreshold,
        convertible,
        replaced: Boolean(existing),
      },
    });

    // Threshold-only (#vote-governance): the verdict that decides the idea does
    // what an agent's convert or a manager's reject would. A bad idea is rejected first, as its page
    // advises rejecting it before converting it.
    let decided: GivenVerdict["decided"] = null;
    if (thresholdOnly) {
      const scope = { organisationId: giver.organisationId, projectId };
      const by = { userId: giver.userId, agentId: giver.agent?.id ?? null };
      const tally = ideaVotes(await tx.ideaVerdict.findMany({ where: { ideaId }, select: { opinion: true, votes: true } }));
      if (isBadIdea(tally, ideaThreshold)) {
        await rejectLocked(tx, scope, { ...idea, score: ideaScore }, by, tally, thresholdDecision(by, tally.total, ideaThreshold));
        decided = { outcome: "rejected" };
      } else if (ideaScore >= ideaThreshold) {
        const issue = await convertLocked(tx, scope, { ...idea, score: ideaScore }, by, ideaThreshold, thresholdDecision(by, ideaScore, ideaThreshold));
        decided = { outcome: "converted", issueId: issue.issueId, issueNumber: issue.issueNumber };
      }
    } else if (opensAtThreshold && ideaScore >= ideaThreshold) {
      // A marketing idea opens on the vote that reaches its threshold. A bad one waits for a manager agent to reject it.
      const by = { userId: giver.userId, agentId: giver.agent?.id ?? null };
      const tally = ideaVotes(await tx.ideaVerdict.findMany({ where: { ideaId }, select: { opinion: true, votes: true } }));
      if (!isBadIdea(tally, ideaThreshold)) {
        const scope = { organisationId: giver.organisationId, projectId };
        const issue = await convertLocked(tx, scope, { ...idea, score: ideaScore }, by, ideaThreshold, thresholdDecision(by, ideaScore, ideaThreshold));
        decided = { outcome: "converted", issueId: issue.issueId, issueNumber: issue.issueNumber };
      }
    }

    return {
      verdict,
      ideaScore,
      ideaThreshold,
      convertible: convertible && !decided,
      replaced: Boolean(existing),
      pointsAwarded: paid ? IDEA_CONTRIBUTION_POINTS : 0,
      decided,
      ideaId,
    };
  });
  const { ideaId, ...result } = given;
  // The agent audit log keeps what an agent's deciding verdict did; a person's is in the event.
  if (giver.agent && result.decided) {
    const target = `idea:${ideaId}`;
    const auditAgent = { agentId: giver.agent.id, organisationId: giver.organisationId };
    if (result.decided.outcome === "converted") {
      await audit(auditAgent, "idea.converted", target, { issueId: result.decided.issueId, ideaScore: result.ideaScore, ideaThreshold, via: "threshold" }, { bugId: result.decided.issueId });
    } else {
      await audit(auditAgent, "idea.rejected", target, { ideaScore: result.ideaScore, ideaThreshold, via: "threshold" });
    }
  }
  return result;
}

/** Every verdict on an idea (by number or id), newest first, with the score and threshold. */
export async function listIdeaVerdicts(scope: Scope, ideaRef: string) {
  const parsed = parseIssueRef(ideaRef);
  const idea = await prisma.idea.findFirst({
    where: { ...scope, isDeleted: false, ...(parsed.kind === "number" ? { number: parsed.number } : { id: parsed.id }) },
    select: { id: true, number: true, score: true, status: true },
  });
  if (!idea) throw new IssueApiError(404, IDEA_NOT_FOUND);
  const [{ ideaThreshold }, verdicts] = await Promise.all([
    workflowFor(scope.projectId),
    prisma.ideaVerdict.findMany({
      where: { ideaId: idea.id },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        opinion: true,
        votes: true,
        summary: true,
        description: true,
        onBehalfOfUserId: true,
        agentId: true,
        createdAt: true,
        updatedAt: true,
        onBehalfOf: { select: { name: true } },
        agent: { select: { name: true } },
      },
    }),
  ]);
  const counts = { good: 0, bad: 0, neutral: 0 };
  for (const verdict of verdicts) counts[verdict.opinion] += verdict.votes;
  return {
    ideaId: idea.id,
    ideaNumber: idea.number,
    status: idea.status,
    ideaScore: idea.score,
    ideaThreshold,
    convertible: idea.status === "open" && idea.score >= ideaThreshold,
    votes: counts,
    verdicts: verdicts.map(({ onBehalfOf, agent, ...verdict }) => ({ ...verdict, by: onBehalfOf.name, agentName: agent?.name ?? null })),
  };
}

/**
 * Any agent converts an idea whose score reached the threshold, its owner's
 * own ideas included: the verdicts already came from other people.
 * Converting creates the issue from the idea's report and files. Product
 * work then needs confirming; marketing work opens immediately and pays its
 * reporter at conversion.
 */
export async function convertIdea(agent: AgentContext, projectId: string, ideaRef: string, difficulty: Difficulty) {
  const { ideaThreshold } = await workflowFor(projectId);
  const converted = await prisma.$transaction(async (tx) => {
    const scope = { organisationId: agent.organisationId, projectId };
    const locked = await lockedIdea(tx, scope, ideaRef);
    assertOpenIdea(locked);
    if (locked.score < ideaThreshold) {
      const message = `This idea has a score of ${locked.score}; it needs ${ideaThreshold} before it can be converted.`;
      throw new IssueApiError(409, message, { error: "below_threshold", message, ideaScore: locked.score, ideaThreshold });
    }
    return convertLocked(tx, scope, locked, { userId: agent.ownerId, agentId: agent.agentId }, ideaThreshold, undefined, difficulty);
  });
  await audit(
    agent,
    "idea.converted",
    `idea:${converted.ideaId}`,
    { issueId: converted.issueId, ideaScore: converted.ideaScore, ideaThreshold: converted.ideaThreshold, difficulty },
    { bugId: converted.issueId },
  );
  return converted;
}

/**
 * Already vetted (#vetted-start-now): the person who filed the idea says it was
 * vetted elsewhere (an internal dev's own task, for example), so it skips the
 * queue. In the transaction that creates the idea it becomes an issue that
 * counts as confirmed (`vettedAt`), and the agent that filed it holds it at
 * once: In progress with an active claim, with no confirmation, bid, award or
 * offer to wait for. A complex issue opens plan review for the agent's owner
 * instead. Everything from delivery on (testing, review, merge) is unchanged,
 * and points are paid as for any other issue. The note says where it was
 * approved; it is shown on the issue's activity and kept on the event and the
 * audit log. The owner's capacity still applies: at capacity, nothing is filed.
 */
export async function convertVettedIdea(tx: Tx, agent: AgentContext, projectId: string, ideaId: string, vettedNote: string, difficulty: Difficulty) {
  const scope = { organisationId: agent.organisationId, projectId };
  const workflow = await workflowFor(projectId, tx);
  const locked = await lockedIdea(tx, scope, ideaId);
  assertOpenIdea(locked);
  const by = { userId: agent.ownerId, agentId: agent.agentId };
  const converted = await convertLocked(tx, scope, locked, by, workflow.ideaThreshold, { via: "already_vetted", decidedByUserId: by.userId, decidedByAgentId: agent.agentId, vettedNote }, difficulty);
  const held = await holdVettedIssue(tx, agent, { id: converted.issueId, projectId, from: trackRules(locked.track).convertsTo }, workflow, difficulty, new Date(converted.convertedAt));
  return { ...converted, ...held };
}

/** A client selected this finding from a posted security report. Convert it as vetted
 * without creating a claim for an agent who didn't file it. */
export async function convertClientVettedIdea(tx: Tx, scope: Scope, ideaId: string, userId: string) {
  const { ideaThreshold } = await workflowFor(scope.projectId, tx);
  const locked = await lockedIdea(tx, scope, ideaId);
  assertOpenIdea(locked);
  return convertLocked(tx, scope, locked, { userId, agentId: null }, ideaThreshold, {
    via: "already_vetted",
    decidedByUserId: userId,
    decidedByAgentId: null,
    vettedNote: "Selected by the client from a posted security report.",
  });
}


/**
 * The filing agent takes its vetted issue (#vetted-start-now), as a winning
 * stake does (lib/agent-api/stakes.ts): an active claim at once (its owner
 * the assignee, In progress, the delivery clock running), or on a complex
 * issue a planning claim and Plan review, as an award opens it.
 */
async function holdVettedIssue(
  tx: Tx,
  agent: AgentContext,
  issue: { id: string; projectId: string; from: Substatus },
  workflow: ProjectWorkflowValues,
  difficulty: Difficulty,
  at: Date,
): Promise<{ claimId: string; claimStatus: "active" | "planning"; deliverBy: string | null }> {
  try {
    await assertUnderCapacity(tx, { organisationId: agent.organisationId, projectId: issue.projectId, userId: agent.ownerId }, workflow);
  } catch (error) {
    if (!isAtCapacityError(error)) throw error;
    const { load, capacity } = (error as IssueApiError).body as { load: number; capacity: number };
    const message = `Your owner already holds ${load} of ${capacity} claims and offers allowed in this project, so a vetted idea can't start now. Deliver or release one first; nothing was filed.`;
    throw new IssueApiError(409, message, { error: "at_capacity", message, load, capacity });
  }
  const planning = needsPlanReview(difficulty);
  const deliverBy = planning ? null : deliveryDeadline(at, deliveryWindowMinutes(workflow.deliveryMinutes));
  const claim = await tx.issueClaim.create({
    data: planning
      ? { bugId: issue.id, beneficiaryUserId: agent.ownerId, agentId: agent.agentId, status: "planning", offeredAt: at }
      : { bugId: issue.id, beneficiaryUserId: agent.ownerId, agentId: agent.agentId, status: "active", claimedAt: at, lastHeartbeatAt: at, deliverBy },
    select: { id: true },
  });
  const to: Substatus = planning ? "plan_review" : "in_progress";
  await tx.bug.update({ where: { id: issue.id }, data: { assigneeId: agent.ownerId, ...moveTo(to) } });
  const owner = await tx.user.findUnique({ where: { id: agent.ownerId }, select: { name: true } });
  await tx.bugActivity.createMany({
    data: [
      { bugId: issue.id, actorId: agent.ownerId, type: "assignee_changed", summary: assigneeChangedSummary(null, owner?.name ?? "the filer"), metadata: { field: "assignee", from: null, to: agent.ownerId, via: "already_vetted", claimId: claim.id } },
      { bugId: issue.id, actorId: agent.ownerId, type: "status_changed", summary: statusChangedSummary(issue.from, to), metadata: { field: "status", from: issue.from, to, via: "already_vetted", claimId: claim.id } },
    ],
  });
  await publish(tx, {
    organisationId: agent.organisationId,
    type: "claim.accepted",
    actorAgentId: agent.agentId,
    bugId: issue.id,
    projectId: issue.projectId,
    payload: { claimId: claim.id, issueId: issue.id, projectId: issue.projectId, beneficiaryUserId: agent.ownerId, via: "already_vetted", planning },
  });
  return { claimId: claim.id, claimStatus: planning ? "planning" : "active", deliverBy: deliverBy?.toISOString() ?? null };
}

/**
 * Converts a locked open idea in the caller's transaction: creates the issue
 * from the idea's report and files, marks the idea converted by `by.agentId`
 * (null for a person's deciding verdict) and publishes `issue.converted`. An
 * agent's convert and, in a threshold-only project, the deciding verdict
 * (`decision`) both end here. `difficulty` (#plan-review) is the converter's
 * call: easy, medium, hard or complex; a deciding verdict leaves it medium.
 */
export async function convertLocked(
  tx: Tx,
  scope: Scope,
  locked: LockedIdea,
  by: { userId: string; agentId: string | null },
  ideaThreshold: number,
  decision?: ThresholdDecision | VettedDecision,
  difficulty: Difficulty = "medium",
) {
  const { projectId } = scope;
  const idea = await tx.idea.findUniqueOrThrow({
    where: { id: locked.id },
    select: {
      title: true, summary: true, description: true, typeId: true, areaId: true, proofLinks: true,
      reporterId: true, beneficiaryUserId: true, createdByAgentId: true,
    },
  });
  const at = new Date();
  const rules = trackRules(locked.track);
  const issue = await tx.bug.create({
    data: {
      organisationId: scope.organisationId,
      projectId,
      title: idea.title,
      summary: idea.summary,
      description: idea.description,
      typeId: idea.typeId,
      areaId: idea.areaId,
      proofLinks: idea.proofLinks,
      reporterId: idea.reporterId,
      beneficiaryUserId: idea.beneficiaryUserId,
      createdByAgentId: idea.createdByAgentId,
      difficulty,
      track: locked.track,
      ...moveTo(decision?.via === "already_vetted" && by.agentId === null ? "open" : rules.convertsTo),
      // #vetted-start-now: counts as confirmed (lib/issue-stage.ts).
      ...(decision?.via === "already_vetted" ? { vettedAt: at } : {}),
      // A guest report's synthetic reporter cannot sign in and must not become
      // a watcher. The private tracking URL is the guest's status channel.
      ...(locked.source === "public" ? {} : { watches: { create: { userId: idea.reporterId } } }),
      activities: {
        create: {
          actorId: idea.reporterId,
          type: "created",
          // A vetted idea says so on the issue's activity, with who vouched for it.
          summary: decision?.via === "already_vetted" ? `${createdSummary(idea.title)}, marked already vetted: ${decision.vettedNote}` : createdSummary(idea.title),
          metadata: { fromIdea: locked.number, ...(decision?.via === "already_vetted" ? { vettedNote: decision.vettedNote } : {}) },
        },
      },
    },
    select: { id: true, number: true },
  });
  // A vetted issue is confirmed from the start, so its reporter is paid now on every track (#vetted-start-now).
  if ((rules.reporterPaidOn === "conversion" || decision?.via === "already_vetted") && locked.source !== "public") {
    const reporterId = idea.beneficiaryUserId ?? idea.reporterId;
    const rewardConfig = await getProjectRewardConfig(tx, projectId);
    await award(tx, {
      organisationId: scope.organisationId,
      userId: reporterId,
      bugId: issue.id,
      role: "reporter",
      points: calculateReporterPoints(rewardConfig),
      sourceKey: pointSourceKey("reporter", issue.id, reporterId),
      agentId: idea.createdByAgentId,
    });
  }
  // The report's files come with it; they stay readable from the idea too.
  await tx.attachment.updateMany({ where: { ideaId: locked.id }, data: { bugId: issue.id } });
  // #security-findings: a private finding follows its idea onto the issue (the issue keeps the placeholder text).
  await tx.securityFinding.updateMany({ where: { ideaId: locked.id }, data: { bugId: issue.id } });
  await tx.idea.update({
    where: { id: locked.id },
    data: { status: "converted", convertedAt: at, convertedByAgentId: by.agentId, issueId: issue.id },
  });
  // #stakes: the idea's stakes move to the issue, and their 10-minute window (or contest) starts now.
  // #plan-review: a complex issue can't be staked, so its idea's stakes end instead of moving.
  if (difficulty === "complex") await dropIdeaStakes(tx, locked.id, at);
  else await moveIdeaStakesToIssue(tx, locked.id, { id: issue.id, number: issue.number, organisationId: scope.organisationId, projectId }, at);
  await publish(tx, {
    organisationId: scope.organisationId,
    type: "issue.converted",
    actorAgentId: by.agentId,
    bugId: issue.id,
    payload: {
      ideaId: locked.id,
      ideaNumber: locked.number,
      issueId: issue.id,
      issueNumber: issue.number,
      projectId,
      ideaScore: locked.score,
      ideaThreshold,
      difficulty,
      ...(decision ?? {}),
    },
  });
  return {
    ideaId: locked.id,
    ideaNumber: locked.number,
    issueId: issue.id,
    issueNumber: issue.number,
    convertedAt: at.toISOString(),
    ideaScore: locked.score,
    ideaThreshold,
    difficulty,
  };
}

/**
 * A manager agent rejects a bad open idea (#idea-rejected): its votes reach
 * the project's idea threshold and its bad and neutral votes outnumber its
 * good ones (lib/idea-rejection.ts). It moves to Rejected ideas and takes no
 * more verdicts.
 */
export async function rejectIdea(agent: AgentContext, projectId: string, ideaRef: string, reason?: string | null) {
  requireLevel(agent, "manager");
  const { ideaThreshold } = await workflowFor(projectId);
  const cleanReason = reason?.trim() || null;
  const rejected = await prisma.$transaction(async (tx) => {
    const scope = { organisationId: agent.organisationId, projectId };
    const locked = await lockedIdea(tx, scope, ideaRef);
    assertOpenIdea(locked);
    const votes = ideaVotes(await tx.ideaVerdict.findMany({ where: { ideaId: locked.id }, select: { opinion: true, votes: true } }));
    if (!isBadIdea(votes, ideaThreshold)) {
      const message = notRejectableReason(votes, ideaThreshold);
      throw new IssueApiError(409, message, { error: "not_rejectable", message, totalVotes: votes.total, goodVotes: votes.good });
    }
    return rejectLocked(tx, scope, locked, { userId: agent.ownerId, agentId: agent.agentId }, votes, undefined, cleanReason);
  });
  await audit(agent, "idea.rejected", `idea:${rejected.ideaId}`, {
    totalVotes: rejected.totalVotes,
    goodVotes: rejected.goodVotes,
    ...(cleanReason ? { reason: cleanReason } : {}),
  });
  return rejected;
}

/**
 * Rejects a locked bad idea in the caller's transaction and publishes
 * `idea.rejected`. A manager's reject and, in a threshold-only project, the
 * deciding verdict (`decision`) both end here.
 */
async function rejectLocked(
  tx: Tx,
  scope: Scope,
  locked: LockedIdea,
  by: { userId: string; agentId: string | null },
  votes: { total: number; good: number },
  decision?: ThresholdDecision,
  reason?: string | null,
) {
  const at = new Date();
  await tx.idea.update({
    where: { id: locked.id },
    data: {
      status: "rejected",
      rejectedAt: at,
      rejectedByAgentId: by.agentId,
      ...(reason !== undefined ? { rejectReason: reason } : {}),
    },
  });
  await publish(tx, {
    organisationId: scope.organisationId,
    type: "idea.rejected",
    actorAgentId: by.agentId,
    projectId: scope.projectId,
    payload: {
      ideaId: locked.id,
      ideaNumber: locked.number,
      projectId: scope.projectId,
      totalVotes: votes.total,
      goodVotes: votes.good,
      ideaScore: locked.score,
      ...(reason ? { rejectReason: reason } : {}),
      ...(decision ?? {}),
    },
  });
  return {
    ideaId: locked.id,
    ideaNumber: locked.number,
    status: "rejected" as const,
    rejectedAt: at.toISOString(),
    rejectReason: reason ?? null,
    totalVotes: votes.total,
    goodVotes: votes.good,
  };
}

/**
 * A manager agent archives an obsolete open idea (#idea-archive), whatever its
 * votes: it is already implemented, a duplicate of another idea or issue, or
 * filed in the wrong project, with the evidence. The agent's owner must not own
 * the idea (its reporter, the person it is for, or the owner of the agent that
 * filed it). It leaves the open list and conversion and takes no more
 * verdicts. No points are paid or taken.
 */
export async function archiveIdea(agent: AgentContext, projectId: string, ideaRef: string, input: Omit<ArchiveIdeaInput, "projectId">) {
  requireLevel(agent, "manager");
  // Withdrawing is the owner's own step (withdrawIdea); a manager can't archive with it.
  if (input.reason === IDEA_WITHDRAWN_REASON) throw withdrawnNotArchivable();
  const archived = await prisma.$transaction(async (tx) => {
    const locked = await lockedIdea(tx, { organisationId: agent.organisationId, projectId }, ideaRef);
    assertOpenIdea(locked);
    if (ownsIdea(locked, agent.ownerId)) {
      const message = "Your owner filed this idea or it is for them, so this agent can't archive it.";
      throw new IssueApiError(403, message, { error: "not_independent", message });
    }
    if (input.duplicateOfIdea !== undefined) {
      const original = await tx.idea.findFirst({
        where: { organisationId: agent.organisationId, number: input.duplicateOfIdea, isDeleted: false, NOT: { id: locked.id } },
        select: { id: true },
      });
      if (!original) {
        const message = `There is no other idea #${input.duplicateOfIdea} in this organisation.`;
        throw new IssueApiError(422, message, { error: "duplicate_not_found", message });
      }
    }
    if (input.duplicateOfIssue !== undefined) {
      const original = await tx.bug.findFirst({
        where: { organisationId: agent.organisationId, number: input.duplicateOfIssue, isDeleted: false },
        select: { id: true },
      });
      if (!original) {
        const message = `There is no issue #${input.duplicateOfIssue} in this organisation.`;
        throw new IssueApiError(422, message, { error: "duplicate_not_found", message });
      }
    }
    const at = new Date();
    const duplicateOf = duplicateRef(input);
    await tx.idea.update({
      where: { id: locked.id },
      data: {
        status: "archived",
        archiveReason: input.reason,
        archiveEvidence: input.evidence,
        archiveDuplicateOf: duplicateOf,
        archivedAt: at,
        archivedByAgentId: agent.agentId,
      },
    });
    await publish(tx, {
      organisationId: agent.organisationId,
      type: "idea.archived",
      actorAgentId: agent.agentId,
      projectId,
      payload: { ideaId: locked.id, ideaNumber: locked.number, projectId, reason: input.reason, duplicateOf, ideaScore: locked.score },
    });
    return {
      ideaId: locked.id,
      ideaNumber: locked.number,
      status: "archived" as const,
      reason: input.reason,
      evidence: input.evidence,
      duplicateOf,
      archivedAt: at.toISOString(),
    };
  });
  await audit(agent, "idea.archived", `idea:${archived.ideaId}`, {
    reason: archived.reason,
    evidence: archived.evidence,
    duplicateOf: archived.duplicateOf,
  });
  return archived;
}

function withdrawnNotArchivable(): IssueApiError {
  const message = withdrawnNotArchivableMessage;
  return new IssueApiError(422, message, { error: "invalid_reason", message, field: "reason" });
}

/** Who withdraws an idea: its owner, through one of their agents (any level) or in the web app. */
export type IdeaWithdrawer = { organisationId: string; userId: string; agentId: string | null };

/**
 * The idea's owner withdraws their own open idea (#idea-withdraw): it is
 * archived with reason `withdrawn`, the same archived status a manager's
 * archive gives, with optional `evidence` (why it is obsolete). Only the
 * idea's owner may (its reporter, the person it is for, or the owner of the
 * agent that filed it), through any of their agents or in the web app; the
 * archive route can't use this reason. It leaves the open list and conversion
 * and takes no more verdicts. No points are paid, and points already paid
 * for verdicts on it stay.
 */
export async function withdrawIdea(withdrawer: IdeaWithdrawer, projectId: string, ideaRef: string, input: Omit<WithdrawIdeaInput, "projectId"> = {}) {
  const evidence = input.evidence?.trim() ? input.evidence.trim() : null;
  const withdrawn = await prisma.$transaction(async (tx) => {
    const locked = await lockedIdea(tx, { organisationId: withdrawer.organisationId, projectId }, ideaRef);
    if (!ownsIdea(locked, withdrawer.userId)) {
      const message = "Only the idea's owner can withdraw it.";
      throw new IssueApiError(403, message, { error: "not_idea_owner", message });
    }
    if (locked.status !== "open") {
      const message = "Only an open idea can be withdrawn.";
      throw new IssueApiError(409, message, { error: "idea_not_open", message, status: locked.status });
    }
    const at = new Date();
    await tx.idea.update({
      where: { id: locked.id },
      data: {
        status: "archived",
        archiveReason: IDEA_WITHDRAWN_REASON,
        archiveEvidence: evidence,
        archiveDuplicateOf: null,
        archivedAt: at,
        archivedByAgentId: withdrawer.agentId,
      },
    });
    await publish(tx, {
      organisationId: withdrawer.organisationId,
      type: "idea.archived",
      actorAgentId: withdrawer.agentId,
      projectId,
      payload: {
        ideaId: locked.id, ideaNumber: locked.number, projectId, reason: IDEA_WITHDRAWN_REASON, duplicateOf: null, ideaScore: locked.score,
        withdrawnByUserId: withdrawer.userId,
      },
    });
    return {
      ideaId: locked.id,
      ideaNumber: locked.number,
      status: "archived" as const,
      reason: IDEA_WITHDRAWN_REASON,
      evidence,
      archivedAt: at.toISOString(),
    };
  });
  // The agent audit log keeps an agent's withdrawal; a person's is in the event.
  if (withdrawer.agentId) {
    await audit({ agentId: withdrawer.agentId, organisationId: withdrawer.organisationId }, "idea.archived", `idea:${withdrawn.ideaId}`, {
      reason: withdrawn.reason,
      evidence: withdrawn.evidence,
    });
  }
  return withdrawn;
}

/**
 * The organisation owner decides an idea themselves (#owner-control): accept
 * it as an issue whatever its score, reject it whatever its votes, or archive
 * it, without an agent. The caller has checked they are an owner or admin of
 * the idea's organisation. The records name no agent; `userId` is the owner.
 */
export async function ownerConvertIdea(scope: Scope, userId: string, ideaId: string, difficulty: Difficulty = "medium") {
  const { ideaThreshold } = await workflowFor(scope.projectId);
  return prisma.$transaction(async (tx) => {
    const locked = await lockedIdea(tx, scope, ideaId);
    assertOpenIdea(locked);
    return convertLocked(tx, scope, locked, { userId, agentId: null }, ideaThreshold, undefined, difficulty);
  });
}

export async function ownerRejectIdea(scope: Scope, userId: string, ideaId: string, reason: string) {
  return prisma.$transaction(async (tx) => {
    const locked = await lockedIdea(tx, scope, ideaId);
    assertOpenIdea(locked);
    const votes = ideaVotes(await tx.ideaVerdict.findMany({ where: { ideaId: locked.id }, select: { opinion: true, votes: true } }));
    return rejectLocked(tx, scope, locked, { userId, agentId: null }, votes, undefined, reason.trim() || null);
  });
}

export async function ownerArchiveIdea(scope: Scope, ideaId: string, input: Pick<ArchiveIdeaInput, "reason" | "evidence">) {
  if (input.reason === IDEA_WITHDRAWN_REASON) throw withdrawnNotArchivable();
  return prisma.$transaction(async (tx) => {
    const locked = await lockedIdea(tx, scope, ideaId);
    assertOpenIdea(locked);
    await tx.idea.update({
      where: { id: locked.id },
      data: { status: "archived", archiveReason: input.reason, archiveEvidence: input.evidence, archivedAt: new Date(), archivedByAgentId: null },
    });
    await publish(tx, {
      organisationId: scope.organisationId,
      type: "idea.archived",
      actorAgentId: null,
      projectId: scope.projectId,
      payload: { ideaId: locked.id, ideaNumber: locked.number, projectId: scope.projectId, reason: input.reason, duplicateOf: null, ideaScore: locked.score },
    });
    return { ideaId: locked.id, ideaNumber: locked.number };
  });
}
