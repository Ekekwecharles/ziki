import Link from "next/link";
import { requireUser } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import { buyZiksAction } from "@/app/actions/coins";
import { WITHDRAW_THRESHOLD } from "@/lib/earnings-threshold";
import { walletSummary } from "@/lib/coins/ledger";
import { ZIK_PACKS, formatUsd, formatZik, zikToCents } from "@/lib/coins/math";
import { stripeConfigured } from "@/lib/coins/stripe";
import { WITHDRAWAL_WAIT_DAYS, WITHDRAW_MIN_ZIK, syncPayoutsEnabled } from "@/lib/coins/withdraw";
import { LocalTime } from "@/components/local-time";
import { UrlNotice } from "@/components/coins/url-notice";
import { PayoutsPanel } from "./payouts-panel";

export const metadata = { title: "Ziks" };
export const dynamic = "force-dynamic";

const card = "rounded-[22px] border border-zk-border bg-zk-surface p-5 sm:p-6";
const label = "text-[11px] font-bold uppercase tracking-[0.08em] text-zk-muted";

/** What a ledger row says happened, for the activity list. */
const KIND_LABEL = {
  purchase: "Bought Ziks",
  fund_issue: "Funded an issue",
  release: "Earned from an issue",
  fee: "Fee",
  refund: "Refunded from an issue",
  withdrawal: "Withdrawal",
  withdrawal_reversal: "Withdrawal returned",
  check_payment: "Unlocked security fixes",
} as const;

/**
 * Ziks (#ziki-coins): your wallet, the packs you can buy with Stripe, payouts for
 * what you earn, and what moved. Buying is Stripe Checkout; the wallet is only
 * credited when Stripe's webhook says the payment went through.
 */
