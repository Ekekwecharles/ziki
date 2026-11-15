"use client";

import { Fragment } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ideasPath, marketingPath, orgHomePath, projectPath, projectRef, type ProjectRef } from "@/lib/project-paths";

/** The organisation's slug, and the project (none on the organisation's own page). */
export type BreadcrumbProject = { orgSlug: string; slug?: string; name?: string };

/** One step of the trail after the project: a page's name, linked when it is a page above the current one. */
type Crumb = { label: string; href?: string };

/** Each issue list's stage (the tabs across the top) and, when the stage has several, its step. */
const ISSUE_LISTS: Record<string, string[]> = {
  // Project Overview is the project's own page: the trail ends at the project's name.
  "your-work": [],
  open: ["In Progress", "Open"],
  "in-progress": ["In Progress", "In progress"],
  closed: ["In Progress", "Closed"],
  "possibly-delivered": ["In Progress", "Possibly delivered"],
  "your-call": ["In Progress", "Your call"],
  done: ["Delivered", "Done"],
  merge: ["Delivered", "Merge"],
  error: ["Delivered", "Error"],
  live: ["Live"],
  all: ["All issues"],
  rejected: ["All issues", "Rejected"],
  duplicates: ["All issues", "Duplicates"],
  finished: ["All issues", "Closed"],
  history: ["Merge history"],
  new: ["Report an issue"],
};
const IDEA_LISTS: Record<string, string> = { rejected: "Rejected", drafts: "Drafts" };
const MARKETING_PAGES: Record<string, string> = { "output-box": "Output box", settings: "Settings", ideas: "Rejected ideas", tasks: "Tasks" };

/** The project's settings, at its Goals section. */
function projectGoalsSettingsHref(ref: ProjectRef): string {
  const slug = decodeURIComponent(String(ref).split("/")[1] ?? "");
  return `/projects/${encodeURIComponent(slug)}/settings?section=goals`;
}

/**
 * What the page under the project is, from its path: [Ideas], [In Progress, Closed], [Issue #12], …
 * Every project page names itself here (#breadcrumbs), so none draws a trail of its own.
 */
function sectionOf(pathname: string, ref: ProjectRef): Crumb[] {
  const rest = pathname.slice(projectPath(ref).length).replace(/^\/+|\/+$/g, "");
  const [first, second, third] = rest.split("/");
  const named = (...labels: string[]) => labels.map((label) => ({ label }));
  if (!first) return [];
  if (/^[0-9]+$/.test(first)) return named(`Issue #${first}`);
  if (first === "ideas") {
    // The ideas lists are the New tab.
    if (second && /^[0-9]+$/.test(second)) return [{ label: "New", href: ideasPath(ref) }, { label: `Idea #${second}` }];
    return second && IDEA_LISTS[second] ? named("New", IDEA_LISTS[second]) : named("New");
  }
  if (first === "issues") return named(...(ISSUE_LISTS[second ?? "all"] ?? ["Issues"]).filter((part): part is string => Boolean(part)));
  // A goal's own page sits under the project's settings, where the goals are listed.
  if (first === "goals") return [{ label: "Goals", href: projectGoalsSettingsHref(ref) }, { label: "Goal" }];
  if (first === "marketing") {
    if (!second) return named("Marketing");
    if (second === "tasks" && third === "new") {
      return [{ label: "Marketing", href: marketingPath(ref) }, { label: "Tasks", href: marketingPath(ref, "tasks") }, { label: "New task" }];
    }
    return [{ label: "Marketing", href: marketingPath(ref) }, { label: MARKETING_PAGES[second] ?? "Marketing" }];
  }
  if (first === "tasks") return [{ label: "Marketing", href: marketingPath(ref) }, { label: "Tasks", href: marketingPath(ref, "tasks") }, { label: second ? `Task #${second}` : "Task" }];
  if (first === "features") {
    if (!second) return named("Feature plans");
    return [{ label: "Feature plans", href: projectPath(ref, "/features") }, { label: second === "new" ? "New plan" : "Plan" }];
  }
  const pages: Record<string, string> = { notes: "Notes", org: "Organisation", workstream: "Workstream", report: "Report an issue", import: "Import delivered work" };
  return pages[first] ? named(pages[first]) : [];
}

/**
 * The idea lists and the workstream sit in a narrower column (920 px) than the
 * other project pages (max-w-6xl). The breadcrumb takes the same width, so it
 * lines up with the page under it.
 */
function narrowPage(pathname: string, ref: ProjectRef): boolean {
  const [first, second] = pathname.slice(projectPath(ref).length).replace(/^\/+|\/+$/g, "").split("/");
  if (first === "workstream") return true;
  return first === "ideas" && !(second && /^[0-9]+$/.test(second));
}

const crumb = "rounded-md px-1.5 py-0.5 hover:bg-zk-chip hover:text-zk-text focus-visible:outline-2 focus-visible:outline-zk-accent";

/**
 * Where you are (#no-platforms): All Projects (the organisation's projects
 * page, `/<org>`), the project (its issue list) and the page in it. On the
 * projects page itself, All Projects is all there is.
 */
export function ProjectBreadcrumb({ project }: { project: BreadcrumbProject }) {
  const pathname = usePathname() ?? "";
  const projectsHref = orgHomePath(project.orgSlug);
  const ref = project.slug ? projectRef(project.orgSlug, project.slug) : null;
  const onProjects = !ref;
  const section = ref ? sectionOf(pathname, ref) : [];
  const width = ref && narrowPage(pathname, ref) ? "max-w-[920px]" : "max-w-6xl";
  return (
    <nav aria-label="Breadcrumb" className={`mx-auto mb-3 flex w-full ${width} items-center px-0.5 text-[13px] text-zk-text2 max-sm:mb-1`}>
      <ol className="flex min-w-0 flex-wrap items-center gap-0.5">
        {/* Every project of the organisation, with its health. */}
        <li className="min-w-0">
          <Link href={projectsHref} aria-current={onProjects ? "page" : undefined} className={`${crumb} block truncate ${onProjects ? "font-bold text-zk-text" : "font-medium text-zk-text2"}`}>
            All Projects
          </Link>
        </li>
        {!ref ? null : (
          <>
            <li aria-hidden="true" className="text-zk-muted">/</li>
            <li className="min-w-0">
              <Link href={projectPath(ref)} className={`${crumb} block truncate font-bold text-zk-text`}>{project.name}</Link>
            </li>
            {section.map((part, index) => (
              <Fragment key={part.label}>
                <li aria-hidden="true" className="text-zk-muted">/</li>
                {part.href && index < section.length - 1 ? (
                  <li className="min-w-0">
                    <Link href={part.href} className={`${crumb} block truncate font-medium text-zk-text2`}>{part.label}</Link>
                  </li>
                ) : (
                  <li aria-current={index === section.length - 1 ? "page" : undefined} className={`truncate px-1.5 ${index === section.length - 1 ? "" : "font-medium"}`}>{part.label}</li>
                )}
              </Fragment>
            ))}
          </>
        )}
      </ol>
      {ref ? <Link href={`${projectPath(ref)}/import`} className={`${crumb} ml-auto shrink-0 text-zk-accent`}>Import work</Link> : null}
    </nav>
  );
}
