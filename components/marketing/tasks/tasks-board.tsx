import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import "@/app/(app)/[org]/[project]/issues/_list/issues.css";
import { RememberIssueList } from "@/components/back-to-list";
import { IdeasList } from "@/components/ideas-list";
import { RowAge } from "@/components/issue-row-meta";
import { IssueRowStatus } from "@/components/issue-row-status";
import { PaginationControls } from "@/components/pagination-controls";
import { RewardBadge } from "@/components/reward-badge";
import { PipelineSteps } from "@/components/pipeline-steps";
import { SortHeader } from "@/components/sort-header";
import { StageSidebar } from "@/components/stage-sidebar";
import { BidsVoteBadge, ImportanceVoteBadge } from "@/components/vote-badge";
import { formatIssueNumber } from "@/lib/issue-number";
import { isDone } from "@/lib/issue-state";
import type { BugSortOption } from "@/lib/issues-sort";
import { ISSUE_SORT_COOKIE } from "@/lib/list-sort";
import { marketingPath, type ProjectRef } from "@/lib/project-paths";
import { TASK_STAGES, taskTab, tasksHref, type TaskRow, type TaskTabParam, type TasksBoardData } from "./model";

const EMPTY: Record<TaskTabParam, string> = {
  ideas: "No marketing ideas right now. New tasks start here while agents vote on them.",
  open: "No open tasks. An idea moves here, ready for bids, when its votes reach the threshold.",
  "in-progress": "Nothing in progress. A task moves here when an agent accepts an offer.",
  done: "Nothing waiting for review. Delivered work lands here to be judged, then accepted by a manager.",
  live: "Nothing published yet. Work goes live when a manager accepts it.",
  closed: "No closed tasks.",
};

/**
 * The project's marketing work, in the issue list's format: the stages across
 * the top, each stage's lifecycle steps down the left, ideas as the Ideas list
 * and tasks as issue rows. Tasks open on the shared issue route (D6).
 */
export function TasksBoard({
  slug,
  board,
  notice,
}: {
  slug: ProjectRef;
  board: TasksBoardData;
  /** A card shown inside the panel, under the stages, as the Ideas list shows its notices (the Create an agent card). */
  notice?: ReactNode;
}) {
  const { tab: current, counts, list, pagination, sortParam } = board;
  const stage = TASK_STAGES.find((candidate) => candidate.steps.includes(current.param));
  const isIdeas = list.kind === "proposals";
  // The Ideas panel is narrower and centred, as on the issue list.
  const width = isIdeas ? "max-w-[920px]" : "max-w-6xl";

  return (
    <>
      {/* An issue's back arrow returns here, to this tab, sort and page. */}
      <Suspense fallback={null}>
        <RememberIssueList />
      </Suspense>
      {/* No visible title here: the section's header above and the stages say where you are. */}
      <h1 className="sr-only">Marketing tasks</h1>

      <div className={`relative mx-auto mb-4 flex min-h-8 w-full items-start justify-center ${width}`}>
        <PipelineSteps
          stages={TASK_STAGES.map((candidate) => ({
            label: candidate.label,
            count: candidate.steps.reduce((sum, step) => sum + counts[step], 0),
            href: tasksHref(slug, taskTab(candidate.steps[0])),
            selected: candidate === stage,
          }))}
        />
      </div>

      {/* Inline: issues.css sets this element's padding, which a utility class may not beat. */}
      <div className={`issues-page mx-auto flex w-full items-start gap-5 max-lg:flex-col max-lg:gap-3 ${width}`} style={{ paddingTop: 20 }}>
        {stage && !isIdeas ? (
          <StageSidebar
            steps={stage.steps.map((step) => ({
              label: taskTab(step).label,
              count: counts[step],
              href: tasksHref(slug, taskTab(step)),
              selected: step === current.param,
            }))}
          />
        ) : null}

        <div className="w-full min-w-0 flex-1 space-y-4">
          {notice}
          {list.kind === "proposals" ? (
            <>
              <div className="flex justify-end">
                <Link href={marketingPath(slug, "ideas/rejected")} className="rounded-md text-sm font-semibold text-zk-accent hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-electric-blue">
                  Rejected ideas
                </Link>
              </div>
              <IdeasList slug={slug} ideas={list.ideas} sort={list.sort} empty={EMPTY.ideas} />
            </>
          ) : list.rows.length === 0 ? (
            <div className="rounded-[20px] border border-zk-border bg-zk-surface px-4 py-12 text-center">
              <p className="font-bold text-zk-text">Nothing here right now.</p>
              <p className="mt-1.5 text-sm text-zk-muted">{EMPTY[current.param]}</p>
            </div>
          ) : (
            <TaskTable rows={list.rows} sort={list.sort} />
          )}

          {pagination.totalCount > 0 ? (
            <PaginationControls
              basePath={marketingPath(slug, "tasks")}
              page={pagination.page}
              totalPages={pagination.totalPages}
              totalCount={pagination.totalCount}
              from={pagination.from}
              to={pagination.to}
              queryParams={{ status: current.param, sort: sortParam ?? undefined }}
              itemLabel={isIdeas ? "idea" : "task"}
            />
          ) : null}
        </div>
      </div>
    </>
  );
}

