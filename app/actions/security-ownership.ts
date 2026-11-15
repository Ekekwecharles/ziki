"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { requireUser } from "@/lib/auth-helpers";
import { currentOrganisationAccess } from "@/lib/organisation-access";
import { prisma } from "@/lib/prisma";
import { ownershipProofRequired } from "@/lib/security-checks";
import { OWNERSHIP_METHODS, proveOwnership, recordOwnership, type OwnershipMethod } from "@/lib/security-checks/ownership";
import { kickCheck } from "@/lib/security-checks/engine";

/**
 * Step 2, show it's yours (#security-checks, part 2). One "Check now" tries
 * every way the target allows; only when one of them is really there is the
 * target marked proven and its checks let go to the agents (part 3).
 *
 * Switched off for now (14 Nov plan, D1): while SECURITY_OWNERSHIP_PROOF_REQUIRED
 * isn't "true", nothing here runs and a stray "Check now" just goes back to
 * Security. The code stays, so turning the setting on brings it all back.
 */

export type VerifyState = {
  /** Something that stops the check as a whole. */
  error?: string;
  /** Why each way that was tried isn't there yet, shown under that way. */
  missing?: Partial<Record<OwnershipMethod, string>>;
};

/** Look for the proof, every allowed way, and once one is there go on to pay or skip. */
export async function verifySecurityTarget(targetId: string): Promise<VerifyState> {
  const user = await requireUser();
  // Proof is off: every target already counts as proven, so there is nothing to check or record.
  if (!ownershipProofRequired()) redirect("/security");
  const access = await currentOrganisationAccess(user.id, user.role);
  if (!access.organisationId) return { error: "Join or create a workspace to secure your assets." };

  const target = await prisma.securityTarget.findFirst({
    where: { id: targetId, organisationId: access.organisationId },
    select: { id: true, organisationId: true, kind: true, value: true, ownershipToken: true, verifiedAt: true },
  });
  if (!target) return { error: "That site isn't in this workspace." };

  // Proven once, never asked again: skip the proof and go straight on.
  let proven: OwnershipMethod | null = null;
  const missing: Partial<Record<OwnershipMethod, string>> = {};
  if (target.verifiedAt) {
    proven = OWNERSHIP_METHODS[target.kind][0]!;
  } else {
    for (const method of OWNERSHIP_METHODS[target.kind]) {
      const proof = await proveOwnership(target, method);
      if (proof.ok) {
        proven = method;
        break;
      }
      missing[method] = proof.reason;
    }
  }
  if (!proven) return { missing };

  const { checkId, queued } = await recordOwnership(target.id, target.organisationId, user.id, proven);
  // Start the check now, not at the next sweep (12 Nov plan, D1 -> H1). It runs after the
  // response, so the client isn't kept waiting while Ziki's AI splits it; kickCheck never
  // throws, and the sweep still starts anything that didn't.
  if (queued.length) after(() => Promise.all(queued.map((id) => kickCheck(prisma, id))));
  revalidatePath("/security");
  // The scan is free: back to Assets, with this site picked out, while it runs.
  redirect(checkId ? `/security?check=${encodeURIComponent(checkId)}` : "/security");
}
