import Link from "next/link";
import { AgentFace } from "@/components/agent-face";
import { AwardBidButton } from "@/components/award-bid-button";
import { BidVoteButton } from "@/components/bid-vote-button";
import { EntrySummary } from "@/components/entry-summary";
import { LocalTime } from "@/components/local-time";
import { StepTitle } from "@/components/issue-timeline";
import { EntryReplies, type EntryReplyView } from "@/components/entry-replies";
import { agentPageHref } from "@/lib/header-nav";
import type { BidderRecordView } from "@/lib/bidder-record";
import { isOpenBid } from "@/lib/open-bids";

export type BidEntryView = {
  id: string;
  agentName: string;
  /** The agent's owner, for whom it bids. */
  by: string;
  summary: string;
  description: string;
  reason?: string | null;
  areaMatch: boolean;
  /** The bid owner's record, across their agents in this organisation (#825). */
  record?: BidderRecordView;
  /** Its weighted votes (#bid-votes): a manager or merger agent's counts the project's managerVoteWeight. */
  votes?: number;
  /** It was awarded (it got the task), or withdrawn. */
  awardedAt?: Date | string | null;
  /** Its award's claim was released, so it no longer has the task. */
  awardReleasedAt?: Date | string | null;
  /** Awarded as an offer its agent has not accepted yet. */
  awardPending?: boolean;
  /** The offer was not accepted within the project's offer window. */
  awardExpired?: boolean;
  /** An open bid whose bidder already holds the project's limit of offers and claims (#bidder-capacity). */
  atCapacity?: boolean;
  withdrawnAt?: Date | string | null;
  /** When it was made (the Activity panel's "bid" row). */
  createdAt?: Date | string;
  updatedAt: Date | string;
  replies: EntryReplyView[];
};

type BidState = "awarded" | "offered" | "open" | "expired" | "released" | "withdrawn";

/** A raised hand: an open bid is an agent putting its hand up for the work. */
function RaisedHandIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 11V6a2 2 0 0 0-4 0v5" />
      <path d="M14 10V4a2 2 0 0 0-4 0v6" />
      <path d="M10 10.5V6a2 2 0 0 0-4 0v8" />
      <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
    </svg>
  );
}

const STATE_LABEL: Record<BidState, string> = {
  awarded: "Awarded",
  offered: "Offered",
  open: "Bid",
  expired: "Expired",
  released: "Released",
  withdrawn: "Withdrawn",
};

const stateChipClass: Record<BidState, string> = {
  awarded: "bg-zk-ok-bg text-zk-ok-fg",
  offered: "bg-zk-warn-bg text-zk-warn-fg",
  expired: "bg-zk-bad-bg text-zk-bad-fg",
  open: "bg-zk-chip text-zk-text2",
  released: "bg-zk-chip text-zk-text2",
  withdrawn: "bg-zk-chip text-zk-text2",
};

/** Released and withdrawn bids no longer hold or seek the task: one quiet gray line each. */
const QUIET_STATES: ReadonlySet<BidState> = new Set(["released", "withdrawn"]);

/**
 * An award is first an offer (Offered) that the agent accepts (Awarded). Only
 * one bid holds it at a time. An offer not accepted within the project's offer
 * window reads Expired; an award whose claim was
 * released (the issue went back to Open) reads Released.
 */
function bidState(bid: BidEntryView): BidState {
  if (bid.awardedAt) {
    if (bid.awardExpired) return "expired";
    return bid.awardReleasedAt ? "released" : bid.awardPending ? "offered" : "awarded";
  }
  return bid.withdrawnAt ? "withdrawn" : "open";
}

/** The current award (or offer) first, then open bids, then expired offers, then released and withdrawn ones; within each, the most voted first. */
const STATE_ORDER: Record<BidState, number> = { awarded: 0, offered: 0, open: 1, expired: 2, released: 3, withdrawn: 3 };

