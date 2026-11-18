import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * A skill row with real content. An agent's skills always have a summary and a
 * description through the API and the forms, but imported or half-written rows
 * can be blank; a blank row is a placeholder, not something to index.
 */
export const populatedSkillWhere: Prisma.AgentSkillWhereInput = {
  summary: { not: "" },
  description: { not: "" },
};

/** Whether one skill says anything: the rule behind `populatedSkillWhere`. */
export function isPopulatedSkill(skill: { summary: string | null; description: string | null }): boolean {
  return Boolean(skill.summary?.trim()) && Boolean(skill.description?.trim());
}

/**
 * Which agents are public on Ziki (#agent-profile): not revoked, and with a
 * set-up profile (a tagline, an About me and at least one skill that says
 * something). One rule for the /agents directory, the sitemap and whether a
 * profile may be indexed, so an empty or placeholder record is never listed,
 * linked from a skill page or crawled as a profile.
 */
export const LISTED_AGENT_CONDITIONS: Prisma.AgentWhereInput[] = [
  { revokedAt: null },
  { tagline: { not: null } },
  { NOT: { tagline: "" } },
  { about: { not: null } },
  { NOT: { about: "" } },
  { skills: { some: populatedSkillWhere } },
];

export const listedAgentWhere: Prisma.AgentWhereInput = { AND: LISTED_AGENT_CONDITIONS };

/** Whether one agent is listed: the same rule, for an agent already loaded. */
export function isListedAgent(agent: {
  revokedAt: Date | null;
  tagline: string | null;
  about: string | null;
  skills: Array<{ summary: string | null; description: string | null }>;
}): boolean {
  return (
    !agent.revokedAt &&
    Boolean(agent.tagline?.trim()) &&
    Boolean(agent.about?.trim()) &&
    agent.skills.some(isPopulatedSkill)
  );
}

export type DirectoryTag = { slug: string; name: string; agents: number };

/**
 * The skill tags listed agents have: one per slug across every organisation (each
 * organisation keeps its own tags), with how many listed agents have it, most first.
 *
 * A tag counts only through a populated skill row, so an empty placeholder never
 * creates a skill page. `take` bounds what a sitemap builds in one request; the
 * directory omits it and shows every tag.
 */
export async function directoryTags(take?: number): Promise<DirectoryTag[]> {
  const tags = await prisma.skillTag.findMany({
    where: { skills: { some: { agent: listedAgentWhere, ...populatedSkillWhere } } },
    ...(take ? { take } : {}),
    select: {
      slug: true,
      name: true,
      _count: { select: { skills: { where: { agent: listedAgentWhere, ...populatedSkillWhere } } } },
    },
  });
  const bySlug = new Map<string, DirectoryTag>();
  for (const tag of tags) {
    const seen = bySlug.get(tag.slug);
    if (seen) seen.agents += tag._count.skills;
    else bySlug.set(tag.slug, { slug: tag.slug, name: tag.name, agents: tag._count.skills });
  }
  return [...bySlug.values()].sort((a, b) => b.agents - a.agents || a.name.localeCompare(b.name));
}

/** One skill's display name and how many listed agents have it; null when no listed agent does. */
export async function directoryTag(slug: string): Promise<DirectoryTag | null> {
  const tags = await prisma.skillTag.findMany({
    where: { slug, skills: { some: { agent: listedAgentWhere, ...populatedSkillWhere } } },
    select: {
      name: true,
      _count: { select: { skills: { where: { agent: listedAgentWhere, ...populatedSkillWhere } } } },
    },
  });
  if (!tags.length) return null;
  return { slug, name: tags[0].name, agents: tags.reduce((sum, tag) => sum + tag._count.skills, 0) };
}
