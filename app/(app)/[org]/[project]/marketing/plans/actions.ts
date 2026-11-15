"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireProject } from "@/lib/project-route";
import { requireUser } from "@/lib/auth-helpers";
import { marketingPath, type ProjectRef } from "@/lib/project-paths";
import { MarketingPlanStoreError, saveMarketingPlanDraft } from "@/lib/structured-marketing-plans";
import { saveMarketingPlanDraftSchema } from "@/lib/validations/structured-marketing-plan";

export async function saveMarketingPlanDraftAction(slug: ProjectRef, planId: string, input: unknown) {
  const [org, project] = slug.split("/");
  const context = await requireProject(org, project);
  const user = await requireUser();
  const parsed = saveMarketingPlanDraftSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the plan and try again." };
  try {
    const saved = await saveMarketingPlanDraft(user, context.project.id, planId, parsed.data);
    revalidatePath(marketingPath(slug, `plans/${encodeURIComponent(planId)}`));
    revalidatePath(marketingPath(slug, "plans"));
    return { saved };
  } catch (error) {
    if (error instanceof MarketingPlanStoreError || error instanceof z.ZodError) return { error: error.message };
    throw error;
  }
}
