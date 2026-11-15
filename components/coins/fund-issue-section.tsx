import { prisma } from "@/lib/prisma";
import { canFundIssue } from "@/lib/coins/fund";
import { escrowBalance, walletBalance } from "@/lib/coins/ledger";
import { estimateToZik, formatUsd } from "@/lib/coins/math";
import { FundIssueBox } from "./fund-issue-box";

/**
 * The Ziks behind an issue (#ziki-coins), on the issue page. Everyone sees what
 * is funded; only the issue's owner or an organisation admin gets the form,
 * and only while the issue can still pay out. Draws nothing for an issue with
 * no Ziks that you can't fund.
 */
export async function FundIssueSection({
  bugId,
  userId,
  estimate,
}: {
  bugId: string;
  userId: string;
  /** The agreed reward estimate, once at least one has been given (never the $1 default). */
  estimate?: { dollars: number; count: number } | null;
}) {
  const bug = await prisma.bug.findUnique({
    where: { id: bugId },
    select: { organisationId: true, reporterId: true, status: true, isDeleted: true, payoutReleasedAt: true },
  });
  if (!bug || bug.isDeleted) return null;
  const finished = bug.status === "closed" || Boolean(bug.payoutReleasedAt);
  const [escrow, mayFund] = await Promise.all([escrowBalance(prisma, bugId), finished ? Promise.resolve(false) : canFundIssue(userId, bug)]);
  if (escrow === 0 && !mayFund) return null;
  const balance = mayFund ? await walletBalance(prisma, userId) : 0;
  const estimateZik = estimate ? estimateToZik(estimate.dollars) : null;
  return (
    <FundIssueBox
      bugId={bugId}
      escrow={escrow}
      balance={balance}
      canFund={mayFund}
      estimate={estimate && estimateZik ? { zik: estimateZik, usd: formatUsd(Math.round(estimate.dollars * 100)), count: estimate.count } : null}
    />
  );
}
