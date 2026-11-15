import type { IssueStage } from "@/lib/issue-stage";
import type { MergePath } from "@/lib/merge-history";
import { MergePathChips } from "@/components/merge-path";
import { ElapsedTime } from "@/components/elapsed-time";
import { closedLabel } from "@/lib/close-reasons";
import type { Substatus } from "@prisma/client";
import { substatusLabel } from "@/lib/labels";

const icon = "h-3 w-3 shrink-0";

function Svg({ children, className = icon }: { children: React.ReactNode; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      {children}
    </svg>
  );
}

const CheckIcon = ({ className }: { className?: string }) => <Svg className={className}><path d="m5 12 4.5 4.5L19 7" /></Svg>;
const BotIcon = () => <Svg><rect x="4" y="8" width="16" height="12" rx="3" /><path d="M12 4v4M9 14h.01M15 14h.01" /></Svg>;
const ClockIcon = () => <Svg className="h-2.5 w-2.5 shrink-0"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Svg>;
/** A filled check in a circle: the idea has passed its threshold. */
const CheckCircleIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="shrink-0">
    <path fillRule="evenodd" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm4.7 7.7a1 1 0 0 0-1.4-1.4L10.5 13l-1.8-1.8a1 1 0 0 0-1.4 1.4l2.5 2.5a1 1 0 0 0 1.4 0l5.5-5.4Z" clipRule="evenodd" />
  </svg>
);

const BulbIcon = () => (
  <Svg>
    <path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.6.5 1.1 1.3 1.1 2.2h5c0-.9.5-1.7 1.1-2.2A6 6 0 0 0 12 3Z" />
  </Svg>
);

/** A hammer that taps, in place of the word "working". Still under reduced motion. */
function HammeringIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`hammering ${icon}`}>
      <g className="hammering-head">
        <path d="m15 12-8.4 8.4a2.1 2.1 0 1 1-3-3L12 9" />
        <path d="M17.6 15 22 10.6M20.9 11.7 12.3 3.1a1 1 0 0 0-1.4 0L9.6 4.4a1 1 0 0 0 0 1.4l8.6 8.6a1 1 0 0 0 1.4 0l1.3-1.3a1 1 0 0 0 0-1.4Z" />
      </g>
    </svg>
  );
}
const BidIcon = () => <Svg><path d="m14 13-7.5 7.5a2.1 2.1 0 0 1-3-3L11 10M16 16l6-6M8 8l6-6M9 7l8 8M21 11l-8-8" /></Svg>;


export type IssueRowWork = {
  /** The person the work is for (the agent's owner), or the assignee. */
  person: string | null;
  /** When the active claim started; null when unknown. */
  since: Date | null;
};

/**
 * One line saying where an issue stands: Idea (with its score), Requires confirmation
 * (bots), Ready for bids, who is working on it and for how long, Delivered, Done, Ready to merge,
 * or Live / Closed. A live fix shows its dev → staging → main chips from merge history instead.
 */
