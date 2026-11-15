import { prisma } from "@/lib/prisma";
import { absoluteUrl } from "@/lib/site-url";
import { agentPageHref, agentsSkillHref } from "@/lib/header-nav";
import { directoryTags, listedAgentWhere } from "@/lib/agents/directory";
import { comparisonHref, COMPARE_HREF } from "@/lib/compare/slug";
import { listComparisonCards } from "@/lib/compare/data";
import { projectPath, projectRef } from "@/lib/project-paths";
import { getSkills } from "@/app/(app)/skills/skills-data";

/**
 * The sitemap, in sections (#seo-sitemap). /sitemap.xml is an index of them;
 * each section is its own file under /sitemaps/, built from the database on
 * request so a new agent or skill appears without a deploy:
 *
 *   pages.xml          the public site: home, marketing pages, the agents directory, /compare, /discover, /skills
 *   compare.xml        every indexable comparison: Ziki against each platform, and published hand-written pairs
 *   skills.xml         /agents/skill/{tag} for every skill a listed agent has
 *   library.xml        /skills/{slug} for every skill in the skills library
 *   projects.xml       /<org>/<project> for every public project
 *   agents-{n}.xml     /agent/{username} for every listed agent, AGENTS_PER_FILE a file
 *
 * Only public, indexable pages are listed: an agent that is revoked or still
 * being set up has a noindex profile, so it isn't here either.
 */

/** Agents per sitemap file; search engines accept up to 50,000 URLs a file. */
export const AGENTS_PER_FILE = 10_000;

type Entry = { path: string; lastModified?: Date; changeFrequency?: "hourly" | "daily" | "weekly"; priority?: number };

const escapeXml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

function urlset(entries: Entry[]): string {
  const urls = entries.map((entry) =>
    [
      "  <url>",
      `    <loc>${escapeXml(absoluteUrl(entry.path))}</loc>`,
      entry.lastModified ? `    <lastmod>${entry.lastModified.toISOString()}</lastmod>` : null,
      entry.changeFrequency ? `    <changefreq>${entry.changeFrequency}</changefreq>` : null,
      entry.priority !== undefined ? `    <priority>${entry.priority.toFixed(1)}</priority>` : null,
      "  </url>",
    ]
      .filter(Boolean)
      .join("\n"),
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}

/** The sections, for the index: their file names and when each last changed. */
export async function sitemapSections(): Promise<Array<{ file: string; lastModified?: Date }>> {
  const [agentCount, newestAgent] = await Promise.all([
    prisma.agent.count({ where: listedAgentWhere }),
    prisma.agent.findFirst({ where: listedAgentWhere, orderBy: { updatedAt: "desc" }, select: { updatedAt: true } }),
  ]);
  const agentFiles = Math.max(1, Math.ceil(agentCount / AGENTS_PER_FILE));
  return [
    { file: "pages.xml" },
    { file: "compare.xml" },
    { file: "skills.xml", lastModified: newestAgent?.updatedAt },
    { file: "library.xml" },
    { file: "projects.xml" },
    ...Array.from({ length: agentFiles }, (_, index) => ({ file: `agents-${index + 1}.xml`, lastModified: newestAgent?.updatedAt })),
  ];
}

export function sitemapIndexXml(sections: Array<{ file: string; lastModified?: Date }>): string {
  const items = sections.map((section) =>
    [
      "  <sitemap>",
      `    <loc>${escapeXml(absoluteUrl(`/sitemaps/${section.file}`))}</loc>`,
      section.lastModified ? `    <lastmod>${section.lastModified.toISOString()}</lastmod>` : null,
      "  </sitemap>",
    ]
      .filter(Boolean)
      .join("\n"),
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${items.join("\n")}\n</sitemapindex>\n`;
}

/**
 * One section's XML, or null for a name that isn't a section. Issue pages, the
 * app, settings and the API are never listed (robots.ts keeps crawlers out of
 * the private ones).
 */
export async function sitemapSectionXml(file: string): Promise<string | null> {
  if (file === "pages.xml") {
    return urlset([
      { path: "/", changeFrequency: "weekly", priority: 1 },
      ...["/how-it-works", "/security", "/for-agents", "/developers"].map((path) => ({ path, changeFrequency: "weekly" as const, priority: 0.8 })),
      // New agents join all the time.
      { path: "/agents", changeFrequency: "hourly", priority: 0.9 },
      { path: COMPARE_HREF, changeFrequency: "weekly", priority: 0.8 },
      { path: "/discover", changeFrequency: "daily", priority: 0.8 },
      { path: "/skills", changeFrequency: "daily", priority: 0.8 },
    ]);
  }
  if (file === "compare.xml") {
    const cards = await listComparisonCards();
    return urlset(cards.map((card) => ({ path: comparisonHref(card.a.slug, card.b.slug), changeFrequency: "weekly" as const, priority: card.popular ? 0.7 : 0.5 })));
  }
  if (file === "skills.xml") {
    const tags = await directoryTags();
    return urlset(tags.map((tag) => ({ path: agentsSkillHref(tag.slug), changeFrequency: "daily" as const, priority: 0.6 })));
  }
  if (file === "library.xml") {
    const { skills } = await getSkills();
    return urlset(skills.map((skill) => ({ path: `/skills/${encodeURIComponent(skill.slug)}`, changeFrequency: "weekly" as const, priority: 0.6 })));
  }
  if (file === "projects.xml") {
    // Public projects only: the same rule as their pages' metadata, which indexes nothing else.
    const projects = await prisma.project.findMany({
      where: { visibility: "public", archivedAt: null, organisation: { archivedAt: null } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 50_000,
      select: { slug: true, updatedAt: true, organisation: { select: { slug: true } } },
    });
    return urlset(projects.map((project) => ({ path: projectPath(projectRef(project.organisation.slug, project.slug)), lastModified: project.updatedAt, changeFrequency: "daily" as const, priority: 0.6 })));
  }
  const match = /^agents-([1-9][0-9]{0,5})\.xml$/.exec(file);
  if (match) {
    const page = Number(match[1]);
    const agents = await prisma.agent.findMany({
      where: listedAgentWhere,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      skip: (page - 1) * AGENTS_PER_FILE,
      take: AGENTS_PER_FILE,
      select: { username: true, updatedAt: true },
    });
    if (agents.length === 0 && page > 1) return null;
    return urlset(
      agents.map((agent) => ({ path: agentPageHref(agent.username), lastModified: agent.updatedAt, changeFrequency: "daily" as const, priority: 0.7 })),
    );
  }
  return null;
}

/** Sitemaps are public and cheap to rebuild; let caches keep them an hour. */
export const SITEMAP_HEADERS = {
  "Content-Type": "application/xml; charset=utf-8",
  "Cache-Control": "public, max-age=3600, s-maxage=3600",
};
