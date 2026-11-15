import Stripe from "stripe";
import { prisma } from "@/lib/prisma";
import { WITHDRAW_THRESHOLD } from "@/lib/earnings-threshold";
import { absoluteUrl } from "@/lib/site-url";
import { CoinError, appendRows, lockUser, walletSummary } from "./ledger";
import { zikToCents } from "./math";
import { getStripe } from "./stripe";

/**
 * Withdrawing earned Ziks (#ziki-coins). A person sets up payouts once (a Stripe
 * Connect Express account, onboarded on Stripe's own page). At the withdraw
 * threshold, Withdraw takes their earned Ziks out of the wallet and sends the
 * dollars as a Stripe Transfer, with an idempotency key so a retry never pays
 * twice. Stripe's webhooks mark it paid; a failed or reversed transfer writes a
 * `withdrawal_reversal` row that puts the Ziks back.
 */

/** The smallest withdrawal: the existing threshold, in Ziks. */
export const WITHDRAW_MIN_ZIK = Math.ceil((WITHDRAW_THRESHOLD * 100) / zikToCents(1));

/** Starts (or resumes) Stripe's hosted onboarding and returns the page to send the person to. */
/** The country payout accounts are opened in (two letters). It must be one Stripe supports for the platform's own country. */
function payoutCountry(): string {
  return process.env.ZIKI_PAYOUT_COUNTRY?.trim().toUpperCase() || "US";
}

export async function startPayoutOnboarding(userId: string, email: string | undefined): Promise<string> {
  const stripe = getStripe();
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { stripeAccountId: true } });
  let accountId = user.stripeAccountId;
  if (!accountId) {
    // Stripe collects the person's details on its hosted onboarding and carries the losses, which is the only shape
    // a platform with Stripe-managed risk may create (the older `type: "express"` is refused there).
    const account = await stripe.accounts.create({
      country: payoutCountry(),
      email,
      controller: {
        stripe_dashboard: { type: "none" },
        fees: { payer: "application" },
        losses: { payments: "stripe" },
        requirement_collection: "stripe",
      },
      capabilities: { transfers: { requested: true }, card_payments: { requested: true } },
      metadata: { userId },
    });
    accountId = account.id;
    await prisma.user.update({ where: { id: userId }, data: { stripeAccountId: accountId } });
  }
  const link = await stripe.accountLinks.create({
    account: accountId,
    type: "account_onboarding",
    refresh_url: absoluteUrl("/coins?payouts=refresh"),
    return_url: absoluteUrl("/coins?payouts=return"),
  });
  return link.url;
}

/** Whether Stripe says this account can receive transfers. */
export function accountCanReceive(account: Pick<Stripe.Account, "capabilities" | "details_submitted">): boolean {
  return account.details_submitted === true && account.capabilities?.transfers === "active";
}

/** Reads the person's Stripe account and records whether payouts work. Safe to call whenever. */
export async function syncPayoutsEnabled(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { stripeAccountId: true, payoutsEnabled: true } });
  if (!user?.stripeAccountId) return false;
  const enabled = accountCanReceive(await getStripe().accounts.retrieve(user.stripeAccountId));
  if (enabled !== user.payoutsEnabled) await prisma.user.update({ where: { id: userId }, data: { payoutsEnabled: enabled } });
  return enabled;
}

/** The webhook's version: sets it from an `account.updated` event for the account's owner. */
export async function recordAccountUpdate(account: Stripe.Account): Promise<void> {
  await prisma.user.updateMany({ where: { stripeAccountId: account.id }, data: { payoutsEnabled: accountCanReceive(account) } });
}

export type WithdrawOutcome = { withdrawalId: string; zik: number; amountCents: number; status: "pending" | "failed" };

/**
 * Withdraws everything the person can: their earned Ziks (not ones they
 * bought), once it reaches the threshold. The wallet debit and the withdrawal
 * row are written together first; only then is Stripe asked to move the money.
 */
