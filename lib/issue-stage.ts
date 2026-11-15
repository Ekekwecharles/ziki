import type { Prisma, PrismaClient } from "@prisma/client";
import { workflowFor } from "@/lib/workflow";
import { DEFAULT_PROJECT_WORKFLOW } from "@/lib/workflow-config";

/**
 * Where an open issue sits before someone starts the work. Not a status.
 * Ideas are not issues (#idea-table): they live in their own table and have
 * no stage here.
 *
 * - `confirming`: converted from an idea, waiting for independent people
 *   to confirm it is real and not a duplicate.
 * - `ready`: a confirmed issue, so it can be passed on.
 */
export type IssueStage = "confirming" | "ready";

/** List filters. `ready` is the issue that can be passed on. */
export type IssueStageView = IssueStage;

export const issueStageLabels: Record<IssueStage, string> = {
  confirming: "Requires confirmation",
  ready: "Ready",
};

/** `?stage=` values. */
export function parseIssueStageView(raw: string | null | undefined): IssueStageView | null {
  return raw === "confirming" || raw === "ready" ? raw : null;
}

/** The stage of an open issue. Anything no longer open has no stage. */
export function issueStage(input: { substatus: string }): IssueStage | null {
  // #substatus: the stage follows the substatus. Open · Requires confirmation
  // is being confirmed; Open · Open was confirmed.
  if (input.substatus === "requires_confirmation") return "confirming";
  return input.substatus === "open" ? "ready" : null;
}

/** A confirmation entry, as the confirmed rule reads it (#issue-confirmations). */
export type ConfirmationEntry = {
  id: string;
  verdict: "confirm" | "reject" | "neutral";
  duplicateOfId: string | null;
  /** When it was last given. */
  updatedAt: Date;
  undoneAt?: Date | null;
  /** The agent that gave it; null for a person in the web app. */
  agentId: string | null;
  /** The agent's owner; null for a person. */
  agentOwnerUserId: string | null;
  onBehalfOfUserId: string;
  /** "manager" (a manager or merger agent) or "working" (a worker agent or a person). */
  weightClass?: string;
};

/** A counted entry with what it counts for (#confirmation-weights). */
export type CountedConfirmation = ConfirmationEntry & { weight: number };

/** Whether the entry's person reported the issue, is the one it is for, or owns the agent that filed it. */
export function ownsIssue(
  owner: string,
  bug: { reporterId?: string | null; beneficiaryUserId?: string | null; createdByAgent?: { ownerUserId: string } | null },
): boolean {
  return owner === bug.reporterId || owner === bug.beneficiaryUserId || owner === bug.createdByAgent?.ownerUserId;
}

/**
 * The entries that count on an issue, oldest first, each with its weight
 * (#confirmation-weights): given after its latest edit and not undone. A
 * person may give one entry of each class: a manager or merger agent's counts
 * `managerVoteWeight`, a worker agent's or the person's own counts 1. Anyone
 * may confirm their own issue, at the same weight (#owner-agents).
 */
