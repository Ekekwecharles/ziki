"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { fundIssueAction } from "@/app/actions/coins";

/**
 * Fund an issue with Ziks (#ziki-coins). The request id is made when the box
 * first draws, so a double click or a retry funds once. What the issue pays
 * out, and to whom, is the same as its reward (lib/points/payout.ts): Ziki's
 * fee comes off, and what is left goes to the people who earned it.
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
  const [amount, setAmount] = useState("");
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const value = Number(amount);
  const valid = Number.isInteger(value) && value > 0 && value <= balance;
  // What is still missing to reach the estimate, so "fund the estimate" never over-funds an issue that has some Ziks.
  const toEstimate = estimate ? Math.max(0, estimate.zik - escrow) : 0;

  const fund = (zik: number) => {
    setNote(null);
    startTransition(async () => {
      const result = await fundIssueAction(bugId, zik, requestId);
      setNote({ ok: result.ok, text: result.ok ? result.message : result.error });
      if (result.ok) {
        setAmount("");
        setRequestId(crypto.randomUUID());
        router.refresh();
      }
    });
  };

  return (
    <section aria-labelledby={`fund-${bugId}`} className="rounded-[20px] border border-zk-border bg-zk-surface p-5 sm:p-[22px]">
      <h2 id={`fund-${bugId}`} className="m-0 text-[11px] font-bold uppercase tracking-[0.08em] text-zk-muted">Ziks behind this issue</h2>
      <p className="mb-0 mt-2 text-2xl font-extrabold tabular-nums text-zk-text">{escrow.toLocaleString("en-US")} <span className="text-sm font-medium text-zk-muted">{escrow === 1 ? "Zik" : "Ziks"} held</span></p>
      <p className="mb-0 mt-1 text-sm text-zk-text2">Paid to the people who solve and review it once the work is reported live. Anything left when it closes goes back to whoever put it in.</p>
      {estimate ? (
        <p className="mb-0 mt-3 text-sm text-zk-text2">
          Agents and people estimated this at <b className="text-zk-text">{estimate.usd}</b>, which is {estimate.zik.toLocaleString("en-US")} Ziks (the average of {estimate.count} {estimate.count === 1 ? "estimate" : "estimates"}).
          {toEstimate === 0 ? " It is funded to that estimate." : ""}
        </p>
      ) : null}
      {canFund && estimate && toEstimate > 0 ? (
        <button
          type="button"
          disabled={pending || toEstimate > balance}
          onClick={() => fund(toEstimate)}
          className="mt-3 inline-flex min-h-11 cursor-pointer items-center justify-center rounded-full border border-electric-blue-strong px-5 text-sm font-bold whitespace-nowrap text-electric-blue-strong transition hover:bg-zk-chip focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-electric-blue focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? "Funding…" : escrow > 0 ? `Top up to the estimate: ${toEstimate.toLocaleString("en-US")} Ziks` : `Fund the estimate: ${toEstimate.toLocaleString("en-US")} Ziks`}
        </button>
      ) : null}
      {canFund ? (
        <form
          className="mt-4 flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!valid) return;
            fund(value);
          }}
        >
          <label className="flex flex-col gap-1 text-xs font-semibold text-zk-text2">
            Ziks to add
            <input
              inputMode="numeric"
              value={amount}
              onChange={(event) => setAmount(event.target.value.replace(/[^\d]/g, ""))}
              placeholder="50"
              className="h-11 w-32 rounded-full border border-zk-border bg-zk-surface px-4 text-sm font-semibold tabular-nums text-zk-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-electric-blue"
            />
          </label>
          <button
            type="submit"
            disabled={!valid || pending}
            className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-full bg-electric-blue-strong px-5 text-sm font-bold whitespace-nowrap text-white transition hover:bg-[#2552af] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-electric-blue focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {pending ? "Funding…" : "Fund issue"}
          </button>
          <p className="m-0 w-full text-xs text-zk-muted">
            You have {balance.toLocaleString("en-US")} {balance === 1 ? "Zik" : "Ziks"}. <Link href="/coins" className="font-semibold text-zk-accent hover:underline">Buy Ziks</Link>
          </p>
        </form>
      ) : null}
      {note ? <p role="status" className={`mb-0 mt-3 text-sm font-semibold ${note.ok ? "text-zk-ok-fg" : "text-zk-warn-fg"}`}>{note.text}</p> : null}
    </section>
  );
}
