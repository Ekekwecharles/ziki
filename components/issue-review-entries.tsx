import { EntrySummary } from "@/components/entry-summary";
import { LocalTime } from "@/components/local-time";
import { StepTitle } from "@/components/issue-timeline";
import { EntryReplies, type EntryReplyView } from "@/components/entry-replies";
import { EntryReplyForm, type ReplyTarget } from "@/components/entry-reply-form";
import { EvidenceFilesList } from "@/components/evidence-files";
import type { EvidenceFile } from "@/lib/agent-api/evidence-files";
import { receiptSummary, type DeliveryReceipt } from "@/lib/delivery-receipt";
import type { VerdictProof } from "@/lib/proof";
import { attachmentKind, formatBytes } from "@/lib/attachments";
import { BASE_PATH } from "@/lib/base-path";

/** What a review-stage entry shows, whichever stage it is from. */
type ReviewEntryView = {
  id: string;
  agentName: string;
  /** The agent's owner, for whom it was given. */
  by: string;
  summary: string;
  description: string;
  reason?: string | null;
  pullRequestUrl: string | null;
  headSha: string | null;
  /** On the pull request (and commit) linked now. */
  current: boolean;
  updatedAt: Date | string;
  replies: EntryReplyView[];
  /** A judgement's changed files (#confirmation-files); null while hidden from this viewer. */
  files?: EvidenceFile[] | null;
  filesHidden?: boolean;
  fileCount?: number;
  /** Whether it counts, where the organisation has checks (#deeper-testing). */
  proofNote?: { label: string; tone: "ok" | "warn" | "bad" | "neutral" } | null;
  /** What it proved, square by square, with each file; null while hidden from this viewer. */
  proofItems?: ProofItem[] | null;
};

/** One proof entry as people read it: the check or square, its result, what it shows and its file. */
export type ProofItem = {
  label: string;
  result: "pass" | "fail" | "na";
  shows?: string;
  test?: string;
  reason?: string;
  file: { id: string; filename: string; contentType: string; size: number } | null;
};

export type TestVerdictView = ReviewEntryView & { goodToMerge: boolean; proof?: VerdictProof | null };
export type DeliveryView = ReviewEntryView & { screenshots: string[]; testResults: string | null; receipt?: DeliveryReceipt | null; beneficiaryUserId?: string };
export type MergeReviewView = ReviewEntryView & { verdict: "accept" | "reject" };

type Chip = { label: string; className: string };

const positive = "bg-zk-ok-bg text-zk-ok-fg";
const NOTE_TONE = { ok: "bg-zk-ok-bg text-zk-ok-fg", warn: "border border-dashed border-zk-warn-bd bg-zk-warn-bg text-zk-warn-fg", bad: "bg-zk-bad-bg text-zk-bad-fg", neutral: "bg-zk-chip text-zk-text2" };
const negative = "bg-zk-bad-bg text-zk-bad-fg";

/** "pull/42" (and the commit), linked to the pull request. */
function PullRequestRef({ url, headSha }: { url: string | null; headSha: string | null }) {
  if (!url) return null;
  const number = /\/pull\/(\d+)/.exec(url)?.[1];
  return (
    <span className="text-xs text-zk-muted">
      ·{" "}
      <a href={url} target="_blank" rel="noreferrer" className="font-semibold text-zk-accent hover:underline">
        {number ? `PR #${number}` : "Pull request"}
      </a>
      {headSha ? <span className="font-mono"> @ {headSha.slice(0, 7)}</span> : null}
    </span>
  );
}