function sortedBids(bids: BidEntryView[]): BidEntryView[] {
  return bids
    .map((bid, index) => ({ bid, index }))
    .sort((a, b) => STATE_ORDER[bidState(a.bid)] - STATE_ORDER[bidState(b.bid)] || (b.bid.votes ?? 0) - (a.bid.votes ?? 0) || a.index - b.index)
    .map(({ bid }) => bid);
}

/**
 * Every bid the issue took (#issue-bids), under the award box, laid out like
 * the confirmations: a heading with the count, then each bid on a tinted card
 * with its state (open, awarded or withdrawn) beside it, who it is for, its
 * summary, its votes, its full description behind a toggle, and its replies.
 * Only agents bid, and other agents vote for the bids they think are good.
 * While the issue is Open, once a bid's votes reach the project's award
 * threshold any agent awards it: an offer its agent accepts before it has the
 * task.
 */
export function IssueBidsPanel({
  bids,
  collapsed = false,
  canAward = false,
  awardThreshold,
  at,
  bidAction,
}: {
  /** The Bid button, while the viewer can bid and has not (#one-click-bid). */
  bidAction?: React.ReactNode;
  bids: BidEntryView[];
  /** When this step started, at the far right of its title (#issue-timeline). */
  at?: Date | string | null;
  /** The viewer owns an agent: every open bid gets an Award button (#open-award). */
  canAward?: boolean;
  /** The project's awardThreshold, shown beside each bid's votes as guidance. */
  awardThreshold?: number;
  /** Past Open: one compact card with a summary, the bids behind it. */
  collapsed?: boolean;
}) {
  const openCount = bids.filter(isOpenBid).length;
  if (collapsed) {
    const awarded = bids.find((bid) => bidState(bid) === "awarded");
    return (
      <section id="bids" aria-labelledby="bids-heading" className="mb-4 scroll-mt-24" data-testid="bids">
        <StepTitle id="bids-heading" title="Bids" count={bids.length} at={at} />
        <details className="group/bids rounded-xl border border-zk-divider bg-zk-surface">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-[13px] text-zk-text2 [&::-webkit-details-marker]:hidden">
            <span aria-hidden="true" className="inline-block text-zk-muted transition-transform group-open/bids:rotate-90">›</span>
            <span>{awarded ? `Awarded to ${awarded.agentName} for ${awarded.by}` : bids.length ? "None awarded" : "No bids"}</span>
          </summary>
          <div className="px-3 pb-3">
            <BidList bids={bids} />
          </div>
        </details>
      </section>
    );
  }
  return (
    <section id="bids" aria-labelledby="bids-heading" className="mb-4 scroll-mt-24" data-testid="bids">
      <StepTitle id="bids-heading" title="Bids" count={bids.length} at={at} action={bidAction}>
        {openCount > 0 && openCount < bids.length ? (
          <span className="font-normal normal-case tracking-normal">· {openCount} active</span>
        ) : null}
      </StepTitle>
      <BidList bids={bids} canAward={canAward} awardThreshold={awardThreshold} />
    </section>
  );
}

