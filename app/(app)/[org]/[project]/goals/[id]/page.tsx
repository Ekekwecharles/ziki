import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireProject } from "@/lib/project-route";
import { goalPath, type ProjectRef } from "@/lib/project-paths";
import { issuePath } from "@/lib/issue-ref";
import { withBudget, type GoalAllocationRecord } from "@/lib/goals/service";
import { activeIn } from "@/lib/agents/active-in";
import type { GoalBudgetSummary, GoalSplitStatus } from "@/lib/goals/pool-split";
import { GoalStatusControls } from "../goal-status-controls";
import { SplitWizard, type AgentTarget, type GoalTarget, type IssueTarget } from "./split-wizard";

export const metadata = { title: "Goal" };

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

const METHOD_LABEL: Record<string, string> = {
  even: "Even",
  proportional: "By weight",
  milestone: "Milestone shares",
  manual: "Manual amounts",
};

/** What one live allocation points at, resolved for the ledger. */
type ResolvedTarget = { text: string; href?: string };

function TargetLink({ target }: { target: ResolvedTarget }) {
  return target.href ? (
    <Link href={target.href} className="font-medium text-zk-accent hover:underline">
      {target.text}
    </Link>
  ) : (
    <span className="font-medium text-zk-text">{target.text}</span>
  );
}

/**
 * `/<org>/<project>/goals/<id>`: one goal's pool, its nested tree, the split
 * wizard, and the allocation ledger with every slice's `sourceKey` (#616).
 */