export function IssueRowStatus({
  substatus,
  stage,
  botConfirmations,
  work,
  mergePath,
  bids,
  offeredTo = null,
  planReviewFor = null,
  confirmed = false,
  closeReason = null,
}: {
  /** The issue's substatus (#substatus): the row says which step of its status it is at. */
  substatus: string;
  /** Why a closed issue was closed (#close-reasons): shown as "Closed: not reproducible". */
  closeReason?: string | null;
  stage: IssueStage | undefined;
  botConfirmations: number;
  /** Requires confirmation: enough independent people confirmed it (the one rule). */
  confirmed?: boolean;
  work: IssueRowWork | null;
  /** Open issues: how many open bids it has. */
  bids?: number;
  /** Open issues: whom a pending offer is for, until it is accepted. */
  offeredTo?: string | null;
  /** #plan-review: whose plan is under review while the issue is at In progress · Plan review. */
  planReviewFor?: string | null;
  /** Where the merged fix has got to; null or absent before it merges. */
  mergePath?: MergePath | null;
}) {
  const live = substatus === "on_dev" || substatus === "on_staging" || substatus === "on_prod" || substatus === "published";
  const finished = live || substatus === "closed";
  if (mergePath && finished) {
    return <MergePathChips path={mergePath} compact />;
  }
  if (finished) {
    return (
      <span className={`issue-row-status inline-flex items-center gap-1 ${live ? "text-zk-ok-fg" : "text-zk-muted"}`}>
        <CheckIcon /> {live ? substatusLabel[substatus as Substatus] : closedLabel(closeReason)}
      </span>
    );
  }
  if (substatus === "requires_review") {
    return (
      <span className="issue-row-status inline-flex items-center gap-1 font-medium text-purple-700 dark:text-purple-300">
        <CheckIcon /> Requires review
      </span>
    );
  }
  if (substatus === "plan_review") {
    return (
      <span className="issue-row-status inline-flex min-w-0 flex-col items-start gap-0.5" data-testid="row-plan-review">
        <span className="inline-flex items-center gap-1 font-medium text-zk-warn-fg">
          <ClockIcon /> Plan review
        </span>
        {planReviewFor ? <span className="max-w-[10rem] truncate pl-4 text-[10.5px] text-zk-muted">{planReviewFor}</span> : null}
      </span>
    );
  }
  if (substatus === "accepted") {
    return (
      <span className="issue-row-status inline-flex items-center gap-1 font-medium text-sky-600 dark:text-sky-400">
        <CheckIcon /> Accepted
      </span>
    );
  }
  if (substatus === "ready_to_merge") {
    return (
      <span className="issue-row-status inline-flex items-center gap-1 font-medium text-emerald-600 dark:text-emerald-400">
        <CheckIcon /> Ready to merge
      </span>
    );
  }
  // #force-merge: merged by its author without Ziki's checks, waiting for judgements; or judged faulty, needing a fix.
  if (substatus === "force_merged") {
    return (
      <span className="issue-row-status inline-flex items-center gap-1 font-medium text-zk-warn-fg">
        <CheckIcon /> Force-merged
      </span>
    );
  }
  if (substatus === "merged_broken") {
    return (
      <span className="issue-row-status inline-flex items-center gap-1 font-medium text-zk-bad-fg">
        Broken{bids ? ` · ${bids} ${bids === 1 ? "bid" : "bids"}` : ""}
      </span>
    );
  }
  if (substatus === "error") {
    return (
      <span className="issue-row-status inline-flex items-center gap-1 font-medium text-zk-bad-fg">
        Error
      </span>
    );
  }
  if (work) {
    // Two lines: a working hammer and who, then how long.
    return (
      <span className="issue-row-status inline-flex min-w-0 flex-col items-start gap-0.5">
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <span className="text-zk-ok-fg"><HammeringIcon /></span>
          <span className="max-w-[9rem] truncate text-zk-text2">{work.person ?? "Someone"}</span>
          <span className="sr-only">is working on it</span>
        </span>
        {work.since ? (
          <span className="inline-flex items-center gap-0.5 pl-5 text-[10.5px] tabular-nums text-zk-muted">
            <ClockIcon />
            <ElapsedTime since={work.since} />
          </span>
        ) : null}
      </span>
    );
  }
  if (substatus === "open" && offeredTo) {
    return (
      <span className="issue-row-status inline-flex min-w-0 flex-col items-start gap-0.5">
        <span className="inline-flex items-center gap-1 font-medium text-zk-warn-fg">
          <ClockIcon /> <span className="max-w-[10rem] truncate">Offered to {offeredTo}</span>
        </span>
      </span>
    );
  }
  if (stage === "ready") {
    return (
      // With bids it says how many ("2 bids"); without, that it is waiting for them.
      <span className="issue-row-status inline-flex items-center gap-1 text-zk-ok-fg" data-testid="row-bid-status">
        <BidIcon /> {bids ? `${bids} bid${bids === 1 ? "" : "s"}` : "Ready for bids"}
      </span>
    );
  }
  if (stage === "confirming" && confirmed) {
    // Enough people confirmed it; it moves to Open as the agents carry on.
    const bots = `${botConfirmations} ${botConfirmations === 1 ? "person" : "people"}`;
    return (
      <span className="issue-row-status inline-flex items-center gap-1 text-zk-ok-fg" title={`Confirmed by ${bots}`}>
        <CheckIcon /> Confirmed
      </span>
    );
  }
  if (stage === "confirming") {
    // An issue now; it is Ready for bids once enough independent people (or their agents) confirm it.
    const bots = `${botConfirmations} ${botConfirmations === 1 ? "person" : "people"}`;
    return (
      <span
        className="issue-row-status inline-flex items-center gap-1 text-zk-text2"
        title={`Confirmed by ${bots} so far`}
      >
        <span className="text-zk-accent"><BotIcon /></span>
        <span>Awaiting Confirmation</span>
        <span className="sr-only"> Confirmed by {bots}.</span>
      </span>
    );
  }
  return <span className="issue-row-status inline-flex items-center gap-1 text-zk-text2">Open</span>;
}

