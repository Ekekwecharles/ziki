"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth-helpers";
import { currentOrganisationAccess } from "@/lib/organisation-access";
import { OWNERS_ONLY_MESSAGE } from "@/lib/security-checks";
import { unlockFindings } from "@/lib/security-checks/payment";

/**
 * Unlocking fixes on Security (#security-checks, plan C1). Adding a site is
 * the chat's job (security-assistant.ts). The database is the handover to the
 * other parts: unlocking sets `unlockedAt`, and the engine pays the finder.
 */

const NO_WORKSPACE = "Join or create a workspace to secure your assets.";

/**
 * Unlock fixes (plan C1): every locked finding on the check, or the ones
 * chosen, paid in Ziks (lib/security-checks/payment.ts). Then back to Your
 * sites, with a short note.
 */
export async function unlockSecurityFindings(checkId: string, which: "all" | string[]): Promise<{ error?: string }> {
  const user = await requireUser();
  const access = await currentOrganisationAccess(user.id, user.role);
  if (!access.organisationId) return { error: NO_WORKSPACE };
  if (!access.admin) return { error: OWNERS_ONLY_MESSAGE };
  const ids = which === "all" ? "all" : which.filter((id) => typeof id === "string").slice(0, 200);
  if (ids !== "all" && ids.length === 0) return { error: "Choose at least one finding to unlock." };

  const outcome = await unlockFindings(checkId, access.organisationId, user.id, ids);
  if (!outcome.ok) {
    if (outcome.reason === "not_found") return { error: "That check isn't one of yours." };
    if (outcome.reason === "not_posted") return { error: "The report isn't ready yet. You can unlock fixes once it's posted." };
    if (outcome.reason === "insufficient_ziks") {
      return { error: `That costs ${outcome.needed} Ziks and you have ${outcome.balance}. Buy more Ziks, then unlock again.` };
    }
    return { error: "Those findings are already unlocked." };
  }
  revalidatePath("/security");
  redirect(`/security?check=${encodeURIComponent(checkId)}&unlocked=${outcome.unlocked}`);
}
