import Link from "next/link";
import type { ReactNode } from "react";
import { prisma } from "@/lib/prisma";
import { goalPath, type ProjectRef } from "@/lib/project-paths";
import { listGoals, type GoalWithBudget } from "@/lib/goals/service";
import type { GoalBudgetSummary, GoalSplitStatus } from "@/lib/goals/pool-split";
import { CreateGoalForm } from "./create-goal-form";

/** How full a goal's pool is, as the badge on every card. */
const SPLIT_LABEL: Record<GoalSplitStatus, string> = {
  "no-budget": "No budget",
  unfunded: "Unfunded",
  "partially-split": "Partially split",
  "fully-split": "Fully split",
};

const STATUS_BADGE: Record<string, string> = {
  active: "bg-zk-tint text-zk-accent",
  completed: "bg-zk-ok-bg text-zk-ok-fg",
  cancelled: "bg-zk-chip text-zk-muted",
};

function Chip({ className, children }: { className: string; children: ReactNode }) {
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-[0.06em] ${className}`}>
      {children}
    </span>
  );
}

/** Pool / allocated / remaining with the utilisation bar every card shares. */
function BudgetBar({ budget }: { budget: GoalBudgetSummary }) {
  return (
    <div className="mt-3" data-testid="goal-budget-bar">
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-zk-chip"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={budget.budgetPool}
        aria-valuenow={budget.allocated}
        aria-label={`${budget.allocated} of ${budget.budgetPool} credits allocated`}
      >
        <div
          className="h-2 rounded-full bg-electric-blue-strong"
          style={{ width: `${budget.utilizationPercent}%` }}
        />
      </div>
      <p className="mt-1.5 flex flex-wrap gap-x-3 text-[12.5px] text-zk-text2">
        <span><strong className="font-semibold text-zk-text">{budget.budgetPool.toLocaleString()}</strong> pool</span>
        <span><strong className="font-semibold text-zk-text">{budget.allocated.toLocaleString()}</strong> allocated</span>
        <span><strong className="font-semibold text-zk-text">{budget.remaining.toLocaleString()}</strong> remaining</span>
      </p>
    </div>
  );
}

/** One goal in the tree: title, chips, budget bar, and its link into the detail page. */
function GoalNode({
  goal,
  href,
  funding,
}: {
  goal: GoalWithBudget;
  href: string;
  funding?: { from: string; amount: number };
}) {
  return (
    <div className="rounded-[20px] border border-zk-border bg-zk-surface p-4 sm:p-5" data-testid="goal-card">
      {funding ? (
        <p className="mb-2 text-[12.5px] text-zk-muted">
          ↳ funded {funding.amount.toLocaleString()} credits by{" "}
          <strong className="font-semibold text-zk-text2">{funding.from}</strong>
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h2 className="truncate text-base font-bold text-zk-text">{goal.title}</h2>
          <Chip className={STATUS_BADGE[goal.status] ?? "bg-zk-chip text-zk-muted"}>{goal.status}</Chip>
          <Chip className="bg-zk-chip text-zk-text2">{SPLIT_LABEL[goal.budget.splitStatus]}</Chip>
        </div>
        <Link
          href={href}
          className="rounded-lg border border-zk-border px-3 py-1.5 text-[13px] font-semibold text-zk-text hover:bg-zk-chip"
        >
          Open &amp; split
        </Link>
      </div>
      {goal.description ? <p className="mt-2 line-clamp-2 text-sm text-zk-text2">{goal.description}</p> : null}
      <BudgetBar budget={goal.budget} />
    </div>
  );
}

/**
 * The project's goals (#616), in the project's settings: every goal with its budget
 * pool, newest first, nested goals funded from a parent's pool shown beneath
 * it, and the form for a new one. The web surface for `GET/POST /api/v1/goals*`.
 * Shown only to people who can contribute to the project.
 */
export async function ProjectGoals({
  org,
  organisationId,
  project,
}: {
  org: string;
  organisationId: string;
  project: { id: string; slug: string; ref: ProjectRef };
}) {
  const ref: ProjectRef = project.ref;

  const goals = await listGoals(organisationId, project.id);
  const edges = goals.length
    ? await prisma.goalAllocation.findMany({
        where: {
          goalId: { in: goals.map((goal) => goal.id) },
          targetType: "goal",
          targetGoalId: { not: null },
          releasedAt: null,
        },
        select: { goalId: true, targetGoalId: true, amount: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      })
    : [];

  const byId = new Map(goals.map((goal) => [goal.id, goal]));
  const childrenOf = new Map<string, { child: GoalWithBudget; amount: number; from: string }[]>();
  const parentOf = new Map<string, string>();
  for (const edge of edges) {
    const child = byId.get(edge.targetGoalId!);
    const parent = byId.get(edge.goalId);
    if (!child || !parent || edge.goalId === edge.targetGoalId) continue;
    // A goal renders under the first pool that funded it; its other funding
    // shows on its own page, and a cycle can never recurse forever.
    if (parentOf.has(child.id)) continue;
    parentOf.set(child.id, parent.id);
    const list = childrenOf.get(parent.id) ?? [];
    list.push({ child, amount: edge.amount, from: parent.title });
    childrenOf.set(parent.id, list);
  }

  const rendered = new Set<string>();
  const build = (goal: GoalWithBudget, funding?: { from: string; amount: number }): ReactNode => {
    rendered.add(goal.id);
    const kids = (childrenOf.get(goal.id) ?? []).filter((kid) => !rendered.has(kid.child.id));
    return (
      <li key={goal.id}>
        <GoalNode goal={goal} href={goalPath(ref, goal.id)} funding={funding} />
        {kids.length ? (
          <ul className="mt-3 ml-4 space-y-3 border-l-2 border-zk-border pl-4 sm:ml-6">
            {kids.map((kid) => build(kid.child, { from: kid.from, amount: kid.amount }))}
          </ul>
        ) : null}
      </li>
    );
  };

  const forest = goals.filter((goal) => !parentOf.has(goal.id)).map((goal) => build(goal));
  // Anything a funding cycle kept from the forest still gets a root slot.
  for (const goal of goals) if (!rendered.has(goal.id)) forest.push(build(goal));

  return (
    <div className="space-y-5">
      <CreateGoalForm org={org} slug={project.slug} />

      {goals.length === 0 ? (
        <p className="rounded-[20px] border border-dashed border-zk-border bg-zk-surface p-6 text-sm text-zk-muted">
          No goals yet. Create the first one to give work a budget.
        </p>
      ) : (
        <ul className="space-y-3" data-testid="goal-tree">
          {forest}
        </ul>
      )}
    </div>
  );
}
