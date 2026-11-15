import Link from "next/link";
import type { SecuritySeverity } from "@prisma/client";
import { SeverityChip } from "@/components/security-finding-panel";
import { ReportProgress } from "@/components/security-checks/report-progress";
import { shortLine } from "@/lib/security-checks/short-line";
import type { PostedReport, ResultFix } from "@/lib/security-checks/report";

/**
 * "What we found" on a posted security report (12 and 14 Nov plans): every
 * finding, worst first, kept short: its title and one line, and "How to fix"
 * only on a finding the client paid to have fixed. The full detail is in the
 * downloaded report. The report is free; choosing which to fix is Sanmi's
 * page. A finding moved to the client's app keeps its place, with a small
 * "Moved to your app" mark linking to its issue (reports never go away).
 */
export function ReportResults({ report }: { report: PostedReport }) {
  return (
    <section aria-labelledby="found-heading" className="overflow-hidden rounded-[20px] border border-zk-border bg-zk-surface">
      <div className="flex items-start justify-between gap-3 px-4 pt-4 sm:px-6 sm:pt-5">
        <div>
          <h2 id="found-heading" className="text-base font-semibold text-zk-text">What we found</h2>
          <p className="text-xs text-zk-muted">Worst first. The downloaded report has the full details.</p>
        </div>
        <span className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-zk-text2">
          <LockIcon />
          Private
        </span>
      </div>

      {report.total === 0 ? (
        <p className="px-4 py-4 text-sm text-zk-text2 sm:px-6">The agents found no problems.</p>
      ) : (
        <Findings report={report} />
      )}

      {report.parts.length ? <ClearFooter report={report} /> : null}
    </section>
  );
}

/** Every finding, worst first. */
function Findings({ report }: { report: PostedReport }) {
  return (
    <ol className="mt-3 divide-y divide-zk-border border-t border-zk-border">
      {report.findings.map((finding) => (
        <li key={finding.id}>
          <ProblemRow severity={finding.severity} title={finding.title} description={finding.description} howToFix={finding.howToFix} fix={finding.fix} />
        </li>
      ))}
    </ol>
  );
}

function ProblemRow({
  severity,
  title,
  description,
  howToFix,
  fix,
}: {
  severity: SecuritySeverity;
  title: string;
  description: string;
  howToFix: string | null;
  fix: ResultFix | null;
}) {
  return (
    <article className="grid gap-2 px-4 py-4 sm:grid-cols-[6rem_minmax(0,1fr)] sm:gap-4 sm:px-6">
      <div>
        <SeverityChip severity={severity} />
      </div>
      <div className="min-w-0">
        <h3 className="wrap-break-word text-base font-bold text-zk-text">{title}</h3>
        {fix ? <MovedMark fix={fix} /> : null}
        {/* One short line; the downloaded report has the rest. */}
        <p className="mt-1 text-sm text-zk-text2">{shortLine(description)}</p>
        {/* "How to fix:" only on a finding the client paid to have fixed; same format as before, one line. */}
        {howToFix ? (
          <p className="mt-2 text-sm text-zk-text">
            <span className="font-semibold">How to fix:</span> {shortLine(howToFix)}
          </p>
        ) : null}
      </div>
    </article>
  );
}

const FIX_STATE: Record<ResultFix["bucket"], string> = { fixing: "Being fixed", fixed: "Fixed", closed: "Closed" };

/**
 * "↗ Moved to your app · Issue #150 · Fixed": one small mark under a moved
 * finding's title, linking to its issue (or its private finding while there
 * is no issue yet).
 */
function MovedMark({ fix }: { fix: ResultFix }) {
  return (
    <Link
      href={fix.issue?.href ?? fix.findingHref}
      className="mt-1 inline-flex flex-wrap items-center gap-1 rounded-full bg-zk-chip px-2.5 py-0.5 text-xs font-semibold text-zk-text2 hover:underline focus-visible:outline-2 focus-visible:outline-zk-accent"
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M7 17 17 7M9 7h8v8" />
      </svg>
      Moved to your app
      <span className="text-zk-muted">
        {fix.issue ? ` · Issue #${fix.issue.number}` : ""} · {FIX_STATE[fix.bucket]}
      </span>
    </Link>
  );
}

/** "36 clear · Security headers, Open pages and 34 more checks found nothing. See all checks" */
function ClearFooter({ report }: { report: PostedReport }) {
  const clear = report.clearParts;
  const named = clear.slice(0, 3);
  const rest = clear.length - named.length;
  return (
    <details className="security-report group border-t border-zk-border bg-zk-tint">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-4 py-3 text-sm sm:px-6">
        {clear.length ? (
          <>
            <span className="rounded-full bg-zk-ok-bg px-2.5 py-0.5 text-xs font-bold text-zk-ok-fg">{clear.length} clear</span>
            <span className="min-w-0 flex-1 text-zk-text2">
              {named.join(", ")}
              {rest > 0 ? ` and ${rest} more ${rest === 1 ? "check" : "checks"}` : ""} found nothing.
            </span>
          </>
        ) : (
          <span className="min-w-0 flex-1 text-zk-text2">{report.progress.done} of {report.progress.total} checks done.</span>
        )}
        {/* The words follow the list: "See all checks" while closed, "Hide checks" once open. */}
        <span className="font-semibold text-zk-accent group-open:hidden">See all checks</span>
        <span className="hidden font-semibold text-zk-accent group-open:inline">Hide checks</span>
      </summary>
      <div className="border-t border-zk-border bg-zk-surface px-4 py-3 sm:px-6">
        <ReportProgress progress={report.progress} parts={report.parts} />
      </div>
    </details>
  );
}

function LockIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}
