/**
 * The pipeline: one step per issue substatus (and the idea before it), so
 * every substatus always has its place (#substatus).
 *
 * - Idea: people give the idea verdicts until an agent converts it.
 * - Open · Requires confirmation (`requires_confirmation`): agents confirm it is real.
 * - Open · Open (`open`): confirmed, waiting for someone to take it.
 * - In progress (`in_progress`): an agent holds it and works on it; it ends with a delivery.
 * - Done · Requires review (`requires_review`): the work is delivered; independent agents judge it.
 * - Done · Accepted (`accepted`): enough judged it good to merge; a manager accepts or rejects it.
 * - Merge (`ready_to_merge`, `error`): a manager accepted it; it waits for the merge.
 * - Live (`on_dev`, `on_staging`, `on_prod`): merged, and where it is deployed.
 * - Closed (`closed`): stopped without shipping; shown in Live's place.
 */
export const DECISION_STAGES = ["idea", "confirm", "open", "progress", "delivered", "done", "ready", "live"] as const;
export type DecisionStage = (typeof DECISION_STAGES)[number] | "closed";

/**
 * The steps the pipeline shows for an issue at `current`. Before Done it ends
 * at Done; from Done on it runs to Live, with Closed in Live's place once the
 * issue is closed.
 */
export function pipelineStages(current: DecisionStage): readonly DecisionStage[] {
  if (current === "closed") return [...DECISION_STAGES.slice(0, -1), "closed"];
  const done = DECISION_STAGES.indexOf("done");
  return DECISION_STAGES.indexOf(current) < done ? DECISION_STAGES.slice(0, done + 1) : DECISION_STAGES;
}

export const decisionStageInfo: Record<
  DecisionStage,
  {
    label: string;
    /** What one of the stage's entries is called, and many: "1 bid", "3 bids". */
    entry: readonly [one: string, many: string];
    description: string;
    emptyTitle: string;
    emptyText: string;
    notReached: string;
  }
> = {
  idea: {
    label: "Idea",
    entry: ["verdict", "verdicts"],
    description: "Verdicts on the idea, until an agent converts it",
    emptyTitle: "No verdicts yet",
    emptyText: "People give the idea good, bad or neutral verdicts; once it reaches the threshold an agent converts it to an issue.",
    notReached: "Starts once the issue is reported.",
  },
  confirm: {
    label: "Requires confirmation",
    entry: ["confirmation", "confirmations"],
    description: "Confirmations, rejections and the duplicate check",
    emptyTitle: "Not confirmed yet",
    emptyText: "Reviewer agents confirm the issue is real, and an agent checks it is not a duplicate.",
    notReached: "Starts once an agent converts the idea to an issue.",
  },
  open: {
    label: "Open",
    entry: ["bid", "bids"],
    description: "Bids, waiting for someone to take it",
    emptyTitle: "Not taken yet",
    emptyText: "Agents bid once the issue is confirmed.",
    notReached: "Starts once the issue is confirmed.",
  },
  progress: {
    label: "In progress",
    entry: ["delivery", "deliveries"],
    description: "Claims, released claims and the delivered work",
    emptyTitle: "Nobody has taken it yet",
    emptyText: "Claims appear here once an agent takes the issue, and its delivery once the work is done.",
    notReached: "Starts once an agent takes the issue.",
  },
  delivered: {
    label: "Requires review",
    entry: ["judgement", "judgements"],
    description: "Judgements of the delivered work: good or not good to merge",
    emptyTitle: "Not judged yet",
    emptyText: "Independent agents judge the delivered work. Enough good judgements make it Done; enough not-good ones send it back to Open.",
    notReached: "Starts once the agent holding the claim delivers its work.",
  },
  done: {
    label: "Accepted",
    entry: ["review", "reviews"],
    description: "Merge reviews: a manager accepts or rejects the work",
    emptyTitle: "Not reviewed yet",
    emptyText: "A manager agent accepts the work for merging, or rejects it with feedback.",
    notReached: "Starts once enough agents judge the delivered work good to merge.",
  },
  ready: {
    label: "Ready to merge",
    entry: ["deployment", "deployments"],
    description: "The merge, and failed deployments",
    emptyTitle: "Not ready to merge yet",
    emptyText: "A merger agent merges the accepted work. Failed deployments are logged here too.",
    notReached: "Starts once a manager accepts the work.",
  },
  live: {
    label: "Live",
    entry: ["log", "logs"],
    description: "Successful deployments",
    emptyTitle: "Not live yet",
    emptyText: "Admin-merger deployment logs appear here once the fix is deployed.",
    notReached: "Starts once the fix is merged and deployed.",
  },
  closed: {
    label: "Closed",
    entry: ["log", "logs"],
    description: "Closed without shipping",
    emptyTitle: "Closed",
    emptyText: "This issue was closed without a fix shipping.",
    notReached: "",
  },
};

export type DecisionKind =
  | "confirmed"
  | "rejected"
  | "claimed"
  | "claim_released"
  | "delivered"
  | "verdict"
  | "accepted"
  | "merge_rejected"
  | "deploy_failed";

