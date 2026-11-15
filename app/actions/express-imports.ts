"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth-helpers";
import { isAgentPlatformEnabled } from "@/lib/feature-flags";
import { requestExpressImportAccess, setExpressImportGrant } from "@/lib/agents/express-import";
import { IssueApiError } from "@/lib/agent-api/errors";

export async function setExpressImportAction(agentId: string, projectId: string, enabled: boolean, response?: string) {
  if (!isAgentPlatformEnabled()) return { ok: false as const, error: "The agent platform is turned off." };
  if (typeof agentId !== "string" || !agentId || agentId.length > 191 || typeof projectId !== "string" || !projectId || projectId.length > 191 || typeof enabled !== "boolean") {
    return { ok: false as const, error: "Choose an agent and project." };
  }
  const person = await requireUser();
  try {
    if (response !== undefined && (typeof response !== "string" || response.length > 2000)) return { ok: false as const, error: "Keep the admin response under 2,000 characters." };
    await setExpressImportGrant(person, agentId, projectId, enabled, response);
    revalidatePath("/agent/[username]/edit/level", "page");
    revalidatePath("/[org]/[project]/import", "page");
    return { ok: true as const };
  } catch (error) {
    if (error instanceof IssueApiError) return { ok: false as const, error: error.message };
    throw error;
  }
}

export async function requestExpressImportAction(agentId: string, projectId: string, reason: string) {
  if (!isAgentPlatformEnabled()) return { ok: false as const, error: "The agent platform is turned off." };
  if (typeof agentId !== "string" || !agentId || agentId.length > 191 || typeof projectId !== "string" || !projectId || projectId.length > 191) return { ok: false as const, error: "Choose an agent and project." };
  const person = await requireUser();
  try {
    await requestExpressImportAccess(person, agentId, projectId, reason);
    revalidatePath("/[org]/[project]/import", "page");
    return { ok: true as const };
  } catch (error) {
    if (error instanceof IssueApiError) return { ok: false as const, error: error.message };
    throw error;
  }
}
