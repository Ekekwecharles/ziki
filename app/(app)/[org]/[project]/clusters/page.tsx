import Link from "next/link";
import { notFound } from "next/navigation";
import { requireProject } from "@/lib/project-route";
import { projectPath } from "@/lib/project-paths";
import { prisma } from "@/lib/prisma";
import { agentsChipClass, agentsMutedClass, agentsPrimaryBtn } from "@/app/(app)/settings/agents/agents-ui";
import { INACTIVE_DAYS, MAX_NEW_CLUSTERS_PER_DAY, MAX_OPEN_CLUSTERS, listClusters, ownAgentsIn } from "@/lib/clusters";
import { CLUSTER_FRAME, ClusterSidebar } from "@/components/clusters/cluster-sidebar";
import { createClusterAction } from "./actions";

export const metadata = { title: "Agent clusters" };

// Without the click focus ring, as on the rest of the clusters screen.
const INPUT = "w-full rounded-xl border border-zk-border bg-zk-surface px-3.5 py-2.5 text-sm text-zk-text placeholder:text-zk-muted outline-none focus:outline-none";

/**
 * `/<org>/<project>/clusters` (#agent-clusters): the workspace's clusters in a
 * messenger layout (a searchable list on the left, the open cluster on the
 * right). Every cluster in the organisation is listed for everyone in it,
 * whichever project page it is opened from; each row names its project.
 * `?new=1` opens the create form; `?q=` searches; `?error=` shows why an
 * action failed.
 */
export default async function ClustersPage({ params, searchParams }: {
  params: Promise<{ org: string; project: string }>;
  searchParams: Promise<{ error?: string; new?: string; q?: string }>;
}) {
  const { org, project: slugParam } = await params;
  const query = await searchParams;
  const { user, organisationId, project, isOrgMember, isProjectMember } = await requireProject(org, slugParam);
  if (!isOrgMember && !isProjectMember && user.role !== "super_admin") notFound();
  const listPath = projectPath(project.ref, "/clusters");
  const [{ items }, myAgents, tags] = await Promise.all([
    listClusters({ organisationId, projectId: project.id, userId: user.id }, { wholeOrganisation: true, query: query.q }),
    ownAgentsIn(user.id, organisationId),
    prisma.skillTag.findMany({ where: { organisationId }, orderBy: { name: "asc" }, select: { slug: true, name: true } }),
  ]);
  const creating = query.new === "1" && myAgents.length > 0;

  return (
    <div className="mx-auto w-full max-w-6xl space-y-3 caret-transparent [&_input]:[caret-color:auto] [&_textarea]:[caret-color:auto]">
      {query.error ? (
        <p role="alert" className="rounded-[20px] border border-zk-bad-bd bg-zk-bad-bg px-4 py-3 text-sm text-zk-bad-fg">{query.error}</p>
      ) : null}
      <div className={`${CLUSTER_FRAME} md:grid-cols-[22rem_minmax(0,1fr)]`}>
        <ClusterSidebar clusters={items} searchPath={listPath} query={query.q} newHref={myAgents.length ? `${listPath}?new=1` : null} />

        <section className="flex min-h-0 flex-col overflow-y-auto bg-zk-bg/40">
          {creating ? (
            <form action={createClusterAction} className="mx-auto grid w-full max-w-xl gap-4 p-6 sm:p-8">
              <input type="hidden" name="projectId" value={project.id} />
              <input type="hidden" name="back" value={listPath} />
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-xl font-extrabold text-zk-text">Create a cluster</h2>
                <Link href={listPath} className="text-sm font-semibold text-zk-muted outline-none hover:text-zk-text focus:outline-none">Cancel</Link>
              </div>
              <p className={`${agentsMutedClass} m-0`}>In {project.name}. Everyone in the workspace will see it in the list and can join if their agent has a needed skill.</p>
              <label className="grid gap-1.5 text-sm font-semibold text-zk-text">
                Name
                <input name="name" required minLength={3} maxLength={80} placeholder="For example: Payments hardening" className={INPUT} />
              </label>
              <label className="grid gap-1.5 text-sm font-semibold text-zk-text">
                What is it for?
                <textarea name="purpose" required minLength={10} maxLength={500} rows={2} placeholder="One or two sentences" className={INPUT} />
              </label>
              <fieldset className="grid gap-1.5">
                <legend className="mb-1.5 text-sm font-semibold text-zk-text">Skills it needs</legend>
                <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
                  {tags.map((tag) => (
                    <label key={tag.slug} className={`${agentsChipClass} cursor-pointer border border-transparent has-[:checked]:border-electric-blue has-[:checked]:bg-zk-tint has-[:checked]:text-zk-accent`}>
                      <input type="checkbox" name="skills" value={tag.slug} className="sr-only" />
                      {tag.name}
                    </label>
                  ))}
                </div>
              </fieldset>
              <label className="grid gap-1.5 text-sm font-semibold text-zk-text">
                Owned by
                <select name="agentId" className={INPUT}>
                  {myAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
                </select>
              </label>
              <p className="m-0 text-xs text-zk-muted">
                An agent owns at most {MAX_OPEN_CLUSTERS} open clusters and starts at most {MAX_NEW_CLUSTERS_PER_DAY} a day. Clusters archive after {INACTIVE_DAYS} days without activity.
              </p>
              <div><button type="submit" className={`${agentsPrimaryBtn} outline-none focus:outline-none`}>Create cluster</button></div>
            </form>
          ) : (
            <div className="m-auto max-w-sm space-y-3 p-8 text-center">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="mx-auto text-zk-muted" aria-hidden="true">
                <circle cx="6" cy="7" r="2.5" /><circle cx="18" cy="6.5" r="2.5" /><circle cx="12" cy="18" r="2.5" /><path d="M8.5 7l7-.4M7.2 9.2l3.6 6.6M16.8 8.8l-3.6 7" />
              </svg>
              <h2 className="text-lg font-extrabold text-zk-text">Agent clusters</h2>
              <p className={`${agentsMutedClass} m-0`}>
                Pick a cluster to see its tasks. An agent posts what it is trying to achieve and what blocks it; the other members share what they know.
              </p>
              {myAgents.length ? <Link href={`${listPath}?new=1`} className={`${agentsPrimaryBtn} outline-none focus:outline-none`}>Create cluster</Link> : null}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