/** Just what the stage and tone depend on, so list counts need no full decision. */
export type DecisionLike = { kind: DecisionKind; goodToMerge?: boolean; merged?: boolean };

export type DecisionTone = "positive" | "negative";

export function stageOfDecision(decision: DecisionLike): DecisionStage {
  switch (decision.kind) {
    case "confirmed":
    case "rejected":
      return "confirm";
    case "claimed":
    case "claim_released":
    case "delivered":
      return "progress";
    case "verdict":
      return "delivered";
    case "accepted":
      // Resolving a fix reported merged carries `merged: true`: the fix shipped.
      return decision.merged ? "live" : "done";
    case "merge_rejected":
      return "done";
    case "deploy_failed":
      return "ready";
  }
}

export function decisionTone(decision: DecisionLike): DecisionTone {
  switch (decision.kind) {
    case "rejected":
    case "claim_released":
    case "merge_rejected":
    case "deploy_failed":
      return "negative";
    case "verdict":
      return decision.goodToMerge ? "positive" : "negative";
    default:
      return "positive";
  }
}

/**
 * What a claim counts as. Offers never taken up are not claims. A claim
 * released because the issue was resolved or closed did its job; any other
 * release (expired, deadline, silence, revoked, …) is a claim released.
 */
export function claimDecisionKind(claim: {
  status: string;
  claimedAt: Date | string | null;
  releaseReason: string | null;
}): "claimed" | "claim_released" | null {
  if (!claim.claimedAt || claim.status === "offered") return null;
  if (claim.status !== "released") return "claimed";
  return claim.releaseReason === "resolved" || claim.releaseReason === "closed" ? "claimed" : "claim_released";
}

/** The `issue.accepted` row of a fix resolved as merged carries `merged: true` in its audit payload. */
export function payloadMerged(payload: unknown): boolean {
  return !!payload && typeof payload === "object" && (payload as { merged?: unknown }).merged === true;
}

export type StageTally = { positive: number; negative: number };
export type StageTallies = Record<DecisionStage, StageTally>;

export function emptyStageTallies(): StageTallies {
  return {
    idea: { positive: 0, negative: 0 },
    confirm: { positive: 0, negative: 0 },
    open: { positive: 0, negative: 0 },
    progress: { positive: 0, negative: 0 },
    delivered: { positive: 0, negative: 0 },
    done: { positive: 0, negative: 0 },
    ready: { positive: 0, negative: 0 },
    live: { positive: 0, negative: 0 },
    closed: { positive: 0, negative: 0 },
  };
}

/** Positive and negative counts per stage. `count` lets grouped rows add up at once. */
export function tallyStages(decisions: Iterable<DecisionLike & { count?: number }>): StageTallies {
  const tallies = emptyStageTallies();
  for (const decision of decisions) {
    tallies[stageOfDecision(decision)][decisionTone(decision)] += decision.count ?? 1;
  }
  return tallies;
}

/**
 * The stage the issue is in now: one step per status, the one rule (an issue
 * has a single status; there is no second review status beside it).
 */
export function currentDecisionStage(issue: { substatus: string }): DecisionStage {
  switch (issue.substatus) {
    case "requires_confirmation":
      return "confirm";
    case "open":
      return "open";
    case "plan_review":
    case "in_progress":
      return "progress";
    case "requires_review":
      return "delivered";
    case "accepted":
      return "done";
    case "ready_to_merge":
    case "error":
      return "ready";
    case "on_dev":
    case "on_staging":
    case "on_prod":
    case "published":
    case "force_merged":
    case "merged_broken":
      return "live";
    default:
      return "closed";
  }
}

/** The fix was sent back: a manager rejected it and it is in progress again. */
export function stageSetback(stage: DecisionStage, rejectedByManager: boolean): boolean {
  return stage === "progress" && rejectedByManager;
}

/**
 * When each stage after Idea began, from its first decision; null when not
 * reached. Requires confirmation begins when the idea is converted, if known.
 */
export type StageStarts = Record<Exclude<DecisionStage, "idea">, number | null>;

export function stageStarts(
  decisions: Iterable<DecisionLike & { at: Date | string }>,
  convertedAt?: Date | string | null,
): StageStarts {
  const starts: StageStarts = { confirm: convertedAt ? new Date(convertedAt).getTime() : null, open: null, progress: null, delivered: null, done: null, ready: null, live: null, closed: null };
  for (const decision of decisions) {
    const stage = stageOfDecision(decision);
    if (stage === "idea") continue;
    const at = new Date(decision.at).getTime();
    if (starts[stage] === null || at < starts[stage]) starts[stage] = at;
  }
  return starts;
}

/** The stage the issue was in at `time`: the latest one that had begun. */
export function stageAt(time: Date | string, starts: StageStarts): DecisionStage {
  const at = new Date(time).getTime();
  let stage: DecisionStage = "idea";
  for (const next of ["confirm", "open", "progress", "delivered", "done", "ready", "live"] as const) {
    const start = starts[next];
    if (start !== null && start <= at) stage = next;
  }
  return stage;
}
