import type { Prisma, SecuritySeverity } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { CoinError, appendRows, lockUser, walletBalance } from "@/lib/coins/ledger";
import { assertCanSpendOnSecurity, loanState } from "@/lib/coins/loan";
import { SEVERITY_PRICE, unlockTotal } from "@/lib/security-checks";

/**
 * Unlocking fixes (#security-checks, plan C1). The scan is free; the client
 * pays per finding, by severity (SEVERITY_PRICE), all at once or the ones they
 * choose, in Ziks from their wallet (lib/coins). Unlocking sets
 * `SecurityCheckResult.unlockedAt`, which shows the finding's details and fix
 * (isResultUnlocked) and lets the engine pay its finder, once. The Ziks and the
 * unlock happen in one transaction: a person who can't cover the findings
 * unlocks none of them, and one who double-clicks pays once. Both checkout flows
 * (unlocking, and sending findings to a project) pay through `payForFindings`.
 */

export type UnlockOutcome =
  | { ok: true; unlocked: number; coins: number }
  | { ok: false; reason: "not_found" | "not_posted" | "nothing_to_unlock" }
  | { ok: false; reason: "insufficient_ziks"; needed: number; balance: number; canBorrow: boolean };

/** What one finding costs to unlock: its stored price, or its severity's for older results. */
export function findingPrice(result: { severity: SecuritySeverity; priceCoins: number | null }): number {
  return result.priceCoins ?? SEVERITY_PRICE[result.severity];
}

/**
 * Unlock findings on the person's own check: every locked one, or only those
 * listed. A finding can be unlocked as soon as its part is done (16 Nov call: findings show
 * before the whole report is posted), and one already unlocked is never charged again, so a double click is safe.
 * Someone else's check, even in the same workspace, is `not_found`.
 */
export async function unlockFindings(
  checkId: string,
  organisationId: string,
  userId: string,
  which: "all" | string[],
  now = new Date(),
): Promise<UnlockOutcome> {
  const check = await prisma.securityCheck.findFirst({
    where: { id: checkId, organisationId, requestedById: userId },
    select: { id: true },
  });
  if (!check) return { ok: false, reason: "not_found" };

  try {
    return await prisma.$transaction(async (tx): Promise<UnlockOutcome> => {
      const paid = await payForFindings(tx, userId, checkId, which, now);
      if (!paid.ok) return paid;
      if (paid.unlocked === 0) return { ok: false, reason: "nothing_to_unlock" };
      return paid;
    });
  } catch (error) {
    if (error instanceof CoinError && error.code === "closed") return { ok: false, reason: "nothing_to_unlock" };
    throw error;
  }
}

/**
 * Pays, in Ziks, for the locked findings of a check and unlocks them. It runs inside the caller's transaction, so the
 * charge and the unlock stand or fall together. Nothing is charged when the wallet can't cover every one of them, and
 * a finding that is already unlocked is never charged again. Throws a CoinError (`closed`) if someone unlocked some of
 * the same findings between the read and the write; the caller's transaction then rolls back and it can look again.
 * `checkId` may be several scans: a rescan sends its own findings and the earlier ones it rechecks in one payment.
 */
export async function payForFindings(
  tx: Prisma.TransactionClient,
  userId: string,
  checkId: string | readonly string[],
  which: "all" | string[],
  now = new Date(),
): Promise<{ ok: true; unlocked: number; coins: number } | { ok: false; reason: "insufficient_ziks"; needed: number; balance: number; canBorrow: boolean }> {
  await lockUser(tx, userId);
  const inChecks = typeof checkId === "string" ? checkId : { in: [...checkId] };
  const locked = await tx.securityCheckResult.findMany({
    where: { checkId: inChecks, unlockedAt: null, ...(which === "all" ? {} : { id: { in: which } }) },
    select: { id: true, severity: true, priceCoins: true },
  });
  if (locked.length === 0) return { ok: true, unlocked: 0, coins: 0 };
  const total = unlockTotal(locked);
  if (total > 0) {
    try {
      // Security may use a borrowed overdraft (lib/coins/loan.ts).
      await assertCanSpendOnSecurity(tx, userId, total);
    } catch (error) {
      if (error instanceof CoinError && error.code === "insufficient_ziks") {
        const [balance, loan] = await Promise.all([walletBalance(tx, userId), loanState(tx, userId)]);
        return { ok: false, reason: "insufficient_ziks", needed: total, balance, canBorrow: loan.canBorrow };
      }
      throw error;
    }
  }
  const { count } = await tx.securityCheckResult.updateMany({
    where: { id: { in: locked.map((result) => result.id) }, checkId: inChecks, unlockedAt: null },
    data: { unlockedAt: now },
  });
  // Someone unlocked some of them between our read and write: pay for none, let the caller look again.
  if (count !== locked.length) throw new CoinError("closed", "These findings changed while you were unlocking them.");
  const rows = locked.flatMap((result) => {
    const price = findingPrice(result);
    if (price <= 0) return [];
    return [
      { account: "wallet" as const, userId, kind: "check_payment" as const, amount: -price, sourceKey: `check:${result.id}:wallet` },
      { account: "revenue" as const, kind: "check_payment" as const, amount: price, sourceKey: `check:${result.id}:revenue` },
    ];
  });
  if (rows.length > 0) await appendRows(tx, rows);
  return { ok: true, unlocked: count, coins: total };
}