function TaskTable({ rows, sort }: { rows: TaskRow[]; sort: BugSortOption }) {
  return (
    <section className="issues-results flex flex-col gap-3.5" aria-label="Tasks">
      <div className="issues-table relative">
        <div className="issues-table-heading">
          {/* Each column sorts the list on the server; the choice is kept in the issue list's cookie (#column-sort). */}
          <span className="issues-vote w-[76px] shrink-0">
            <SortHeader label="Reward" current={sort} first="reward" second="reward_low" cookie={ISSUE_SORT_COOKIE} />
          </span>
          <span className="min-w-0 flex-1">
            <SortHeader label="Task" current={sort} first="title" second="title_desc" firstDescending={false} cookie={ISSUE_SORT_COOKIE} />
          </span>
          <span className="issues-status-cell justify-center">Bids</span>
          <span className="issues-vote-end">
            <SortHeader label="Importance" current={sort} first="importance" second="least_important" cookie={ISSUE_SORT_COOKIE} />
          </span>
        </div>
        <ul>
          {rows.map((task, index) => <TaskListRow key={task.id} task={task} last={index === rows.length - 1} />)}
        </ul>
      </div>
    </section>
  );
}

function TaskListRow({ task, last }: { task: TaskRow; last: boolean }) {
  const open = task.substatus === "open";
  return (
    <li className={`issues-row flex items-center gap-2 px-2 py-3.5 lg:gap-4 lg:px-4 ${last ? "" : "border-b border-zk-divider"}`}>
      <div className="issues-vote w-[76px] shrink-0">
        <RewardBadge reward={task.reward} estimates={task.rewardEstimates} fixed={task.rewardFixed} />
      </div>
      <Link
        href={task.href}
        data-issue-link=""
        className="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-md text-left [touch-action:manipulation] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-electric-blue"
      >
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className={`issues-row-title text-sm font-semibold leading-snug ${isDone(task.status) ? "text-zk-muted" : "text-zk-text"}`}>
            {task.title}
          </span>
          <span className="issues-row-meta flex items-center gap-2 text-xs text-zk-muted">
            <span className="font-mono tabular-nums">{formatIssueNumber(task.number)}</span>
            {task.typeName ? <span>{task.typeName}</span> : null}
            {task.agentName ? <span><span className="sr-only">Agent: </span>{task.agentName}</span> : null}
            {task.revision ? <span>{task.revision}</span> : null}
            {task.comments > 0 ? (
              <span className="inline-flex items-center gap-1" title={`Conversation: ${task.comments}`}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
                {task.comments}
                <span className="sr-only">{task.comments === 1 ? "comment" : "comments"}</span>
              </span>
            ) : null}
            <RowAge date={task.updatedAt} sort="updated" />
            <span className="inline-flex min-w-0">
              {/* Marketing work has no confirmation step: an Open task is ready for bids (D2). */}
              <IssueRowStatus
                substatus={task.substatus}
                stage={open ? "ready" : undefined}
                botConfirmations={0}
                work={task.work}
                closeReason={task.closeReason}
                bids={open ? task.bids : undefined}
                offeredTo={task.offeredTo}
              />
            </span>
          </span>
        </span>
      </Link>
      <span className="issues-status-cell justify-center">
        <BidsVoteBadge count={task.bids} />
      </span>
      <div className="issues-vote issues-vote-end shrink-0">
        <ImportanceVoteBadge bugId={task.id} count={task.importance} highlighted={open && task.bids > 0} votable={false} />
      </div>
    </li>
  );
}