export default async function GoalDetailPage({
  params,
}: {
  params: Promise<{ org: string; project: string; id: string }>;
}) {
  const { org, project: slugParam, id: goalId } = await params;
  const context = await requireProject(org, slugParam);
  if (!context.canContribute) notFound();
  const { organisationId, project } = context;
  const ref: ProjectRef = project.ref;

  const goal = await prisma.goal.findFirst({
    where: { id: goalId, organisationId, projectId: project.id },
    select: {
      id: true,
      organisationId: true,
      projectId: true,
      createdById: true,
      title: true,
      description: true,
      budgetPool: true,
      allocated: true,
      status: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!goal) notFound();
  const budget: GoalBudgetSummary = withBudget(goal).budget;

  const allocations = await prisma.goalAllocation.findMany({
    where: { goalId: goal.id, releasedAt: null },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });

  const [issues, otherGoals, agents, bugs, nestedGoals, agentRows] = await Promise.all([
    // The wizard's issue picker: live work in this project, newest first.
    prisma.bug.findMany({
      where: { projectId: project.id, isDeleted: false, status: { in: ["open", "in_progress", "done", "merge"] } },
      orderBy: [{ number: "desc" }],
      take: 150,
      select: { id: true, number: true, title: true, status: true },
    }),
    prisma.goal.findMany({
      where: { projectId: project.id, id: { not: goal.id }, status: "active" },
      orderBy: [{ createdAt: "desc" }],
      take: 100,
      select: { id: true, title: true },
    }),
    prisma.agent.findMany({
      where: { ...activeIn(organisationId), revokedAt: null },
      orderBy: [{ name: "asc" }],
      take: 50,
      select: { id: true, name: true },
    }),
    prisma.bug.findMany({
      where: { id: { in: allocations.filter((row) => row.targetBugId).map((row) => row.targetBugId!) } },
      select: { id: true, number: true, title: true },
    }),
    prisma.goal.findMany({
      where: { id: { in: allocations.filter((row) => row.targetGoalId).map((row) => row.targetGoalId!) } },
      select: { id: true, title: true },
    }),
    prisma.agent.findMany({
      where: { id: { in: allocations.filter((row) => row.targetAgentId).map((row) => row.targetAgentId!) } },
      select: { id: true, name: true },
    }),
  ]);

  const bugById = new Map(bugs.map((row) => [row.id, row]));
  const nestedById = new Map(nestedGoals.map((row) => [row.id, row]));
  const agentById = new Map(agentRows.map((row) => [row.id, row]));
  const resolveTarget = (row: GoalAllocationRecord): ResolvedTarget => {
    if (row.targetType === "issue" && row.targetBugId) {
      const bug = bugById.get(row.targetBugId);
      return bug
        ? { text: `#${bug.number} ${bug.title}`, href: issuePath(ref, bug.number) }
        : { text: `Issue ${row.targetBugId} (deleted)` };
    }
    if (row.targetType === "goal" && row.targetGoalId) {
      const nested = nestedById.get(row.targetGoalId);
      return nested
        ? { text: nested.title, href: goalPath(ref, nested.id) }
        : { text: `Goal ${row.targetGoalId} (removed)` };
    }
    const agent = row.targetAgentId ? agentById.get(row.targetAgentId) : null;
    return { text: row.label ?? agent?.name ?? "Agent deliverable" };
  };

  const wizardIssues: IssueTarget[] = issues.map((row) => ({
    id: row.id,
    number: row.number,
    title: row.title,
    status: row.status,
  }));
  const wizardGoals: GoalTarget[] = otherGoals.map((row) => ({ id: row.id, title: row.title }));
  const wizardAgents: AgentTarget[] = agents.map((row) => ({ id: row.id, name: row.name }));

  const totalAllocated = budget.allocated;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-5">
      {/* The pool itself: what it holds, what is carved out, what is left. */}
      <section aria-label="Budget pool" className="rounded-[20px] border border-zk-border bg-zk-surface p-5" data-testid="goal-detail">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg font-extrabold tracking-tight text-zk-text">{goal.title}</h1>
            <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-[0.06em] ${STATUS_BADGE[goal.status] ?? "bg-zk-chip text-zk-muted"}`}>
              {goal.status}
            </span>
            <span className="rounded-full bg-zk-chip px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-[0.06em] text-zk-text2">
              {SPLIT_LABEL[budget.splitStatus]}
            </span>
          </div>
          <GoalStatusControls org={org} slug={project.slug} goalId={goal.id} status={goal.status} />
        </div>
        {goal.description ? <p className="mt-2 text-sm text-zk-text2">{goal.description}</p> : null}
        <dl className="mt-4 grid grid-cols-3 gap-3" data-testid="goal-figures">
          <div className="rounded-xl bg-zk-chip px-3 py-2.5">
            <dt className="text-[11px] font-bold uppercase tracking-[0.06em] text-zk-muted">Pool</dt>
            <dd className="mt-0.5 text-xl font-extrabold tabular-nums text-zk-text">{budget.budgetPool.toLocaleString()}</dd>
          </div>
          <div className="rounded-xl bg-zk-chip px-3 py-2.5">
            <dt className="text-[11px] font-bold uppercase tracking-[0.06em] text-zk-muted">Allocated</dt>
            <dd className="mt-0.5 text-xl font-extrabold tabular-nums text-zk-text">{totalAllocated.toLocaleString()}</dd>
          </div>
          <div className="rounded-xl bg-zk-chip px-3 py-2.5">
            <dt className="text-[11px] font-bold uppercase tracking-[0.06em] text-zk-muted">Remaining</dt>
            <dd className="mt-0.5 text-xl font-extrabold tabular-nums text-zk-text">{budget.remaining.toLocaleString()}</dd>
          </div>
        </dl>
        <div
          className="mt-4 h-2 w-full overflow-hidden rounded-full bg-zk-chip"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={budget.budgetPool}
          aria-valuenow={budget.allocated}
          aria-label={`${budget.allocated} of ${budget.budgetPool} credits allocated`}
        >
          <div className="h-2 rounded-full bg-electric-blue-strong" style={{ width: `${budget.utilizationPercent}%` }} />
        </div>
      </section>

      {goal.status === "active" ? (
        <SplitWizard
          org={org}
          slug={project.slug}
          goalId={goal.id}
          budget={budget}
          issues={wizardIssues}
          goals={wizardGoals}
          agents={wizardAgents}
        />
      ) : (
        <p className="rounded-[20px] border border-dashed border-zk-border bg-zk-surface p-5 text-sm text-zk-muted">
          This goal is {goal.status}, so its pool cannot be split. Reopen it above to carve out more credits.
        </p>
      )}

      {/* The ledger: every live slice, with the sourceKey that proves which split made it. */}
      <section aria-labelledby="ledger-heading" className="overflow-hidden rounded-[20px] border border-zk-border bg-zk-surface">
        <div className="border-b border-zk-border px-5 py-4">
          <h2 id="ledger-heading" className="text-base font-bold text-zk-text">Allocation ledger</h2>
          <p className="mt-0.5 text-[13px] text-zk-text2">
            Every credit carved from this pool, newest first. Each row keeps the <code className="rounded bg-zk-chip px-1 font-mono text-[11px]">sourceKey</code> of the split that created it.
          </p>
        </div>
        {allocations.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-zk-muted">Nothing allocated yet. Split the pool to fund work.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-zk-border text-[11px] font-bold uppercase tracking-[0.06em] text-zk-muted">
                  <th scope="col" className="px-5 py-2.5">Credits</th>
                  <th scope="col" className="px-5 py-2.5">Target</th>
                  <th scope="col" className="px-5 py-2.5">Split</th>
                  <th scope="col" className="px-5 py-2.5">Source key</th>
                  <th scope="col" className="px-5 py-2.5">Added</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zk-border" data-testid="allocation-ledger">
                {allocations.map((row) => (
                  <tr key={row.id}>
                    <td className="px-5 py-3 font-bold tabular-nums text-zk-text">{row.amount.toLocaleString()}</td>
                    <td className="max-w-[240px] px-5 py-3">
                      <span className="block truncate"><TargetLink target={resolveTarget(row)} /></span>
                      <span className="text-[11px] uppercase tracking-wide text-zk-muted">{row.targetType}</span>
                    </td>
                    <td className="px-5 py-3 text-zk-text2">{METHOD_LABEL[row.method] ?? row.method}</td>
                    <td className="px-5 py-3">
                      <code
                        title={row.sourceKey}
                        className="block max-w-[170px] truncate rounded bg-zk-chip px-1.5 py-0.5 font-mono text-[11px] text-zk-text2"
                      >
                        {row.sourceKey}
                      </code>
                    </td>
                    <td className="whitespace-nowrap px-5 py-3 text-[12.5px] text-zk-muted">
                      {row.createdAt.toISOString().slice(0, 16).replace("T", " ")} UTC
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
