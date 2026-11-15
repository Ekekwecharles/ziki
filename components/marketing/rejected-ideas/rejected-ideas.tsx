import Link from "next/link";
import { EntrySummary } from "@/components/entry-summary";
import { IdeaVoteTotals, opinionChipClass, opinionLabels } from "@/components/idea-verdicts";
import { LocalTime } from "@/components/local-time";
import { PaginationControls } from "@/components/pagination-controls";
import { ideaPath, marketingPath, type ProjectRef } from "@/lib/project-paths";
import type { RejectedIdea, RejectedIdeasResult } from "./model";

const chip = "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-bold";
const link = "rounded-md text-zk-accent hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-electric-blue";

function Verdicts({ item }: { item: RejectedIdea }) {
  return (
    <section aria-label={`Verdicts on idea #${item.number}`}>
      <h3 className="text-xs font-bold uppercase tracking-[0.08em] text-zk-muted">
        Verdicts <span className="font-mono font-normal normal-case tracking-normal">{item.verdicts.length}</span>
      </h3>
      {item.verdicts.length === 0 ? (
        <p className="mt-2 text-[13px] text-zk-muted">It had no verdicts.</p>
      ) : (
        <ul className="mt-2 flex list-none flex-col gap-2 p-0">
          {item.verdicts.map((verdict) => (
            <li key={verdict.id} className="rounded-xl border border-zk-divider px-3 py-2.5">
              <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-zk-text">
                <span className={`${chip} ${opinionChipClass[verdict.opinion]}`}>{opinionLabels[verdict.opinion]}</span>
                <b className="font-semibold">{verdict.by}</b>
                {verdict.agentName ? <span className="text-zk-muted">via {verdict.agentName}</span> : null}
                {verdict.votes > 1 ? <span className="text-zk-muted">· {verdict.votes} votes</span> : null}
                <span className="whitespace-nowrap text-xs text-zk-muted">
                  · <LocalTime date={verdict.updatedAt} />
                </span>
              </p>
              <EntrySummary summary={verdict.summary} description={verdict.description} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function IdeaCard({ slug, item }: { slug: ProjectRef; item: RejectedIdea }) {
  return (
    <li className="rounded-[20px] border border-zk-border bg-zk-surface p-5 sm:p-[22px]">
      <article className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2 text-xs text-zk-muted">
          {item.typeName ? <span className={`${chip} bg-zk-chip text-zk-text2`}>{item.typeName}</span> : null}
          <span className="font-mono tabular-nums">Idea #{item.number}</span>
          {item.reporterName ? <span>{item.reporterName}</span> : null}
          <LocalTime date={item.createdAt} />
        </div>

        <div className="flex flex-col gap-1.5">
          <h2 className="m-0 text-base font-bold leading-snug text-zk-text">
            <Link href={ideaPath(slug, item.number)} className={`${link} text-zk-text hover:text-zk-accent`}>
              {item.title}
            </Link>
          </h2>
          {item.summary ? <p className="m-0 text-sm leading-relaxed text-zk-text2">{item.summary}</p> : null}
        </div>

        {item.rationale ? (
          <p className="m-0 rounded-xl bg-zk-tint px-3 py-2.5 text-[13px] leading-relaxed text-zk-text2">
            <b className="font-semibold text-zk-text">Why it serves the focus: </b>
            {item.rationale}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <IdeaVoteTotals votes={item.votes} />
          <span className="font-mono text-xs font-semibold tabular-nums text-zk-text2">
            Score {item.score} of {item.threshold}
          </span>
          {item.status === "rejected" ? (
            <span className={`${chip} bg-zk-bad-bg text-zk-bad-fg`}>Rejected</span>
          ) : (
            <span className={`${chip} bg-zk-chip text-zk-muted`}>Archived</span>
          )}
        </div>

        <Verdicts item={item} />

        <footer className="border-t border-zk-divider pt-4 text-xs text-zk-muted">
          {item.status === "rejected" ? (
            <>
              Rejected{item.rejectedAt ? <> <LocalTime date={item.rejectedAt} /></> : null} by {item.rejectedBy ?? "a manager agent"}
            </>
          ) : (
            <>
              Archived{item.archivedAt ? <> <LocalTime date={item.archivedAt} /></> : null} by {item.archivedBy ?? "a manager agent"}
              {item.archiveReason ? <> — {item.archiveReason}</> : null}
            </>
          )}
        </footer>
      </article>
    </li>
  );
}

/** `/<slug>/marketing/ideas/rejected`: marketing ideas that were rejected or archived. Open ones are on the board's Ideas tab. */
export function RejectedIdeas({ slug, initial }: { slug: ProjectRef; initial: RejectedIdeasResult }) {
  const href = marketingPath(slug, "ideas/rejected");
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 pb-10">
      <header>
        <h1 className="text-[28px] font-extrabold leading-tight tracking-[-0.02em] text-zk-text">Rejected ideas</h1>
        <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-zk-text2">
          Marketing ideas a manager rejected or archived, with the verdicts that led there.
        </p>
      </header>

      {!initial.ok ? (
        <div role="alert" className="rounded-[20px] border border-zk-border bg-zk-surface px-4 py-12 text-center">
          <p className="font-bold text-zk-text">We couldn’t load the rejected ideas</p>
          <p className="mt-1.5 text-sm text-zk-muted">Check your connection and try again in a moment.</p>
          <Link href={href} className={`mt-4 inline-block text-sm font-semibold ${link}`}>Try again</Link>
        </div>
      ) : initial.items.length === 0 ? (
        <div className="rounded-[20px] border border-zk-border bg-zk-surface px-4 py-12 text-center">
          <p className="font-bold text-zk-text">No rejected ideas.</p>
          <p className="mt-1.5 text-sm text-zk-muted">Ideas a manager rejects or archives appear here.</p>
        </div>
      ) : (
        <>
          <ul className="flex list-none flex-col gap-4 p-0" aria-label="Rejected ideas">
            {initial.items.map((item) => <IdeaCard key={item.id} slug={slug} item={item} />)}
          </ul>
          <PaginationControls
            page={initial.page}
            totalPages={initial.totalPages}
            totalCount={initial.total}
            from={initial.from}
            to={initial.to}
            queryParams={{}}
            basePath={href}
            itemLabel="idea"
          />
        </>
      )}
    </div>
  );
}
