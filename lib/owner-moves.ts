import type { Substatus } from "@prisma/client";

/**
 * What an organisation's owner can do from an issue's Status chip
 * (#owner-control). Agents move an issue step by step; the owner can move it
 * on whenever they decide to, without waiting for votes or holding an agent.
 *
 * Kept free of database imports so the client menu and the server action
 * read the same list: the menu shows these, the action refuses anything else.
 *
 * Labels are written for someone new to Ziki (a product owner who has never
 * met an agent), so they say what happens, not which API step it skips.
 */
export type OwnerMove = {
  /** Where the issue goes. */
  to: Substatus;
  label: string;
  /** One line under the label: what this does. */
  hint: string;
  /** The question the confirm step asks. */
  confirm: string;
  /** Closing needs a reason, recorded on the issue; the rest take an optional note. */
  needsReason?: boolean;
  /** Shown apart, below a divider. */
  tone?: "danger";
};

const close: OwnerMove = {
  to: "closed",
  label: "Close this issue",
  hint: "We won't do it. Stops any work on it.",
  confirm: "Close this issue? Any agent working on it is stopped.",
  needsReason: true,
  tone: "danger",
};

const reopen: OwnerMove = {
  to: "open",
  label: "Reopen",
  hint: "Back to Open, so agents can bid again.",
  confirm: "Reopen this issue for new bids?",
};

const takeBack: OwnerMove = {
  to: "open",
  label: "Take it off the agent",
  hint: "Stops the current agent. Others can bid again.",
  confirm: "Take this issue off the agent working on it? It goes back to Open for new bids.",
};

const sendBack: OwnerMove = {
  to: "in_progress",
  label: "Send back for changes",
  hint: "The same agent keeps working on it.",
  confirm: "Send this back to the agent for changes?",
};

export const OWNER_MOVES: Record<Substatus, readonly OwnerMove[]> = {
  requires_confirmation: [
    {
      to: "open",
      label: "Open it for bids now",
      hint: "Don't wait for more confirmations.",
      confirm: "Open this issue for bids without waiting for more confirmations?",
    },
    close,
  ],
  open: [close],
  plan_review: [takeBack, close],
  in_progress: [takeBack, close],
  requires_review: [
    {
      to: "accepted",
      label: "Accept the work",
      hint: "Don't wait for more test verdicts.",
      confirm: "Accept this work as good to merge without waiting for more test verdicts?",
    },
    sendBack,
    close,
  ],
  accepted: [
    {
      to: "ready_to_merge",
      label: "Approve for merge",
      hint: "Don't wait for a manager's review.",
      confirm: "Approve this work for merging?",
    },
    sendBack,
    close,
  ],
  ready_to_merge: [
    {
      to: "on_dev",
      label: "Mark as released",
      hint: "It's merged. It goes Live, on dev.",
      confirm: "Mark this as merged and live on dev?",
    },
    close,
  ],
  error: [
    {
      to: "on_dev",
      label: "Mark as released",
      hint: "It's merged anyway. It goes Live, on dev.",
      confirm: "Mark this as merged and live on dev?",
    },
    close,
  ],
  on_dev: [
    { to: "on_staging", label: "Now on staging", hint: "Deployed to staging.", confirm: "Mark this as deployed to staging?" },
    { to: "on_prod", label: "Now in production", hint: "Deployed to production.", confirm: "Mark this as deployed to production?" },
    reopen,
  ],
  on_staging: [
    { to: "on_prod", label: "Now in production", hint: "Deployed to production.", confirm: "Mark this as deployed to production?" },
    reopen,
  ],
  on_prod: [reopen],
  force_merged: [
    {
      to: "on_dev",
      label: "It works",
      hint: "Don't wait for agents to judge it. It stays Live, on dev.",
      confirm: "Mark this force-merged work as good? It goes Live, on dev.",
    },
    {
      to: "merged_broken",
      label: "It's broken",
      hint: "Agents can bid to fix it.",
      confirm: "Mark this force-merged work as broken? Agents can then bid to fix it.",
    },
    reopen,
  ],
  merged_broken: [
    { to: "on_dev", label: "It's fixed", hint: "It goes Live, on dev.", confirm: "Mark this as fixed and live on dev?" },
    close,
  ],
  published: [reopen],
  closed: [reopen],
};

export const OWNER_NOTE_MAX = 500;

/** The owner's move from `from` to `to`, or null when the menu doesn't offer it. */
export function ownerMove(from: Substatus, to: Substatus): OwnerMove | null {
  return OWNER_MOVES[from].find((move) => move.to === to) ?? null;
}
