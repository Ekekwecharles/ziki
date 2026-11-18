import Link from "next/link";
import "@/components/security-finding.css";
import { SECURITY_SEVERITIES, SEVERITY_LABEL } from "@/lib/security-severity";
import { Badge } from "@/components/ui/badge";
import { LocalTime } from "@/components/local-time";
import { CheckActivity, type CheckPhase } from "@/components/security-checks/check-activity";
import { statusClass, substatusClass } from "@/lib/labels";
import { CHECK_STATUS_LABEL, FINISHED_CHECK_STATUSES } from "@/lib/security-checks";
import type { CheckReport } from "@/lib/security-checks/report";
import { firstSentence } from "@/lib/security-checks/short-line";

/** Ziki's issue status colours, by meaning: waiting on someone like Requires confirmation, working like In progress, finished like Live. */
const STATUS_CLASS: Record<CheckReport["status"], string> = {
  awaiting_ownership: substatusClass.requires_confirmation,
  queued: substatusClass.requires_confirmation,
  splitting: statusClass.in_progress,
  checking: statusClass.in_progress,
  done: statusClass.resolved,
  cancelled: statusClass.closed,
};

/** What the check is doing: planning its parts, agents checking them, writing the report, finished or stopped. */
export function phaseOf(report: Pick<CheckReport, "status" | "parts" | "progress" | "posted">): CheckPhase {
  if (report.status === "cancelled") return "stopped";
  if (report.posted || FINISHED_CHECK_STATUSES.has(report.status)) return "done";
  if (report.parts.length === 0) return "planning";
  return report.progress.done >= report.progress.total ? "writing" : "checking";
}

/**
 * The top of a check's page (16 Nov, Hamzat): where it stands, the lively strip (a wandering magnifier and a
 * line that changes while agents work), and the progress bar with the numbers.
 */
export function CheckHeader({ report }: { report: CheckReport }) {
  const phase = phaseOf(report);
  const moving = phase !== "done" && phase !== "stopped";
  const { done, total, percent } = report.progress;
  return (
    <div className="space-y-5 bg-linear-to-b from-zk-tint/60 to-transparent p-4 sm:p-6">
      <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zk-text2">
        <Badge className={STATUS_CLASS[report.status]}>{CHECK_STATUS_LABEL[report.status]}</Badge>
        <span>
          <LocalTime date={report.createdAt} absolute />
          {total ? ` · ${total} ${total === 1 ? "check" : "checks"}` : ""}
        </span>
      </p>
      <CheckActivity site={report.target.value} phase={phase} done={done} total={total} />
      {report.posted ? (
        <FindingsSummary report={report} />
      ) : <div>
        <div
          role="progressbar"
          aria-label="Check progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-valuetext={total ? `${done} of ${total} parts done` : "Planning the checks"}
          className="relative h-2 w-full overflow-hidden rounded-full bg-zk-chip"
        >
          <div className="h-full rounded-full bg-electric-blue-strong transition-[width]" style={{ width: `${total ? percent : 0}%` }} />
          {moving ? (
            <div aria-hidden="true" className="absolute inset-y-0 left-0 w-1/4 rounded-full bg-white/40 motion-safe:[animation:zk-check-slide_1.8s_ease-in-out_infinite]" />
          ) : null}
        </div>
        <p className="mt-1.5 text-xs font-semibold tabular-nums text-zk-text">
          {total ? `${done} of ${total} parts done · ${percent}%` : "Planning the checks…"}
        </p>
      </div>}
    </div>
  );
}

function FindingsSummary({ report }: { report: Extract<CheckReport, { posted: true }> }) {
  const critical = report.counts.critical;
  // Any problem at all gets the warning look, even a single low one (17 Nov, Hamzat: "something scary").
  const warn = report.total > 0;
  // Every finding not already in the app, a rescan's earlier ones still there included (18 Nov, Tolu).
  const remaining = report.findings.filter((finding) => !finding.fix);
  const criticalRemaining = remaining.filter((finding) => finding.severity === "critical");
  const selection = criticalRemaining.length ? criticalRemaining : remaining;
  const fixLabel = criticalRemaining.length === 1 ? "Fix the critical one"
    : criticalRemaining.length > 1 ? "Fix critical findings" : "Fix remaining findings";
  // Back to this page with them ticked and the fix panel open, under the Deeper scan.
  const fixHref = `/security/checks/${encodeURIComponent(report.checkId)}?fix=${selection.map(({ id }) => encodeURIComponent(id)).join(",")}#fix-panel`;

  return (
    <section aria-label="Findings summary" className={`flex flex-col gap-4 rounded-[20px] border p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6 ${warn ? "border-2 border-red-400 bg-red-100" : "border-zk-border bg-zk-surface"}`}>
      <div className="min-w-0 space-y-2">
        <h2 className={`text-lg font-bold sm:text-xl ${warn ? "text-red-800" : "text-zk-text"}`}>
          {report.total === 0 ? "No security problems found" : `${report.total} security ${report.total === 1 ? "problem" : "problems"} found${critical ? `, ${critical} of them critical` : ""}`}
        </h2>
        {report.fixed.length ? (
          <p className="m-0 text-sm font-semibold text-zk-ok-fg">
            {report.fixed.length} {report.fixed.length === 1 ? "problem" : "problems"} from the last scan fixed
          </p>
        ) : null}
        {report.summary ? <p className={`break-words text-sm sm:text-base ${warn ? "text-red-950" : "text-zk-text2"}`}>{firstSentence(report.summary)}</p> : null}
        {report.total > 0 ? (
          <ul aria-label="Findings by severity" className="flex flex-wrap gap-2">
            {SECURITY_SEVERITIES.filter((severity) => report.counts[severity] > 0).map((severity) => (
              <li key={severity} className={`security-severity security-severity--${severity} rounded-full px-3 py-1 text-xs font-bold`}>
                {/* "1 critical threat", "3 low threats": the summary speaks of threats; the list below just says the level. */}
                {report.counts[severity]} {SEVERITY_LABEL[severity].toLowerCase()} {report.counts[severity] === 1 ? "threat" : "threats"}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {selection.length ? (
        <Link href={fixHref} className="inline-flex min-h-11 shrink-0 items-center justify-center self-start rounded-full bg-electric-blue-strong px-5 py-2 text-sm font-bold text-white hover:brightness-105 sm:self-center">
          {fixLabel}
        </Link>
      ) : null}
    </section>
  );
}
