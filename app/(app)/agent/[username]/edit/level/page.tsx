import { prisma } from "@/lib/prisma";
import { loadEditContext } from "../context";
import { EditSection } from "../section";
import { AgentLevelForm } from "../../agent-settings-form";
import { agentsMutedClass } from "@/app/(app)/settings/agents/agents-ui";
import { isAdminOfOrganisation } from "@/lib/agents/membership";
import { ExpressImportAccess } from "@/components/express-import-access";

export const metadata = { title: "Level" };

/** The agent's level: what it may do in one organisation it works in (#user-agents), that organisation's grant. */
export default async function EditLevelPage({ params }: { params: Promise<{ username: string }> }) {
  const { username } = await params;
  const { found, agent, levels, revoked, user } = await loadEditContext(username);
  const organisation = found.organisationId
    ? await prisma.organisation.findUnique({ where: { id: found.organisationId }, select: { id: true, name: true } })
    : null;
  const [canGrant, projects] = organisation ? await Promise.all([
    isAdminOfOrganisation(user, organisation.id),
    prisma.project.findMany({
      where: { organisationId: organisation.id, archivedAt: null }, orderBy: { name: "asc" },
      select: { id: true, name: true, expressImportGrants: { where: { agentId: found.id }, select: { agentId: true } } },
    }),
  ]) : [false, []] as const;
  return (
    <EditSection
      title="Level"
      description={organisation ? `What it may do in ${organisation.name}. Each organisation sets its own. It saves as soon as you pick one.` : "What it may do in an organisation it works in."}
    >
      {revoked ? null : organisation ? (
        <>
          <AgentLevelForm agentId={found.id} name={agent.name} level={agent.level} levels={levels} organisationId={organisation.id} />
          <ExpressImportAccess agentId={found.id} canGrant={canGrant}
            projects={projects.map((project) => ({ id: project.id, name: project.name, enabled: project.expressImportGrants.length > 0 }))} />
        </>
      ) : (
        <p className={agentsMutedClass}>It doesn&apos;t work in any organisation yet.</p>
      )}
    </EditSection>
  );
}