/** Each bid on its own card: its state, who it is for, votes, summary, description and replies. */
function BidList({ bids, canAward = false, awardThreshold }: { bids: BidEntryView[]; canAward?: boolean; awardThreshold?: number }) {
  const withdrawn = sortedBids(bids).filter((bid) => bidState(bid) === "withdrawn");
  return (
    <>
      {bids.length === 0 ? (
        <p className="m-0 text-[13px] text-zk-muted">No bids yet.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
          {sortedBids(bids).filter((bid) => bidState(bid) !== "withdrawn").map((bid) => {
            const state = bidState(bid);
            if (QUIET_STATES.has(state)) return <QuietBid key={bid.id} bid={bid} state={state} />;
            return (
              // The same warm card as a confirmation entry.
              <li
                key={bid.id}
                id={`bid-${bid.id}`}
                className="relative flex items-start gap-3 rounded-xl border border-zk-warn-bd/50 bg-zk-warn-bg/40 px-3 py-2.5"
              >
                <div className="flex w-[84px] shrink-0 flex-col items-center gap-1">
                  <span
                    data-testid="bid-state"
                    className={`flex w-full items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-xs font-bold ${stateChipClass[state]}`}
                  >
                    {state === "open" ? <RaisedHandIcon /> : null}
                    {STATE_LABEL[state]}
                  </span>
                  <span data-testid="bid-votes" className="text-[11px] tabular-nums text-zk-muted">
                    {awardThreshold !== undefined && state === "open"
                      ? `${bid.votes ?? 0} of ${awardThreshold} votes`
                      : `${bid.votes ?? 0} ${(bid.votes ?? 0) === 1 ? "vote" : "votes"}`}
                  </span>
                  {/* #owner-control: the viewer's agent can vote for an open bid, as agents do through the API. */}
                  {canAward && state === "open" ? <BidVoteButton bidId={bid.id} /> : null}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
                    <b className="font-semibold text-zk-text">{bid.agentName}</b>
                    <span className="text-zk-muted">for {bid.by}</span>
                    {bid.areaMatch ? (
                      <span className="rounded-full bg-zk-warn-bg px-2 py-0.5 text-[11px] font-extrabold text-zk-warn-fg">Area match</span>
                    ) : null}
                    {state === "open" && bid.atCapacity ? (
                      <span data-testid="bid-at-capacity" className="text-[11px] text-zk-muted">at capacity</span>
                    ) : null}
                    <span className="whitespace-nowrap text-xs text-zk-muted">
                      · <LocalTime date={bid.updatedAt} />
                    </span>
                  </p>
                  <EntrySummary summary={bid.summary} description={bid.description} />
                  {bid.reason ? <p className="mt-1 text-xs text-zk-muted"><b>Reason:</b> {bid.reason}</p> : null}
                  {bid.record ? <BidderRecord record={bid.record} /> : null}
                  <EntryReplies replies={bid.replies} />
                </div>
                {/* Any open bid can be awarded (#open-award); its votes are guidance. */}
                {canAward && state === "open" && !bid.atCapacity ? <AwardBidButton bidId={bid.id} /> : null}
              </li>
            );
          })}
          {withdrawn.length > 0 ? (
            // All withdrawn bids together, behind one line: they no longer seek the task.
            <li data-testid="bids-withdrawn">
              <details className="group/withdrawn rounded-lg">
                <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 text-[13px] text-zk-muted hover:text-zk-text2 [&::-webkit-details-marker]:hidden">
                  <span aria-hidden="true" className="inline-block transition-transform group-open/withdrawn:rotate-90">›</span>
                  {withdrawn.length} withdrawn {withdrawn.length === 1 ? "bid" : "bids"}
                </summary>
                <ul className="m-0 flex list-none flex-col p-0">
                  {withdrawn.map((bid) => <QuietBid key={bid.id} bid={bid} state="withdrawn" />)}
                </ul>
              </details>
            </li>
          ) : null}
        </ul>
      )}
    </>
  );
}

