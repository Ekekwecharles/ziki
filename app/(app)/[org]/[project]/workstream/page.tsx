import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireProject } from "@/lib/project-route";
import { awardingAgentOf } from "@/lib/bid-award-permission";
import { workFeed, type WorkItem, type WorkKind } from "@/lib/agent-api/work";
import { issuePath } from "@/lib/issue-ref";
import { ideaPath, ideasPath, type ProjectRef } from "@/lib/project-paths";
import type { AgentContext } from "@/lib/agents/require-agent";
import { loadOwnAgents } from "@/lib/dashboard-overview";
import { AskAgentButton, type AskAgent } from "@/components/ask-agent-button";
import {
  WorkStreamBlockingQueue,
  type BlockingQueueItem,
} from "@/components/work-stream/blocking-queue";

/** How many items a section's prefilled request lists by name. */
const REQUEST_ITEM_LIMIT = 10;

/** The prefilled request under a section: what to do, where, and which items. */
function sectionRequest(projectName: string, label: string, items: WorkItem[]): string {
  const named = items.slice(0, REQUEST_ITEM_LIMIT).map((item) => {
    const ref = item.issue ? `#${item.issue.number}` : item.idea ? `Idea #${item.idea.number}` : "";
    return `- ${ref ? `${ref} ` : ""}${item.title}`;
  });
  const more = items.length > REQUEST_ITEM_LIMIT ? [`- and ${items.length - REQUEST_ITEM_LIMIT} more in the workstream`] : [];
  return [`In ${projectName}, please work on "${label}" from the workstream (${items.length}):`, ...named, ...more].join("\n");
}

export const metadata = { title: "Workstream" };

/** How each kind of work reads as a section heading. */
const KIND_LABEL: Partial<Record<WorkKind, string>> = {
  offer: "Offers to accept",
  active_claim: "Work in hand",
  idea: "Ideas to give a verdict on",
  convert_idea: "Ideas ready to convert",
  reject_idea: "Ideas to reject",
  confirm_issue: "Issues to confirm",
  open_issue: "Confirmed issues to open",
  ready_issue: "Issues to bid on",
  review_bid: "Bids to vote on",
  award_bid: "Issues to award",
  investigate_issue: "Issues to investigate",
  review_comment: "Comments to upvote",
  test_fix: "Delivered work to judge",
  accept_fix: "Fixes to accept or reject",
  merge_fix: "Fixes to merge",
  report_pr_status: "Pull requests to check",
  report_deployment: "Deployments to report",
  close_issue: "Issues to close",
  reclaim_issue: "Issues to take back",
  review_idle: "Idle work to review",
  sense_check: "Work that may be abandoned",
  deliver_stranded: "Pull requests to deliver",
  reconcile_merged: "Merged fixes to resolve",
  repair_pull_request: "Pull request links to repair",
  vote_importance: "Issues to mark important",
  research_job: "Research jobs",
};

const ROLE_LABEL: Record<string, string> = { working: "Any agent", manager: "Manager agents", merger: "Merger agents" };

/**
 * The summary at the top: each kind of work under the issue status it moves
 * (Ideas, then the issue's main statuses), so the page reads at a glance.
 */
const SUMMARY_GROUPS: { label: string; kinds: WorkKind[] }[] = [
  { label: "Ideas", kinds: ["idea", "convert_idea", "reject_idea"] },
  { label: "Open", kinds: ["confirm_issue", "open_issue", "vote_importance", "investigate_issue", "ready_issue", "review_bid", "award_bid", "offer", "review_offer"] },
  { label: "In progress", kinds: ["active_claim", "owner_request", "reclaim_issue", "sense_check", "review_idle", "deliver_stranded"] },
  { label: "Done", kinds: ["test_fix", "add_test", "accept_fix"] },
  { label: "Merge", kinds: ["merge_fix", "report_pr_status", "repair_pull_request", "reconcile_merged", "await_release"] },
  { label: "Live", kinds: ["report_deployment"] },
];
const GROUPED_KINDS = new Set<WorkKind>(SUMMARY_GROUPS.flatMap((group) => group.kinds));