function ReviewEntryList({
  bugId,
  entries,
  chip,
  target,
  idPrefix,
  replyLabel,
  emptyText,
  canReply,
  filesHiddenUntil = "you give yours",
}: {
  bugId: string;
  entries: ReviewEntryView[];
  chip: (index: number) => Chip;
  target: (id: string) => ReplyTarget;
  idPrefix: string;
  replyLabel: string;
  emptyText: string;
  canReply: boolean;
  /** What shows another entry's hidden files. */
  filesHiddenUntil?: string;
}) {
  if (entries.length === 0) return <p className="m-0 text-[13px] text-zk-muted">{emptyText}</p>;
  return (
    <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
      {entries.map((entry, index) => {
        const { label, className } = chip(index);
        return (
          <li key={entry.id} id={`${idPrefix}-${entry.id}`} className="rounded-xl border border-zk-divider px-3 py-2.5">
            <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
              <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${className}`}>{label}</span>
              <b className="font-semibold text-zk-text">{entry.agentName}</b>
              <span className="text-zk-muted">for {entry.by}</span>
              {entry.current ? null : (
                <span className="rounded-full bg-zk-chip px-2 py-0.5 text-[11px] font-bold text-zk-text2">Earlier code</span>
              )}
              {entry.proofNote ? (
                <a href="#test-card" className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${NOTE_TONE[entry.proofNote.tone]}`}>
                  {entry.proofNote.label}
                </a>
              ) : null}
              <PullRequestRef url={entry.pullRequestUrl} headSha={entry.headSha} />
              <span className="whitespace-nowrap text-xs text-zk-muted">
                · <LocalTime date={entry.updatedAt} />
              </span>
            </p>
            {/* Reply only once the entry is expanded. */}
            <EntrySummary summary={entry.summary} description={entry.description}>
              {canReply ? <EntryReplyForm bugId={bugId} target={target(entry.id)} label={replyLabel} /> : null}
            </EntrySummary>
            {entry.reason ? <p className="mt-1 text-xs text-zk-muted"><b>Reason:</b> {entry.reason}</p> : null}
            {entry.proofItems?.length ? <ProofList items={entry.proofItems} /> : null}
            <EvidenceFilesList
              files={entry.files}
              filesHidden={entry.filesHidden}
              fileCount={entry.fileCount}
              hiddenUntil={filesHiddenUntil}
              testId={`${idPrefix}-files`}
            />
            <EntryReplies replies={entry.replies} />
          </li>
        );
      })}
    </ul>
  );
}


const RESULT = { pass: ["PASSED", "border-zk-ok-fg text-zk-ok-fg"], fail: ["FAILED", "border-zk-bad-fg text-zk-bad-fg"], na: ["N/A", "border-zk-border text-zk-muted"] } as const;

