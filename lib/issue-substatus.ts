import type { Status, Substatus } from "@prisma/client";

/**
 * Main statuses and substatuses (#substatus). An issue has one main status
 * (`Bug.status`, the issue list's tabs) and one substatus within it
 * (`Bug.substatus`, the step it is at). The two always move together:
 * every write goes through `moveTo`, so `status` is always `STATUS_OF[substatus]`.
 *
 * - Open: Requires confirmation → Open (waiting for bids)
 * - In progress: Plan review (a complex issue's awarded agent writes its plan
 *   and its owner approves it, #plan-review) → In progress
 * - Done: Requires review (delivered, being judged) → Accepted (judged good to merge)
 * - Merge: Ready to merge, or Error (the latest pull request report says it can't merge)
 * - Live (`resolved`): On dev → On staging → On prod (where agents report it is deployed), or Published (marketing work a manager accepted),
 *   or Force-merged (merged by the local coder outside Ziki's checks, judged afterwards, #force-merge) and Broken (judged faulty after a force-merge: takes bids for a fix)
 * - Closed
 */
export const STATUS_OF = {
  requires_confirmation: "open",
  open: "open",
  plan_review: "in_progress",
  in_progress: "in_progress",
  requires_review: "done",
  accepted: "done",
  ready_to_merge: "merge",
  error: "merge",
  on_dev: "resolved",
  on_staging: "resolved",
  on_prod: "resolved",
  published: "resolved",
  force_merged: "resolved",
  merged_broken: "resolved",
  closed: "closed",
} as const satisfies Record<Substatus, Status>;

/** Each main status's substatuses, in pipeline order. */
export const SUBSTATUSES: Record<Status, readonly Substatus[]> = {
  open: ["requires_confirmation", "open"],
  in_progress: ["plan_review", "in_progress"],
  done: ["requires_review", "accepted"],
  merge: ["ready_to_merge", "error"],
  resolved: ["on_dev", "on_staging", "on_prod", "published", "force_merged", "merged_broken"],
  closed: ["closed"],
};

/**
 * Where an issue takes bids and awards (#open-award): Open, while it awaits
 * confirmation too, and Live · Broken, merged but faulty after a force-merge
 * (#force-merge), so someone fixes it.
 */
export const BIDDING_SUBSTATUSES: readonly Substatus[] = ["requires_confirmation", "open", "merged_broken"];

/** Where an award can be accepted and the work started: confirmed and open, or Live · Broken. */
export const AWARDABLE_SUBSTATUSES: readonly Substatus[] = ["open", "merged_broken"];

export function takesBids(substatus: Substatus): boolean {
  return BIDDING_SUBSTATUSES.includes(substatus);
}

/** The data that moves an issue to `substatus`: both columns, set together. */
export function moveTo<S extends Substatus>(substatus: S): { status: (typeof STATUS_OF)[S]; substatus: S } {
  return { status: STATUS_OF[substatus], substatus };
}

/**
 * Where a main status starts: the substatus an issue gets when it is moved to
 * that main status as a whole (a person closing or reopening it in the app).
 * Live starts On dev: merged into the default branch, until agents report a
 * deployment (POST /api/v1/issues/{id}/deployment).
 */
export const ENTRY_SUBSTATUS: Record<Status, Substatus> = {
  open: "open",
  in_progress: "in_progress",
  done: "requires_review",
  merge: "ready_to_merge",
  resolved: "on_dev",
  closed: "closed",
};

/** The deployment environments a Live issue's substatus names. */
export const ENVIRONMENTS = ["dev", "staging", "prod"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export const LIVE_SUBSTATUS: Record<Environment, Substatus> = { dev: "on_dev", staging: "on_staging", prod: "on_prod" };
