import type { Metadata } from "next";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { openSecret } from "@/lib/secret-box";
import { AGENT_LEVEL_LABELS } from "@/lib/agents/levels";
import { agentPageHref } from "@/lib/header-nav";
import { isAgentPlatformEnabled } from "@/lib/feature-flags";
import { loadOrg } from "../org-context";
import { OrgPageHeader, ReadOnlyNote } from "../org-ui";
import { AgentActivationButton } from "@/app/(app)/settings/agents/agent-activation-button";
import { AgentRowKey } from "@/app/(app)/settings/agents/agent-row-key";
import { agentsLink, agentsMutedClass, agentsPrimaryBtn, agentsSecondaryBtn, agentsSurface } from "@/app/(app)/settings/agents/agents-ui";

export const metadata: Metadata = { title: "Agents" };

/** A sealed key for copying again; one that can't be opened shows as not copyable. */
function reveal(sealed: string | null): string | null {
  if (!sealed) return null;
  try {
    return openSecret(sealed);
  } catch {
    return null;
  }
}

/**
 * The organisation's agents (#user-agents). A person owns their agents once;
 * every organisation they belong to may use all of them, and they choose
 * which work here. Your agents: bring each in or take it out, and copy its
 * key for this organisation (it works in every project here). Below, every
 * agent working here; an admin may take any of them out, and sets their
 * class on Members.
 */
export default async function OrgAgentsPage() {
  const { user, org } = await loadOrg();
  if (!org) return null;
  if (!isAgentPlatformEnabled()) {
    return (
      <div className="space-y-4">
        <OrgPageHeader title="Agents">The agent platform is not enabled in this environment.</OrgPageHeader>
      </div>
    );
  }

  const [mine, working] = await Promise.all([
    prisma.agent.findMany({
      where: { ownerUserId: user.id, revokedAt: null },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        name: true,
        username: true,
        model: true,
        activations: { where: { organisationId: org.id, deactivatedAt: null }, select: { level: true } },
        apiKeys: {
          where: { organisationId: org.id, revokedAt: null },
          orderBy: { createdAt: "desc" },
          select: { id: true, prefix: true, sealedKey: true, lastUsedAt: true },
        },
      },
    }),
    prisma.agentActivation.findMany({
      where: { organisationId: org.id, deactivatedAt: null, agent: { revokedAt: null } },
      orderBy: [{ activatedAt: "asc" }, { id: "asc" }],
      take: 500,
      select: {
        level: true,
        activatedAt: true,
        guest: true,
        agent: { select: { id: true, name: true, username: true, ownerUserId: true, owner: { select: { name: true, email: true } } } },
      },
    }),
  ]);
  const others = working.filter((row) => row.agent.ownerUserId !== user.id);
  const hasGuests = others.some((row) => row.guest);

  return (
    <div className="space-y-8">
      <OrgPageHeader title="Agents">
        Your agents are yours, wherever you work. {org.name} may use any of them; you choose which
        work here. An agent brought in works in every project of {org.name}, with its own key for it.
      </OrgPageHeader>

      <section aria-labelledby="my-agents-heading" className="space-y-3">
        <h2 id="my-agents-heading" className="text-lg font-extrabold text-zk-text">
          Your agents
        </h2>
        {mine.length === 0 ? (
          <div className={`${agentsSurface} border-dashed p-5 text-sm text-zk-text2`}>
            <p>You have no agents yet. Create one and it starts working here.</p>
            <Link href="/settings/connect" className={`mt-3 inline-flex ${agentsPrimaryBtn}`}>
              Create agent
            </Link>
          </div>
        ) : (
          <ul className="space-y-2">
            {mine.map((agent) => {
              const here = agent.activations[0] ?? null;
              const key = agent.apiKeys[0] ?? null;
              return (
                <li key={agent.id} className={`${agentsSurface} flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between`}>
                  <div className="min-w-0 space-y-0.5">
                    <Link href={agentPageHref(agent.username)} className={`text-base font-extrabold ${agentsLink}`}>
                      {agent.name}
                    </Link>
                    <p className="text-xs text-zk-muted">
                      {agent.model ? <>{agent.model} · </> : null}
                      {here ? <>Works here as {AGENT_LEVEL_LABELS[here.level].toLowerCase()}</> : <>Not working here</>}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {here && key ? (
                      <AgentRowKey apiKey={reveal(key.sealedKey)} prefix={key.prefix} organisationName={org.name} />
                    ) : null}
                    <AgentActivationButton
                      agentId={agent.id}
                      agentName={agent.name}
                      organisationId={org.id}
                      organisationName={org.name}
                      active={Boolean(here)}
                      className={here ? agentsSecondaryBtn : agentsPrimaryBtn}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="org-agents-heading" className="space-y-3">
        <h2 id="org-agents-heading" className="text-lg font-extrabold text-zk-text">
          Other people&apos;s agents here
        </h2>
        {org.admin ? null : (
          <ReadOnlyNote>Owners and admins can take an agent out of {org.name} and set its class on Members.</ReadOnlyNote>
        )}
        {hasGuests ? (
          <p className={agentsMutedClass}>
            On-call agents are helping {org.name} get started. They stay until
            {org.admin ? " you take them out" : " an owner or admin takes them out"}.
          </p>
        ) : null}
        {others.length === 0 ? (
          <p className={agentsMutedClass}>No one else has brought an agent into {org.name} yet.</p>
        ) : (
          <ul className="space-y-2">
            {others.map(({ agent, level, guest }) => (
              <li key={agent.id} className={`${agentsSurface} flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between`}>
                <div className="min-w-0 space-y-0.5">
                  <Link href={agentPageHref(agent.username)} className={`text-base font-extrabold ${agentsLink}`}>
                    {agent.name}
                  </Link>
                  <p className="text-xs text-zk-muted">
                    {/* A guest's owner isn't part of this workspace, so they aren't named here. */}
                    {guest ? <>On-call guest</> : <>{AGENT_LEVEL_LABELS[level]} · {agent.owner.name ?? agent.owner.email}&apos;s agent</>}
                  </p>
                </div>
                {org.admin ? (
                  <AgentActivationButton
                    agentId={agent.id}
                    agentName={agent.name}
                    organisationId={org.id}
                    organisationName={org.name}
                    active
                    className={agentsSecondaryBtn}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
