"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import { CoinError } from "@/lib/coins/ledger";
import { fundIssue } from "@/lib/coins/fund";
import { createPackCheckout } from "@/lib/coins/purchase";
import { startPayoutOnboarding, syncPayoutsEnabled, withdrawEarned } from "@/lib/coins/withdraw";

/**
 * Ziki Coins actions (#ziki-coins). Each one acts for the signed-in person
 * only; the amounts and who may do what are decided in lib/coins, not here.
 */

export type CoinActionResult = { ok: true; message: string } | { ok: false; error: string };

function failure(error: unknown): CoinActionResult {
  if (error instanceof CoinError) return { ok: false, error: error.message };
  console.error("[coins]", error);
  // Stripe says what it refused (for example, that Connect isn't switched on); that is safe to show and useful to read.
  // Authentication errors are left out: their text can quote part of a key.
  if (error && typeof error === "object" && (error as { type?: string }).type === "StripeInvalidRequestError") {
    const message = (error as { message?: string }).message;
    if (message) return { ok: false, error: message };
  }
  return { ok: false, error: "Something went wrong. Try again in a moment." };
}

/** Sends the buyer to Stripe Checkout for a pack. The wallet is credited by the webhook, not by this. */
export async function buyZiksAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  let url: string;
  try {
    url = await createPackCheckout(user.id, user.email ?? undefined, String(formData.get("packId") ?? ""));
  } catch (error) {
    const message = failure(error);
    redirect(`/coins?error=${encodeURIComponent(message.ok ? "" : message.error)}`);
  }
  redirect(url);
}

/** Puts Ziks behind an issue. `requestId` is made when the form is drawn, so a double submit funds once. */
export async function fundIssueAction(bugId: string, amount: number, requestId: string): Promise<CoinActionResult> {
  const user = await requireUser();
  try {
    const result = await fundIssue(user.id, bugId, Math.trunc(Number(amount)), requestId);
    revalidatePath("/", "layout");
    return { ok: true, message: result.funded ? `Funded. ${result.escrow.toLocaleString("en-US")} Ziks are now behind this issue.` : "Already funded." };
  } catch (error) {
    return failure(error);
  }
}

/** Opens Stripe's hosted onboarding for payouts. */
export async function setUpPayoutsAction(): Promise<void> {
  const user = await requireUser();
  let url: string;
  try {
    url = await startPayoutOnboarding(user.id, user.email ?? undefined);
  } catch (error) {
    const message = failure(error);
    redirect(`/coins?error=${encodeURIComponent(message.ok ? "" : message.error)}`);
  }
  redirect(url);
}

/** Re-reads the person's Stripe account, for when they come back from onboarding. */
export async function refreshPayoutsAction(): Promise<boolean> {
  const user = await requireUser();
  try {
    const enabled = await syncPayoutsEnabled(user.id);
    revalidatePath("/coins");
    return enabled;
  } catch {
    return (await prisma.user.findUnique({ where: { id: user.id }, select: { payoutsEnabled: true } }))?.payoutsEnabled ?? false;
  }
}

/** Withdraws the person's earned Ziks as a Stripe Transfer. */
export async function withdrawZiksAction(): Promise<CoinActionResult> {
  const user = await requireUser();
  try {
    const outcome = await withdrawEarned(user.id);
    revalidatePath("/coins");
    if (outcome.status === "failed") return { ok: false, error: "Stripe couldn't send the money. Your Ziks are back in your wallet." };
    const amount = `$${(outcome.amountCents / 100).toFixed(2)}`;
    if (outcome.waiting) {
      return { ok: true, message: `Your ${amount} is queued. Stripe is still releasing the money from recent payments, so it will be sent automatically, usually within a few days.` };
    }
    return { ok: true, message: `Sending ${amount} to your Stripe account.` };
  } catch (error) {
    return failure(error);
  }
}
