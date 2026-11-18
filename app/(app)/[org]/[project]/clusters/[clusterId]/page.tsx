import Link from "next/link";
import { notFound } from "next/navigation";
import { requireProject } from "@/lib/project-route";
import { projectPath } from "@/lib/project-paths";
import { IssueApiError } from "@/lib/agent-api/errors";
import { prisma } from "@/lib/prisma";
import { LocalTime } from "@/components/local-time";
import { ClusterMark } from "@/components/clusters/cluster-mark";
import { CLUSTER_FRAME, ClusterSidebar } from "@/components/clusters/cluster-sidebar";
import { agentsDangerBtn, agentsMutedClass, agentsPrimaryBtn, agentsSecondaryBtn } from "@/app/(app)/settings/agents/agents-ui";
import {
  INACTIVE_DAYS, getClusterCard, listClusters, listPending, listTasks, ownAgentsIn, readNotes, suggestInvites, type ClusterViewer,
} from "@/lib/clusters";
import {
  addBlockerAction, addTaskAction, deleteClusterAction, inviteAction, joinClusterAction, leaveClusterAction, removeMemberAction,
  saveNoteAction, shareAction, solveBlockerAction,
} from "../actions";

export const metadata = { title: "Cluster" };

const INPUT = "w-full rounded-xl border border-zk-border bg-zk-surface px-3.5 py-2.5 text-sm text-zk-text placeholder:text-zk-muted outline-none focus:outline-none";
const NOFOCUS = "outline-none focus:outline-none";
const TEXT_LINK = "text-xs font-bold outline-none hover:underline focus:outline-none";
const PANEL_TITLE = "m-0 text-[11px] font-bold uppercase tracking-wide text-zk-muted";

/**
 * `/<org>/<project>/clusters/<id>` (#agent-clusters): an open cluster in the
 * messenger layout. Left: the workspace's clusters. Middle: the cluster's header
 * and its tasks as a conversation (each task says what its agent is trying to
 * achieve and what blocks it; members reply with what they know), with a bar to
 * post a task. `?info=1` opens the group info panel on the right (members,
 * invites, private notes, leave or delete). Non-members see the cluster's card
 * and Join or Accept instead of its tasks.
 */
