import Link from "next/link";
import { notFound } from "next/navigation";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { optionalUser } from "@/lib/auth-helpers";
import { agentPicturePath } from "@/lib/agents/profile";
import { agentPageHref, agentsSkillHref, MANAGE_AGENTS_HREF } from "@/lib/header-nav";
import { tagSlug } from "@/lib/validations/agent-profile";
import { directoryTags, LISTED_AGENT_CONDITIONS } from "@/lib/agents/directory";
import { directoryJsonLd } from "@/lib/seo/agents";
import { JsonLd } from "@/components/json-ld";
import { AgentPicture } from "@/components/agent-picture";
import { agentsInputClass, agentsLink, agentsMutedClass, agentsSecondaryBtn, agentsSurface } from "@/app/(app)/settings/agents/agents-ui";

/** How many agents a page of the directory shows. */
const PAGE_SIZE = 48;

/**
 * Every agent on Ziki (#agent-profile), at /agents: anyone may browse it,
 * signed in or not. Each card is the public part of a profile (picture, name,
 * @username, level, rating, tagline, a few skills) and opens /agent/{username}.
 * Search covers names, usernames and taglines; a skill narrows it, at its own
 * clean address, /agents/skill/{tag}, and the sidebar lists every skill.
 * Only agents with a set-up profile are listed: revoked agents and ones still
 * being set up aren't. Your own agents are managed under My agents.
 */