export default async function CoinsPage({ searchParams }: { searchParams?: Promise<{ bought?: string; payouts?: string; error?: string }> }) {
  const [user, query] = await Promise.all([requireUser(), searchParams ?? Promise.resolve({} as { bought?: string; payouts?: string; error?: string })]);
  // Coming back from Stripe's onboarding page: read the account now rather than wait for its webhook.
  if (query.payouts === "return" && stripeConfigured()) await syncPayoutsEnabled(user.id).catch(() => false);

  const [wallet, account, entries, withdrawals] = await Promise.all([
    walletSummary(prisma, user.id),
    prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { stripeAccountId: true, payoutsEnabled: true } }),
    prisma.coinEntry.findMany({
      where: { account: "wallet", userId: user.id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 12,
      select: { id: true, kind: true, amount: true, createdAt: true, bug: { select: { number: true, title: true } } },
    }),
    prisma.withdrawal.findMany({ where: { userId: user.id }, orderBy: { createdAt: "desc" }, take: 5, select: { id: true, zik: true, amountCents: true, status: true, stripeTransferId: true, createdAt: true } }),
  ]);
  // A withdrawal that is debited but not yet paid: either still waiting for Stripe's funds, or sent and on its way.
  const open = withdrawals.find((withdrawal) => withdrawal.status === "pending");
  const canWithdraw = wallet.withdrawable >= WITHDRAW_MIN_ZIK;
  const configured = stripeConfigured();

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5">
      <Link href="/home" className="self-start text-sm font-semibold text-zk-accent hover:underline">← Back</Link>
      <div>
        <h1 className="text-3xl font-extrabold tracking-tight text-zk-text">Ziks</h1>
        <p className="mt-1 text-sm text-zk-text2">Ziks fund issues, unlock security fixes and pay out what you earn. One Zik is {zikToCents(1)}¢.</p>
      </div>

      {query.bought === "1" ? (
        <p role="status" className="m-0 rounded-2xl bg-zk-ok-bg px-4 py-3 text-sm font-semibold text-zk-ok-fg">Thanks. Your Ziks arrive as soon as Stripe confirms the payment, usually within a few seconds.</p>
      ) : null}
      {query.payouts === "return" ? (
        <p role="status" className={`m-0 rounded-2xl px-4 py-3 text-sm font-semibold ${account.payoutsEnabled ? "bg-zk-ok-bg text-zk-ok-fg" : "bg-zk-warn-bg text-zk-warn-fg"}`}>
          {account.payoutsEnabled ? "Payouts are set up." : "Stripe still needs a few details before you can withdraw."}
        </p>
      ) : null}
      {query.error ? <UrlNotice role="alert" className="m-0 rounded-2xl bg-zk-warn-bg px-4 py-3 text-sm font-semibold text-zk-warn-fg">{query.error}</UrlNotice> : null}

      <div className="grid gap-5 md:grid-cols-2">
        <section aria-labelledby="wallet" className={`${card} bg-[linear-gradient(160deg,var(--color-zk-surface)_60%,var(--color-zk-tint))]`}>
          <h2 id="wallet" className={label}>Your Ziks</h2>
          <p className="mt-3 text-4xl font-extrabold tracking-tight tabular-nums text-zk-text sm:text-[44px]">{wallet.balance.toLocaleString("en-US")}</p>
          <p className="mt-1 text-sm text-zk-text2">{formatUsd(zikToCents(wallet.balance))} in value</p>
          <dl className="mt-5 grid grid-cols-2 gap-3 border-t border-zk-divider pt-4">
            <div><dt className="text-xs text-zk-muted">To spend</dt><dd className="mt-0.5 font-mono text-base font-bold tabular-nums text-zk-text">{(wallet.balance - wallet.withdrawable).toLocaleString("en-US")}</dd></div>
            <div><dt className="text-xs text-zk-muted">Earned, can withdraw</dt><dd className="mt-0.5 font-mono text-base font-bold tabular-nums text-zk-ok-fg">{wallet.withdrawable.toLocaleString("en-US")}</dd></div>
          </dl>
        </section>

        <section aria-labelledby="payouts" className={card}>
          <h2 id="payouts" className={label}>Payouts</h2>
          <div className="mt-3">
            {configured ? (
              <PayoutsPanel
                payoutsReady={account.payoutsEnabled}
                hasAccount={Boolean(account.stripeAccountId)}
                withdrawable={wallet.withdrawable}
                withdrawableUsd={formatUsd(zikToCents(wallet.withdrawable))}
                thresholdUsd={WITHDRAW_THRESHOLD}
                canWithdraw={canWithdraw}
                inFlight={open ? { zik: open.zik, usd: formatUsd(open.amountCents), sent: Boolean(open.stripeTransferId), waitDays: WITHDRAWAL_WAIT_DAYS } : null}
              />
            ) : (
              <p className="m-0 text-sm text-zk-text2">Payouts aren&apos;t available yet.</p>
            )}
          </div>
        </section>
      </div>

      <section aria-labelledby="packs" className={card}>
        <h2 id="packs" className={label}>Buy Ziks</h2>
        <ul className="m-0 mt-4 grid list-none gap-3 p-0 sm:grid-cols-2 lg:grid-cols-4">
          {ZIK_PACKS.map((pack) => (
            <li key={pack.id} className="rounded-2xl border border-zk-border p-4">
              <p className="m-0 text-sm font-bold text-zk-text">{pack.label}</p>
              <p className="m-0 mt-2 text-2xl font-extrabold tabular-nums text-zk-text">{pack.zik.toLocaleString("en-US")}</p>
              <p className="m-0 text-xs text-zk-muted">Ziks</p>
              <form action={buyZiksAction} className="mt-4">
                <input type="hidden" name="packId" value={pack.id} />
                <button
                  type="submit"
                  disabled={!configured}
                  className="inline-flex min-h-11 w-full cursor-pointer items-center justify-center rounded-full border border-zk-border bg-zk-surface px-4 text-sm font-bold text-zk-text transition hover:bg-zk-chip focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-electric-blue disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Buy for {formatUsd(zikToCents(pack.zik))}
                </button>
              </form>
            </li>
          ))}
        </ul>
        {!configured ? <p className="mb-0 mt-3 text-sm text-zk-text2">Buying Ziks isn&apos;t available yet.</p> : null}
      </section>

      <section aria-labelledby="activity" className={card}>
        <h2 id="activity" className={label}>Activity</h2>
        {entries.length === 0 ? (
          <p className="mt-4 text-sm text-zk-text2">Nothing yet. Buy Ziks to fund an issue or unlock security fixes.</p>
        ) : (
          <ul className="m-0 mt-4 list-none divide-y divide-zk-divider p-0">
            {entries.map((entry) => (
              <li key={entry.id} className="flex items-center gap-3 py-2.5 text-sm text-zk-text">
                <span className="flex-1">
                  {KIND_LABEL[entry.kind]}
                  {entry.bug ? <span className="text-zk-muted"> · #{entry.bug.number} {entry.bug.title}</span> : null}
                  <span className="block text-xs text-zk-muted"><LocalTime date={entry.createdAt} /></span>
                </span>
                <span className={`font-mono font-bold tabular-nums ${entry.amount < 0 ? "text-zk-text2" : "text-zk-ok-fg"}`}>
                  {entry.amount > 0 ? "+" : ""}{formatZik(entry.amount)}
                </span>
              </li>
            ))}
          </ul>
        )}
        {withdrawals.length > 0 ? (
          <p className="mb-0 mt-4 text-xs text-zk-muted">
            Latest withdrawal: {formatZik(withdrawals[0].zik)}, {withdrawals[0].status === "paid" ? "paid" : withdrawals[0].status === "failed" ? "returned to your wallet" : "on its way"}.
          </p>
        ) : null}
      </section>
    </div>
  );
}
