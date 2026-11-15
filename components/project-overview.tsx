import Link from "next/link";
import { Avatar } from "@/components/avatar";
import { RichText } from "@/components/rich-text";
import { ProjectOverviewJoinButton } from "@/components/project-overview-join-button";
import { ProjectJoinRequestButton } from "@/components/project-join-request-button";
import { Badge } from "@/components/ui/badge";
import { issuesPath, marketingPath, orgHomePath, projectRef } from "@/lib/project-paths";
import { publicReportPath } from "@/lib/public-project-paths";
import { safeHref } from "@/lib/rich-text";
import type { ProjectOverviewData } from "@/lib/project-overview";

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-zk-border bg-zk-surface p-4">
      <dt className="text-sm text-zk-text2">{label}</dt>
      <dd className="mt-1 text-2xl font-bold text-zk-text">{value.toLocaleString()}</dd>
    </div>
  );
}

function ResourceLink({
  label,
  url,
  detail,
}: {
  label: string;
  url: string | null;
  detail?: string | null;
}) {
  const href = url ? safeHref(url) : null;
  if (!href) return null;
  const display = href.replace(/^https?:\/\//i, "").replace(/\/$/, "");

  return (
    <li>
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="break-all text-sm font-medium text-zk-accent hover:underline"
      >
        <span className="text-zk-text2">{label}: </span>{display}
      </a>
      {detail ? <p className="mt-1 text-xs text-zk-muted">{detail}</p> : null}
    </li>
  );
}

function PersonRow({
  person,
  badgeLabel,
  isCurrentUser,
}: {
  person: { id: string; name: string; image: string | null };
  badgeLabel: string;
  isCurrentUser: boolean;
}) {
  return (
    <li className="flex items-center gap-3">
      <Avatar name={person.name} image={person.image} size="sm" />
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-zk-text">
        {person.name}
        {isCurrentUser ? <span className="ml-1 text-zk-muted">(you)</span> : null}
      </span>
      <Badge className="shrink-0 border border-zk-border bg-zk-chip text-xs text-zk-text2">{badgeLabel}</Badge>
    </li>
  );
}

export function ProjectOverviewView({
  data,
  currentUserId,
  workHref,
}: {
  data: ProjectOverviewData;
  currentUserId: string | null;
  /** Where a member starts work: the project's Marketing tab or its Ideas. */
  workHref: string | null;
}) {
  const { project } = data;
  const ref = projectRef(project.organisation.slug, project.slug);
  const repositories = [
    ...(project.repoUrl ? [{ label: "GitHub", url: project.repoUrl, detail: null }] : []),
    ...project.repositories.map((repository) => ({
      label: repository.label || "Repository",
      url: repository.url,
      detail: repository.branch ? `Branch: ${repository.branch}` : null,
    })),
  ].filter((repository, index, all) =>
    all.findIndex((candidate) => candidate.url === repository.url) === index
  );
  const resources = [
    ...repositories,
    { label: "Live", url: project.siteUrl, detail: null },
    { label: "Staging", url: project.stagingUrl, detail: null },
  ].filter((resource) => resource.url && safeHref(resource.url));

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 px-4 pb-10">
      <header className="rounded-2xl border border-zk-border bg-zk-surface p-5 sm:p-7">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div className="min-w-0">
            <p className="mb-2 text-sm text-zk-text2">
              <Link href={orgHomePath(project.organisation.slug)} className="hover:text-zk-accent hover:underline">
                {project.organisation.name}
              </Link>
              <span className="mx-2 text-zk-muted">/</span>
              <span>{project.slug}</span>
            </p>
            <h1 className="text-3xl font-extrabold tracking-tight text-zk-text">{project.name}</h1>
            <div className="mt-3 flex flex-wrap gap-2">
              <Badge className="border border-zk-border bg-zk-chip text-zk-text2">
                {project.visibility === "public" ? "Public" : "Private"}
              </Badge>
              {project.isOpenForContributors ? (
                <Badge className="border border-zk-border bg-zk-chip text-zk-text2">
                  Open for collaboration
                </Badge>
              ) : null}
            </div>
          </div>
          <div className="flex items-center gap-3">
            {project.acceptsGuestIdeas ? (
              <Link
                href={publicReportPath({ orgSlug: project.organisation.slug, projectSlug: project.slug })}
                className="inline-flex min-h-10 items-center justify-center rounded-xl border border-zk-border bg-zk-surface px-4 py-2 text-sm font-semibold text-zk-text hover:bg-zk-chip"
              >
                Report an issue
              </Link>
            ) : null}
            {data.canManage ? (
              <Link
                href={`/projects/${encodeURIComponent(project.slug)}/settings`}
                aria-label="Project settings"
                title="Project settings"
                className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-zk-border text-zk-text2 hover:bg-zk-chip hover:text-zk-text"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="3" />
                  <path d="m19.4 15 .1.1a1.7 1.7 0 0 1-2.4 2.4l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a1.7 1.7 0 0 1-3.4 0v-.2a1.7 1.7 0 0 0-2.9-1.2l-.1.1a1.7 1.7 0 1 1-2.4-2.4l.1-.1a1.7 1.7 0 0 0-1.2-2.9H4a1.7 1.7 0 0 1 0-3.4h.2a1.7 1.7 0 0 0 1.2-2.9l-.1-.1a1.7 1.7 0 1 1 2.4-2.4l.1.1a1.7 1.7 0 0 0 2.9-1.2V4a1.7 1.7 0 0 1 3.4 0v.2a1.7 1.7 0 0 0 2.9 1.2l.1-.1a1.7 1.7 0 1 1 2.4 2.4l-.1.1a1.7 1.7 0 0 0 1.2 2.9h.2a1.7 1.7 0 0 1 0 3.4h-.2a1.7 1.7 0 0 0-1.2.9Z" />
                </svg>
              </Link>
            ) : null}
            {!data.isMember && project.isOpenForContributors ? (
              currentUserId ? (
                <ProjectOverviewJoinButton projectId={project.id} />
              ) : (
                <Link
                  href={`/login?callbackUrl=${encodeURIComponent(`/${ref}`)}`}
                  className="inline-flex min-h-10 items-center justify-center rounded-xl bg-zk-accent px-4 py-2 text-sm font-bold text-white hover:opacity-90"
                >
                  Sign in to Join
                </Link>
              )
            ) : !data.isMember && project.visibility === "public" ? (
              // Public but not open: ask the maintainers instead (#join-requests).
              currentUserId ? (
                <ProjectJoinRequestButton project={project} state={data.joinRequest} size="md" />
              ) : (
                <Link
                  href={`/login?callbackUrl=${encodeURIComponent(`/${ref}`)}`}
                  className="inline-flex min-h-10 items-center justify-center rounded-xl border border-zk-border bg-zk-surface px-4 py-2 text-sm font-semibold text-zk-text hover:bg-zk-chip"
                >
                  Sign in to ask to join
                </Link>
              )
            ) : null}
          </div>
        </div>

        <dl className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Metric label="Open ideas" value={data.openIdeas} />
          <Metric label="Open issues" value={data.openIssues} />
          <Metric label="Delivered fixes" value={data.deliveredFixes} />
          <Metric label="Contributors" value={project.contributorCount} />
        </dl>
      </header>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <section aria-labelledby="project-goal-heading" className="rounded-2xl border border-zk-border bg-zk-surface p-5 sm:p-6">
            <h2 id="project-goal-heading" className="text-lg font-bold text-zk-text">About &amp; goal</h2>
            {project.goal ? (
              <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-zk-text2">{project.goal}</p>
            ) : (
              <p className="mt-3 text-sm text-zk-muted">No project goal has been added yet.</p>
            )}
          </section>

          <section aria-labelledby="contributor-guidelines-heading" className="rounded-2xl border border-zk-border bg-zk-surface p-5 sm:p-6">
            <h2 id="contributor-guidelines-heading" className="text-lg font-bold text-zk-text">Contributor guidelines</h2>
            {project.contributorGuidelines ? (
              <RichText
                content={project.contributorGuidelines}
                className="!mt-3 !text-zk-text [&_a]:!text-zk-accent [&_pre]:!bg-zk-chip [&_pre]:!text-zk-text"
              />
            ) : (
              <p className="mt-3 text-sm text-zk-muted">Contributor guidelines haven&apos;t been added yet.</p>
            )}
          </section>

          {data.isMember && workHref ? (
            <section aria-label="Project actions" className="flex flex-wrap gap-3 border-t border-zk-border pt-5">
              <Link
                href={workHref}
                className="inline-flex min-h-10 items-center rounded-xl bg-zk-accent px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
              >
                {workHref === marketingPath(ref) ? "Open Marketing →" : "Browse Ideas →"}
              </Link>
              <Link
                href={issuesPath(ref, "open")}
                className="inline-flex min-h-10 items-center rounded-xl border border-zk-border bg-zk-surface px-4 py-2 text-sm font-semibold text-zk-text hover:bg-zk-chip"
              >
                View Issues →
              </Link>
            </section>
          ) : null}
        </div>

        <aside className="space-y-6">
          <section aria-labelledby="project-resources-heading" className="rounded-2xl border border-zk-border bg-zk-surface p-5">
            <h2 id="project-resources-heading" className="text-lg font-bold text-zk-text">Links &amp; environments</h2>
            {resources.length ? (
              <ul className="mt-4 space-y-3">
                {resources.map((repository) => (
                  <ResourceLink
                    key={repository.url}
                    label={repository.label}
                    url={repository.url}
                    detail={repository.detail}
                  />
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-sm text-zk-muted">No project links have been added yet.</p>
            )}
          </section>

          <section aria-labelledby="contributors-heading" className="rounded-2xl border border-zk-border bg-zk-surface p-5">
            <h2 id="contributors-heading" className="text-lg font-bold text-zk-text">Contributors</h2>
            <ul className="mt-4 space-y-4">
              {project.maintainer ? (
                <PersonRow
                  person={project.maintainer}
                  badgeLabel="Maintainer"
                  isCurrentUser={project.maintainer.id === currentUserId}
                />
              ) : null}
              {project.contributors.map((contributor) => (
                <PersonRow
                  key={contributor.id}
                  person={contributor}
                  badgeLabel="Contributor"
                  isCurrentUser={contributor.id === currentUserId}
                />
              ))}
            </ul>
            {!project.maintainer && project.contributors.length === 0 ? (
              <p className="mt-3 text-sm text-zk-muted">No contributors are listed yet.</p>
            ) : null}
            {project.contributorCount > project.contributors.length ? (
              <p className="mt-4 text-xs text-zk-muted">
                And {project.contributorCount - project.contributors.length} more contributor{project.contributorCount - project.contributors.length === 1 ? "" : "s"}.
              </p>
            ) : null}
          </section>
        </aside>
      </div>
    </div>
  );
}
