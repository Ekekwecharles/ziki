"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { joinOpenProjectAction } from "@/app/actions/project-join-requests";
import { ProjectJoinRequestButton } from "@/components/project-join-request-button";
import { projectPath, projectRef } from "@/lib/project-paths";
import { publicReportPath } from "@/lib/public-project-paths";

export type DiscoverableProject = {
  id: string;
  slug: string;
  name: string;
  goal: string | null;
  siteUrl: string | null;
  repoUrl: string | null;
  isOpenForContributors: boolean;
  acceptsGuestIdeas: boolean;
  contributorGuidelines: string | null;
  organisation: {
    id: string;
    name: string;
    slug: string;
  };
  _count: {
    bugs: number;
    ideas: number;
  };
  userStatus: "member" | "pending" | "rejected" | "none" | "guest";
};

export function DiscoverProjectCard({ project }: { project: DiscoverableProject }) {
  const currentStatus = project.userStatus;
  const router = useRouter();
  const [joining, startJoining] = useTransition();
  const [joinError, setJoinError] = useState<string | null>(null);
  const publicRef = { orgSlug: project.organisation.slug, projectSlug: project.slug };
  // Open projects take you in straight away (#earnings): no request, no waiting, then on to its work.
  const join = () =>
    startJoining(async () => {
      setJoinError(null);
      const result = await joinOpenProjectAction(project.id);
      if (result.ok) router.push(result.href);
      else setJoinError(result.error);
    });

  return (
    <>
      <article className="flex flex-col justify-between rounded-[20px] border border-zk-border bg-zk-surface p-5 transition hover:border-zk-border-hover sm:p-6">
        <div className="space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <span className="text-xs font-semibold uppercase tracking-wider text-zk-muted">
                {project.organisation.name}
              </span>
              <h3 className="text-lg font-bold text-zk-text">
                <Link
                  href={projectPath(projectRef(project.organisation.slug, project.slug))}
                  className="hover:text-zk-accent hover:underline"
                >
                  {project.name}
                </Link>
              </h3>
            </div>
            {project.isOpenForContributors ? (
              <Badge className="shrink-0 rounded-full border border-emerald-500/30 bg-emerald-500/10 text-[11px] font-semibold text-emerald-400">
                Open for Contributors
              </Badge>
            ) : (
              <Badge className="shrink-0 rounded-full border border-zk-border bg-zk-chip text-[11px] font-medium text-zk-text2">
                Not open for now
              </Badge>
            )}
          </div>

          <p className="line-clamp-2 text-sm text-zk-text2">
            {project.goal || "No project description provided."}
          </p>

          <div className="flex flex-wrap items-center gap-4 text-xs text-zk-muted">
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" />
              {project._count.bugs} open issues
            </span>
            <span className="flex items-center gap-1.5">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="shrink-0 text-zk-muted"
                aria-hidden="true"
              >
                <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5" />
                <path d="M9 18h6" />
                <path d="M10 22h4" />
              </svg>
              {project._count.ideas} ideas
            </span>
          </div>
        </div>

        <div className="mt-5 flex items-center justify-between border-t border-zk-divider pt-4">
          <div className="flex items-center gap-2 text-xs text-zk-muted">
            {project.repoUrl ? (
              <a
                href={project.repoUrl}
                target="_blank"
                rel="noreferrer"
                className="hover:text-zk-text hover:underline"
              >
                Code ↗
              </a>
            ) : null}
            {project.siteUrl ? (
              <a
                href={project.siteUrl}
                target="_blank"
                rel="noreferrer"
                className="hover:text-zk-text hover:underline"
              >
                Website ↗
              </a>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2">
            {project.acceptsGuestIdeas ? (
              <Link href={publicReportPath(publicRef)}>
                <Button variant="secondary" className="text-xs font-semibold">
                  Report issue
                </Button>
              </Link>
            ) : null}
            {currentStatus === "guest" ? (
              project.isOpenForContributors ? (
                <Link href={`/login?callbackUrl=${encodeURIComponent("/discover")}`}>
                  <Button
                    variant="primary"
                    className="text-xs font-semibold"
                  >
                    Sign in to Join
                  </Button>
                </Link>
              ) : (
                <Link href={`/login?callbackUrl=${encodeURIComponent("/discover")}`}>
                  <Button variant="secondary" className="text-xs font-semibold">
                    Sign in to ask to join
                  </Button>
                </Link>
              )
            ) : currentStatus === "member" ? (
              <Link href={projectPath(projectRef(project.organisation.slug, project.slug))}>
                <Button variant="secondary" className="text-xs font-medium">
                  Open Project →
                </Button>
              </Link>
            ) : project.isOpenForContributors ? (
              // Open means anyone may join, so an earlier declined request no longer stands in the way.
              <div className="flex flex-col items-end gap-1">
                <Button variant="primary" onClick={join} disabled={joining} className="text-xs font-bold">
                  {joining ? "Joining…" : "Join"}
                </Button>
                {joinError ? <p role="alert" className="text-xs text-zk-bad-fg">{joinError}</p> : null}
              </div>
            ) : (
              <ProjectJoinRequestButton project={project} state={currentStatus} />
            )}
          </div>
        </div>
      </article>

    </>
  );
}
