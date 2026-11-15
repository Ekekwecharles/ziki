import { PRODUCT_TRACK } from "@/lib/marketing/track";
import Link from "next/link";
import type { Prisma } from "@prisma/client";
import "./history.css";
import { prisma } from "@/lib/prisma";
import { bugInOrganisation } from "@/lib/organisation-context";
import { requireProject } from "@/lib/project-route";
import { issuesPath, projectPath } from "@/lib/project-paths";
import { calculatePagination } from "@/lib/pagination";
import { PaginationControls } from "@/components/pagination-controls";
import { toSingleQueryParam } from "@/lib/search";
import { issueHref } from "@/lib/issue-ref";
import { parsePullRequestUrl } from "@/lib/github/pull-request-url";
import { DEPLOY_STAGES } from "@/lib/deploy-stage";
import {
  groupByPullRequest,
  latestMovement,
  mergePathOf,
  movementLabel,
  parseMergeBucket,
  type MergeBucket,
  type MergeMovement,
  type MergePath,
} from "@/lib/merge-history";
import { Arrow, MergeIcon, MergePathChips, PullRequestIcon, chipBase, mergedTone, openTone, stageChipClass } from "@/components/merge-path";

export const metadata = { title: "Merge history" };

const PAGE_SIZE = 20;
/** The release PR view groups everything on one page; this caps the query. */
const RELEASE_VIEW_LIMIT = 200;

type SearchParams = Promise<{ stage?: string | string[]; view?: string | string[]; page?: string | string[] }>;

const bucketTabs: { value: MergeBucket; label: string; tone: string }[] = [
  { value: "all", label: "All", tone: "" },
  { value: "dev", label: "Only in dev", tone: "text-zk-muted" },
  { value: "staging", label: "In staging", tone: "text-blue-600" },
  { value: "production", label: "In production", tone: "text-emerald-600" },
  { value: "not_linked", label: "Not linked", tone: "text-amber-700" },
];

/**
 * Which completed issues each tab lists. Staging and production stay empty
 * until the merger agent records those movements (see mergePathOf).
 */
function bucketWhere(bucket: MergeBucket): Prisma.BugWhereInput {
  switch (bucket) {
    case "all":
      return {};
    case "dev":
      return { pullRequestUrl: { not: null } };
    case "not_linked":
      return { pullRequestUrl: null };
    case "staging":
    case "production":
      return { id: { in: [] } };
  }
}

const dateFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const dateTimeFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

const movementTone = (m: MergeMovement | null, path: MergePath) =>
  path.bucket === "not_linked" ? "text-amber-800" : m?.kind === "opened" ? "text-violet-700" : "text-zk-text";

