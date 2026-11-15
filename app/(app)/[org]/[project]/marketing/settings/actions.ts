"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import type { MarketingBrief } from "@/components/marketing/settings/model";
import { IssueApiError } from "@/lib/agent-api/errors";
import { saveProjectBrief } from "@/lib/marketing/brief";
import { assertMarketingSettingsAccess, updateMarketingSettings } from "@/lib/marketing/settings";
import {
  createMarketingTaskType,
  deleteMarketingTaskType,
  toggleMarketingTaskTypeActive,
  updateMarketingTaskType,
} from "@/lib/marketing/task-types";
import { marketingPath, type ProjectRef } from "@/lib/project-paths";
import { requireProject } from "@/lib/project-route";
import { revisionLimitSchema } from "@/lib/workflow-config";

export type MarketingSettingsActionResult = { error?: string; ok?: boolean };

/**
 * The project whose marketing settings are being changed, after the access
 * check. Members are refused with the message from the rule, so they read the
 * settings but never change them.
 */
async function requireSettingsAdmin(slug: ProjectRef) {
  const [org, project] = slug.split("/");
  const context = await requireProject(org, project);
  try {
    await assertMarketingSettingsAccess(context.user, context.organisationId, "change");
  } catch (error) {
    if (error instanceof IssueApiError) return { error: error.message };
    throw error;
  }
  return {
    organisationId: context.organisationId,
    projectId: context.project.id,
    projectSlug: slug,
    userId: context.user.id,
  };
}

function revalidateMarketing(slug: ProjectRef): void {
  revalidatePath(marketingPath(slug, "settings"));
  revalidatePath(marketingPath(slug, "tasks"));
}

/**
 * The revision limit dial (M-UI-7 for M-API-6): how many send-backs a marketing
 * delivery takes before the task reopens for bids. The lib function owns the
 * rule: it bounds the value to 1–10, refuses non-admins and audits the change.
 */
export async function updateMarketingRevisionLimitAction(
  slug: ProjectRef,
  formData: FormData,
): Promise<MarketingSettingsActionResult> {
  const admin = await requireSettingsAdmin(slug);
  if ("error" in admin) return admin;

  const parsed = revisionLimitSchema.safeParse(Number(formData.get("revisionLimit")));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Revision limit must be a whole number from 1 to 10." };
  }

  try {
    await updateMarketingSettings(admin.organisationId, admin.projectId, admin.userId, { revisionLimit: parsed.data });
  } catch (error) {
    if (error instanceof IssueApiError) return { error: error.message };
    throw error;
  }

  revalidateMarketing(slug);
  return { ok: true };
}

/** Save the project brief agents read (M-UI-7 for M-API-8). */
export async function updateMarketingBriefAction(
  slug: ProjectRef,
  brief: MarketingBrief,
): Promise<MarketingSettingsActionResult> {
  const admin = await requireSettingsAdmin(slug);
  if ("error" in admin) return admin;

  try {
    await saveProjectBrief(admin.organisationId, admin.projectId, admin.userId, brief);
  } catch (error) {
    if (error instanceof IssueApiError) return { error: error.message };
    if (error instanceof z.ZodError) return { error: error.issues[0]?.message ?? "Check the form and try again." };
    throw error;
  }

  revalidateMarketing(slug);
  return { ok: true };
}

/**
 * Runs a task type change from lib/marketing/task-types.ts (M-API-7), which
 * owns the rules the agent API uses too, and turns its refusals into the
 * form's error message.
 */
async function runTypeChange(slug: ProjectRef, change: () => Promise<unknown>): Promise<MarketingSettingsActionResult> {
  try {
    await change();
  } catch (error) {
    if (error instanceof IssueApiError) return { error: error.message };
    throw error;
  }
  revalidateMarketing(slug);
  return { ok: true };
}

/** The form fields a task type carries; no points, because pay comes from each task's reward. */
function typeFields(formData: FormData) {
  const description = formData.get("description")?.toString() ?? "";
  const rawActive = formData.get("isActive");
  return {
    name: formData.get("name")?.toString() ?? "",
    description: description ? description : null,
    // An unticked checkbox isn't sent, so a missing value means inactive.
    isActive: rawActive === "true" || rawActive === "on",
  };
}

/**
 * Create a marketing task type (M-UI-7 for M-API-7). The name stays unique per
 * organisation across both tracks, matching the model's `(organisationId, name)` key, so a
 * marketing type can't shadow a product type.
 */
export async function createMarketingIssueTypeAction(
  slug: ProjectRef,
  formData: FormData,
): Promise<MarketingSettingsActionResult> {
  const admin = await requireSettingsAdmin(slug);
  if ("error" in admin) return admin;
  return runTypeChange(slug, () => createMarketingTaskType(admin.organisationId, typeFields(formData)));
}

/** Update a marketing task type. Renames leave a note on the tasks that carry the type. */
export async function updateMarketingIssueTypeAction(
  slug: ProjectRef,
  id: string,
  formData: FormData,
): Promise<MarketingSettingsActionResult> {
  const admin = await requireSettingsAdmin(slug);
  if ("error" in admin) return admin;
  return runTypeChange(slug, () => updateMarketingTaskType(admin.organisationId, admin.userId, id, typeFields(formData)));
}

/** Active types are offered when a marketing task is proposed; retired ones keep their history. */
export async function toggleMarketingIssueTypeActiveAction(
  slug: ProjectRef,
  id: string,
): Promise<MarketingSettingsActionResult> {
  const admin = await requireSettingsAdmin(slug);
  if ("error" in admin) return admin;
  return runTypeChange(slug, () => toggleMarketingTaskTypeActive(admin.organisationId, admin.userId, id));
}

/**
 * Delete a marketing task type. Types that tasks or proposals still use are
 * refused, with the reason and the thing to do instead: deactivate the type.
 */
export async function deleteMarketingIssueTypeAction(
  slug: ProjectRef,
  id: string,
): Promise<MarketingSettingsActionResult> {
  const admin = await requireSettingsAdmin(slug);
  if ("error" in admin) return admin;
  return runTypeChange(slug, () => deleteMarketingTaskType(admin.organisationId, id));
}
