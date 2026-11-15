import type { Substatus } from "@prisma/client";

/** Shared card shell for the issue detail redesign. */
export const issueCardClass =
  "rounded-[20px] border border-zk-border bg-zk-surface p-5 sm:p-6";

export const issueRailCardClass =
  "rounded-[20px] border border-zk-border bg-zk-surface p-5";

export const issueSectionLabelClass =
  "text-xs font-bold uppercase tracking-[0.08em] text-zk-muted";

export const issueAccentLinkClass =
  "font-semibold text-zk-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-electric-blue-strong focus-visible:ring-offset-2";

/** Status language from the redesign handoff (overrides shared label classes). */
export const issueStatusChipClass: Record<Substatus, string> = {
  requires_confirmation: "bg-zk-warn-bg text-zk-warn-fg",
  open: "bg-zk-info-bg text-zk-info-fg",
  plan_review: "bg-zk-warn-bg text-zk-warn-fg",
  in_progress: "bg-zk-info-bg text-zk-info-fg",
  requires_review: "bg-zk-info-bg text-zk-info-fg",
  accepted: "bg-zk-info-bg text-zk-info-fg",
  ready_to_merge: "bg-zk-ok-bg text-zk-ok-fg",
  error: "bg-zk-bad-bg text-zk-bad-fg",
  on_dev: "bg-zk-ok-bg text-zk-ok-fg",
  on_staging: "bg-zk-ok-bg text-zk-ok-fg",
  on_prod: "bg-zk-ok-bg text-zk-ok-fg",
  published: "bg-zk-ok-bg text-zk-ok-fg",
  force_merged: "bg-zk-warn-bg text-zk-warn-fg",
  merged_broken: "bg-zk-bad-bg text-zk-bad-fg",
  closed: "bg-zk-chip text-zk-text2",
};

export const issueChipBaseClass =
  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold";
