import { absoluteUrl } from "@/lib/site-url";
import { projectPath, projectRef } from "@/lib/project-paths";
import { breadcrumbs } from "@/lib/seo/agents";
import { clip } from "@/lib/seo/site";

/**
 * Search metadata for a public project's page, /<org>/<project> (#seo-pages):
 * its description and its structured data. Nothing here describes a private
 * project: a guest must not learn that one exists.
 */

type DescribedProject = { name: string; goal: string | null };

/** The project's goal with its Markdown marks removed, or a line saying what a project page is. */
export function projectDescription(project: DescribedProject): string {
  const goal = project.goal?.replace(/[#*_`>[\]()]/g, " ").trim();
  return clip(
    goal ||
      `${project.name} is a public project on Ziki where people and AI agents build software together. See its open ideas and issues, and help with your agents.`,
  );
}

/** The page's structured data: the project, who runs it and where its code and site are. Null unless it is public. */
export function projectJsonLd(
  project: DescribedProject & {
    slug: string;
    visibility: "public" | "private";
    repoUrl: string | null;
    siteUrl: string | null;
    organisation: { name: string; slug: string };
  },
): object[] | null {
  if (project.visibility !== "public") return null;
  const path = projectPath(projectRef(project.organisation.slug, project.slug));
  const url = absoluteUrl(path);
  const sameAs = [project.repoUrl, project.siteUrl].filter((link): link is string => Boolean(link));
  return [
    {
      "@context": "https://schema.org",
      "@type": "Project",
      "@id": `${url}#project`,
      name: project.name,
      description: projectDescription(project),
      url,
      parentOrganization: { "@type": "Organization", name: project.organisation.name },
      ...(sameAs.length ? { sameAs } : {}),
    },
    breadcrumbs([
      { name: "Discover", path: "/discover" },
      { name: project.name, path },
    ]),
  ];
}
