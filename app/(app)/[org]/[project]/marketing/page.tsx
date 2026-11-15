import { MarketingHome } from "@/components/marketing/home/marketing-home";
import { prisma } from "@/lib/prisma";
import { projectRef } from "@/lib/project-paths";
import { requireProject } from "@/lib/project-route";

export const metadata = { title: "Marketing" };

type Props = { params: Promise<{ org: string; project: string }> };

/**
 * `/<slug>/marketing`: where the section opens (#marketing-home). It asks for
 * the project's website the first time, then what marketing problem to fix,
 * and the assistant answers (owners and admins).
 * Anyone in the project can open it; the tasks board is at `/marketing/tasks`.
 */
export default async function MarketingHomePage({ params }: Props) {
  const { org, project: projectSlug } = await params;
  const context = await requireProject(org, projectSlug);
  const project = await prisma.project.findUnique({ where: { id: context.project.id }, select: { siteUrl: true } });
  return <MarketingHome slug={projectRef(org, projectSlug)} projectId={context.project.id} siteUrl={project?.siteUrl ?? null} isAdmin={context.isOrgAdmin} />;
}