export async function withdrawEarned(userId: string): Promise<WithdrawOutcome> {
  await syncPayoutsEnabled(userId).catch(() => false);
  const started = await prisma.$transaction(async (tx) => {
    await lockUser(tx, userId);
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { stripeAccountId: true, payoutsEnabled: true } });
    if (!user.stripeAccountId || !user.payoutsEnabled) throw new CoinError("payouts_not_ready", "Set up payouts first.");
    const { withdrawable } = await walletSummary(tx, userId);
    if (withdrawable < WITHDRAW_MIN_ZIK) {
      throw new CoinError("below_threshold", `Withdrawals open at $${WITHDRAW_THRESHOLD} of earned Ziks.`);
    }
    const amountCents = zikToCents(withdrawable);
    const withdrawal = await tx.withdrawal.create({
      data: { userId, zik: withdrawable, amountCents, idempotencyKey: `ziki-withdrawal-${crypto.randomUUID()}` },
    });
    await appendRows(tx, [{ account: "wallet", userId, kind: "withdrawal", amount: -withdrawable, sourceKey: `withdrawal:${withdrawal.id}`, withdrawalId: withdrawal.id }]);
    return { withdrawal, destination: user.stripeAccountId };
  });
  return sendTransfer(started.withdrawal, started.destination);
}

/** Asks Stripe to move the money for a withdrawal already debited. Retrying with the same row reuses its idempotency key. */
export async function sendTransfer(
  withdrawal: { id: string; userId: string; zik: number; amountCents: number; idempotencyKey: string },
  destination: string,
): Promise<WithdrawOutcome> {
  try {
    const transfer = await getStripe().transfers.create(
      {
        amount: withdrawal.amountCents,
        currency: "usd",
        destination,
        description: "Ziki Coins withdrawal",
        metadata: { withdrawalId: withdrawal.id, userId: withdrawal.userId },
      },
      { idempotencyKey: withdrawal.idempotencyKey },
    );
    await prisma.withdrawal.updateMany({ where: { id: withdrawal.id, stripeTransferId: null }, data: { stripeTransferId: transfer.id } });
    return { withdrawalId: withdrawal.id, zik: withdrawal.zik, amountCents: withdrawal.amountCents, status: "pending" };
  } catch (error) {
    // A dropped connection could mean Stripe did move the money: leave it pending (a retry with the same key is safe)
    // rather than put the Ziks back. Anything else is a definite refusal.
    if (error instanceof Stripe.errors.StripeConnectionError) {
      return { withdrawalId: withdrawal.id, zik: withdrawal.zik, amountCents: withdrawal.amountCents, status: "pending" };
    }
    await failWithdrawal(withdrawal.id, error instanceof Error ? error.message : "The transfer failed.");
    return { withdrawalId: withdrawal.id, zik: withdrawal.zik, amountCents: withdrawal.amountCents, status: "failed" };
  }
}

/** Stripe's `transfer.created`: the money is on its way to the person's account. */
export async function markWithdrawalPaid(withdrawalId: string, transferId: string): Promise<boolean> {
  const { count } = await prisma.withdrawal.updateMany({
    where: { id: withdrawalId, status: "pending" },
    data: { status: "paid", paidAt: new Date(), stripeTransferId: transferId },
  });
  return count > 0;
}

/**
 * A failed or reversed transfer: the withdrawal is marked failed and the Ziks go
 * back to the wallet in a `withdrawal_reversal` row. Once only, however many
 * times Stripe tells us.
 */
export async function failWithdrawal(withdrawalId: string, reason: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const withdrawal = await tx.withdrawal.findUnique({ where: { id: withdrawalId }, select: { userId: true, zik: true, status: true } });
    if (!withdrawal) return false;
    await lockUser(tx, withdrawal.userId);
    const { count } = await tx.withdrawal.updateMany({
      where: { id: withdrawalId, status: { in: ["pending", "paid"] } },
      data: { status: "failed", failureReason: reason.slice(0, 500) },
    });
    if (count === 0) return false;
    await appendRows(tx, [
      { account: "wallet", userId: withdrawal.userId, kind: "withdrawal_reversal", amount: withdrawal.zik, sourceKey: `withdrawal_reversal:${withdrawalId}`, withdrawalId },
    ]);
    return true;
  });
}
