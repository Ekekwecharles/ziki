import Link from "next/link";
import { LocalTime } from "@/components/local-time";
import { ClusterMark } from "@/components/clusters/cluster-mark";

/** The messenger frame: the chat list on the left, the open cluster on the right. */
export const CLUSTER_FRAME = "grid overflow-hidden rounded-[20px] border border-zk-border bg-zk-surface md:h-[calc(100vh-13rem)] md:min-h-[560px]";

export type SidebarCluster = {
  id: string;
  name: string;
  purpose: string;
  members: { agentId: string }[];
  lastActivityAt: Date;
  myStatus: string | null;
  archived: boolean;
  project: { name: string; path: string };
  lastTask: { title: string; authorName: string } | null;
};

/**
 * The left column of the Clusters screen (#agent-clusters), laid out like a
 * messenger's chat list: a search box, then the workspace's clusters as rows
 * (mark, name, time, the latest task or purpose, project and members). Your
 * clusters come first; the rest are clusters you can open and join.
 */
export function ClusterSidebar({ clusters, currentId, searchPath, query, newHref }: {
  clusters: SidebarCluster[];
  currentId?: string;
  searchPath: string;
  query?: string;
  newHref: string | null;
}) {
  const mine = clusters.filter((c) => c.myStatus === "active");
  const others = clusters.filter((c) => c.myStatus !== "active");
  const row = (c: SidebarCluster) => {
    const on = c.id === currentId;
    return (
      <li key={c.id}>
        <Link
          href={`${c.project.path}/clusters/${c.id}`}
          aria-current={on ? "page" : undefined}
          className={`flex items-center gap-3 px-4 py-3 outline-none transition focus:outline-none ${on ? "bg-zk-tint" : "hover:bg-zk-chip/60"} ${c.archived ? "opacity-60" : ""}`}
        >
          <ClusterMark name={c.name} size={44} />
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline justify-between gap-2">
              <span className="truncate text-sm font-bold text-zk-text">{c.name}</span>
              <span className="shrink-0 text-[11px] text-zk-muted"><LocalTime date={c.lastActivityAt} /></span>
            </span>
            <span className="block truncate text-xs text-zk-text2">
              {c.lastTask ? `${c.lastTask.authorName}: ${c.lastTask.title}` : c.purpose}
            </span>
            <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-zk-muted">
              <span className="truncate">{c.project.name}</span>
              <span aria-hidden="true">·</span>
              <span className="shrink-0">{c.members.length} {c.members.length === 1 ? "member" : "members"}</span>
              {c.myStatus === "invited" ? <span className="shrink-0 rounded-full bg-zk-accent px-1.5 text-[10px] font-bold text-white">Invited</span> : null}
            </span>
          </span>
        </Link>
      </li>
    );
  };
  return (
    <div className="flex min-h-0 flex-col border-zk-border md:border-r">
      <div className="flex items-center justify-between gap-2 px-4 pb-2 pt-4">
        <h1 className="text-xl font-extrabold tracking-tight text-zk-text">Clusters</h1>
        {newHref ? (
          <Link href={newHref} title="Create cluster" aria-label="Create cluster" className="grid h-9 w-9 place-items-center rounded-full bg-electric-blue-strong text-white outline-none hover:bg-[#2552af] focus:outline-none">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
          </Link>
        ) : null}
      </div>
      <form action={searchPath} method="get" className="px-4 pb-3">
        <label className="sr-only" htmlFor="cluster-search">Search clusters</label>
        <input
          id="cluster-search"
          name="q"
          type="search"
          defaultValue={query ?? ""}
          placeholder="Search clusters"
          className="h-10 w-full rounded-full border border-zk-border bg-zk-chip/50 px-4 text-sm text-zk-text placeholder:text-zk-muted outline-none focus:outline-none"
        />
      </form>
      <div className="min-h-0 flex-1 overflow-y-auto border-t border-zk-border [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {mine.length ? (
          <>
            <p className="m-0 px-4 pb-1 pt-3 text-[11px] font-bold uppercase tracking-wide text-zk-muted">Your clusters</p>
            <ul className="m-0 list-none p-0">{mine.map(row)}</ul>
          </>
        ) : null}
        {others.length ? (
          <>
            <p className="m-0 px-4 pb-1 pt-3 text-[11px] font-bold uppercase tracking-wide text-zk-muted">Join a cluster</p>
            <ul className="m-0 list-none p-0">{others.map(row)}</ul>
          </>
        ) : null}
        {!clusters.length ? (
          <p className="m-0 px-4 py-6 text-sm text-zk-muted">{query ? "No clusters match your search." : "No clusters yet."}</p>
        ) : null}
      </div>
    </div>
  );
}
