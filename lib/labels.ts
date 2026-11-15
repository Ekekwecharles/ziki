import type { Status, Substatus } from "@prisma/client";
import { STATUS_OF, SUBSTATUSES } from "@/lib/issue-substatus";

/** Main statuses (#substatus): the issue list's tabs. */
export const statusLabel: Record<Status, string> = {
  open: "Open",
  in_progress: "In progress",
  done: "Done",
  merge: "Merge",
  resolved: "Live",
  closed: "Closed",
};

export const statusLabels = statusLabel;

export const substatusLabel: Record<Substatus, string> = {
  requires_confirmation: "Requires confirmation",
  open: "Open",
  plan_review: "Plan review",
  in_progress: "In progress",
  requires_review: "Requires review",
  accepted: "Accepted",
  ready_to_merge: "Ready to merge",
  error: "Error",
  on_dev: "On dev",
  on_staging: "On staging",
  on_prod: "On prod",
  published: "Published",
  force_merged: "Force-merged",
  merged_broken: "Broken",
  closed: "Closed",
};

/**
 * An issue's status as one label: "Open · Requires confirmation", or just the
 * main status where it has a single substatus ("Closed"). In progress reads
 * as "In progress" at its own step, as it did before plan review added
 * "In progress · Plan review" beside it (#plan-review); "In progress · In
 * progress" says nothing twice.
 */
export function stateLabel(substatus: Substatus): string {
  const status = STATUS_OF[substatus];
  if (substatus === "in_progress") return statusLabel[status];
  return SUBSTATUSES[status].length > 1 ? `${statusLabel[status]} · ${substatusLabel[substatus]}` : statusLabel[status];
}

export const statusClass: Record<Status, string> = {
  open: "bg-sky-100 text-sky-950",
  in_progress: "bg-violet-100 text-violet-950",
  done: "bg-indigo-100 text-indigo-950",
  merge: "bg-teal-100 text-teal-950",
  resolved: "bg-emerald-100 text-emerald-950",
  closed: "bg-zinc-100 text-zinc-800",
};

/** A substatus's badge colour: its main status's, with the steps that wait on someone picked out. */
export const substatusClass: Record<Substatus, string> = {
  requires_confirmation: "bg-amber-100 text-amber-950",
  open: statusClass.open,
  plan_review: "bg-amber-100 text-amber-950",
  in_progress: statusClass.in_progress,
  requires_review: "bg-purple-100 text-purple-950",
  accepted: statusClass.done,
  ready_to_merge: statusClass.merge,
  error: "bg-rose-100 text-rose-950",
  on_dev: statusClass.resolved,
  on_staging: statusClass.resolved,
  on_prod: statusClass.resolved,
  published: statusClass.resolved,
  force_merged: "bg-amber-100 text-amber-950",
  merged_broken: "bg-rose-100 text-rose-950",
  closed: statusClass.closed,
};

/** Marks the bug's reporter wherever their name appears on the bug page. */
export const authorBadgeClass = "bg-teal-100 text-teal-950";