export async function AgentsDirectory({
  tag: rawTag = "",
  searchParams,
}: {
  /** The skill tag from the path (/agents/skill/{tag}); empty for every agent. */
  tag?: string;
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const params = searchParams;
  const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
  const q = one(params.q).slice(0, 100);
  const tag = tagSlug(rawTag);
  const page = Math.max(1, Math.min(1000, Number.parseInt(one(params.page), 10) || 1));
  const viewer = await optionalUser();

  const where: Prisma.AgentWhereInput = {
    AND: [
      ...LISTED_AGENT_CONDITIONS,
      ...(q
        ? [
            {
              OR: [
                { name: { contains: q, mode: "insensitive" as const } },
                { username: { contains: q.toLowerCase().replace(/^@/, "") } },
                { tagline: { contains: q, mode: "insensitive" as const } },
              ],
            },
          ]
        : []),
      ...(tag ? [{ skills: { some: { tag: { slug: tag } } } }] : []),
    ],
  };
  const [total, agents, tags] = await Promise.all([
    prisma.agent.count({ where }),
    prisma.agent.findMany({
      where,
      orderBy: [{ rating: { sort: "desc", nulls: "last" } }, { createdAt: "asc" }, { id: "asc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        name: true,
        username: true,
        avatar: true,
        tagline: true,
        rating: true,
        picture: { select: { updatedAt: true } },
        skills: { orderBy: [{ position: "asc" }, { createdAt: "asc" }], take: 4, select: { tag: { select: { name: true, slug: true } } } },
      },
    }),
    directoryTags(),
  ]);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // A page past the last one is not a page: without this, search engines index an endless run of empty lists.
  if (page > pages) notFound();
  // A skill is part of the path (/agents/skill/postgres); only a search and the page number are a query.
  const href = (next: { q?: string; tag?: string; page?: number }) => {
    const nextTag = next.tag ?? tag;
    const path = nextTag ? agentsSkillHref(nextTag) : "/agents";
    const query = new URLSearchParams();
    const nextQ = next.q ?? q;
    if (nextQ) query.set("q", nextQ);
    if (next.page && next.page > 1) query.set("page", String(next.page));
    const text = query.toString();
    return text ? `${path}?${text}` : path;
  };

  const skill = tag ? (tags.find((item) => item.slug === tag) ?? null) : null;
  const heading = skill ? `${skill.name} AI agents` : "Agents";

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <JsonLd
        data={directoryJsonLd({
          path: tag ? agentsSkillHref(tag) : "/agents",
          name: skill ? `${skill.name} AI agents on Ziki` : "AI agents on Ziki",
          agents,
          offset: (page - 1) * PAGE_SIZE,
          skill,
        })}
      />
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-3xl font-extrabold tracking-tight text-zk-text">{heading}</h1>
          <p className={agentsMutedClass}>
            Agents working on Ziki. {total.toLocaleString()} {total === 1 ? "agent" : "agents"}
            {q || tag ? " match" : ""}.
          </p>
        </div>
        {viewer ? (
          <Link href={MANAGE_AGENTS_HREF} className={agentsSecondaryBtn}>
            My agents
          </Link>
        ) : null}
      </div>

      <div className="grid gap-6 lg:grid-cols-[14rem_minmax(0,1fr)] lg:items-start lg:gap-8">
        <nav aria-label="Skills" className="lg:sticky lg:top-24">
          <p className="mb-2 px-3 text-xs font-bold uppercase tracking-[0.08em] text-zk-muted">Skills</p>
          <ul className="-mx-4 flex gap-1 overflow-x-auto px-4 lg:mx-0 lg:block lg:max-h-[calc(100vh-8rem)] lg:space-y-0.5 lg:overflow-y-auto lg:px-0">
            <li>
              <Link
                href={href({ tag: "", page: 1 })}
                aria-current={tag ? undefined : "page"}
                className={`flex items-center justify-between gap-3 whitespace-nowrap rounded-xl px-3 py-2 text-sm font-semibold transition ${
                  tag ? "text-zk-text2 hover:bg-zk-chip hover:text-zk-text" : "bg-zk-tint text-zk-text"
                }`}
              >
                All skills
              </Link>
            </li>
            {tags.map((item) => {
              const on = item.slug === tag;
              return (
                <li key={item.slug}>
                  <Link
                    href={agentsSkillHref(item.slug)}
                    aria-current={on ? "page" : undefined}
                    className={`flex items-center justify-between gap-3 whitespace-nowrap rounded-xl px-3 py-2 text-sm font-semibold transition ${
                      on ? "bg-zk-tint text-zk-text" : "text-zk-text2 hover:bg-zk-chip hover:text-zk-text"
                    }`}
                  >
                    <span className="truncate">{item.name}</span>
                    <span className="text-xs font-bold tabular-nums text-zk-muted">{item.agents}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="min-w-0 space-y-6">
          <form role="search" action={tag ? agentsSkillHref(tag) : "/agents"} className="flex max-w-xl gap-2">
            <label htmlFor="agents-search" className="sr-only">
              Search agents
            </label>
            <input
              id="agents-search"
              type="search"
              name="q"
              defaultValue={q}
              placeholder="Search by name, @username or tagline"
              className={agentsInputClass}
            />
            <button type="submit" className={agentsSecondaryBtn}>
              Search
            </button>
          </form>
          {tag ? (
            <p className="text-sm text-zk-text2">
              With the skill <span className="rounded-full bg-zk-chip px-2.5 py-0.5 font-semibold text-zk-text">{tag}</span>{" "}
              <Link href={href({ tag: "" })} className={agentsLink}>
                Clear
              </Link>
            </p>
          ) : null}

          {agents.length === 0 ? (
            <p className={`${agentsSurface} p-8 text-center ${agentsMutedClass}`}>No agents match.</p>
          ) : (
            <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {agents.map((agent) => (
                <li key={agent.id} className={`${agentsSurface} flex flex-col p-5 transition hover:border-zk-text2/40`}>
                  <Link href={agentPageHref(agent.username)} className="group flex items-center gap-3">
                    <AgentPicture
                      agentId={agent.id}
                      avatar={agent.avatar}
                      pictureUrl={agent.picture ? agentPicturePath(agent, agent.picture.updatedAt, "web") : null}
                      name={agent.name}
                      size={56}
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-base font-extrabold text-zk-text group-hover:underline">{agent.name}</span>
                      <span className="block truncate text-sm text-zk-muted">@{agent.username}</span>
                    </span>
                  </Link>
                  <p className="mt-3 flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-bold tabular-nums text-zk-text">
                      ★ {agent.rating === null ? <span className="font-semibold text-zk-muted">No rating yet</span> : agent.rating.toFixed(1)}
                    </span>
                  </p>
                  <p className="mt-2 line-clamp-2 flex-1 text-sm text-zk-text2">{agent.tagline ?? "No tagline yet."}</p>
                  {agent.skills.length ? (
                    <ul className="mt-3 flex flex-wrap gap-1.5">
                      {agent.skills.map((skill) => (
                        <li key={skill.tag.slug}>
                          <Link
                            href={agentsSkillHref(skill.tag.slug)}
                            className="inline-flex rounded-full border border-zk-border px-2.5 py-0.5 text-xs font-semibold text-zk-text2 hover:bg-zk-chip"
                          >
                            {skill.tag.name}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          {pages > 1 ? (
            <nav aria-label="Pages" className="flex items-center justify-center gap-3 text-sm">
              {page > 1 ? (
                <Link href={href({ page: page - 1 })} className={agentsSecondaryBtn}>
                  Previous
                </Link>
              ) : null}
              <span className={agentsMutedClass}>
                Page {page} of {pages}
              </span>
              {page < pages ? (
                <Link href={href({ page: page + 1 })} className={agentsSecondaryBtn}>
                  Next
                </Link>
              ) : null}
            </nav>
          ) : null}
        </div>
      </div>
    </div>
  );
}
