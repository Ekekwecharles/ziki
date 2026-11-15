"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setUpPayoutsAction, withdrawZiksAction } from "@/app/actions/coins";

const PRIMARY =
  "inline-flex min-h-11 cursor-pointer items-center justify-center rounded-full bg-electric-blue-strong px-5 text-sm font-bold whitespace-nowrap text-white shadow-[0_8px_20px_rgba(46,111,239,0.30)] transition hover:bg-[#2552af] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-electric-blue focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60";

/**
 * Payouts on the Ziks page: set up Stripe once, then withdraw earned Ziks once
 * they reach the threshold. The server decides everything (lib/coins/withdraw.ts);
 * this only shows what it said.
 */
export function PayoutsPanel({
  payoutsReady,
  hasAccount,
  withdrawable,
  withdrawableUsd,
  thresholdUsd,
  canWithdraw,
}: {
  payoutsReady: boolean;
  hasAccount: boolean;
  withdrawable: number;
  withdrawableUsd: string;
  thresholdUsd: number;
  canWithdraw: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  if (!payoutsReady) {
    return (
      <div>
        <p className="m-0 text-sm text-zk-text2">
          {hasAccount
            ? "Finish setting up your payout account with Stripe to withdraw what you earn."
            : "Connect a payout account with Stripe once. After that you can withdraw what you earn."}
        </p>
        <form action={setUpPayoutsAction} className="mt-4">
          <button type="submit" className={PRIMARY}>{hasAccount ? "Finish payout setup" : "Set up payouts"}</button>
        </form>
      </div>
    );
  }

  return (
    <div>
      <p className="m-0 text-sm text-zk-text2">
        {canWithdraw
          ? `You can withdraw ${withdrawable.toLocaleString("en-US")} Ziks, ${withdrawableUsd}, to your Stripe account.`
          : `Withdrawals open at $${thresholdUsd} of earned Ziks. You have ${withdrawableUsd} so far.`}
      </p>
      <button
        type="button"
        disabled={!canWithdraw || pending}
        className={`${PRIMARY} mt-4`}
        onClick={() => {
          setNote(null);
          startTransition(async () => {
            const result = await withdrawZiksAction();
            setNote({ ok: result.ok, text: result.ok ? result.message : result.error });
            router.refresh();
          });
        }}
      >
        {pending ? "Withdrawing…" : "Withdraw"}
      </button>
      {note ? (
        <p role="status" className={`mb-0 mt-3 text-sm font-semibold ${note.ok ? "text-zk-ok-fg" : "text-zk-warn-fg"}`}>{note.text}</p>
      ) : null}
    </div>
  );
}
