import type { Status } from "@prisma/client";
import type { IdeaListRow } from "@/components/ideas-list";
import type { IssueRowWork } from "@/components/issue-row-status";
import { statusLabel } from "@/lib/labels";
import { parseBugSort, type BugSortOption } from "@/lib/issues-sort";
import { parseIdeaSort, type IdeaSortOption } from "@/lib/list-sort";
import { marketingPath, type ProjectRef } from "@/lib/project-paths";
import { toSingleQueryParam } from "@/lib/search";

/**
 * The board's lists. Ideas have their own table; the rest list issues by main
 * status. Marketing work skips Merge (D1). The first list is where the board opens.
 */
export const TASK_TABS = [
  { param: "ideas", label: "Ideas", status: null },
  { param: "open", label: statusLabel.open, status: "open" },
  { param: "in-progress", label: statusLabel.in_progress, status: "in_progress" },
  { param: "closed", label: statusLabel.closed, status: "closed" },
  { param: "done", label: statusLabel.done, status: "done" },
  { param: "live", label: statusLabel.resolved, status: "resolved" },
] as const satisfies readonly { param: string; label: string; status: Status | null }[];

export type TaskTab = (typeof TASK_TABS)[number];
export type TaskTabParam = TaskTab["param"];

/**
 * The stages across the top, as on the issue list, each holding the lifecycle
 * steps listed down the left when it is picked. Ideas has no steps of its own.
 */
export const TASK_STAGES: readonly { label: string; steps: readonly TaskTabParam[] }[] = [
  { label: "Ideas", steps: ["ideas"] },
  { label: "In Progress", steps: ["open", "in-progress", "closed"] },
  { label: "Delivered", steps: ["done", "live"] },
];

/** The tab a list's param names. */
export function taskTab(param: TaskTabParam): TaskTab {
  return TASK_TABS.find((tab) => tab.param === param)!;
}

export type TaskRow = {
  id: string;
  number: number;
  title: string;
  href: string;
  status: Status;
  substatus: string;
  closeReason: string | null;
  importance: number;
  reward: number;
  rewardEstimates: number;
  rewardFixed: boolean;
  typeName: string | null;
  /** The agent on it: its holder, whoever it is offered to, or who delivered it. */
  agentName: string | null;
  work: IssueRowWork | null;
  offeredTo: string | null;
  /** While it is back with its worker: "Revision 1 of 2". */
  revision: string | null;
  bids: number;
  comments: number;
  updatedAt: Date;
};

export type TaskView = {
  tab: TaskTab;
  page: string | null;
  /** The sort the address names, carried by page links. A remembered sort stays in its cookie. */
  sortParam: string | null;
  taskSort: BugSortOption;
  proposalSort: IdeaSortOption;
};

export type TasksBoardData = {
  tab: TaskTab;
  counts: Record<TaskTabParam, number>;
  sortParam: string | null;
  list:
    | { kind: "proposals"; ideas: IdeaListRow[]; sort: IdeaSortOption }
    | { kind: "tasks"; rows: TaskRow[]; sort: BugSortOption };
  pagination: { page: number; totalPages: number; totalCount: number; from: number; to: number };
};

/** Reads the address. No tab, or an unknown one, opens Ideas. A sort in it beats the one remembered in each list's cookie, as on the issue list. */
export function parseTaskView(
  params: Record<string, string | string[] | undefined>,
  remembered: { taskSort?: string; proposalSort?: string } = {},
): TaskView {
  const status = toSingleQueryParam(params.status);
  const sortParam = toSingleQueryParam(params.sort) ?? null;
  return {
    tab: TASK_TABS.find((tab) => tab.param === status) ?? TASK_TABS[0],
    page: toSingleQueryParam(params.page) ?? null,
    sortParam,
    taskSort: parseBugSort(sortParam ?? remembered.taskSort),
    proposalSort: parseIdeaSort(sortParam ?? remembered.proposalSort),
  };
}

/** A tab's address. The sort isn't carried across: each list keeps its own. */
export function tasksHref(slug: ProjectRef, tab: TaskTab): string {
  return `${marketingPath(slug, "tasks")}?status=${tab.param}`;
}
