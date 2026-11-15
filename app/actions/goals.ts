"use server";

import { revalidatePath } from "next/cache";
import type { ZodIssue } from "zod";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { IssueApiError } from "@/lib/agent-api/errors";
import { requireProject } from "@/lib/project-route";
import { createGoalForPerson, splitGoalPoolForPerson, updateGoalStatusForPerson } from "@/lib/goals/service";
import { createGoalSchema, splitGoalPoolSchema, updateGoalStatusSchema } from "@/lib/validations/goal";

/**
 * The web goals UI's writes (#616): create a goal with a budget pool, split
 * the pool across issues, nested goals and agent deliverables, and move a
 * goal through its statuses. Every action rechecks project access, validates
 * through the same Zod schemas as the agent API, and maps the service's
 * IssueApiError guardrails (400 bad input, 404 missing, 409 pool conflicts)
 * onto the result so the form can show exactly what was refused.
 */

export type GoalActionResult =
  | { ok: true; goalId?: string; message?: string }
  | { ok: false; error: string; status?: number; fieldErrors?: Record<string, string> };

/** First message per field, so a form can place errors beside their inputs. */
function fieldErrors(issues: readonly ZodIssue[]): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of issues) {
    const key = issue.path.join(".") || "_";
    if (!errors[key]) errors[key] = issue.message;
  }
  return errors;
}

function asErrorResult(error: unknown, fallback: string): GoalActionResult {
  if (error instanceof IssueApiError) return { ok: false, error: error.message, status: error.status };
  logger.error("[goals] action failed", error);
  return { ok: false, error: fallback };
}

function readScope(formData: FormData): { org: string; slug: string } {
  return { org: String(formData.get("org") ?? ""), slug: String(formData.get("slug") ?? "") };
}

/** The goal named by the form, only when it lives in the URL's project. */
async function scopedGoalId(
  formData: FormData,
  organisationId: string,
  projectId: string,
): Promise<string | null> {
  const goalId = String(formData.get("goalId") ?? "");
  if (!goalId) return null;
  const goal = await prisma.goal.findFirst({
    where: { id: goalId, organisationId, projectId },
    select: { id: true },
  });
  return goal ? goalId : null;
}

/** POST a new goal with its budget pool (the goals list's create form). */
export async function createGoalAction(
  _previous: GoalActionResult | undefined,
  formData: FormData,
): Promise<GoalActionResult> {
  const { org, slug } = readScope(formData);
  const context = await requireProject(org, slug);
  if (!context.canContribute) return { ok: false, error: "Only project members can create goals." };

  const parsed = createGoalSchema.safeParse({
    title: formData.get("title"),
    description: formData.get("description") ?? "",
    budgetPool: formData.get("budgetPool"),
    projectId: context.project.id,
  });
  if (!parsed.success) {
    return { ok: false, error: "Check the goal details.", status: 400, fieldErrors: fieldErrors(parsed.error.issues) };
  }

  try {
    const goal = await createGoalForPerson(
      { userId: context.user.id, organisationId: context.organisationId },
      parsed.data,
    );
    revalidatePath("/projects/[slug]/settings", "page");
    return { ok: true, goalId: goal.id, message: `“${goal.title}” created with a ${goal.budgetPool}-credit pool.` };
  } catch (error) {
    return asErrorResult(error, "Could not create this goal. Try again.");
  }
}

/** Apply a split of the goal's pool across the chosen targets. */
export async function splitGoalAction(
  _previous: GoalActionResult | undefined,
  formData: FormData,
): Promise<GoalActionResult> {
  const { org, slug } = readScope(formData);
  const context = await requireProject(org, slug);
  if (!context.canContribute) return { ok: false, error: "Only project members can split a goal's pool." };

  const goalId = await scopedGoalId(formData, context.organisationId, context.project.id);
  if (!goalId) return { ok: false, error: "Goal not found in this project.", status: 404 };

  let payload: unknown;
  try {
    payload = JSON.parse(String(formData.get("payload") ?? ""));
  } catch {
    return { ok: false, error: "The split details were malformed. Try again.", status: 400 };
  }
  const parsed = splitGoalPoolSchema.safeParse(payload);
  if (!parsed.success) {
    return { ok: false, error: "Check the split details.", status: 400, fieldErrors: fieldErrors(parsed.error.issues) };
  }

  try {
    const { goal } = await splitGoalPoolForPerson(
      { userId: context.user.id, organisationId: context.organisationId },
      goalId,
      parsed.data,
    );
    revalidatePath("/projects/[slug]/settings", "page");
    revalidatePath("/[org]/[project]/goals/[id]", "page");
    return {
      ok: true,
      goalId,
      message: `Split applied: ${goal.allocated} of ${goal.budgetPool} credits allocated.`,
    };
  } catch (error) {
    return asErrorResult(error, "Could not apply this split. Try again.");
  }
}

/** Move a goal between active, completed and cancelled (and back). */
export async function updateGoalStatusAction(
  _previous: GoalActionResult | undefined,
  formData: FormData,
): Promise<GoalActionResult> {
  const { org, slug } = readScope(formData);
  const context = await requireProject(org, slug);
  if (!context.canContribute) return { ok: false, error: "Only project members can change a goal's status." };

  const goalId = await scopedGoalId(formData, context.organisationId, context.project.id);
  if (!goalId) return { ok: false, error: "Goal not found in this project.", status: 404 };

  const parsed = updateGoalStatusSchema.safeParse({ status: formData.get("status") });
  if (!parsed.success) {
    return { ok: false, error: "Check the goal status.", status: 400, fieldErrors: fieldErrors(parsed.error.issues) };
  }

  try {
    await updateGoalStatusForPerson(
      { userId: context.user.id, organisationId: context.organisationId },
      goalId,
      parsed.data,
    );
    revalidatePath("/projects/[slug]/settings", "page");
    revalidatePath("/[org]/[project]/goals/[id]", "page");
    return { ok: true, goalId, message: `Goal marked ${parsed.data.status}.` };
  } catch (error) {
    return asErrorResult(error, "Could not change this goal's status. Try again.");
  }
}
