import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { CoinError, appendRows, lockUser, walletBalance } from "@/lib/coins/ledger";
import { assertCanSpendOnSecurity, loanState } from "@/lib/coins/loan";
import { ownershipProofRequired } from "@/lib/security-checks";
import { openEarlierFindings } from "./engine";

/**
 * Scan again with agents (#security-rescan, 17 Nov): a paid follow-up of a finished scan. It is not a fresh job: the
 * agents recheck every earlier finding that isn't fixed (still there or fixed) and look for new problems. The earlier
 * findings stay their own rows, so their unlocks, prices and moved issues carry over and nothing is paid twice.
 */
export const RESCAN_PRICE_ZIKS = 10;

/** What the confirm shows before anything is charged. */
export type RescanQuote =
  | { ok: true; site: string; earlier: number; price: number; balance: number; canBorrow: boolean }
  | { ok: false; error: string };

export type RescanOutcome =
  | { ok: true; checkId: string }
  | { ok: false; reason: "not_found" | "not_finished" | "already_rescanned"; error: string; checkId?: string }
  | { ok: false; reason: "insufficient_ziks"; error: string; needed: number; balance: number; canBorrow: boolean };

const NOT_FOUND = "That scan isn't in your scans.";
const NOT_FINISHED = "Agents are still checking this scan. Scan it again once its report is in.";
const ALREADY = "This scan was already scanned again. Open the newest one.";

/** The scan to follow, if it's this person's, not removed, finished, and the newest of its line. */
async function rescannable(organisationId: string, userId: string, checkId: string) {
  const check = await prisma.securityCheck.findFirst({
    where: { id: checkId, organisationId, requestedById: userId, status: { not: "cancelled" } },
    select: { id: true, organisationId: true, requestedById: true, targetId: true, postedAt: true, nextCheck: { select: { id: true } }, target: { select: { value: true, verifiedAt: true } } },
  });
  if (!check) return { ok: false as const, reason: "not_found" as const, error: NOT_FOUND };
  if (check.nextCheck) return { ok: false as const, reason: "already_rescanned" as const, error: ALREADY, checkId: check.nextCheck.id };
  if (!check.postedAt) return { ok: false as const, reason: "not_finished" as const, error: NOT_FINISHED };
  return { ok: true as const, check };
}

/** The confirm's numbers: how many earlier findings agents will recheck, the price and the wallet. Charges nothing. */
export async function rescanQuote(organisationId: string, userId: string, checkId: string): Promise<RescanQuote> {
  const found = await rescannable(organisationId, userId, checkId);
  if (!found.ok) return { ok: false, error: found.error };
  const [earlier, balance, loan] = await Promise.all([
    openEarlierFindings(prisma, { organisationId, requestedById: userId, targetId: found.check.targetId }, ""),
    walletBalance(prisma, userId),
    loanState(prisma, userId),
  ]);
  return { ok: true, site: found.check.target.value, earlier: earlier.length, price: RESCAN_PRICE_ZIKS, balance, canBorrow: loan.canBorrow };
}

/**
 * Pays RESCAN_PRICE_ZIKS and starts the follow-up scan, in one transaction: nobody pays without a rescan, and a
 * double click makes one rescan (a scan can be followed once: `previousCheckId` is unique). The caller starts it
 * (`kickCheck`) after answering.
 */
export async function startRescan(organisationId: string, userId: string, checkId: string, now = new Date()): Promise<RescanOutcome> {
  const found = await rescannable(organisationId, userId, checkId);
  if (!found.ok) return found;
  const { check } = found;
  try {
    return await prisma.$transaction(async (tx): Promise<RescanOutcome> => {
      await lockUser(tx, userId);
      try {
        // Security may use a borrowed overdraft (lib/coins/loan.ts).
        await assertCanSpendOnSecurity(tx, userId, RESCAN_PRICE_ZIKS);
      } catch (error) {
        if (error instanceof CoinError && error.code === "insufficient_ziks") {
          const [balance, loan] = await Promise.all([walletBalance(tx, userId), loanState(tx, userId)]);
          return {
            ok: false,
            reason: "insufficient_ziks",
            error: `Scanning again costs ${RESCAN_PRICE_ZIKS} Ziks and you have ${balance}. Buy Ziks on your Ziks page.`,
            needed: RESCAN_PRICE_ZIKS,
            balance,
            canBorrow: loan.canBorrow,
          };
        }
        throw error;
      }
      const next = await tx.securityCheck.create({
        data: {
          organisationId: check.organisationId,
          targetId: check.targetId,
          requestedById: check.requestedById,
          previousCheckId: check.id,
          free: false,
          priceCoins: RESCAN_PRICE_ZIKS,
          paidAt: now,
          // A target proven once never asks again; no proof step while it's switched off (14 Nov plan).
          status: check.target.verifiedAt !== null || !ownershipProofRequired() ? "queued" : "awaiting_ownership",
        },
        select: { id: true },
      });
      await appendRows(tx, [
        { account: "wallet", userId, kind: "check_payment", amount: -RESCAN_PRICE_ZIKS, sourceKey: `rescan:${next.id}:wallet` },
        { account: "revenue", kind: "check_payment", amount: RESCAN_PRICE_ZIKS, sourceKey: `rescan:${next.id}:revenue` },
      ]);
      return { ok: true, checkId: next.id };
    });
  } catch (error) {
    // Someone (or a second click) followed this scan first.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return { ok: false, reason: "already_rescanned", error: ALREADY };
    throw error;
  }
}