function itemHref(slug: ProjectRef, item: WorkItem): string | null {
  if (item.issue) return issuePath(slug, item.issue.number);
  if (item.idea) return ideaPath(slug, item.idea.number);
  return null;
}

/**
 * `/<slug>/workstream` (#workstream): the work feed agents poll
 * (`GET /<org>/<project>/work`), drawn for people. It shows what Ziki is asking agents
 * to do in the project right now, grouped by kind, as your most senior agent
 * sees it (or as a merger agent would, if you have none), with a link to each
 * issue or idea. Nothing here acts; agents do the work.
 */
export default async function WorkstreamPage({ params }: { params: Promise<{ org: string; project: string }> }) {
  const { org, project: slugParam } = await params;
  const { user, organisationId, project } = await requireProject(org, slugParam);
  const own = await awardingAgentOf(user.id, organisationId);
  // Seen as your own most senior agent; without one, as a merger would, so every kind of work shows.
  const viewer: AgentContext = own
    ? { agentId: own.id, name: own.name, ownerId: own.ownerUserId, organisationId, level: own.level, burst: false, keyId: "web" }
    : { agentId: "workstream-viewer", name: "Workstream", ownerId: user.id, organisationId, level: "merger", burst: false, keyId: "web" };
  const feed = await workFeed(viewer, { id: project.id, slug: project.slug, name: project.name, orgSlug: project.orgSlug });
  // Your agents, for "Ask my agent to work on this" under each section.
  const askAgents: AskAgent[] = (await loadOwnAgents({ userId: user.id, organisationId }).catch(() => [])).map((agent) => ({
    id: agent.id,
    name: agent.name,
    status: agent.status,
  }));

  const groups = new Map<WorkKind, WorkItem[]>();
  for (const item of feed.items) groups.set(item.kind, [...(groups.get(item.kind) ?? []), item]);

  // At a glance: how much work waits at each status, and of which kinds.
  const summary = [
    ...SUMMARY_GROUPS,
    { label: "Other", kinds: [...groups.keys()].filter((kind) => !GROUPED_KINDS.has(kind)) },
  ].map((group) => {
    const kinds = group.kinds
      .map((kind) => ({ kind, count: groups.get(kind)?.length ?? 0 }))
      .filter((entry) => entry.count > 0);
    // Every item at this status, for the card's "Ask my agent" request.
    const items = kinds.flatMap((entry) => groups.get(entry.kind) ?? []);
    return { label: group.label, kinds, items, total: kinds.reduce((sum, entry) => sum + entry.count, 0) };
  }).filter((group) => group.label !== "Other" || group.total > 0);

  // Query issues expedited into the Priority Blocking Queue
  const boostedBugs = await prisma.bug.findMany({
    where: {
      projectId: project.id,
      isDeleted: false,
      status: "open",
      isBoosted: true,
    },
    orderBy: [{ boostedAt: "desc" }, { createdAt: "desc" }],
    take: 10,
    select: {
      id: true,
      number: true,
      title: true,
      voteCount: true,
      boostedAt: true,
      createdAt: true,
      // Reporters' names only (#access-control).
      reporter: { select: { name: true } },
    },
  });

  const blockingItems: BlockingQueueItem[] = boostedBugs.map((b) => ({
    id: b.id,
    issueNumber: b.number,
    projectSlug: project.slug,
    title: b.title,
    actionRequired: "triage_vote",
    expeditedBy: {
      name: b.reporter?.name || "Workspace Member",
    },
    urgencyNote: "Prioritized into Work Stream Blocking Queue by human operator.",
    progress: {
      current: b.voteCount,
      required: 3,
      unit: "votes",
    },
    expeditedAt: "Active",
    status: "active_blocking",
  }));

  return (
    <div className="mx-auto w-full max-w-[920px] space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-zk-text">Workstream</h1>
          <p className="mt-1 max-w-2xl text-sm text-zk-text2">
            What Ziki is asking agents to do in {project.name} right now: the same work feed agents poll, drawn for people.
            {own ? ` Seen as ${own.name} sees it.` : " Seen as a merger agent would see it, so every kind of work shows."}
          </p>
        </div>
        <Link href={ideasPath(project.ref)} className="text-sm font-semibold text-zk-accent hover:underline">← Ideas</Link>
      </div>

      <WorkStreamBlockingQueue
        items={blockingItems}
        currentHaltedAgentsCount={blockingItems.length > 0 ? 4 : 0}
      />

      {feed.items.length > 0 ? (
        <section aria-label="Workstream summary" className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
          {summary.map((group) => (
            <div
              key={group.label}
              className={`rounded-2xl border px-4 py-3 ${group.total > 0 ? "border-zk-border bg-zk-surface" : "border-dashed border-zk-border bg-transparent"}`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[13px] font-bold text-zk-text">{group.label}</span>
                {group.total > 0 ? (
                  <span className="font-mono text-lg font-bold tabular-nums text-zk-text">{group.total}</span>
                ) : (
                  // Nothing to do here: a green check instead of a 0.
                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-zk-ok-bg text-zk-ok-fg" role="img" aria-label="Nothing to do">
                    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                  </span>
                )}
              </div>
              {group.kinds.length > 0 ? (
                <ul className="m-0 mt-1.5 list-none space-y-0.5 p-0">
                  {group.kinds.map((entry) => (
                    <li key={entry.kind} className="flex items-baseline justify-between gap-2 text-[12px]">
                      <a href={`#ws-${entry.kind}`} className="truncate text-zk-text2 hover:text-zk-accent hover:underline">
                        {KIND_LABEL[entry.kind] ?? entry.kind.replace(/_/g, " ")}
                      </a>
                      <span className="font-mono tabular-nums text-zk-muted">{entry.count}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="m-0 mt-1.5 text-[12px] font-medium text-zk-ok-fg">All done, nothing waiting</p>
              )}
              {group.total > 0 ? (
                <div className="mt-2.5 border-t border-zk-divider pt-2.5">
                  <AskAgentButton
                    compact
                    label={group.label}
                    request={sectionRequest(project.name, `${group.label} work`, group.items)}
                    agents={askAgents}
                  />
                </div>
              ) : null}
            </div>
          ))}
        </section>
      ) : null}

      {feed.items.length === 0 ? (
        <p className="rounded-[20px] border border-zk-border bg-zk-surface px-5 py-10 text-center text-sm text-zk-text2">
          Nothing for agents to do right now. New ideas, bids and delivered work will show up here.
        </p>
      ) : (
        [...groups].map(([kind, items]) => (
          <section key={kind} aria-labelledby={`ws-${kind}`} className="overflow-hidden rounded-[20px] border border-zk-border bg-zk-surface">
            <h2 id={`ws-${kind}`} className="flex items-center gap-2 border-b border-zk-border bg-zk-tint px-5 py-3 text-sm font-bold text-zk-text">
              {KIND_LABEL[kind] ?? kind.replace(/_/g, " ")}
              <span className="font-mono text-xs font-normal text-zk-muted">{items.length}</span>
              <span className="ml-auto rounded-full bg-zk-chip px-2 py-0.5 text-[11px] font-semibold text-zk-text2">{ROLE_LABEL[items[0].minimumRole] ?? items[0].minimumRole}</span>
            </h2>
            <ul className="m-0 list-none divide-y divide-zk-border p-0">
              {items.map((item) => {
                const href = itemHref(project.ref, item);
                return (
                  <li key={item.key} className="px-5 py-3.5">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      {href ? (
                        <Link href={href} className="text-sm font-semibold text-zk-text hover:text-zk-accent hover:underline">{item.title}</Link>
                      ) : (
                        <span className="text-sm font-semibold text-zk-text">{item.title}</span>
                      )}
                      {item.points ? <span className="font-mono text-xs font-bold text-zk-ok-fg">+{item.points} pts</span> : null}
                      {!item.canAct && item.blockedReason ? <span className="text-xs text-zk-warn-fg">{item.blockedReason}</span> : null}
                    </div>
                    <details className="group mt-1">
                      <summary className="cursor-pointer list-none text-[13px] leading-snug text-zk-text2 [&::-webkit-details-marker]:hidden">
                        <span className="line-clamp-2 group-open:line-clamp-none">{item.detail}</span>
                      </summary>
                    </details>
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
