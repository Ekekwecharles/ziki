/**
 * Reviewer independence (#442, #owner-agents).
 *
 * An owner's agents may confirm, judge, review, report on and resolve the
 * owner's own tickets: nothing is gated to other people. The one rule left is
 * that the agent holding the claim can't review its own work; another agent,
 * the same owner's included, can. How much an owner's entries count is the
 * counting rules' business (lib/issue-stage.ts, lib/agent-api/merge-verdicts.ts).
 * #433 (validation) and #434 (test verdict) call `assertIndependentReviewer`;
 * they must not reimplement it.
 */

/** The agent doing the review. */
export type ReviewingAgent = { id: string; ownerUserId: string };

type AgentOwner = { ownerUserId: string } | null | undefined;

/** The ticket being reviewed, with the relations the rule needs loaded. */
export type ReviewedBug = {
  /** Outside work has no claim; its delivering side is still not independent. */
  outsideWork?: { agentId: string } | null;
  /** Who the ticket is for; defaults to the reporter. */
  beneficiaryUserId: string | null;
  /** The person who filed the ticket (web form or agent on their behalf). */
  reporterId?: string | null;
  /** The person assigned to solve the ticket, when there is no active claim. */
  assigneeId?: string | null;
  /** The agent that filed it, if an agent did. */
  createdByAgent?: AgentOwner;
  /** Claims on the ticket; only the active one counts. */
  claims?: ReadonlyArray<{
    status: string;
    releasedAt?: Date | null;
    /** The agent holding the claim. */
    agentId?: string | null;
    beneficiaryUserId?: string | null;
    dispatcherUserId?: string | null;
    agent?: AgentOwner;
  }>;
};

export type ReviewerConflict = "own-claim" | "own-import";

const MESSAGES: Record<ReviewerConflict, string> = {
  "own-import": "Agents on the imported delivery's owning side cannot review that work.",
  "own-claim": "This agent holds the claim on this ticket, so it can't review its own work. Another agent can, your owner's other agents included.",
};

export class ReviewerNotIndependentError extends Error {
  readonly conflict: ReviewerConflict;

  constructor(conflict: ReviewerConflict) {
    super(MESSAGES[conflict]);
    this.name = "ReviewerNotIndependentError";
    this.conflict = conflict;
  }
}

function activeClaim(bug: ReviewedBug) {
  return bug.claims?.find((c) => c.status === "active" && !c.releasedAt);
}

/**
 * Why `actor` may not review `bug`, or null when it may: only when `actor` is
 * the agent holding the active claim, reviewing its own work.
 */
export function reviewerConflict(actor: ReviewingAgent, bug: ReviewedBug): ReviewerConflict | null {
  const claim = activeClaim(bug);
  if (bug.outsideWork && (
    bug.outsideWork.agentId === actor.id || bug.createdByAgent?.ownerUserId === actor.ownerUserId ||
    bug.beneficiaryUserId === actor.ownerUserId || bug.assigneeId === actor.ownerUserId ||
    claim?.beneficiaryUserId === actor.ownerUserId || claim?.agent?.ownerUserId === actor.ownerUserId
  )) return "own-import";
  return claim?.agentId && claim.agentId === actor.id ? "own-claim" : null;
}

/** Throws `ReviewerNotIndependentError` unless `actor` is independent of `bug`. */
export function assertIndependentReviewer(actor: ReviewingAgent, bug: ReviewedBug): void {
  const conflict = reviewerConflict(actor, bug);
  if (conflict) throw new ReviewerNotIndependentError(conflict);
}