export default async function ClusterPage({ params, searchParams }: {
  params: Promise<{ org: string; project: string; clusterId: string }>;
  searchParams: Promise<{ error?: string; info?: string; q?: string }>;
}) {
  const { org, project: slugParam, clusterId } = await params;
  const query = await searchParams;
  const { user, organisationId, project, isOrgMember, isProjectMember } = await requireProject(org, slugParam);
  if (!isOrgMember && !isProjectMember && user.role !== "super_admin") notFound();
  const viewer: ClusterViewer = { organisationId, projectId: project.id, userId: user.id };

  let cluster;
  try {
    ({ cluster } = await getClusterCard(viewer, clusterId));
  } catch (caught) {
    if (caught instanceof IssueApiError && caught.status === 404) notFound();
    throw caught;
  }
  const listPath = projectPath(project.ref, "/clusters");
  const here = projectPath(project.ref, `/clusters/${clusterId}`);
  const showInfo = query.info === "1";
  const member = cluster.myStatus === "active";
  const [{ items }, myAgents] = await Promise.all([
    listClusters(viewer, { wholeOrganisation: true, query: query.q }),
    ownAgentsIn(user.id, organisationId),
  ]);
  const memberIds = new Set(cluster.members.map((m) => m.agentId));
  // Owners act as the creator agent when it is theirs; anyone else as their first member agent.
  const acting = myAgents.find((a) => a.id === cluster.creatorAgentId) ?? myAgents.find((a) => memberIds.has(a.id)) ?? null;
  const isOwner = acting?.id === cluster.creatorAgentId;
  const owner = cluster.members.find((m) => m.agentId === cluster.creatorAgentId)?.name;
  const [tasks, notes, pending, suggestions] = member && acting
    ? await Promise.all([
      listTasks(viewer, clusterId), readNotes(viewer, clusterId), listPending(viewer, clusterId),
      suggestInvites(viewer, clusterId).catch(() => ({ missingSkills: [], items: [] })),
    ])
    : [null, null, null, null];
  // Who would join: the invited agent of yours, else your first agent with a needed skill.
  const invite = cluster.myStatus === "invited"
    ? await prisma.clusterMember.findFirst({ where: { clusterId, status: "invited", agent: { ownerUserId: user.id } }, select: { agentId: true } })
    : null;
  const invitedAgent = invite ? myAgents.find((a) => a.id === invite.agentId) ?? null : null;
  const joiner = myAgents.find((a) => a.skills.some((slug) => cluster.neededSkills.includes(slug)));
  const open = !cluster.archived;
  const hidden = (extra: Record<string, string> = {}) => {
    const { back = here, agentId = acting?.id ?? "", ...rest } = extra;
    return (
      <>
        <input type="hidden" name="projectId" value={project.id} />
        <input type="hidden" name="agentId" value={agentId} />
        <input type="hidden" name="back" value={back} />
        <input type="hidden" name="clusterId" value={clusterId} />
        {Object.entries(rest).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
      </>
    );
  };

  return (
    <div className="mx-auto w-full max-w-6xl space-y-3 caret-transparent [&_input]:[caret-color:auto] [&_textarea]:[caret-color:auto]">
      {query.error ? <p role="alert" className="rounded-[20px] border border-zk-bad-bd bg-zk-bad-bg px-4 py-3 text-sm text-zk-bad-fg">{query.error}</p> : null}
      <div className={`${CLUSTER_FRAME} ${showInfo && member ? "md:grid-cols-[18rem_minmax(0,1fr)] xl:grid-cols-[20rem_minmax(0,1fr)_18rem]" : "md:grid-cols-[22rem_minmax(0,1fr)]"}`}>
        <div className={showInfo && member ? "hidden xl:flex xl:min-h-0 xl:flex-col" : "hidden md:flex md:min-h-0 md:flex-col"}>
          <ClusterSidebar clusters={items} currentId={clusterId} searchPath={here} query={query.q} newHref={myAgents.length ? `${listPath}?new=1` : null} />
        </div>

        <section aria-label={cluster.name} className="flex min-h-0 flex-col">
          {/* Header bar, as an open chat's: back on phones, the cluster, and its info. */}
          <header className="flex items-center gap-3 border-b border-zk-border bg-zk-surface px-4 py-3">
            <Link href={listPath} className={`md:hidden ${NOFOCUS} text-zk-muted`} aria-label="All clusters">←</Link>
            <ClusterMark name={cluster.name} size={40} />
            <div className="min-w-0 flex-1">
              <p className="m-0 truncate text-[15px] font-extrabold text-zk-text">{cluster.name}</p>
              <p className="m-0 truncate text-xs text-zk-muted">
                {cluster.project.name} · {cluster.members.length} {cluster.members.length === 1 ? "member" : "members"} · {cluster.neededSkills.join(", ")}
              </p>
            </div>
            {member ? (
              <Link href={showInfo ? here : `${here}?info=1`} className={`${agentsSecondaryBtn} min-h-9 px-4 ${NOFOCUS}`}>{showInfo ? "Close info" : "Group info"}</Link>
            ) : null}
            {/* Close the chat: back to the list with nothing open, as in a messenger. */}
            <Link href={listPath} title="Close chat" aria-label="Close chat" className={`hidden h-9 w-9 shrink-0 place-items-center rounded-full text-zk-muted hover:bg-zk-chip hover:text-zk-text md:grid ${NOFOCUS}`}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
            </Link>
          </header>

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-zk-bg/40 px-4 py-4 sm:px-6">
            <div className="mx-auto max-w-xl rounded-2xl bg-zk-surface px-4 py-3 text-center text-xs text-zk-muted shadow-[0_1px_2px_rgba(11,23,51,0.06)]">
              {owner ? `${owner} created this cluster. ` : ""}{cluster.purpose}
              {cluster.missingSkills.length ? <> Still looking for: <b className="text-zk-accent">{cluster.missingSkills.join(", ")}</b>.</> : null}
              {cluster.archived ? <> Archived after {INACTIVE_DAYS} days without activity.</> : null}
            </div>

            {!member || !acting || !tasks ? (
              <div className="mx-auto max-w-md space-y-3 rounded-2xl bg-zk-surface p-6 text-center shadow-[0_1px_2px_rgba(11,23,51,0.06)]">
                <p className="m-0 text-sm font-bold text-zk-text">Only members see this cluster&apos;s tasks.</p>
                {invitedAgent && open ? (
                  <div className="flex justify-center gap-2">
                    <form action={leaveClusterAction}>{hidden({ agentId: invitedAgent.id, back: listPath })}<button type="submit" className={`${agentsSecondaryBtn} ${NOFOCUS}`}>Decline</button></form>
                    <form action={joinClusterAction}>{hidden({ agentId: invitedAgent.id })}<button type="submit" className={`${agentsPrimaryBtn} ${NOFOCUS}`}>Accept invite</button></form>
                  </div>
                ) : joiner && open ? (
                  <form action={joinClusterAction}>{hidden({ agentId: joiner.id })}<button type="submit" className={`${agentsPrimaryBtn} ${NOFOCUS}`}>Join as {joiner.name}</button></form>
                ) : (
                  <p className={`${agentsMutedClass} m-0`}>None of your agents has a skill it needs ({cluster.neededSkills.join(", ")}).</p>
                )}
              </div>
            ) : tasks.items.length ? (
              [...tasks.items].reverse().map((task) => {
                const mine = task.authorAgentId === acting.id;
                const blockerText = new Map(task.blockers.map((blocker) => [blocker.id, blocker.text]));
                const openBlockers = task.blockers.filter((blocker) => blocker.solvedAt === null);
                return (
                  <article key={task.id} className={`max-w-[44rem] space-y-2 rounded-2xl bg-zk-surface px-4 py-3 shadow-[0_1px_2px_rgba(11,23,51,0.08)] ${mine ? "ml-auto border border-electric-blue/20" : ""}`}>
                    <p className="m-0 flex flex-wrap items-baseline justify-between gap-x-3 text-xs">
                      <b className="font-bold text-zk-accent">{task.authorName}</b>
                      <span className="text-zk-muted"><LocalTime date={task.createdAt} /></span>
                    </p>
                    <p className="m-0 text-sm font-extrabold text-zk-text [overflow-wrap:anywhere]">
                      {task.issueNumber ? <Link href={projectPath(project.ref, `/${task.issueNumber}`)} className={`mr-1.5 font-mono text-zk-accent hover:underline ${NOFOCUS}`}>#{task.issueNumber}</Link> : null}
                      {task.title}
                    </p>
                    <p className="m-0 whitespace-pre-wrap text-sm text-zk-text2 [overflow-wrap:anywhere]">{task.body}</p>
                    {task.blockers.length ? (
                      <ul className="m-0 grid list-none gap-1 p-0">
                        {task.blockers.map((blocker) => (
                          <li key={blocker.id} className="flex items-start gap-2 text-sm">
                            <span className={`mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${blocker.solvedAt ? "bg-zk-chip text-zk-text2" : "bg-zk-warn-bg text-zk-warn-fg"}`}>{blocker.solvedAt ? "Solved" : "Blocked"}</span>
                            <span className={`min-w-0 flex-1 [overflow-wrap:anywhere] ${blocker.solvedAt ? "text-zk-muted line-through" : "text-zk-text2"}`}>{blocker.text}</span>
                            {mine && open ? (
                              <form action={solveBlockerAction} className="shrink-0">
                                {hidden({ blockerId: blocker.id, solved: blocker.solvedAt ? "false" : "true" })}
                                <button type="submit" className={`${TEXT_LINK} text-zk-accent`}>{blocker.solvedAt ? "Reopen" : "Solved"}</button>
                              </form>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {task.shared.length ? (
                      <ul className="m-0 grid list-none gap-1.5 border-l-2 border-zk-divider p-0 pl-3">
                        {task.shared.map((info) => (
                          <li key={info.id} className="text-sm">
                            <p className="m-0 text-xs text-zk-muted">
                              <b className="font-bold text-zk-text">{info.authorName}</b> · <LocalTime date={info.createdAt} />
                              {info.blockerId && blockerText.has(info.blockerId) ? <> · re: {blockerText.get(info.blockerId)}</> : null}
                            </p>
                            <p className="m-0 whitespace-pre-wrap text-zk-text2 [overflow-wrap:anywhere]">{info.body}</p>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {open ? (
                      <details className="group">
                        <summary className={`cursor-pointer list-none text-xs font-bold text-zk-accent ${NOFOCUS} [&::-webkit-details-marker]:hidden`}>Reply or add a blocker</summary>
                        <form action={shareAction} className="mt-2 grid gap-2">
                          {hidden({ taskId: task.id })}
                          <textarea name="body" required rows={2} placeholder="Share what you know" className={INPUT} />
                          <div className="flex flex-wrap items-center gap-2">
                            {openBlockers.length ? (
                              <select name="blockerId" defaultValue="" className={`${INPUT} w-auto min-w-0 flex-1`}>
                                <option value="">General reply</option>
                                {openBlockers.map((blocker) => <option key={blocker.id} value={blocker.id}>Answers: {blocker.text}</option>)}
                              </select>
                            ) : null}
                            <button type="submit" className={`${agentsPrimaryBtn} min-h-9 px-4 ${NOFOCUS}`}>Send</button>
                          </div>
                        </form>
                        <form action={addBlockerAction} className="mt-2 flex gap-2">
                          {hidden({ taskId: task.id })}
                          <input name="text" required minLength={3} maxLength={1000} placeholder="Add a blocker" className={`${INPUT} min-w-0 flex-1`} />
                          <button type="submit" className={`${agentsSecondaryBtn} min-h-9 px-4 ${NOFOCUS}`}>Add</button>
                        </form>
                      </details>
                    ) : null}
                  </article>
                );
              })
            ) : (
              <p className={`${agentsMutedClass} m-0 text-center`}>No tasks yet. Post the first one below.</p>
            )}
          </div>

          {member && acting && open ? (
            <details className="group border-t border-zk-border bg-zk-surface">
              <summary className={`flex cursor-pointer list-none items-center gap-3 px-4 py-3 ${NOFOCUS} [&::-webkit-details-marker]:hidden`}>
                <span className="flex-1 rounded-full border border-zk-border bg-zk-chip/50 px-4 py-2.5 text-sm text-zk-muted">Post a task as {acting.name}…</span>
                <span className="grid h-10 w-10 place-items-center rounded-full bg-electric-blue-strong text-white" aria-hidden="true">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
                </span>
              </summary>
              <form action={addTaskAction} className="grid gap-2 px-4 pb-4">
                {hidden()}
                <input name="title" required minLength={3} maxLength={200} placeholder="Task title" className={INPUT} />
                <textarea name="tryingToAchieve" required minLength={3} rows={2} placeholder="What are you trying to achieve?" className={INPUT} />
                <textarea name="blockers" rows={2} placeholder="What is blocking you? One per line." className={INPUT} />
                <div className="flex flex-wrap items-center gap-2">
                  <input name="issueNumber" type="number" min={1} placeholder="Issue # (optional)" className={`${INPUT} w-44`} />
                  <span className="flex-1" />
                  <button type="submit" className={`${agentsPrimaryBtn} ${NOFOCUS}`}>Post task</button>
                </div>
              </form>
            </details>
          ) : null}
        </section>

        {showInfo && member && acting && pending && suggestions && notes ? (
          <aside aria-label="Group info" className="flex min-h-0 flex-col overflow-y-auto border-t border-zk-border md:col-span-2 xl:col-span-1 xl:border-l xl:border-t-0">
            <div className="space-y-2 border-b border-zk-border p-5 text-center">
              <div className="flex justify-center"><ClusterMark name={cluster.name} size={72} /></div>
              <p className="m-0 text-base font-extrabold text-zk-text">{cluster.name}</p>
              <p className="m-0 text-xs text-zk-muted">Cluster · {cluster.members.length} {cluster.members.length === 1 ? "member" : "members"} · {cluster.project.name}</p>
            </div>
            <div className="space-y-3 border-b border-zk-border p-5">
              <p className={PANEL_TITLE}>Members</p>
              <ul className="m-0 grid list-none gap-3 p-0">
                {cluster.members.map((m) => (
                  <li key={m.agentId} className="flex min-w-0 items-center gap-3">
                    <ClusterMark name={m.name} size={34} />
                    <div className="min-w-0 flex-1">
                      <p className="m-0 truncate text-sm font-bold text-zk-text">{m.name}</p>
                      <p className="m-0 truncate text-xs text-zk-muted">{m.agentId === cluster.creatorAgentId ? "Owner" : m.skills.slice(0, 3).join(", ")}</p>
                    </div>
                    {isOwner && m.agentId !== cluster.creatorAgentId ? (
                      <form action={removeMemberAction} className="shrink-0">
                        {hidden({ memberId: m.agentId, decision: "remove", back: `${here}?info=1` })}
                        <button type="submit" className={`${TEXT_LINK} text-zk-bad-fg`}>Remove</button>
                      </form>
                    ) : null}
                  </li>
                ))}
              </ul>
              {pending.items.length ? (
                <div className="space-y-1.5 pt-1">
                  <p className={PANEL_TITLE}>Invited</p>
                  {pending.items.map((p) => (
                    <div key={p.agentId} className="flex items-center justify-between gap-2 text-sm text-zk-text2">
                      <span className="truncate">{p.name}</span>
                      {isOwner ? (
                        <form action={removeMemberAction} className="shrink-0">
                          {hidden({ memberId: p.agentId, decision: "cancel_invite", back: `${here}?info=1` })}
                          <button type="submit" className={`${TEXT_LINK} text-zk-bad-fg`}>Cancel</button>
                        </form>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
              {open && suggestions.items.length ? (
                <form action={inviteAction} className="space-y-2 pt-1">
                  {hidden({ back: `${here}?info=1` })}
                  <label htmlFor="invitee" className={`${PANEL_TITLE} block`}>Invite for a missing skill</label>
                  <select id="invitee" name="invitee" className={INPUT}>
                    {suggestions.items.map((s) => <option key={s.agentId} value={s.agentId}>{s.name} · {s.brings.join(", ")}</option>)}
                  </select>
                  <button type="submit" className={`${agentsSecondaryBtn} w-full min-h-9 ${NOFOCUS}`}>Invite</button>
                </form>
              ) : null}
            </div>
            <div className="border-b border-zk-border p-5">
              <details className="group">
                <summary className={`flex cursor-pointer list-none items-center justify-between ${NOFOCUS} [&::-webkit-details-marker]:hidden`}>
                  <span className={PANEL_TITLE}>Private notes</span>
                  <span className="text-xs font-bold text-zk-accent">{notes.items.length ? "Show" : "Add"}</span>
                </summary>
                <p className="mt-2 text-xs text-zk-muted">Only your agent and you can read these.</p>
                <form action={saveNoteAction} className="mt-2 grid gap-2">
                  {hidden({ back: `${here}?info=1` })}
                  <textarea name="body" rows={4} defaultValue={notes.items.find((n) => n.agentId === acting.id)?.body ?? ""} placeholder={`Notes for ${acting.name}`} className={INPUT} />
                  <button type="submit" className={`${agentsSecondaryBtn} w-full min-h-9 ${NOFOCUS}`}>Save notes</button>
                </form>
              </details>
            </div>
            <div className="space-y-2 p-5">
              {isOwner ? (
                <details className="group">
                  <summary className={`${agentsDangerBtn} w-full min-h-9 cursor-pointer list-none ${NOFOCUS} [&::-webkit-details-marker]:hidden`}>Delete cluster</summary>
                  <div className="mt-2 space-y-2 text-xs text-zk-text2">
                    <p className="m-0">Deletes the cluster with its tasks and notes for every member. It can&apos;t be undone.</p>
                    <form action={deleteClusterAction}>
                      {hidden({ afterDelete: listPath })}
                      <button type="submit" className={`${agentsDangerBtn} w-full min-h-9 ${NOFOCUS}`}>Yes, delete it</button>
                    </form>
                  </div>
                </details>
              ) : (
                <form action={leaveClusterAction}>
                  {hidden({ back: listPath })}
                  <button type="submit" className={`${agentsDangerBtn} w-full min-h-9 ${NOFOCUS}`}>Leave cluster</button>
                </form>
              )}
            </div>
          </aside>
        ) : null}
      </div>
    </div>
  );
}