/** `/<slug>/issues/history` (#project-urls): the slug picks the project and checks access. */
export default async function MergeHistoryPage({ params: routeParams, searchParams }: { params: Promise<{ org: string; project: string }>; searchParams: SearchParams }) {
  const { org, project: slugParam } = await routeParams;
  const { organisationId: projectOrganisationId, project } = await requireProject(org, slugParam);
  const organisationId: string | null = projectOrganisationId;
  const projectId: string | null = project.id;

  const params = await searchParams;
  const bucket = parseMergeBucket(toSingleQueryParam(params.stage));
  const releaseView = toSingleQueryParam(params.view) === "release";

  // Completed work: live issues (a merged fix is live).
  const completed: Prisma.BugWhereInput = {
    ...bugInOrganisation(organisationId),
    ...PRODUCT_TRACK,
    ...(projectId ? { projectId } : {}),
    isDeleted: false,
    status: "resolved",
  };
  const where: Prisma.BugWhereInput = { AND: [completed, bucketWhere(bucket)] };

  const counts = Object.fromEntries(
    await Promise.all(
      bucketTabs.map(async ({ value }) => [value, await prisma.bug.count({ where: { AND: [completed, bucketWhere(value)] } })] as const),
    ),
  ) as Record<MergeBucket, number>;

  const pagination = calculatePagination({ page: params.page, pageSize: PAGE_SIZE, totalCount: counts[bucket] });
  const bugs = await prisma.bug.findMany({
    where,
    orderBy: [{ updatedAt: "desc" }, { number: "desc" }],
    skip: releaseView ? 0 : pagination.skip,
    take: releaseView ? RELEASE_VIEW_LIMIT : pagination.take,
    select: {
      id: true,
      number: true,
      title: true,
      updatedAt: true,
      pullRequestUrl: true,
      status: true,
      beneficiary: { select: { name: true } },
      project: { select: { slug: true, organisation: { select: { slug: true } } } },
    },
  });
  const rows = bugs.map((bug) => ({ ...bug, path: mergePathOf(bug) }));
  const releases = releaseView ? groupByPullRequest(rows) : [];

  const devRepo = rows.map((r) => parsePullRequestUrl(r.pullRequestUrl)?.repo).find(Boolean);
  const href = (next: { stage?: MergeBucket; view?: "release" | null }) => {
    const q = new URLSearchParams();
    const stage = next.stage ?? bucket;
    const view = next.view === undefined ? (releaseView ? "release" : null) : next.view;
    if (stage !== "all") q.set("stage", stage);
    if (view) q.set("view", view);
    const s = q.toString();
    return `${projectPath(project.ref, "/issues/history")}${s ? `?${s}` : ""}`;
  };

  return (
    <div className="merge-history mx-auto max-w-[1160px]">
      <div className="overflow-hidden rounded-[22px] border border-zk-divider bg-zk-surface">
        <div className="flex items-center justify-between gap-3 border-b border-zk-divider px-6 py-4 max-sm:px-4">
          <h1 className="text-[15px] font-semibold text-zk-text">Merge history</h1>
        </div>

        <div className="merge-tabs flex items-center justify-between gap-3 px-6 pb-3.5 pt-5 max-sm:px-4">
          <div className="flex flex-none gap-2">
            <Link href={issuesPath(project.ref, "all")} className="inline-flex h-10 items-center gap-2 rounded-[10px] bg-zk-chip px-3.5 text-[14px] font-medium text-zk-text2 hover:bg-zk-seg">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z" /></svg>
              Inbox
            </Link>
            <span aria-current="page" className="inline-flex h-10 items-center gap-2 rounded-[10px] bg-electric-blue-strong px-3.5 text-[14px] font-semibold text-white">
              <MergeIcon size={16} />
              <span className="max-sm:sr-only">Merge history</span>
            </span>
          </div>
          <nav aria-label="Filter by stage" className="merge-segs flex min-w-0 gap-0.5 overflow-x-auto rounded-xl bg-zk-chip p-[3px]">
            {bucketTabs.map(({ value, label, tone }) => {
              const current = value === bucket;
              return (
                <Link
                  key={value}
                  href={href({ stage: value })}
                  aria-current={current ? "page" : undefined}
                  className={`inline-flex h-[34px] flex-none items-center gap-2 whitespace-nowrap rounded-[10px] px-3 text-[14px] ${
                    current ? "bg-electric-blue-strong font-semibold text-white" : "font-medium text-zk-text2 hover:bg-zk-seg"
                  }`}
                >
                  <span className={`grid h-[22px] w-[22px] place-items-center rounded-full ${current ? "bg-white text-electric-blue-strong" : tone}`}>
                    <MergeIcon size={14} />
                  </span>
                  {label}
                  <span className={`font-mono text-[12px] ${current ? "rounded-md bg-white/25 px-1.5 text-white" : "text-zk-muted"}`}>{counts[value]}</span>
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="merge-vbar flex items-center justify-between gap-3 px-6 pb-4 max-sm:flex-col max-sm:items-stretch max-sm:px-4">
          <div role="group" aria-label="View" className="inline-flex gap-0.5 self-start rounded-[10px] bg-zk-chip p-[3px]">
            {[{ view: null, label: "By issue" }, { view: "release" as const, label: "By release PR" }].map(({ view, label }) => {
              const current = (view === "release") === releaseView;
              return (
                <Link
                  key={label}
                  href={href({ view })}
                  aria-current={current ? "page" : undefined}
                  className={`inline-flex h-[30px] items-center rounded-lg px-3 text-[13px] ${current ? "bg-zk-surface font-semibold text-zk-accent shadow-sm" : "font-medium text-zk-text2"}`}
                >
                  {label}
                </Link>
              );
            })}
          </div>
          <span className="flex flex-wrap items-center gap-1.5 text-[12.5px] text-zk-muted">
            Path:
            {DEPLOY_STAGES.map((stage, i) => (
              <span key={stage} className="contents">
                {i > 0 ? <Arrow /> : null}
                <span className={`${chipBase} ${stageChipClass[stage]}`}>{stage === "dev" && devRepo ? `${devRepo}/dev` : stage}</span>
              </span>
            ))}
          </span>
        </div>

        {rows.length === 0 || (releaseView && releases.length === 0) ? (
          <p className="mx-6 mb-6 rounded-[14px] border border-zk-divider px-5 py-10 text-center text-sm text-zk-muted max-sm:mx-4">
            {bucket === "staging" || bucket === "production"
              ? "Nothing recorded here yet. Staging and production show up once the merger agent records those merges."
              : rows.length === 0
                ? "No completed issues here yet."
                : "None of these issues has a pull request linked yet."}
          </p>
        ) : releaseView ? (
          <div className="mx-6 mb-6 flex flex-col gap-3 max-sm:mx-4">
            {releases.map(({ movement, rows: carried }) => (
              <section key={`${movement.repo}#${movement.prNumber}`} aria-label={`PR #${movement.prNumber}`} className="overflow-hidden rounded-[14px] border border-zk-divider">
                <div className="flex flex-wrap items-center gap-2.5 bg-zk-bg px-[18px] py-3.5">
                  <MovementIcon movement={movement} size={26} />
                  <PrLink movement={movement} className="text-[14.5px] font-semibold" />
                  <span className="inline-flex items-center gap-1">
                    <span className={`${chipBase} ${stageChipClass.dev}`}>{movement.repo ? `${movement.repo.split("/")[1]}/dev` : "dev"}</span>
                  </span>
                  <span className={`ml-auto rounded-full px-2.5 py-0.5 text-[12px] font-semibold ${movement.kind === "merged" ? mergedTone : openTone}`}>
                    {movement.kind === "merged" ? "Merged" : "Open"}
                  </span>
                  <span className="basis-full text-[12.5px] text-zk-muted">
                    {[movement.repo, movement.at ? `${movement.kind === "merged" ? "merged" : "updated"} ${dateTimeFmt.format(movement.at)}` : null, `carries ${carried.length} ${carried.length === 1 ? "issue" : "issues"}`].filter(Boolean).join(" · ")}
                  </span>
                </div>
                {carried.map((row) => (
                  <div key={row.id} className="merge-reli grid grid-cols-[64px_minmax(0,1fr)_auto] items-center gap-3 border-t border-zk-divider px-[18px] py-2.5 text-[14px]">
                    <span className="font-mono text-[12.5px] text-zk-muted">#{row.number}</span>
                    <Link href={issueHref(row)} className="truncate text-zk-text hover:text-zk-accent">{row.title}</Link>
                    <span className="whitespace-nowrap text-[12px] text-zk-muted">{row.beneficiary.name}</span>
                  </div>
                ))}
              </section>
            ))}
          </div>
        ) : (
          <div className="mx-6 overflow-hidden rounded-[14px] border border-zk-divider max-sm:mx-4">
            <div className="merge-row merge-head bg-zk-bg text-[13.5px] text-zk-text2" aria-hidden="true">
              <span>Completed issue</span><span>Path</span><span>Latest movement</span><span />
            </div>
            {rows.map((row) => {
              const latest = latestMovement(row.path);
              return (
                <details key={row.id} className="merge-item group border-t border-zk-divider">
                  <summary className="merge-row cursor-pointer list-none hover:bg-zk-bg [&::-webkit-details-marker]:hidden">
                    <div className="min-w-0">
                      <span className="block truncate text-[15px] text-zk-text">{row.title}</span>
                      <span className="mt-[3px] flex items-center gap-2 text-[12.5px] text-zk-muted">
                        <span className="font-mono">#{row.number}</span>
                        <span>{row.beneficiary.name}</span>
                        <span>Done {dateFmt.format(row.updatedAt)}</span>
                      </span>
                    </div>
                    <div className="merge-pcol"><MergePathChips path={row.path} /></div>
                    <div className="merge-lcol min-w-0 text-[13px]">
                      <span className={`block truncate font-medium ${movementTone(latest, row.path)}`}>
                        {latest ? movementLabel(latest) : "No pull request linked"}
                      </span>
                      {latest?.at ? <span className="mt-0.5 block text-[12px] text-zk-muted">{dateTimeFmt.format(latest.at)}</span> : null}
                    </div>
                    <span className="grid h-[30px] w-[30px] place-items-center rounded-lg border border-zk-border bg-zk-surface text-zk-muted" aria-hidden="true">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="transition-transform group-open:rotate-180"><path d="m6 9 6 6 6-6" /></svg>
                    </span>
                    <span className="sr-only">Show movements for #{row.number}</span>
                  </summary>
                  <div className="mx-[18px] mb-3 rounded-xl bg-zk-bg px-3.5 py-2.5 text-[13px]">
                    {row.path.movements.length === 0 ? (
                      <p className="text-zk-muted">No pull request is linked to this issue, so it can&apos;t be followed to staging or main.</p>
                    ) : (
                      row.path.movements.map((m) => (
                        <div key={`${m.stage}-${m.prNumber}`} className="flex items-start gap-2.5 py-1.5">
                          <MovementIcon movement={m} size={22} />
                          <span className="min-w-0 flex-1">
                            <PrLink movement={m} className="font-semibold" /> {m.kind === "merged" ? "merged" : "opened"} into {m.stage}
                            <span className="block text-zk-muted">{[m.repo, m.at ? dateTimeFmt.format(m.at) : null].filter(Boolean).join(" · ")}</span>
                          </span>
                        </div>
                      ))
                    )}
                    <Link href={issueHref(row)} className="mt-1.5 inline-block text-[12.5px] text-zk-accent hover:underline">Open issue #{row.number}</Link>
                  </div>
                </details>
              );
            })}
          </div>
        )}

        {!releaseView ? (
          <div className="px-6 pb-6 pt-5 max-sm:px-4">
            <PaginationControls
              page={pagination.page}
              totalPages={pagination.totalPages}
              totalCount={pagination.totalCount}
              from={pagination.from}
              to={pagination.to}
              queryParams={{ stage: bucket === "all" ? undefined : bucket }}
              basePath={projectPath(project.ref, "/issues/history")}
              itemLabel="completed issue"
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function MovementIcon({ movement, size }: { movement: MergeMovement; size: number }) {
  const merged = movement.kind === "merged";
  return (
    <span
      style={{ width: size, height: size }}
      className={`grid flex-none place-items-center rounded-full ${merged ? mergedTone : openTone}`}
    >
      {merged ? <MergeIcon size={size > 24 ? 13 : 12} /> : <PullRequestIcon size={size > 24 ? 13 : 12} />}
    </span>
  );
}

function PrLink({ movement, className = "" }: { movement: MergeMovement; className?: string }) {
  const label = `PR #${movement.prNumber}`;
  return movement.prUrl ? (
    <a href={movement.prUrl} target="_blank" rel="noreferrer" className={`text-zk-accent hover:underline ${className}`}>{label}</a>
  ) : (
    <span className={className}>{label}</span>
  );
}