/**
 * An idea's row status (#idea-table): its score; "Idea accepted" once it
 * reaches the threshold (any agent converts it); "Idea rejected" once a
 * manager agent rejected it (#idea-rejected).
 */
export function IdeaRowStatus({
  score,
  threshold,
  rejected = false,
  archived = null,
  bad = false,
}: {
  score: number;
  threshold: number | null;
  rejected?: boolean;
  /** A manager agent archived it (#idea-archive): the reason in words. */
  archived?: string | null;
  /** More bad and neutral votes than good, at the threshold: manager agents are advised to reject it. */
  bad?: boolean;
}) {
  const text = threshold === null ? `${score}` : `${score}/${threshold}`;
  if (archived) {
    return (
      <span className="issue-row-status inline-flex items-center gap-1 font-semibold text-zk-muted" title={`Archived by a manager agent: ${archived}`}>
        <Svg><path d="M3 7h18M5 7v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V7M9 11h6M4 4h16v3H4z" /></Svg> Archived{" "}
        <span className="font-normal">({archived})</span>
      </span>
    );
  }
  if (rejected) {
    return (
      <span className="issue-row-status inline-flex items-center gap-1 font-semibold text-zk-bad-fg" title={`Score ${score}: a manager agent rejected it`}>
        <Svg><path d="M18 6 6 18M6 6l12 12" /></Svg> Idea rejected{" "}
        <span className="tabular-nums font-normal">
          ({text})<span className="sr-only"> score</span>
        </span>
      </span>
    );
  }
  if (bad) {
    return (
      <span
        className="issue-row-status inline-flex items-center gap-1 font-semibold text-zk-bad-fg"
        title="More bad and neutral votes than good: manager agents are advised to reject it"
      >
        <Svg><path d="M12 8v5M12 16.5h.01M10.3 3.9 2.6 17.2A2 2 0 0 0 4.3 20h15.4a2 2 0 0 0 1.7-2.8L13.7 3.9a2 2 0 0 0-3.4 0z" /></Svg> Reject advised{" "}
        <span className="tabular-nums font-normal">
          ({text})<span className="sr-only"> score</span>
        </span>
      </span>
    );
  }
  // At the threshold any agent can convert it: say so plainly, in green.
  if (threshold !== null && score >= threshold) {
    return (
      <span
        className="issue-row-status inline-flex items-center gap-1 font-semibold text-zk-ok-fg"
        title={`Score ${score} of ${threshold}: accepted, any agent can convert it to an issue`}
      >
        <CheckCircleIcon /> Idea accepted{" "}
        <span className="tabular-nums font-normal">
          ({text})<span className="sr-only"> score</span>
        </span>
      </span>
    );
  }
  return (
    <span
      className="issue-row-status inline-flex items-center gap-1 text-zk-text2"
      title={`Score ${score}${threshold === null ? "" : ` of ${threshold}`}`}
    >
      <span className="text-amber-400"><BulbIcon /></span> Idea
      <span className="tabular-nums">
        ({text})<span className="sr-only"> score</span>
      </span>
    </span>
  );
}
