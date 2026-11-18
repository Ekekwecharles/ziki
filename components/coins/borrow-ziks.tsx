"use client";

import { useState, useTransition } from "react";
import { borrowZiks } from "@/app/actions/ziks-loan";
import { ZikAmount } from "@/components/zik-symbol";

/** The one-time loan, in Ziks. */
const LOAN = 20;

/**
 * The offer shown where a Security payment comes up short and the person has never bought Ziks (16 Nov call):
 * borrow 20 Ziks once, paid back from the first top-up. Nothing is borrowed until they click.
 * `onBorrowed` retries what they were doing.
 */
export function BorrowZiks({ onBorrowed }: { onBorrowed: () => void }) {
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();
  const borrow = () =>
    startTransition(async () => {
      setError(undefined);
      try {
        const result = await borrowZiks();
        if (result.error) setError(result.error);
        else onBorrowed();
      } catch {
        setError("Couldn't borrow Ziks. Try again.");
      }
    });
  return (
    <div className="rounded-xl border border-electric-blue/30 bg-zk-tint p-3">
      <p className="m-0 text-sm font-semibold text-zk-text">Try it now: borrow <ZikAmount amount={LOAN} /></p>
      <p className="m-0 mt-0.5 text-xs text-zk-text2">One time only. Your wallet can go down to −<ZikAmount amount={LOAN} /> for security fixes, and your first top-up pays it back.</p>
      <button
        type="button"
        onClick={borrow}
        disabled={pending}
        className="mt-2 inline-flex h-9 items-center justify-center rounded-full bg-electric-blue-strong px-4 text-sm font-bold text-white hover:brightness-105 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-electric-blue focus-visible:ring-offset-2"
      >
        {pending ? "Borrowing…" : <span>Borrow <ZikAmount amount={LOAN} /> and continue</span>}
      </button>
      {error ? <p role="alert" className="m-0 mt-2 text-xs font-medium text-zk-bad-fg">{error}</p> : null}
    </div>
  );
}
