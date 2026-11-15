"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth-helpers";
import { marketingPath, type ProjectRef } from "@/lib/project-paths";
import { requireProject } from "@/lib/project-route";
import { MarketingPlanStoreError } from "@/lib/structured-marketing-plans";
import { decideMarketingActivity, finalizeMarketingPlanRevision } from "@/lib/marketing-plan-approval";

const inputSchema = z.object({ revision: z.number().int().positive(), version: z.number().int().positive(), activityId: z.uuid().optional(), decision: z.enum(["approved", "rejected"]).optional() }).strict();

async function run(slug: ProjectRef, planId: string, raw: unknown, mode: "decision" | "finalize") {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the approval details." };
  const [org, project] = slug.split("/");
  const context = await requireProject(org, project);
  const user = await requireUser();
  try {
    const result = mode === "decision"
      ? await decideMarketingActivity(user, context.project.id, planId, parsed.data.revision, parsed.data.activityId!, parsed.data.decision!, parsed.data.version)
      : await finalizeMarketingPlanRevision(user, context.project.id, planId, parsed.data.revision, parsed.data.version);
    revalidatePath(marketingPath(slug, `plans/${encodeURIComponent(planId)}`));
    return { result };
  } catch (error) {
    if (error instanceof MarketingPlanStoreError) return { error: error.message };
    if (error instanceof Error && "status" in error && error.status === 403) return { error: error.message };
    throw error;
  }
}

export async function decideMarketingActivityAction(slug: ProjectRef, planId: string, input: unknown) { return run(slug, planId, input, "decision"); }
export async function finalizeMarketingPlanAction(slug: ProjectRef, planId: string, input: unknown) { return run(slug, planId, input, "finalize"); }
