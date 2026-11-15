import type { SecurityCheckItemStatus } from "@prisma/client";
import { Badge } from "@/components/ui/badge";
import { statusClass, substatusClass } from "@/lib/labels";
import { ITEM_STATUS_LABEL } from "@/lib/security-checks";
import type { ReportPart } from "@/lib/security-checks/report";

/** Ziki's issue status colours, by meaning: waiting like Requires confirmation (amber), checking like In progress, done like Live, skipped like Closed. */
const PART_STATUS_CLASS: Record<SecurityCheckItemStatus, string> = {
  waiting: substatusClass.requires_confirmation,
  checking: statusClass.in_progress,
  done: statusClass.resolved,
  skipped: statusClass.closed,
};

/**
 * How far the agents have got with a security check (#security-checks, part
 * 4): a bar with the numbers (so it isn't colour-only), then each part with
 * its status. Never shows what a part found.
 */
export function ReportProgress({
  progress,
  parts,
  working = false,
}: {
  progress: { done: number; total: number; percent: number };
  parts: ReportPart[];
  /** The check is still running: the bar keeps sliding, so 0 of 15 never looks stuck. */
  working?: boolean;
}) {
  return (
    <div className="space-y-4">
      <div>
        <div
          role="progressbar"
          aria-label="Check progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress.percent}
          aria-valuetext={`${progress.done} of ${progress.total} parts done`}
          className="relative h-2 w-full overflow-hidden rounded-full bg-zk-chip"
        >
          <div
            className="h-full rounded-full bg-electric-blue-strong transition-[width]"
            style={{ width: `${progress.percent}%` }}
          />
          {working && progress.percent < 100 ? (
            <div aria-hidden="true" className="absolute inset-y-0 left-0 w-1/4 rounded-full bg-white/40 motion-safe:[animation:zk-check-slide_1.8s_ease-in-out_infinite]" />
          ) : null}
        </div>
        <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums text-zk-text2">
          <span className="font-semibold text-zk-text">{progress.done} of {progress.total} parts done · {progress.percent}%</span>
          {(["checking", "waiting"] as const).map((status) => {
            const count = parts.filter((part) => part.status === status).length;
            return count ? <span key={status}>{count} {ITEM_STATUS_LABEL[status].toLowerCase()}</span> : null;
          })}
        </p>
      </div>
      <ul className="divide-y divide-zk-border">
        {parts.map((part) => (
          <li key={part.id} className="flex items-center justify-between gap-3 py-2">
            <span className="flex min-w-0 items-center gap-2.5">
              <PartMark status={part.status} working={working} />
              <span className={`min-w-0 wrap-break-word text-sm ${part.status === "waiting" ? "text-zk-text2" : "text-zk-text"}`}>{part.title}</span>
            </span>
            <Badge className={`shrink-0 ${PART_STATUS_CLASS[part.status]} ${working && part.status === "checking" ? "motion-safe:animate-pulse" : ""}`}>
              {ITEM_STATUS_LABEL[part.status]}
            </Badge>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A part's mark: a tick when done, a pulsing dot while checked, a hollow ring while waiting. Colour is never the only sign: the badge beside it says the same. */
function PartMark({ status, working }: { status: SecurityCheckItemStatus; working: boolean }) {
  const pulse = working && status === "checking" ? "motion-safe:animate-pulse" : "";
  if (status === "done") {
    return (
      <span aria-hidden="true" className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-zk-ok-bg text-zk-ok-fg">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
      </span>
    );
  }
  if (status === "checking") {
    return (
      <span aria-hidden="true" className={`grid h-5 w-5 shrink-0 place-items-center rounded-full bg-zk-tint ${pulse}`}>
        <span className="h-2 w-2 rounded-full bg-zk-accent" />
      </span>
    );
  }
  return <span aria-hidden="true" className={`h-5 w-5 shrink-0 rounded-full border-2 ${status === "skipped" ? "border-zk-muted/50" : "border-zk-border"}`} />;
}
