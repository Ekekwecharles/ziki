import type { Substatus } from "@prisma/client";
import { isOrganisationAdmin, type OrganisationRole } from "@/lib/organisation-role";
import type { AppRole } from "@/lib/roles";

/**
 * "Take it back" (#851): an organisation owner or admin undoes a merged issue.
 * This file holds the rules, with no database or network, so both the page and
 * the server action answer the same way and the tests can pin them down.
 *
 * The limit is a product rule: an owner may request a revert within 30 days of
 * the merge. Later work has usually been built on top of it, and a revert then
 * risks more than it repairs. After that the issue stays merged.
 */
export const TAKE_IT_BACK_DAYS = 30;
export const TAKE_IT_BACK_REASON_MIN = 10;
export const TAKE_IT_BACK_REASON_MAX = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The activity metadata field that records a request on the original issue. */
export const TAKE_IT_BACK_FIELD = "take_it_back";
/** The activity metadata field that links the revert issue back to the original. */
export const REVERT_OF_FIELD = "revert_of";

export type ExistingRevert = {
  id: string;
  number: number;
  status: string;
  substatus: string;
};

/** What the issue page passes to the client panel. */
export type TakeItBackView = {
  state: "available" | "too_old" | "already_requested";
  issueId: string;
  issueNumber: number;
  title: string;
  mergedAt: string | null;
  endsAt: string | null;
  pullRequestUrl: string | null;
  filesUrl: string | null;
  mergeCommitSha: string | null;
  mergedInto: string | null;
  existing: { number: number; message: string } | null;
};

export type TakeItBackState =
  | { kind: "available" }
  | { kind: "not_allowed" }
  | { kind: "not_merged" }
  | { kind: "too_old"; endsAt: Date }
  | { kind: "already_requested"; revert: ExistingRevert; message: string };

export function takeItBackWindowEndsAt(mergedAt: Date): Date {
  return new Date(mergedAt.getTime() + TAKE_IT_BACK_DAYS * DAY_MS);
}

/** Whether this issue may be taken back by this viewer right now. */
export function takeItBackState(input: {
  status: string;
  isDeleted?: boolean;
  membershipRole?: OrganisationRole | null;
  appRole?: AppRole | null;
  mergedAt: Date | null;
  existing?: ExistingRevert | null;
  now?: Date;
}): TakeItBackState {
  if (input.isDeleted || input.status !== "resolved") return { kind: "not_merged" };
  if (!isOrganisationAdmin(input.membershipRole, input.appRole)) return { kind: "not_allowed" };
  // A request that exists always shows first: it is the answer to "what happened?".
  if (input.existing) {
    return { kind: "already_requested", revert: input.existing, message: revertMessage(input.existing) };
  }
  if (!input.mergedAt) return { kind: "available" };
  const now = input.now ?? new Date();
  if (now.getTime() - input.mergedAt.getTime() > TAKE_IT_BACK_DAYS * DAY_MS) {
    return { kind: "too_old", endsAt: takeItBackWindowEndsAt(input.mergedAt) };
  }
  return { kind: "available" };
}

/** Why a revert issue is not the same as a fresh fix: it undoes code only. */
export function takeItBackReasonError(reason: string): string | null {
  const trimmed = reason.trim();
  if (!trimmed) return "Say why this merged change should be taken back.";
  if (trimmed.length < TAKE_IT_BACK_REASON_MIN) {
    return `Give a little more detail (at least ${TAKE_IT_BACK_REASON_MIN} characters).`;
  }
  if (trimmed.length > TAKE_IT_BACK_REASON_MAX) {
    return `Keep the reason under ${TAKE_IT_BACK_REASON_MAX} characters.`;
  }
  return null;
}

/** The revert issue is a normal issue, so it needs a normal title. */
export function revertTitle(originalNumber: number, originalTitle: string): string {
  const prefix = `Revert #${originalNumber}: `;
  return `${prefix}${originalTitle}`.slice(0, 200);
}

/** A short, plain description an agent can act on without opening Ziki. */
export function revertDescription(input: {
  originalNumber: number;
  originalTitle: string;
  reason: string;
  requestedBy: string;
  pullRequestUrl: string | null;
  mergedInto: string | null;
  mergeCommitSha: string | null;
}): string {
  const lines = [
    `Take it back for #${input.originalNumber}: ${input.originalTitle}`,
    "",
    `**Why:** ${input.reason}`,
    "",
    "Undo the code that was merged for this issue. Code only: data saved after the merge is not changed.",
    "When this revert merges, the original issue returns to Open with the reason above.",
  ];
  if (input.pullRequestUrl) lines.push("", `**Merged pull request:** ${input.pullRequestUrl}`);
  if (input.mergedInto) lines.push(`**Merged into:** \`${input.mergedInto}\``);
  if (input.mergeCommitSha) lines.push(`**Merge commit:** \`${input.mergeCommitSha}\``);
  lines.push("", `Requested by ${input.requestedBy}.`);
  return lines.join("\n");
}

const REVERT_LABELS: Record<string, string> = {
  requires_confirmation: "waiting for confirmation",
  open: "open for bids",
  in_progress: "in progress",
  requires_review: "waiting for judgements",
  accepted: "waiting for a manager's review",
  ready_to_merge: "ready to merge",
  error: "in Merge · Error, so its pull request cannot merge yet",
  on_dev: "merged on dev",
  on_staging: "merged on staging",
  on_prod: "merged on prod",
  force_merged: "force-merged",
  merged_broken: "force-merged and judged broken",
  closed: "closed",
};

/** What to tell the owner about the revert they already asked for. */
export function revertMessage(revert: ExistingRevert): string {
  if (revert.status === "closed") {
    return `Revert issue #${revert.number} was closed without merging, so this issue is still live. Requesting it again is allowed.`;
  }
  if (revert.status === "resolved") {
    return `Revert issue #${revert.number} has merged. If this issue is still live, its reopen did not finish.`;
  }
  const label = REVERT_LABELS[revert.substatus] ?? REVERT_LABELS[revert.status] ?? revert.status;
  return `Revert issue #${revert.number} is ${label}.`;
}

/**
 * The state the original issue moves to when the revert merges. A revert of
 * something already open changes nothing.
 */
export function reopenedFromRevert(input: {
  status: string;
  isDeleted?: boolean;
}): { status: "open"; substatus: Substatus } | null {
  if (input.isDeleted || input.status !== "resolved") return null;
  return { status: "open", substatus: "open" };
}
