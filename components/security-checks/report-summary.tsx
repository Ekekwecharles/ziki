import Link from "next/link";
import type { SecuritySeverity } from "@prisma/client";
import "@/components/security-finding.css";
import { Badge } from "@/components/ui/badge";
import { LocalTime } from "@/components/local-time";
import { statusClass, substatusClass } from "@/lib/labels";
import { CHECK_STATUS_LABEL, FINISHED_CHECK_STATUSES } from "@/lib/security-checks";
import type { CheckReport, PostedReport } from "@/lib/security-checks/report";
import { SECURITY_SEVERITIES, SEVERITY_LABEL } from "@/lib/security-severity";

/** Ziki's issue status colours, by meaning: waiting on someone like Requires confirmation, working like In progress, finished like Live. */
export const STATUS_CLASS: Record<CheckReport["status"], string> = {
  awaiting_ownership: substatusClass.requires_confirmation,
  queued: substatusClass.requires_confirmation,
  splitting: statusClass.in_progress,
  checking: statusClass.in_progress,
  done: statusClass.resolved,
  cancelled: statusClass.closed,
};

const PRIMARY_BUTTON =
  "inline-flex h-10 items-center justify-center gap-2 rounded-full bg-electric-blue-strong px-5 text-sm font-bold text-white hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-electric-blue focus-visible:ring-offset-2";

/** "52 min", "2 h 5 min", "3 days": how long the check took. */
function duration(from: Date, to: Date): string {
  const minutes = Math.max(1, Math.round((to.getTime() - from.getTime()) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"}`;
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/**
 * The top of a security check's page (12 and 14 Nov plans, part S). While
 * Ziki checks, only where the check stands. Once the report is posted: Ziki's
 * one-line summary, the counts by severity and the full PDF. The report is
 * free; clients pay only to have findings fixed.
 */
export function ReportSummary({ report }: { report: CheckReport }) {
  const finished = FINISHED_CHECK_STATUSES.has(report.status);
  const site = report.target.value;
  const statusText =
    report.status === "done" && report.startedAt && report.finishedAt
      ? `Check finished · ${duration(report.startedAt, report.finishedAt)}`
      : report.status === "done"
        ? "Check finished"
        : CHECK_STATUS_LABEL[report.status];

  const headline = !report.posted
    ? report.status === "cancelled"
      ? `No report for ${site}`
      : `Ziki is checking ${site}`
    : report.total === 0
      ? `No problems found on ${site}`
      : `We found ${plural(report.total, "thing")} to fix on ${site}`;


  return (
    <section aria-labelledby="check-headline" className="rounded-[20px] border border-zk-border bg-zk-surface p-4 sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-2">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zk-text2">
            <Badge className={STATUS_CLASS[report.status]}>{statusText}</Badge>
            <span>
              <LocalTime date={report.createdAt} absolute />
              {report.progress.total ? ` · ${plural(report.progress.total, "check")}` : ""}
            </span>
          </p>
          {/* Ziki's big headline style (as on Coming soon): bigger and heavier than a page title. */}
          <h1 id="check-headline" className="wrap-break-word text-2xl font-extrabold tracking-[-0.02em] text-zk-text sm:text-[28px]">
            {headline}
          </h1>
          {/* One clear line (14 Nov call); the coloured counts below say the rest, and the PDF has Ziki's summary. */}
          {report.posted ? (
            <p className="text-sm text-zk-text2">
              We checked {plural(report.progress.total, "part")} of {site} and found{" "}
              {report.total ? plural(report.total, "problem") : "no problems"}.
            </p>
          ) : !report.posted && !finished ? (
            <p className="text-sm text-zk-text2">Your report shows here once every part is checked.</p>
          ) : null}
          {report.posted ? <FixingLine report={report} /> : null}
          {report.posted && (report.total || report.clearParts.length) ? (
            <ul aria-label="Results by severity" className="flex flex-wrap gap-1.5 pt-1">
              {SECURITY_SEVERITIES.filter((level) => report.counts[level] > 0).map((level) => (
                <li key={level}>
                  <CountChip severity={level} count={report.counts[level]} />
                </li>
              ))}
              {report.clearParts.length ? (
                <li>
                  {/* Same shape as the severity chips beside it. */}
                  <span className="inline-flex items-center rounded-full bg-zk-ok-bg px-2.5 py-0.5 text-xs font-bold text-zk-ok-fg">
                    {plural(report.clearParts.length, "check")} clear
                  </span>
                </li>
              ) : null}
            </ul>
          ) : null}
        </div>

        {report.posted ? <Actions report={report} /> : null}
      </div>
    </section>
  );
}

/**
 * The report's button: the full PDF. "Move to your app", where clients choose
 * what to fix and pay, is Sanmi's page (14 Nov call); its button goes here
 * once that page exists.
 */
function Actions({ report }: { report: PostedReport }) {
  return (
    <div className="flex shrink-0 flex-col gap-2 sm:min-w-56">
      {/* A plain link: a full download, not a client-side navigation. */}
      <a href={`/security/checks/${report.checkId}/report.pdf`} className={PRIMARY_BUTTON}>
        <DownloadIcon />
        Download report
      </a>
      {report.findings.length > 0 ? (
        <Link href={`/security/checks/${encodeURIComponent(report.checkId)}/fix`} className={PRIMARY_BUTTON}>
          Move to your app
        </Link>
      ) : null}
    </div>
  );
}

/** "2 of 5 moved to your app · 1 fixed": how far the moved problems' fixes have got (#security-findings). */
function FixingLine({ report }: { report: PostedReport }) {
  const sent = report.findings.filter((finding) => finding.fix);
  if (!sent.length) return null;
  const live = sent.filter((finding) => finding.fix?.bucket === "fixed").length;
  return (
    <p className="text-sm text-zk-text2">
      <span className="font-semibold text-zk-text">{sent.length} of {report.findings.length}</span> moved to your app
      {live ? ` · ${live} fixed` : ""}
    </p>
  );
}

/** "1 critical", in the severity's own colours. */
function CountChip({ severity, count }: { severity: SecuritySeverity; count: number }) {
  return (
    <span className={`security-severity security-severity--${severity} inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-bold`}>
      {count} {SEVERITY_LABEL[severity].toLowerCase()}
    </span>
  );
}

function DownloadIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
    </svg>
  );
}
