"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth-helpers";
import { currentOrganisationAccess } from "@/lib/organisation-access";
import { isSuperAdmin } from "@/lib/roles";
import { fixCheckId, fixSelection, listFixProjects, sendCheckFindings, type FixOutcome } from "@/lib/security-checks/fix";

async function currentClient() {
  const user = await requireUser();
  const access = await currentOrganisationAccess(user.id, user.role);
  if (!access.organisationId || !access.membershipRole) return null;
  return { userId: user.id, organisationId: access.organisationId, superAdmin: isSuperAdmin(user.role) };
}

export async function loadSecurityCheckFixOptions(checkId: string) {
  const parsed = fixCheckId.safeParse(checkId);
  if (!parsed.success) return null;
  const client = await currentClient();
  if (!client) return null;
  return listFixProjects(client, parsed.data);
}

export async function fixSecurityCheck(input: unknown): Promise<FixOutcome> {
  const selection = fixSelection.safeParse(input);
  if (!selection.success) return { ok: false, error: "Choose findings and a destination project." };
  const client = await currentClient();
  if (!client) return { ok: false, error: "Open your workspace before sending findings." };

  let outcome: FixOutcome;
  try {
    outcome = await sendCheckFindings(client, selection.data);
  } catch {
    // Database errors may include private report context. Return a safe message.
    return { ok: false, error: "Could not send the findings. Try again." };
  }
  if (outcome.ok) {
    revalidatePath("/security");
    const reportPath = `/security/checks/${encodeURIComponent(selection.data.checkId)}`;
    revalidatePath(reportPath);
    revalidatePath("/[org]/[project]", "layout");
  }
  return outcome;
}
