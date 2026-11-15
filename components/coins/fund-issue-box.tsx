"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { fundIssueAction } from "@/app/actions/coins";

/**
 * Fund an issue with Ziks (#ziki-coins), drawn inside the Reward card so the person who can fund it sees it with the
 * estimate. The amount starts at what is still missing to reach the estimate and can't go below that; once the issue
 * is funded to the estimate, any amount adds to it. The request id is made when the box first draws, so a double click
 * or a retry funds once. Ziki's fee comes off when the issue pays out (lib/points/payout.ts).
 */
export function FundIssueBox({
  bugId,
  escrow,
  balance,
  canFund,
  estimate,
}: {
  bugId: string;
  escrow: number;
  balance: number;
  canFund: boolean;
  /** The reward estimate agreed by planning poker, in Ziks and in dollars, once anyone has estimated. */
  estimate?: { zik: number; usd: string; count: number } | null;
}) {
  const router = useRouter();
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  // What is still missing to reach the estimate: the least this issue can be funded with right now.
  const toEstimate = estimate ? Math.max(0, estimate.zik - escrow) : 0;
  const minimum = Math.max(1, toEstimate);
  const [amount, setAmount] = useState(() => (toEstimate > 0 ? String(toEstimate) : ""));
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const value = Number(amount);
  const whole = amount !== "" && Number.isInteger(value) && value > 0;
  const valid = whole && value >= minimum && value <= balance;
  const shortBy = Math.max(0, minimum - balance);

  const fund = () => {
    if (!valid) return;
    setNote(null);
    startTransition(async () => {
      const result = await fundIssueAction(bugId, value, requestId);
      setNote({ ok: result.ok, text: result.ok ? result.message : result.error });
      if (result.ok) {
        setAmount("");
        setRequestId(crypto.randomUUID());
        router.refresh();
      }
    });
  };

  return (
    <div className="flex flex-col gap-5 rounded-2xl border border-zk-border bg-zk-chip px-5 py-5" data-testid="fund-issue">
      <p className="m-0 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 pb-0.5">
        <span className="text-xs font-bold uppercase tracking-[0.08em] text-zk-muted">Funded</span>
        <span className="text-sm font-bold tabular-nums text-zk-text">
          {escrow.toLocaleString("en-US")} <span className="font-medium text-zk-muted">{escrow === 1 ? "Zik" : "Ziks"} held</span>
        </span>
      </p>
      {estimate ? (
        <p className="m-0 text-xs text-zk-text2">
          Estimate {estimate.usd}, {estimate.zik.toLocaleString("en-US")} Ziks, from {estimate.count} {estimate.count === 1 ? "estimate" : "estimates"}.
        </p>
      ) : null}

      {canFund ? (
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            fund();
          }}
        >
          <div className="flex items-center gap-2">
            <label className="sr-only" htmlFor={`fund-${bugId}`}>Ziks to put behind this issue</label>
            <input
              id={`fund-${bugId}`}
              inputMode="numeric"
              value={amount}
              onChange={(event) => setAmount(event.target.value.replace(/[^\d]/g, ""))}
              placeholder={String(minimum)}
              className="h-11 w-24 shrink-0 rounded-full border border-zk-border bg-zk-surface px-4 text-sm font-semibold tabular-nums text-zk-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-electric-blue"
            />
            <button
              type="submit"
              disabled={!valid || pending}
              className="inline-flex min-h-11 flex-1 cursor-pointer items-center justify-center rounded-full bg-electric-blue-strong px-4 text-sm font-bold whitespace-nowrap text-white shadow-[0_8px_20px_rgba(46,111,239,0.30)] transition hover:bg-[#2552af] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-electric-blue focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none"
            >
              {pending ? "Funding…" : valid ? `Fund ${value.toLocaleString("en-US")} ${value === 1 ? "Zik" : "Ziks"}` : "Fund issue"}
            </button>
          </div>
          {whole && value < minimum ? (
            <p className="m-0 text-xs font-semibold text-zk-warn-fg">The least you can fund is {minimum.toLocaleString("en-US")} {minimum === 1 ? "Zik" : "Ziks"}.</p>
          ) : null}
          <p className="m-0 mt-1 text-xs text-zk-muted">
            You have {balance.toLocaleString("en-US")} {balance === 1 ? "Zik" : "Ziks"}.{" "}
            <Link href="/coins" className="font-semibold text-zk-accent hover:underline">
              {shortBy > 0 ? `Buy ${shortBy.toLocaleString("en-US")} more Ziks` : "Buy Ziks"}
            </Link>
          </p>
        </form>
      ) : null}
      {note ? <p role="status" className={`m-0 text-sm font-semibold ${note.ok ? "text-zk-ok-fg" : "text-zk-warn-fg"}`}>{note.text}</p> : null}
    </div>
  );
}
