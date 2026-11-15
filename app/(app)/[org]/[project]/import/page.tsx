import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireProject } from "@/lib/project-route";
import { isAgentPlatformEnabled } from "@/lib/feature-flags";
import { OutsideWorkForm, ExpressImportRequestQueue } from "@/components/outside-work-form";

export const metadata = { title: "Import delivered work" };

export default async function ImportOutsideWorkPage({ params }: { params: Promise<{ org: string; project: string }> }) {
  if (!isAgentPlatformEnabled()) notFound();
  const { org, project: slug } = await params;
  const { project, user, isOrgAdmin } = await requireProject(org, slug);
  const [agents, requests] = await Promise.all([
    prisma.agent.findMany({ where: { ownerUserId: user.id, revokedAt: null, activations: { some: { organisationId: project.organisationId, deactivatedAt: null } } }, orderBy: { name: "asc" }, select: {
      id: true, name: true, expressImportGrants: { where: { projectId: project.id }, select: { agentId: true } }, expressImportRequests: { where: { projectId: project.id }, select: { decision: true, response: true } },
    } }),
    isOrgAdmin ? prisma.expressImportRequest.findMany({ where: { projectId: project.id, decision: "pending", agent: { revokedAt: null, activations: { some: { organisationId: project.organisationId, deactivatedAt: null } } } }, orderBy: { requestedAt: "asc" }, select: { agentId: true, reason: true, agent: { select: { name: true, username: true, owner: { select: { name: true } } } } } }) : Promise.resolve([]),
  ]);
  return <main className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
    <h1 className="mb-2 text-2xl font-bold text-zk-text">Import delivered work</h1>
    <p className="mb-6 text-sm text-zk-text2">Record work already delivered outside the board in {project.name}, without an idea, bid or claim.</p>
    <OutsideWorkForm projectId={project.id} agents={agents.map((agent) => ({ id: agent.id, name: agent.name, enabled: agent.expressImportGrants.length > 0, request: agent.expressImportRequests[0] ?? null }))} />
    {isOrgAdmin ? <ExpressImportRequestQueue projectId={project.id} requests={requests.map((request) => ({ agentId: request.agentId, name: request.agent.name, username: request.agent.username, owner: request.agent.owner.name ?? "Agent owner", reason: request.reason }))} /> : null}
  </main>;
}
