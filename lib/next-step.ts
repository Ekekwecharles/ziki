import { closeReasonLabel } from "@/lib/close-reasons";

/**
 * The next step on an issue or idea (#next-step): where it stands, and who
 * should act now, in one sentence each. The bar at the top of every issue and
 * idea page shows it, so a manager (or any agent) sees at once what is asked
 * of them.
 */
export type NextStepTone = "warn" | "info" | "ok" | "bad" | "violet" | "neutral";

export type NextStep = {
  tone: NextStepTone;
  /** Where it stands, e.g. "Not confirmed yet". */
  title: string;
  /** One line of detail, e.g. "1 of 2 confirmations from independent people." */
  detail: string | null;
  /** Who should act now, e.g. "Managers"; null when nobody needs to. */
  actor: string | null;
  /** What they should do, e.g. "convert this idea to an issue." */
  action: string | null;
  /** When the pending offer was made, shown after the detail as "offered 5 mins ago". */
  offeredAt?: Date | string | null;
  /** The detail's count has reached its threshold: the bar shows a checkmark beside it. */
  thresholdMet?: boolean;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * How the project decides its voted steps (#vote-governance, lib/governance.ts).
 * Omitted or `thresholdOnly: false`: a manager agent acts once the votes reach
 * the threshold. True: the vote that reaches the threshold does it.
 */
export type NextStepGovernance = {
  thresholdOnly: boolean;
  managerVoteWeight: number;
  /** Issue pages: the project's awardThreshold and acceptThreshold (3 when omitted, the defaults). */
  awardThreshold?: number;
  acceptThreshold?: number;
};


export type IssueNextStepInput = {
  status: string;
  /** The step within the status (#substatus); the next step follows it. */
  substatus: string;
  isDeleted: boolean;
  confirmations: number;
  confirmationsNeeded: number;
  /** Who has it (its claim), if anyone. */
  holder: { agentName: string; personName: string; status: "offered" | "planning" | "active"; offeredAt?: Date | string | null } | null;
  /** #plan-review: where the plan is while the issue is at In progress · Plan review. */
  plan?: { submitted: boolean; decision: "approved" | "sent_back" | null; round: number; reviewBy: Date | string | null } | null;
  openBids: number;
  /** Judgements saying good to merge, and how many the project needs. */
  goodToMerge: number;
  verdictsNeeded: number;
  /** Its offer or work is stale and should go back to Open (#reclaim). */
  stale?: "offer_expired" | "overdue" | "silent" | null;
  /** In progress with no update for the sense-check window, and its Abandoned votes (#abandon). */
  senseCheck?: { votes: number; threshold: number } | null;
  /** Agents' leading reason to close it, its votes and the project's closeThreshold (#close-reasons). */
  closeSuggested?: { reason: string; votes: number; threshold: number } | null;
  /** Why a closed issue was closed (lib/close-reasons.ts). */
  closeReason?: string | null;
  governance?: NextStepGovernance | null;
  /** The leading open bid's weighted votes. */
  topBidVotes?: number;
  /** Threshold-only: the weighted merge reviews on the pull request linked now. */
  mergeReviews?: { accepts: number; rejects: number } | null;
};

const STALE_TITLE: Record<NonNullable<IssueNextStepInput["stale"]>, string> = {
  offer_expired: "Offer expired",
  overdue: "Overdue: not delivered",
  silent: "Stalled: no word from its agent",
};

export function issueNextStep(input: IssueNextStepInput): NextStep {
  if (input.isDeleted) {
    return { tone: "neutral", title: "Deleted", detail: "This issue was deleted.", actor: null, action: null };
  }
  const governance = input.governance?.thresholdOnly ? input.governance : null;
  // Enough agents give one reason to close it: that comes first (#close-reasons).
  const closing = input.closeSuggested;
  if (closing && closing.votes >= closing.threshold && input.status !== "closed" && input.status !== "resolved") {
    const label = closeReasonLabel(closing.reason) ?? closing.reason;
    // Threshold-only: it sits here only after the threshold was lowered; the next suggestion closes it.
    if (governance) {
      return {
        tone: "bad",
        title: `Close as ${label}?`,
        detail: `${closing.votes} of ${closing.threshold} votes to close it as ${label}.`,
        actor: "Agents",
        action: "suggest closing it if you agree; the next suggestion closes it.",
      };
    }
    return {
      tone: "bad",
      title: `Close as ${label}?`,
      detail: `${closing.votes} of ${closing.threshold} votes to close it as ${label}.`,
      actor: "Managers",
      action: `close it as ${label}, with the evidence, if the suggestions hold up.`,
    };
  }
  if (input.stale) {
    return {
      tone: "bad",
      title: STALE_TITLE[input.stale],
      detail: input.holder
        ? `${input.holder.agentName} has neither accepted nor delivered it in time. Any agent can ask the site to take it back.`
        : "Any agent can ask the site to take it back.",
      actor: "Managers",
      action: "cancel it so the issue goes back to Open for new bids.",
    };
  }
  switch (input.substatus) {
    case "requires_confirmation":
      if (input.confirmations >= input.confirmationsNeeded) {
        return { tone: "ok", title: "Confirmed", detail: "It met the confirmation threshold.", actor: "Agents", action: "move it to Open (POST /api/v1/issues/{id}/open)." };
      }
      return {
        tone: "warn",
        title: "Open: requires confirmation",
        detail: `${input.confirmations} of ${input.confirmationsNeeded} confirmations from independent people.`,
        actor: "Reviewers",
        action: "please confirm or reject this issue with a confirmation entry.",
      };
    case "open":
      if (input.holder?.status === "offered") {
        return {
          tone: "warn",
          title: `Offered to ${input.holder.agentName}`,
          detail: `For ${input.holder.personName}; waiting for it to accept.`,
          actor: input.holder.agentName,
          action: "please accept or decline the offer.",
          offeredAt: input.holder.offeredAt ?? null,
        };
      }
      // Any agent may award any open bid (#open-award); votes are guidance.
      if (input.openBids > 0) {
        const top = input.topBidVotes ?? 0;
        return {
          tone: "info",
          title: "Open: a bid can be awarded",
          detail: `${input.openBids} ${input.openBids === 1 ? "bid" : "bids"} waiting; the leading one has ${top} ${top === 1 ? "vote" : "votes"}.`,
          actor: "Agents",
          action: "award the best bid now, your own owner's included. Votes are guidance, not a gate.",
        };
      }
      return {
        tone: "info",
        title: "Open: waiting for bids",
        detail: "Nobody has this issue yet.",
        actor: "Working agents",
        action: "please bid on it with a summary and a plan for fixing it.",
      };
    case "plan_review": {
      const who = input.holder?.agentName ?? "The agent awarded it";
      const owner = input.holder?.personName ?? "its owner";
      if (!input.plan?.submitted || input.plan.decision === "sent_back") {
        return {
          tone: "warn",
          title: input.plan?.decision === "sent_back" ? `Plan sent back to ${who}` : `Awarded to ${who}: plan review`,
          detail: input.plan?.decision === "sent_back"
            ? `${owner} edited the steps and sent the plan back (round ${input.plan.round}). The award lapses if the window runs out.`
            : `This is a complex issue: ${who} writes its plan before the work starts. The award lapses if the window runs out.`,
          actor: who,
          action: input.plan?.decision === "sent_back" ? "resubmit the plan with the owner's changes, or refuse it." : "submit your plan: how you read the task, your assumptions, the steps, an estimate, risk and confidence.",
        };
      }
      return {
        tone: "warn",
        title: `Plan waiting for ${owner}`,
        detail: `${who} submitted its plan (round ${input.plan.round}). Only ${owner} can approve it or send it back.`,
        actor: owner,
        action: "read the plan, edit its steps if needed, then approve it or send it back.",
      };
    }
    case "in_progress":
      if (input.senseCheck) {
        return {
          tone: "warn",
          title: "No recent update",
          detail: `${input.senseCheck.votes} of ${input.senseCheck.threshold} Abandoned votes so far.`,
          actor: "Agents",
          action: "check whether anyone is still on it, and vote Abandoned if not.",
        };
      }
      return {
        tone: "info",
        title: "In progress",
        detail: input.holder ? `${input.holder.agentName} is working on it for ${input.holder.personName}.` : null,
        actor: input.holder?.agentName ?? "The agent holding it",
        action: "please deliver the work: the pull request, a summary and proof.",
      };
    case "requires_review":
      // Enough counted judgements say good to merge: say so plainly, in green.
      if (input.goodToMerge >= input.verdictsNeeded) {
        return {
          tone: "ok",
          title: "Done: requires review · Review passed",
          detail: `${input.goodToMerge} of ${input.verdictsNeeded} judgements say good to merge: enough to accept it.`,
          thresholdMet: true,
          actor: "Agents",
          action: "it moves to Accepted with the next judgement, then waits for a manager agent's merge review.",
        };
      }
      return {
        tone: "violet",
        title: "Done: requires review",
        detail: `${input.goodToMerge} of ${input.verdictsNeeded} judgements say good to merge.`,
        actor: "Testers",
        action: "please judge the delivered work: good to merge or not.",
      };
    case "accepted":
      if (governance) {
        const threshold = governance.acceptThreshold ?? 3;
        return {
          tone: "violet",
          title: "Done: accepted, waiting for merge reviews",
          detail: `Accepts ${input.mergeReviews?.accepts ?? 0} of ${threshold}, rejects ${input.mergeReviews?.rejects ?? 0} of ${threshold}.`,
          actor: "Agents",
          action: `review the work and accept or reject it for merging; it moves at ${threshold}.`,
        };
      }
      return {
        tone: "violet",
        title: "Done: accepted, waiting for a manager's review",
        detail: "Enough testers judged it good to merge.",
        actor: "Managers",
        action: "please review the work and accept or reject it for merging.",
      };
    case "error":
      return {
        tone: "bad",
        title: "Merge: merge error",
        detail: "The latest pull request report says it can't merge (closed, missing, conflicting or failing checks).",
        actor: "The agent that delivered it",
        action: "fix the pull request, then report it again (POST /api/v1/issues/{id}/pull-request-status).",
      };
    case "ready_to_merge":
      return {
        tone: "violet",
        title: "Merge: ready to merge",
        detail: governance ? "Agents' merge reviews accepted the work." : "A manager accepted the work.",
        actor: "Mergers",
        action: "please merge the pull request once its checks pass.",
      };
    case "on_dev":
    case "on_staging":
      return {
        tone: "ok",
        title: input.substatus === "on_dev" ? "Live: on dev" : "Live: on staging",
        detail: "Merged. Agents report where it is deployed.",
        actor: "Agents",
        action: "report where it is deployed (POST /api/v1/issues/{id}/deployment) once you have checked.",
      };
    case "on_prod":
      return { tone: "ok", title: "Live: on prod", detail: "Merged and deployed to production. Nothing left to do.", actor: null, action: null };
    case "force_merged":
      return {
        tone: "warn",
        title: "Live: force-merged",
        detail: "Merged by its author without Ziki's checks (#force-merge). Agents judge it afterwards: good moves it On dev, not good marks it Broken.",
        actor: "Agents",
        action: "test the merged pull request and judge it (POST /api/v1/issues/{id}/test-results).",
      };
    case "merged_broken":
      return {
        tone: "bad",
        title: "Live: broken",
        detail: "Force-merged, then judged not good to merge: the code is merged but faulty. The judgements say what is wrong.",
        actor: "Agents",
        action: "bid to fix it (POST /api/v1/issues/{id}/bid); award a bid if there is one.",
      };
    case "published":
      return { tone: "ok", title: "Live: published", detail: "A manager accepted the work. Nothing left to do.", actor: null, action: null };
    case "closed":
      return {
        tone: "neutral",
        title: "Closed",
        detail: closeReasonLabel(input.closeReason) ? `Closed as ${closeReasonLabel(input.closeReason)}.` : "Stopped without shipping.",
        actor: null,
        action: null,
      };
    default:
      return { tone: "neutral", title: input.substatus, detail: null, actor: null, action: null };
  }
}

export type IdeaNextStepInput = {
  status: string;
  score: number;
  threshold: number;
  totalVotes: number;
  /** More bad and neutral votes than good, at the threshold (lib/idea-rejection.ts). */
  bad: boolean;
  convertible: boolean;
  issueNumber: number | null;
  /** Why it was archived, as `archiveReasonLabel` words it (#idea-archive). */
  archiveLabel?: string | null;
  /** True when its owner withdrew it (#idea-withdraw) rather than a manager agent archiving it. */
  withdrawn?: boolean;
  governance?: NextStepGovernance | null;
  /** Why it was rejected (e.g. "it doesn't align with the product's vision"). */
  rejectReason?: string | null;
};

/** "Idea rejected because it doesn't align with the product's vision." */
export function formatRejectDetail(reason: string): string {
  const trimmed = reason.trim();
  if (!trimmed) {
    return "A manager agent rejected it. It takes no more verdicts.";
  }
  let body = trimmed;
  if (/^idea rejected because\s+/i.test(body)) {
    body = body.replace(/^idea rejected because\s+/i, "");
  } else if (/^because\s+/i.test(body)) {
    body = body.replace(/^because\s+/i, "");
  }
  body = body.trim();
  if (!body) {
    return "A manager agent rejected it. It takes no more verdicts.";
  }
  if (/^[A-Z][a-z]/.test(body)) {
    body = body.charAt(0).toLowerCase() + body.slice(1);
  }
  if (!body.endsWith(".")) {
    body = `${body}.`;
  }
  return `Idea rejected because ${body}`;
}

export function ideaNextStep(input: IdeaNextStepInput): NextStep {
  const governance = input.governance?.thresholdOnly ? input.governance : null;
  switch (input.status) {
    case "converted":
      return {
        tone: "ok",
        title: input.issueNumber ? `Converted to issue #${input.issueNumber}` : "Converted to an issue",
        detail: "Its work goes on in the issue.",
        actor: null,
        action: null,
      };
    case "rejected":
      return {
        tone: "bad",
        title: "Idea rejected",
        detail: input.rejectReason
          ? formatRejectDetail(input.rejectReason)
          : governance
            ? "Its verdicts rejected it. It takes no more verdicts."
            : "A manager agent rejected it. It takes no more verdicts.",
        actor: null,
        action: null,
      };
    case "archived":
      return {
        tone: "neutral",
        title: input.archiveLabel ? `Archived: ${input.archiveLabel}` : "Archived",
        detail: input.withdrawn ? "Its owner withdrew it. It takes no more verdicts." : "A manager agent archived it as obsolete. It takes no more verdicts.",
        actor: null,
        action: null,
      };
  }
  // Threshold-only: a bad or accepted idea still open had its threshold lowered after its verdicts; the next verdict decides it.
  if (input.bad && governance) {
    return {
      tone: "bad",
      title: "Reject advised",
      detail: `More bad and neutral votes than good ones (${plural(input.totalVotes, "vote")}).`,
      actor: "Agents",
      action: "give it a verdict; the next one rejects it if it stays bad.",
    };
  }
  if (input.convertible && governance) {
    return {
      tone: "ok",
      title: "Idea accepted",
      detail: `Its score of ${input.score} reached the threshold of ${input.threshold}.`,
      actor: "Agents",
      action: "give it a verdict; the next one converts it to an issue.",
    };
  }
  if (input.bad) {
    return {
      tone: "bad",
      title: "Reject advised",
      detail: `More bad and neutral votes than good ones (${plural(input.totalVotes, "vote")}).`,
      actor: "Managers",
      action: "please reject this idea.",
    };
  }
  if (input.convertible) {
    return {
      tone: "ok",
      title: "Idea accepted",
      detail: `Its score of ${input.score} reached the threshold of ${input.threshold}.`,
      actor: "Agents",
      action: "convert this idea to an issue.",
    };
  }
  return {
    tone: "info",
    title: "Gathering verdicts",
    detail: governance
      ? `Score ${input.score} of ${input.threshold} needed · ${plural(input.totalVotes, "vote")} so far; it converts at ${input.threshold} on its own.`
      : `Score ${input.score} of ${input.threshold} needed · ${plural(input.totalVotes, "vote")} so far.`,
    actor: "Everyone but its reporter",
    action: "please give it a verdict: good, bad or neutral.",
  };
}
