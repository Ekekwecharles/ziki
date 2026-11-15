import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { CoinError, appendRows, assertAmount, assertCanSpend, escrowBalance, lockBug, lockUser } from "./ledger";
import { MAX_FUND_ZIK, estimateToZik } from "./math";

/**
 * Funding an issue (#ziki-coins). The owner moves Ziks from their wallet into
 * the issue's escrow. Releasing and refunding it are in ./escrow.ts, which runs
 * inside the payout's and the close's own transactions.
 */

/** Whether this person may put Ziks behind this issue: its reporter, or an owner or admin of its organisation. */
export async function canFundIssue(userId: string, bug: { organisationId: string; reporterId: string }): Promise<boolean> {
  if (bug.reporterId === userId) return true;
  const membership = await prisma.membership.findUnique({
    where: { organisationId_userId: { organisationId: bug.organisationId, userId } },
    select: { role: true },
  });
  return membership?.role === "owner" || membership?.role === "admin";
}

/** The estimate in Ziks, or 0 while nobody has estimated (the $1 every issue starts with isn't a judgement). */
async function estimateFloor(tx: Pick<Prisma.TransactionClient, "bug" | "rewardEstimate">, bugId: string): Promise<number> {
  const [issue, estimates] = await Promise.all([
    tx.bug.findUniqueOrThrow({ where: { id: bugId }, select: { reward: true } }),
    tx.rewardEstimate.count({ where: { bugId } }),
  ]);
  return estimates > 0 ? estimateToZik(Number(issue.reward)) : 0;
}

/** `requestId` makes a double click or a retry fund once. */
export async function fundIssue(userId: string, bugId: string, amount: number, requestId: string): Promise<{ funded: boolean; escrow: number }> {
  assertAmount(amount);
  if (amount > MAX_FUND_ZIK) throw new CoinError("invalid_amount", `Fund at most ${MAX_FUND_ZIK.toLocaleString("en-US")} Ziks at a time.`);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(requestId)) throw new CoinError("invalid_amount", "Reload the page and try again.");
  const bug = await prisma.bug.findUnique({
    where: { id: bugId },
    select: { organisationId: true, reporterId: true, status: true, isDeleted: true, payoutReleasedAt: true },
  });
  if (!bug || bug.isDeleted) throw new CoinError("not_found", "That issue doesn't exist.");
  if (!(await canFundIssue(userId, bug))) throw new CoinError("not_allowed", "Only the issue's owner or an admin can fund it.");
  if (bug.status === "closed" || bug.payoutReleasedAt) throw new CoinError("closed", "This issue is finished, so it can't take more Ziks.");

  return prisma.$transaction(async (tx) => {
    await lockUser(tx, userId);
    await lockBug(tx, bugId);
    // Re-read under the lock: the issue may have closed or paid out while we waited.
    const fresh = await tx.bug.findUniqueOrThrow({ where: { id: bugId }, select: { status: true, payoutReleasedAt: true } });
    if (fresh.status === "closed" || fresh.payoutReleasedAt) throw new CoinError("closed", "This issue is finished, so it can't take more Ziks.");
    const key = `fund:${bugId}:${userId}:${requestId}`;
    if (await tx.coinEntry.findUnique({ where: { sourceKey: `${key}:wallet` }, select: { id: true } })) {
      return { funded: false, escrow: await escrowBalance(tx, bugId) };
    }
    // An issue can't be funded below what its estimate says it is worth. Once it is funded to the estimate, any amount adds to it.
    const [floor, held] = await Promise.all([estimateFloor(tx, bugId), escrowBalance(tx, bugId)]);
    if (held + amount < floor) {
      throw new CoinError("invalid_amount", `Fund at least ${(floor - held).toLocaleString("en-US")} Ziks: the estimate for this issue is ${floor.toLocaleString("en-US")} Ziks.`);
    }
    await assertCanSpend(tx, userId, amount);
    await appendRows(tx, [
      { account: "wallet", userId, bugId, kind: "fund_issue", amount: -amount, sourceKey: `${key}:wallet` },
      { account: "escrow", bugId, kind: "fund_issue", amount, sourceKey: `${key}:escrow` },
    ]);
    return { funded: true, escrow: await escrowBalance(tx, bugId) };
  });
}