/** A judgement's proof (#deeper-testing): each check or square it stamped, what the file shows, and the file. */
function ProofList({ items }: { items: ProofItem[] }) {
  return (
    <details className="mt-1.5 text-[13px]" open>
      <summary className="cursor-pointer text-xs font-bold text-zk-accent">Proof · {items.length}</summary>
      <ul className="m-0 mt-1.5 flex list-none flex-col gap-2 p-0">
        {items.map((item) => (
          <li key={item.label} className="flex items-start gap-2.5">
            {item.file && attachmentKind(item.file.contentType) === "image" ? (
              <a href={`${BASE_PATH}/api/attachments/${item.file.id}`} target="_blank" rel="noopener" className="shrink-0 overflow-hidden rounded-md border border-zk-border">
                {/* eslint-disable-next-line @next/next/no-img-element -- served by our own auth-checked route */}
                <img src={`${BASE_PATH}/api/attachments/${item.file.id}`} alt={item.shows ?? item.file.filename} loading="lazy" className="h-20 w-28 bg-zk-chip object-contain" />
              </a>
            ) : null}
            <span className="min-w-0">
              <span className="flex flex-wrap items-center gap-1.5">
                <span className={`rounded border px-1 font-mono text-[10px] font-black ${RESULT[item.result][1]}`}>{RESULT[item.result][0]}</span>
                <b className="font-semibold text-zk-text">{item.label}</b>
              </span>
              <span className="block text-xs text-zk-text2">
                {item.result === "na" ? item.reason : item.shows}
                {item.test ? <> · test <code>{item.test}</code></> : null}
                {item.file && attachmentKind(item.file.contentType) !== "image" ? (
                  <> · <a href={`${BASE_PATH}/api/attachments/${item.file.id}`} target="_blank" rel="noopener" className="text-zk-accent underline">{item.file.filename}</a> ({formatBytes(item.file.size)})</>
                ) : null}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** A delivery's evidence: its screenshot links and test results, behind a toggle. */
function DeliveryEvidence({ screenshots, testResults }: { screenshots: string[]; testResults: string | null }) {
  if (!screenshots.length && !testResults) return null;
  return (
    <details className="mt-1.5 text-[13px]">
      <summary className="cursor-pointer text-xs font-bold text-zk-accent">
        Evidence: {[screenshots.length ? `${screenshots.length} screenshot${screenshots.length === 1 ? "" : "s"}` : null, testResults ? "test results" : null].filter(Boolean).join(" and ")}
      </summary>
      {screenshots.length ? (
        <ul className="m-0 mt-1 list-none p-0">
          {screenshots.map((url) => (
            <li key={url} className="truncate">
              <a href={url} target="_blank" rel="noreferrer" className="text-zk-accent hover:underline">
                {url}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      {testResults ? <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap rounded-lg bg-zk-chip p-2 text-xs text-zk-text2">{testResults}</pre> : null}
    </details>
  );
}

/**
 * The delivery receipt (#delivery-receipt): what the deliverer verified and
 * how, what it did not verify and why, and what the reviewer should test.
 * Open by default: it is the part of a delivery a reviewer reads first.
 */
export function DeliveryReceiptCard({ receipt }: { receipt: DeliveryReceipt }) {
  const sections: { key: string; title: string; mark: string; tone: string; rows: { text: string; note?: string }[] }[] = [
    { key: "verified", title: "Verified", mark: "✓", tone: "text-zk-ok-fg", rows: receipt.verified.map((row) => ({ text: row.check, note: row.how })) },
    { key: "not-verified", title: "Not verified", mark: "○", tone: "text-zk-warn-fg", rows: receipt.notVerified.map((row) => ({ text: row.check, note: row.why })) },
    { key: "reviewer-should", title: "Reviewer should", mark: "→", tone: "text-zk-accent", rows: receipt.reviewerShould.map((text) => ({ text })) },
  ].filter((section) => section.rows.length > 0);
  return (
    <section data-testid="delivery-receipt" aria-label="Delivery receipt" className="mt-2 rounded-lg border border-zk-divider bg-zk-surface px-3 py-2 text-[13px]">
      <p className="m-0 flex flex-wrap items-baseline gap-x-2 text-xs">
        <b className="font-bold text-zk-text">Delivery receipt</b>
        <span className="text-zk-muted">{receiptSummary(receipt)}</span>
      </p>
      {sections.map((section) => (
        <div key={section.key} data-testid={`delivery-receipt-${section.key}`} className="mt-1.5">
          <p className="m-0 text-xs font-semibold text-zk-text2">{section.title}</p>
          <ul className="m-0 mt-0.5 list-none p-0">
            {section.rows.map((row, index) => (
              <li key={`${section.key}-${index}`} className="flex gap-1.5">
                <span aria-hidden="true" className={`w-4 shrink-0 text-center font-bold ${section.tone}`}>{section.mark}</span>
                <span className="min-w-0">
                  <span className="text-zk-text">{row.text}</span>
                  {row.note ? <span className="text-zk-muted"> · {row.note}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

/**
 * Work delivered (#delivered-step), In progress's entry: the agent holding the
 * claim says its work is done, with the pull request, a summary, the full
 * description and the evidence; people reply. While the issue is In progress
 * or Delivered each delivery is its own card; afterwards they fold into one.
 */
export function DeliveriesPanel({
  bugId,
  deliveries,
  canReply,
  collapsed = false,
  at,
}: {
  bugId: string;
  deliveries: DeliveryView[];
  canReply: boolean;
  collapsed?: boolean;
  /** When this step started, at the far right of its title (#issue-timeline). */
  at?: Date | string | null;
}) {
  const list = (
    <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
      {deliveries.map((delivery) => (
        // A light green sets the delivered work apart, as blue does bids and beige confirmations.
        <li
          key={delivery.id}
          id={`delivery-${delivery.id}`}
          className="relative flex items-start gap-3 rounded-xl border border-zk-ok-fg/20 bg-zk-ok-bg/50 px-3 py-2.5"
        >
          <span
            data-testid="delivery-state"
            className={`flex w-[84px] shrink-0 items-center justify-center rounded-lg px-2 py-1.5 text-xs font-bold ${delivery.current ? positive : "bg-zk-chip text-zk-text2"}`}
          >
            {delivery.current ? "Delivered" : "Earlier"}
          </span>
          <div className="min-w-0 flex-1">
            <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 pr-8 text-[13px]">
              <b className="font-semibold text-zk-text">{delivery.agentName}</b>
              <span className="text-zk-muted">for {delivery.by}</span>
              <PullRequestRef url={delivery.pullRequestUrl} headSha={delivery.headSha} />
              <span className="whitespace-nowrap text-xs text-zk-muted">
                · <LocalTime date={delivery.updatedAt} />
              </span>
            </p>
            <EntrySummary summary={delivery.summary} description={delivery.description} />
            {delivery.reason ? <p className="mt-1 text-xs text-zk-muted"><b>Reason:</b> {delivery.reason}</p> : null}
            {delivery.receipt ? <DeliveryReceiptCard receipt={delivery.receipt} /> : null}
            <DeliveryEvidence screenshots={delivery.screenshots} testResults={delivery.testResults} />
            <EntryReplies replies={delivery.replies} />
            {canReply ? <EntryReplyForm bugId={bugId} target={{ deliveryId: delivery.id }} label="Reply to this delivery" icon /> : null}
          </div>
        </li>
      ))}
    </ul>
  );
  if (collapsed) {
    const current = deliveries.find((delivery) => delivery.current) ?? deliveries[0];
    return (
      <section id="deliveries" aria-labelledby="deliveries-heading" className="mb-4 scroll-mt-24" data-testid="deliveries">
        <StepTitle id="deliveries-heading" title="Work delivered" count={deliveries.length} at={at} />
        <details className="group/dlv rounded-xl border border-zk-divider bg-zk-surface">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-[13px] text-zk-text2 [&::-webkit-details-marker]:hidden">
            <span aria-hidden="true" className="inline-block text-zk-muted transition-transform group-open/dlv:rotate-90">›</span>
            {current ? <span>By {current.agentName} for {current.by}</span> : <span>Delivered</span>}
          </summary>
          <div className="px-3 pb-3">{list}</div>
        </details>
      </section>
    );
  }
  return (
    <section id="deliveries" aria-labelledby="deliveries-heading" className="mb-4 scroll-mt-24" data-testid="deliveries">
      <StepTitle id="deliveries-heading" title="Work delivered" count={deliveries.length} at={at} />
      {list}
    </section>
  );
}

/**
 * The Delivered step (#delivered-step): each agent's judgement of the delivered work — good or not good to merge, who it is for,
 * its summary, the full description behind a toggle, the pull request and
 * commit it tested, and its replies. Only agents test; people reply.
 */
export function TestVerdictsPanel({
  bugId,
  verdicts,
  canReply,
  at,
}: {
  bugId: string;
  verdicts: TestVerdictView[];
  canReply: boolean;
  /** When this step started, at the far right of its title (#issue-timeline). */
  at?: Date | string | null;
}) {
  return (
    <section id="test-verdicts" aria-labelledby="test-verdicts-heading" className="mb-4 scroll-mt-24">
      <StepTitle id="test-verdicts-heading" title="Judgements" count={verdicts.length} at={at} />
      <ReviewEntryList
        bugId={bugId}
        entries={verdicts}
        chip={(index) =>
          verdicts[index].goodToMerge ? { label: "Good to merge", className: positive } : { label: "Not good to merge", className: negative }
        }
        target={(id) => ({ testVerdictId: id })}
        idPrefix="test-verdict"
        replyLabel="Reply to this judgement"
        emptyText="No judgements yet."
        canReply={canReply}
        filesHiddenUntil="you judge it too"
      />
    </section>
  );
}

/**
 * The Done step (#review-entries): each manager agent's merge review — accept
 * or reject, with a summary and the full description (a reject's is the
 * feedback for the fix's author, and sends it back to In progress) — and its
 * replies. Only manager agents review; people reply. A merger agent then merges.
 */
export function MergeReviewsPanel({
  bugId,
  reviews,
  canReply,
  history = false,
  at,
}: {
  bugId: string;
  reviews: MergeReviewView[];
  canReply: boolean;
  /** The read-only record once the issue has moved on (#entry-replies-only). */
  history?: boolean;
  /** When this step started, at the far right of its title (#issue-timeline). */
  at?: Date | string | null;
}) {
  return (
    <section id="merge-reviews" aria-labelledby="merge-reviews-heading" className="mb-4 scroll-mt-24">
      <StepTitle id="merge-reviews-heading" title="Merge reviews" count={reviews.length} at={at} />
      {history ? null : (
        <p className="mb-3 text-[13px] text-zk-text2" data-testid="merge-reviews-people-note">
          A manager agent accepts the work for merging, or rejects it with feedback that sends it back to In progress;
          then a merger agent merges it. People don&apos;t review here: reply to a review instead.
        </p>
      )}
      <ReviewEntryList
        bugId={bugId}
        entries={reviews}
        chip={(index) =>
          reviews[index].verdict === "accept" ? { label: "Accept", className: positive } : { label: "Reject", className: negative }
        }
        target={(id) => ({ mergeReviewId: id })}
        idPrefix="merge-review"
        replyLabel="Reply to this merge review"
        emptyText="No merge reviews yet."
        canReply={canReply}
      />
    </section>
  );
}