export function countedConfirmationEntries(
  entries: readonly ConfirmationEntry[],
  revisedAt: Date | null,
  managerVoteWeight = DEFAULT_PROJECT_WORKFLOW.managerVoteWeight,
): CountedConfirmation[] {
  const seen = new Set<string>();
  const counted: CountedConfirmation[] = [];
  const ordered = [...entries].sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime() || a.id.localeCompare(b.id));
  for (const entry of ordered) {
    if (entry.undoneAt) continue;
    if (revisedAt && entry.updatedAt <= revisedAt) continue;
    const owner = entry.agentOwnerUserId ?? entry.onBehalfOfUserId;
    const weightClass = entry.weightClass ?? "working";
    const key = `${entry.verdict}:${owner}:${weightClass}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const weight = weightClass === "manager" ? managerVoteWeight : 1;
    counted.push({ ...entry, weight });
  }
  return counted;
}

/** The people credited for the confirms that count, oldest first. */
export function confirmersOf(counted: readonly ConfirmationEntry[]): string[] {
  return [...new Set(counted.filter((entry) => entry.verdict === "confirm").map((entry) => entry.onBehalfOfUserId))];
}

/** The weighted total of the counted entries with `verdict`. */
export function weightedTotal(counted: readonly CountedConfirmation[], verdict: "confirm" | "reject"): number {
  return counted.filter((entry) => entry.verdict === verdict).reduce((sum, entry) => sum + entry.weight, 0);
}

/** A counted reject naming another issue marks this one a duplicate. */
export function markedDuplicate(counted: readonly ConfirmationEntry[]): boolean {
  return counted.some((entry) => entry.verdict === "reject" && Boolean(entry.duplicateOfId));
}

export function isConfirmedCount(
  count: number,
  needed = DEFAULT_PROJECT_WORKFLOW.confirmationsNeeded,
): boolean {
  return count >= needed;
}

/** Where an open issue stands on confirmation, from one bulk read (#714). */
export type ConfirmationState = {
  stage: IssueStage;
  /** The weighted confirms (a manager agent's count managerVoteWeight, others 1). */
  accepts: number;
  /** The weighted rejects. */
  rejects: number;
  /** The project's `confirmationsNeeded`. */
  needed: number;
  /** Confirmed under the one rule (`isConfirmed`). */
  confirmed: boolean;
};

export type ReadConfirmation = Omit<ConfirmationState, "stage"> & {
  status: string;
  substatus: string;
  confirmed: boolean;
  /** A counted reject marked it a duplicate of another issue. */
  duplicate: boolean;
  /** The people credited for the counted confirms, oldest first. */
  confirmers: string[];
  /** The entries that count, oldest first, with their weights. */
  counted: CountedConfirmation[];
};

type Db = PrismaClient | Prisma.TransactionClient;

type OptionalDelegates = {
  bug?: { findMany?: unknown };
  bugRevision?: { findMany?: unknown };
  issueConfirmation?: { findMany?: unknown };
};

/**
 * Confirmation state of every issue matching `where`, in a fixed number of
 * queries. This is the one place "confirmed" is decided — for `isConfirmed()`,
 * lists, the work feed and the merge queue: the weighted confirms reach the
 * project's `confirmationsNeeded`, each counted only after the latest edit and
 * unless undone (#issue-confirmations, #confirmation-weights). An issue made
 * from an already-vetted idea (`vettedAt`, #vetted-start-now) is confirmed from
 * the start: its filer vouched for it, and it goes straight to work.
 * Confirming means real and not a duplicate, so there is no separate
 * duplicate clearance. Neutral counts for nothing.
 */
export async function readConfirmations(
  db: Db,
  where: Prisma.BugWhereInput,
): Promise<Map<string, ReadConfirmation>> {
  const result = new Map<string, ReadConfirmation>();
  const delegates = db as unknown as OptionalDelegates;
  if (typeof delegates.bug?.findMany !== "function" || typeof delegates.issueConfirmation?.findMany !== "function") return result;
  const bugs = await db.bug.findMany({
    where,
    select: {
      id: true,
      projectId: true,
      status: true,
      substatus: true,
      vettedAt: true,
      outsideWork: { select: { id: true } },
    },
  });
  if (!bugs?.length) return result;

  const ids = bugs.map((bug) => bug.id);
  const projectIds = [...new Set(bugs.map((bug) => bug.projectId))];
  const workflows = new Map(
    await Promise.all(projectIds.map(async (projectId) => [projectId, await workflowFor(projectId, db)] as const)),
  );
  const [revisions, rows] = await Promise.all([
    typeof delegates.bugRevision?.findMany === "function"
      ? db.bugRevision.findMany({ where: { bugId: { in: ids } }, select: { bugId: true, editedAt: true } })
      : Promise.resolve([] as { bugId: string; editedAt: Date }[]),
    db.issueConfirmation.findMany({
      where: { bugId: { in: ids }, verdict: { in: ["confirm", "reject"] }, undoneAt: null },
      select: {
        id: true,
        bugId: true,
        verdict: true,
        duplicateOfId: true,
        updatedAt: true,
        agentId: true,
        onBehalfOfUserId: true,
        weightClass: true,
        agent: { select: { ownerUserId: true } },
      },
    }),
  ]);

  const revisedAt = new Map<string, Date>();
  for (const revision of revisions ?? []) {
    const current = revisedAt.get(revision.bugId);
    if (!current || revision.editedAt > current) revisedAt.set(revision.bugId, revision.editedAt);
  }
  const entriesByBug = new Map<string, ConfirmationEntry[]>();
  for (const row of rows ?? []) {
    const list = entriesByBug.get(row.bugId) ?? [];
    list.push({
      id: row.id,
      verdict: row.verdict,
      duplicateOfId: row.duplicateOfId,
      updatedAt: row.updatedAt,
      agentId: row.agentId,
      agentOwnerUserId: row.agent?.ownerUserId ?? null,
      onBehalfOfUserId: row.onBehalfOfUserId,
      weightClass: row.weightClass,
    });
    entriesByBug.set(row.bugId, list);
  }

  for (const bug of bugs) {
    const workflow = workflows.get(bug.projectId);
    const counted = countedConfirmationEntries(
      entriesByBug.get(bug.id) ?? [],
      revisedAt.get(bug.id) ?? null,
      workflow?.managerVoteWeight ?? DEFAULT_PROJECT_WORKFLOW.managerVoteWeight,
    );
    const confirmers = confirmersOf(counted);
    const accepts = weightedTotal(counted, "confirm");
    const rejects = weightedTotal(counted, "reject");
    const needed = workflow?.confirmationsNeeded ?? DEFAULT_PROJECT_WORKFLOW.confirmationsNeeded;
    result.set(bug.id, {
      status: bug.status,
      substatus: bug.substatus,
      confirmed: Boolean(bug.vettedAt || bug.outsideWork) || isConfirmedCount(accepts, needed),
      accepts,
      rejects,
      needed,
      duplicate: markedDuplicate(counted),
      confirmers,
      counted,
    });
  }
  return result;
}

/**
 * Stage and confirmation state of every open issue matching `where`, from one
 * bulk read (see `readConfirmations`).
 */
export async function openIssueConfirmations(
  db: Db,
  where: Prisma.BugWhereInput,
): Promise<Map<string, ConfirmationState>> {
  const read = await readConfirmations(db, { ...where, status: "open", isDeleted: false });
  const result = new Map<string, ConfirmationState>();
  for (const [id, { substatus, accepts, rejects, needed, confirmed }] of read) {
    const stage = issueStage({ substatus });
    if (stage) result.set(id, { stage, accepts, rejects, needed, confirmed });
  }
  return result;
}

/**
 * Ids of the confirmed issues matching `where`, whatever their status (an
 * issue being worked on is `in_progress`), from one bulk read.
 */
export async function confirmedIssueIds(db: Db, where: Prisma.BugWhereInput): Promise<Set<string>> {
  const read = await readConfirmations(db, { ...where, isDeleted: false });
  return new Set([...read].filter(([, c]) => c.confirmed).map(([id]) => id));
}

/** Stage of every open issue matching `where` (see `openIssueConfirmations`). */
export async function openIssueStages(
  db: Db,
  where: Prisma.BugWhereInput,
): Promise<Map<string, IssueStage>> {
  const confirmations = await openIssueConfirmations(db, where);
  return new Map([...confirmations].map(([id, confirmation]) => [id, confirmation.stage]));
}
