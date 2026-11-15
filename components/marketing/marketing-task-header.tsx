import type { ReactNode } from "react";
import Link from "next/link";
import { formatIssueNumber } from "@/lib/issue-number";
import { LocalTime } from "@/components/local-time";
import { statusLabels } from "@/lib/labels";
import { marketingPath, type ProjectRef } from "@/lib/project-paths";
import type { Status, Substatus } from "@prisma/client";

export type MarketingTaskHeaderProps = {
  number: number;
  title: string;
  description?: string;
  status: Status;
  substatus: Substatus;
  taskType?: { id: string; name: string } | null;
  reward?: number | null;
  revisionCount: number;
  maxRevisions: number;
  projectSlug: ProjectRef;
  projectName?: string;
  projectFocus?: string | null;
  projectSiteUrl?: string | null;
  rationale?: string | null;
  reporter?: { name: string | null; email?: string | null } | null;
  reporterAgent?: { name: string } | null;
  createdAt: Date | string;
  voteButtonSlot?: ReactNode;
  actionsMenuSlot?: ReactNode;
  headerOnly?: boolean;
  contentOnly?: boolean;
};

export function MarketingTaskHeader({
  number,
  title,
  description,
  status,
  substatus,
  taskType,
  revisionCount,
  maxRevisions,
  projectSlug,
  projectName,
  projectFocus,
  projectSiteUrl,
  rationale,
  reporter,
  reporterAgent,
  createdAt,
  voteButtonSlot,
  actionsMenuSlot,
  headerOnly = false,
  contentOnly = false,
}: MarketingTaskHeaderProps) {
  const isLive = status === "resolved" || substatus === "published";
  const isInProgress = status === "in_progress";
  const isInReview = status === "done" || substatus === "requires_review";
  const showTaskType = taskType && taskType.name.trim().toLowerCase() !== "marketing";

  const renderHeaderRow = () => (
    <div className="flex flex-col gap-3.5 border-b border-zk-divider pb-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-[1_1_600px] space-y-2.5">
          <div className="flex items-start gap-2">
            <Link
              href={marketingPath(projectSlug, "tasks")}
              aria-label="Back to marketing tasks"
              title="Back to marketing tasks"
              className="mt-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zk-accent hover:bg-zk-chip print:hidden"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M19 12H5M12 19l-7-7 7-7" />
              </svg>
            </Link>
            <h1 className="min-w-0 break-words text-[28px] font-extrabold leading-tight tracking-[-0.02em] text-zk-text">
              <span className="font-bold tabular-nums text-zk-muted">
                {formatIssueNumber(number)}
              </span>{" "}
              {title}
            </h1>
          </div>

          {/* Badges & Meta Row */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs">
            <Link
              href={marketingPath(projectSlug)}
              className="inline-flex cursor-pointer items-center rounded-full border border-zk-border bg-zk-tint px-2.5 py-0.5 text-xs font-bold text-zk-accent transition-colors hover:bg-zk-chip"
            >
              Marketing
            </Link>
            {showTaskType ? (
              <span className="inline-flex items-center rounded-full border border-zk-divider bg-zk-surface px-2.5 py-0.5 font-medium text-zk-text2">
                {taskType.name}
              </span>
            ) : null}
            <span
              className={`inline-flex items-center rounded-full px-2.5 py-0.5 font-semibold ${
                isLive
                  ? "border border-zk-ok-fg/30 bg-zk-ok-bg text-zk-ok-fg"
                  : isInProgress
                    ? "border border-zk-info-fg/30 bg-zk-info-bg text-zk-info-fg"
                    : isInReview
                      ? "border border-zk-accent/30 bg-zk-chip text-zk-accent"
                      : "border border-zk-divider bg-zk-chip text-zk-text2"
              }`}
            >
              {isLive ? "Live (Published)" : statusLabels[status] ?? status}
            </span>
            {maxRevisions > 0 && revisionCount > 0 ? (
              <span
                className="inline-flex items-center rounded-full border border-zk-warn-fg/30 bg-zk-warn-bg px-2.5 py-0.5 font-bold text-zk-warn-fg"
                title={`Marketing work revision limit: ${maxRevisions} rounds before reopening`}
              >
                Revision {revisionCount} of {maxRevisions}
              </span>
            ) : null}
            <span className="text-zk-muted">·</span>
            <span className="text-zk-muted">
              Proposed by{" "}
              <b className="font-semibold text-zk-text">
                {reporterAgent?.name ?? reporter?.name ?? "Contributor"}
              </b>
              {reporterAgent && reporter?.name ? ` for ${reporter.name}` : ""}
            </span>
            <span className="text-zk-muted">·</span>
            <LocalTime date={createdAt} />
          </div>
        </div>

        {/* Action Controls: Upvote + Menu */}
        <div className="flex shrink-0 flex-wrap items-center gap-2 self-start print:hidden">
          {voteButtonSlot}
          {actionsMenuSlot}
        </div>
      </div>
    </div>
  );

  const renderContentCards = () => (
    <div className="flex flex-col gap-5">
      {/* Campaign Focus Banner (if active) */}
      {projectFocus ? (
        <div className="flex items-start gap-3 rounded-xl border border-zk-info-fg/30 bg-zk-info-bg/40 p-3.5 text-sm text-zk-text">
          <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-zk-info-fg text-white">
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10" />
              <path d="m12 8 4 4-4 4M8 12h8" />
            </svg>
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-bold uppercase tracking-wider text-zk-info-fg">
                {projectName ? `${projectName} Focus` : "Current Campaign Focus"}
              </span>
              {projectSiteUrl ? (
                <a
                  href={projectSiteUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs font-semibold text-zk-accent hover:underline"
                >
                  Visit Site ↗
                </a>
              ) : null}
            </div>
            <p className="mt-0.5 text-sm font-medium text-zk-text">{projectFocus}</p>
          </div>
        </div>
      ) : null}

      {/* Unified Description & Strategic Rationale Card */}
      {description || rationale ? (
        <section aria-label="Task description" className="rounded-[20px] border border-zk-border bg-zk-surface p-5 sm:p-6 text-sm text-zk-text">
          {description ? (
            <div>
              <h2 className="mb-2 text-xs font-bold uppercase tracking-[0.08em] text-zk-muted">
                Task Description
              </h2>
              <div className="prose prose-sm max-w-none text-zk-text dark:prose-invert whitespace-pre-wrap leading-relaxed">
                {description}
              </div>
            </div>
          ) : null}

          {rationale ? (
            <div className={description ? "mt-4 border-t border-zk-divider pt-4" : ""}>
              <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-[0.08em] text-zk-muted">
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-zk-muted" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                </svg>
                <span>Strategic Rationale</span>
              </div>
              <p className="mt-1.5 text-sm leading-relaxed text-zk-text2 whitespace-pre-line">
                {rationale}
              </p>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );

  if (headerOnly) return renderHeaderRow();
  if (contentOnly) return renderContentCards();

  return (
    <div className="flex flex-col gap-5">
      {renderHeaderRow()}
      {renderContentCards()}
    </div>
  );
}
