import { notFound } from "next/navigation";
import { ProjectOverviewView } from "@/components/project-overview";
import { optionalUser } from "@/lib/auth-helpers";
import { requireProject } from "@/lib/project-route";
import { loadProjectOverview } from "@/lib/project-overview";
import { projectHomePath } from "@/lib/marketing/project-home";
import { projectPath, projectRef } from "@/lib/project-paths";
import { prisma } from "@/lib/prisma";
import type { Metadata } from "next";
import { NOINDEX, pageMetadata } from "@/lib/seo/site";
import { projectDescription, projectJsonLd } from "@/lib/seo/projects";
import { JsonLd } from "@/components/json-ld";

type Props = { params: Promise<{ org: string; project: string }> };

/**
 * Search and share metadata (#seo-pages). Only a public project is described and
 * indexed; anything else says nothing about the project, not even its name,
 * since a guest must not learn that a private project exists.
 */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { org, project: slug } = await params;
  const project = await prisma.project.findFirst({
    where: { slug, visibility: "public", archivedAt: null, organisation: { slug: org, archivedAt: null } },
    select: { name: true, slug: true, goal: true, organisation: { select: { name: true, slug: true } } },
  });
  if (!project) return { robots: NOINDEX };
  return pageMetadata({
    title: `${project.name} by ${project.organisation.name}`,
    description: projectDescription(project),
    path: projectPath(projectRef(project.organisation.slug, project.slug)),
  });
}

/**
 * `/<org>/<project>`: the project's home (#project-urls): its Ideas list, or its
 * Marketing tab when the project is all marketing (#marketing-home). The
 * address picks the project and lib/project-route.ts checks access: a project
 * you can't see is a 404, like any unknown address.
 */
export default async function ProjectOverviewPage({ params }: Props) {
  const { org, project: slug } = await params;
  const user = await optionalUser();
  if (user) await requireProject(org, slug);
  const data = await loadProjectOverview(org, slug, user);
  if (!data) notFound();

  // A member's way into the work is where the project used to open: its
  // Marketing tab when it is all marketing, else its Ideas (#marketing-home).
  const workHref = data.isMember
    ? await projectHomePath(prisma, data.project.id, projectRef(data.project.organisation.slug, data.project.slug))
    : null;

  const jsonLd = projectJsonLd(data.project);
  return (
    <>
      {jsonLd ? <JsonLd data={jsonLd} /> : null}
      <ProjectOverviewView data={data} currentUserId={user?.id ?? null} workHref={workHref} />
    </>
  );
}
