import Link from "next/link";
import { requireUser } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import { buyZiksAction } from "@/app/actions/coins";
import { walletSummary } from "@/lib/coins/ledger";
import { owedOf } from "@/lib/coins/loan";
import { ZIK_PACKS, formatUsd, formatZik, zikToCents } from "@/lib/coins/math";
import { stripeConfigured } from "@/lib/coins/stripe";
import { LocalTime } from "@/components/local-time";
import { ZikiPlans } from "@/components/coins/ziki-plans";
import { discountedCents } from "@/lib/coins/plans";
import { discountPercentFor, liveSubscriptionOf, syncUserSubscriptions } from "@/lib/coins/subscription";
import { UrlNotice } from "@/components/coins/url-notice";

export const metadata = { title: "Ziks" };
export const dynamic = "force-dynamic";

const card = "rounded-[22px] border border-zk-border bg-zk-surface p-5 sm:p-6";
const notice = "m-0 rounded-2xl px-4 py-3 text-sm font-semibold";
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
 * Ziks (#ziki-coins): your wallet, the packs you can buy with Stripe, your plan,
 * and what moved. Buying is Stripe Checkout; the wallet is only credited when
 * Stripe's webhook says the payment went through. Earning and withdrawing are on /coins/payouts (the Withdraw page).
 */
function hasRecentPurchase(entries: { kind: string; createdAt: Date }[]): boolean {
  return entries.some((entry) => entry.kind === "purchase" && Date.now() - entry.createdAt.getTime() < 10 * 60 * 1000);
}

type CoinsQuery ={ bought?: string; subscribed?: string; error?: string };

export default async function CoinsPage({ searchParams }: { searchParams?: Promise<CoinsQuery> }) {
  const [user, query] = await Promise.all([requireUser(), searchParams ?? Promise.resolve({} as CoinsQuery)]);
  // Coming back from subscribing: show the plan now rather than when the webhook gets there.
  if (query.subscribed === "1" && stripeConfigured()) await syncUserSubscriptions(user.id).catch(() => undefined);
  const [subscription, discountPercent] = await Promise.all([liveSubscriptionOf(user.id), discountPercentFor(user.id)]);

  const [wallet, entries] = await Promise.all([
    walletSummary(prisma, user.id),
    prisma.coinEntry.findMany({
      // Buying and spending only; what was earned and withdrawn is on the Withdraw page.
      where: { account: "wallet", userId: user.id, kind: { in: ["purchase", "fund_issue", "refund", "check_payment"] } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 12,
      select: { id: true, kind: true, amount: true, createdAt: true, bug: { select: { number: true, title: true } } },
    }),
  ]);
  const configured = stripeConfigured();
  // Whether the Stripe webhook has already credited what was just paid for (a purchase in the last few minutes).
  const justCredited = hasRecentPurchase(entries);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5">
      <Link href="/home" className="self-start text-sm font-semibold text-zk-accent hover:underline">← Back</Link>
      <div>
        <h1 className="text-3xl font-extrabold tracking-tight text-zk-text">Ziks</h1>
        <p className="mt-1 text-sm text-zk-text2">Ziks fund issues and unlock security fixes. One Zik is {zikToCents(1)}¢.</p>
      </div>

      {/* One-time notices: shown on arrival, then the query is dropped from the address (UrlNotice) so a refresh does not bring them back. */}
      {query.bought === "1" ? (
        <UrlNotice role="status" className={`${notice} bg-zk-ok-bg text-zk-ok-fg`}>
          {justCredited ? "Thanks. Your payment went through and your Ziks are in your wallet." : "Thanks. Your Ziks arrive as soon as Stripe confirms the payment, usually within a few seconds."}
        </UrlNotice>
      ) : null}
      {query.subscribed === "1" ? (
        <UrlNotice role="status" className={`${notice} bg-zk-ok-bg text-zk-ok-fg`}>
          {subscription ? `Thanks. Your plan is on, and every pack is now ${discountPercent}% cheaper.` : "Thanks. Your plan shows here as soon as Stripe confirms the payment, usually within a few seconds."}
        </UrlNotice>
      ) : null}
      {query.error ? <UrlNotice role="alert" className="m-0 rounded-2xl bg-zk-warn-bg px-4 py-3 text-sm font-semibold text-zk-warn-fg">{query.error}</UrlNotice> : null}

      <section aria-labelledby="wallet" className={`${card} bg-[linear-gradient(160deg,var(--color-zk-surface)_60%,var(--color-zk-tint))]`}>
        <h2 id="wallet" className={label}>Your Ziks</h2>
        <p className="mt-3 text-4xl font-extrabold tracking-tight tabular-nums text-zk-text sm:text-[44px]">{wallet.balance.toLocaleString("en-US")}</p>
        <p className="mt-1 text-sm text-zk-text2">{formatUsd(zikToCents(wallet.balance))} in value</p>
        {/* A borrowed overdraft (lib/coins/loan.ts): the part below zero is paid back first by the next top-up. */}
        {owedOf(wallet.balance) > 0 ? (
          <p className="mt-1 text-sm font-semibold text-zk-text">
            You owe {owedOf(wallet.balance).toLocaleString("en-US")} Ziks you borrowed. Your next top-up pays it back first.
          </p>
        ) : null}
      </section>

      <section aria-labelledby="packs" className={card}>
        <h2 id="packs" className={label}>Buy Ziks</h2>
        {discountPercent > 0 ? <p className="m-0 mt-2 text-sm font-semibold text-zk-ok-fg">Your plan takes {discountPercent}% off every pack.</p> : null}
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
                  className="inline-flex min-h-11 w-full cursor-pointer items-center justify-center whitespace-nowrap rounded-full border border-zk-border bg-zk-surface px-2.5 text-sm font-bold text-zk-text transition hover:bg-zk-chip focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-electric-blue disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Buy for {formatUsd(discountedCents(zikToCents(pack.zik), discountPercent))}
                  {discountPercent > 0 ? <s className="ml-1.5 font-medium text-zk-muted">{formatUsd(zikToCents(pack.zik))}</s> : null}
                </button>
              </form>
            </li>
          ))}
        </ul>
        {!configured ? <p className="mb-0 mt-3 text-sm text-zk-text2">Buying Ziks isn&apos;t available yet.</p> : null}
      </section>

      <ZikiPlans subscription={subscription} configured={configured} />

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
      </section>
    </div>
  );
}