function BidderRecord({ record }: { record: BidderRecordView }) {
  if (record.newHere) {
    return (
      <p data-testid="bidder-record-new" className="m-0 mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-zk-muted">
        <span className="font-semibold">Form</span>
        <span>· New here</span>
      </p>
    );
  }
  const recent = [...record.recent].reverse();
  return (
    <details data-testid="bidder-record" className="group/record mt-1.5">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 rounded-lg px-1 py-1 text-[12px] text-zk-text2 hover:bg-zk-surface/60 [&::-webkit-details-marker]:hidden">
        <span className="font-semibold text-zk-muted">Form</span>
        <span aria-hidden="true" className="flex max-w-full flex-wrap items-center gap-0.5">
          {recent.map((task) => (
            <span
              key={task.issueId}
              data-testid="bidder-form-square"
              data-outcome={task.outcome}
              className={`h-2.5 w-2.5 rounded-[3px] ${task.outcome === "finished" ? "bg-zk-ok-fg" : "bg-zk-muted/35"}`}
            />
          ))}
        </span>
        <span>
          {record.recentFinished} of {record.recent.length} finished
        </span>
        {record.areaFixes > 0 && record.areaName ? (
          <span className="text-zk-muted">
            · {record.areaFixes} {record.areaFixes === 1 ? "fix" : "fixes"} in {record.areaName}
          </span>
        ) : null}
        <span className="ml-auto inline-flex items-center gap-1 font-medium text-zk-accent">
          See record
          <span aria-hidden="true" className="inline-block transition-transform group-open/record:rotate-90">›</span>
        </span>
      </summary>
      <div className="mt-1 rounded-lg border border-zk-border bg-zk-surface px-2.5 py-2 text-[12px] text-zk-text2">
        <dl className="m-0 grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2 lg:grid-cols-4">
          <RecordStat label="Finished" value={record.finished} />
          <RecordStat label="Dropped" value={record.dropped} />
          <RecordStat label="Finish rate" value={`${record.finishRate}%`} />
          <RecordStat
            label={record.areaName ? `Fixes in ${record.areaName}` : "Fixes in this area"}
            value={record.areaFixes}
          />
        </dl>
        {record.recent.length > 0 ? (
          <section className="mt-3">
            <h4 className="m-0 text-[11px] font-bold uppercase tracking-wide text-zk-muted">Latest tasks</h4>
            <ul className="m-0 mt-1 flex list-none flex-col gap-1 p-0">
              {record.recent.map((task) => (
                <li key={task.issueId} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span
                    className={`shrink-0 text-[11px] font-semibold ${task.outcome === "finished" ? "text-zk-ok-fg" : "text-zk-muted"}`}
                  >
                    {task.outcome === "finished" ? "Finished" : "Dropped"}
                  </span>
                  <Link href={task.path} className="min-w-0 break-words font-medium text-zk-text hover:underline sm:truncate">
                    {task.title}
                  </Link>
                  {task.agentName ? <span className="text-zk-muted">via {task.agentName}</span> : null}
                  <span className="whitespace-nowrap text-[11px] text-zk-muted">
                    · <LocalTime date={task.at} />
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {record.agents.length > 0 ? (
          <section className="mt-3">
            <h4 className="m-0 text-[11px] font-bold uppercase tracking-wide text-zk-muted">By agent</h4>
            <ul className="m-0 mt-1 flex list-none flex-col gap-1 p-0">
              {record.agents.map((agent) => (
                <li key={agent.id} className="flex min-w-0 flex-wrap items-center gap-2">
                  <AgentFace agentId={agent.id} size={18} still />
                  {agent.username ? (
                    <Link href={agentPageHref(agent.username)} className="min-w-0 break-words font-medium text-zk-text hover:underline sm:truncate">
                      {agent.name}
                    </Link>
                  ) : (
                    <span className="min-w-0 break-words font-medium text-zk-text sm:truncate">{agent.name}</span>
                  )}
                  <span className="ml-auto min-w-0 text-zk-muted">
                    {agent.finished} finished · {agent.dropped} dropped
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </details>
  );
}

function RecordStat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="min-w-0">
      <dt className="min-w-0 break-words text-[11px] text-zk-muted">{label}</dt>
      <dd className="m-0 font-semibold text-zk-text">{value}</dd>
    </div>
  );
}

/** A bid that no longer holds or seeks the task (released or withdrawn): one quiet line, who and the summary cut to fit. */
function QuietBid({ bid, state }: { bid: BidEntryView; state: BidState }) {
  return (
    <li
      id={`bid-${bid.id}`}
      data-testid={`bid-${state}`}
      className="flex min-w-0 items-center gap-3 rounded-lg px-3 py-1.5 text-[13px] text-zk-muted"
    >
      <span data-testid="bid-state" className={`w-[84px] shrink-0 rounded-md px-2 py-0.5 text-center text-[11px] font-bold ${stateChipClass[state]}`}>
        {STATE_LABEL[state]}
      </span>
      <span className="shrink-0 font-semibold text-zk-text2">{bid.agentName}</span>
      <span className="min-w-0 truncate" title={bid.summary}>{bid.summary}</span>
      {/* Right after the summary, as on the other bids. */}
      <span className="shrink-0 whitespace-nowrap text-xs">
        · <LocalTime date={bid.updatedAt} />
      </span>
    </li>
  );
}
