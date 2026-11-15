import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { Button } from "@/components/ui/button";
import { issuesPath, projectRef } from "@/lib/project-paths";
import { NewProjectButton } from "@/app/(app)/[org]/new-project-form";
import { setProjectArchivedAction } from "@/app/(app)/projects/actions";
import { getPlatformRewardConfig, projectDefaultsFromPlatform } from "@/lib/points/platform-rewards";
import { loadOrg } from "../org-context";
import { OrgMessages, OrgPageHeader, oneParam } from "../org-ui";

/* Distinct browser-tab title; the root layout appends the site name. */
export const metadata = { title: "Projects" };

/** A project's settings page, at its first section. */
function settingsHref(slug: string): string {
  return `/projects/${encodeURIComponent(slug)}/settings`;
}

/**
 * The organisation's projects (#project-urls): one row each, opening the
 * project or (for owners and admins) its settings, where everything about it
 * lives: details, GitHub, workflow, goals, archiving and deleting. Owners
 * restore archived projects here.
 */
export default async function OrgProjectsPage({
  params: routeParams,
  searchParams,
}: {
  params: Promise<{ org: string; project: string }>;
  searchParams: Promise<{ error?: string | string[]; notice?: string | string[] }>;
}) {
  // The project the URL is in is the one marked current (#project-urls).
  const { project: currentSlug } = await routeParams;
  const { org } = await loadOrg();
  if (!org) return null;
  const params = await searchParams;
  const canManage = org.admin;

  const [projects, platformRewards] = await Promise.all([
    prisma.project.findMany({
      where: { organisationId: org.id },
      select: { id: true, name: true, slug: true, archivedAt: true, githubInstallationId: true, _count: { select: { bugs: true } } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    getPlatformRewardConfig(prisma),
  ]);
  const active = projects.filter((project) => !project.archivedAt);
  const archived = projects.filter((project) => project.archivedAt);
  const current = decodeURIComponent(currentSlug);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <OrgPageHeader title="Projects">
        One project per product inside {org.name}, such as a web app.
        {canManage ? " Each project's settings hold its details, GitHub, workflow, goals and archiving." : ""}
      </OrgPageHeader>

      <OrgMessages error={oneParam(params.error)} notice={oneParam(params.notice)} />

      <section aria-labelledby="projects-heading" className="overflow-hidden rounded-[20px] border border-zk-border bg-zk-surface">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zk-border px-5 py-4">
          <div>
            <h2 id="projects-heading" className="m-0 text-base font-bold text-zk-text">
              {active.length === 1 ? "1 project" : `${active.length} projects`}
            </h2>
            <p className="m-0 mt-0.5 text-xs text-zk-muted">Open one to work in it.</p>
          </div>
          <NewProjectButton orgSlug={org.slug} defaults={projectDefaultsFromPlatform(platformRewards)} />
        </div>

        {active.length === 0 ? (
          <p className="m-0 px-5 py-8 text-center text-sm text-zk-text2">
            {archived.length ? "No active projects. Restore one below, or create a new one." : "No projects yet. Create the first one."}
          </p>
        ) : (
          <ul className="m-0 list-none divide-y divide-zk-divider p-0">
            {active.map((project) => {
              const here = project.slug === current;
              return (
                <li key={project.id} className="flex items-center gap-4 px-5 py-3.5">
                  <span
                    aria-hidden="true"
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-zk-tint text-sm font-extrabold uppercase text-zk-accent"
                  >
                    {project.name.slice(0, 1)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="m-0 flex items-center gap-2 text-sm font-bold text-zk-text">
                      <Link href={issuesPath(projectRef(org.slug, project.slug), "your_work")} className="truncate hover:text-zk-accent hover:underline">
                        {project.name}
                      </Link>
                      {here ? <span className="rounded-full bg-zk-tint px-2 py-0.5 text-[11px] font-bold text-zk-accent">Current</span> : null}
                    </p>
                    <p className="m-0 mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-zk-muted">
                      <span className="font-mono">{project.slug}</span>
                      <span aria-hidden="true">·</span>
                      <span>{project._count.bugs === 1 ? "1 issue" : `${project._count.bugs} issues`}</span>
                      <span aria-hidden="true">·</span>
                      <span className={project.githubInstallationId ? "font-semibold text-zk-ok-fg" : ""}>
                        {project.githubInstallationId ? "GitHub connected" : "GitHub not connected"}
                      </span>
                    </p>
                  </div>
                  {canManage ? (
                    <Link
                      href={settingsHref(project.slug)}
                      className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-zk-border bg-zk-surface px-3.5 text-xs font-semibold text-zk-text hover:bg-zk-chip focus-visible:outline-2 focus-visible:outline-electric-blue"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <circle cx="12" cy="12" r="3" />
                        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                      </svg>
                      Settings
                    </Link>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {org.owner && archived.length > 0 ? (
        <section aria-labelledby="archived-heading" className="overflow-hidden rounded-[20px] border border-zk-border bg-zk-surface">
          <div className="border-b border-zk-border px-5 py-4">
            <h2 id="archived-heading" className="m-0 text-base font-bold text-zk-text">Archived</h2>
            <p className="m-0 mt-0.5 text-xs text-zk-muted">Hidden from the project switcher. Restore one to use it again; delete it from its settings.</p>
          </div>
          <ul className="m-0 list-none divide-y divide-zk-divider p-0">
            {archived.map((project) => (
              <li key={project.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
                <div className="min-w-0 flex-1">
                  <p className="m-0 truncate text-sm font-semibold text-zk-text2">{project.name}</p>
                  <p className="m-0 mt-0.5 text-xs text-zk-muted">
                    <span className="font-mono">{project.slug}</span> · {project._count.bugs === 1 ? "1 issue" : `${project._count.bugs} issues`}
                  </p>
                </div>
                <Link href={settingsHref(project.slug)} className="text-xs font-semibold text-zk-accent hover:underline">
                  Settings
                </Link>
                <form action={setProjectArchivedAction}>
                  <input type="hidden" name="projectId" value={project.id} />
                  <input type="hidden" name="archived" value="false" />
                  <Button type="submit" variant="secondary">
                    Restore
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
