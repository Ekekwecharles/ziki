import { Badge } from "@/components/ui/badge";
import { LocalTime } from "@/components/local-time";
import { CheckActivity, type CheckPhase } from "@/components/security-checks/check-activity";
import { ReportProgress } from "@/components/security-checks/report-progress";
import { STATUS_CLASS } from "@/components/security-checks/report-summary";
import { CHECK_STATUS_LABEL } from "@/lib/security-checks";
import type { UnpostedReport } from "@/lib/security-checks/report";

/** What the check is doing: no parts yet (Ziki is planning them), parts being checked, or every part done and the report being written. */
export function phaseOf(report: Pick<UnpostedReport, "parts" | "progress">): CheckPhase {
  if (report.parts.length === 0) return "planning";
  return report.progress.done >= report.progress.total ? "writing" : "checking";
}

/**
 * One card for a check that is still running (14 Nov call): where it stands,
 * the headline, something always moving (the magnifier, the changing line, the
 * sliding bar), the numbers, and each part, all in a single flow instead of a
 * still header above a separate Progress section. Never what a part found.
 */
export function LiveCheckCard({ report }: { report: UnpostedReport }) {
  const hasParts = report.parts.length > 0;
  return (
    <section aria-labelledby="check-headline" className="overflow-hidden rounded-[20px] border border-zk-border bg-zk-surface">
      <div className="space-y-5 bg-linear-to-b from-zk-tint/60 to-transparent p-4 sm:p-6">
        <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zk-text2">
          <Badge className={STATUS_CLASS[report.status]}>{CHECK_STATUS_LABEL[report.status]}</Badge>
          <span>
            <LocalTime date={report.createdAt} absolute />
            {report.progress.total ? ` · ${report.progress.total} ${report.progress.total === 1 ? "check" : "checks"}` : ""}
          </span>
        </p>
        <CheckActivity site={report.target.value} phase={phaseOf(report)} done={report.progress.done} total={report.progress.total} />
        {/* Before there are parts there is no bar to fill, so a slim one slides: Ziki is working, just not ready to list the parts. */}
        {hasParts ? null : (
          <div aria-hidden="true" className="relative h-1.5 w-full overflow-hidden rounded-full bg-zk-chip">
            <div className="absolute inset-y-0 left-0 w-1/4 rounded-full bg-electric-blue-strong motion-safe:[animation:zk-check-slide_1.8s_ease-in-out_infinite]" />
          </div>
        )}
      </div>
      {hasParts ? (
        <div className="border-t border-zk-border p-4 sm:p-6">
          <ReportProgress progress={report.progress} parts={report.parts} working />
        </div>
      ) : null}
    </section>
  );
}
