import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { agentErrorResponse, requireAgent, type AgentContext } from "@/lib/agents/require-agent";
import { agentBudgetExceededResponse, consumeAgentBudget, type AgentBudgetKind } from "@/lib/agents/rate-budget";
import { withAgentBudgetHeaders } from "@/lib/agents/rate-budget-headers";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { SECURITY_SEVERITIES } from "@/lib/security-severity";
import { isSecurityCleared } from "@/lib/security-checks";
import { MAX_RESULTS_PER_PART, SecurityJobError } from "./engine";

/**
 * Shared handling for the security-check job routes (#security-checks).
 *
 * These routes are not workspace-scoped: a security-cleared agent checks parts
 * of any client's check, so a part is served by who holds it
 * (`SecurityCheckItem.agentId`), never by the key's workspace. Only agents with
 * site-wide security clearance (its owner's `User.securityClearedAt`) may call them.
 *
 * Request bodies hold private results, so nothing here logs or audits them.
 */

export async function securityJobRequest(
  request: NextRequest,
  kind: AgentBudgetKind,
  handler: (agent: AgentContext) => Promise<NextResponse>,
): Promise<NextResponse> {
  let agent: AgentContext;
  try {
    agent = await requireAgent(request);
  } catch (error) {
    return agentErrorResponse(error);
  }
  const budget = await consumeAgentBudget({ id: agent.agentId, burst: agent.burst, burstUntil: agent.burstUntil ?? null }, kind);
  if (!budget.allowed) return agentBudgetExceededResponse(budget.retryAfterSeconds, budget);

  const row = await prisma.agent.findUnique({ where: { id: agent.agentId }, select: { owner: { select: { securityClearedAt: true } } } });
  if (!row || !isSecurityCleared(row.owner)) {
    return withAgentBudgetHeaders(
      NextResponse.json(
        { error: "not_security_cleared", message: "Only agents whose owner is cleared for security checks do these jobs. Staff grant clearance, usually with an on-call invite." },
        { status: 403 },
      ),
      budget,
    );
  }
  try {
    return withAgentBudgetHeaders(await handler(agent), budget);
  } catch (error) {
    if (error instanceof SecurityJobError) {
      return withAgentBudgetHeaders(NextResponse.json({ error: error.code, message: error.message }, { status: error.status }), budget);
    }
    if (error instanceof z.ZodError) {
      return withAgentBudgetHeaders(
        NextResponse.json({ error: "invalid_body", message: "The request body is not valid.", issues: error.issues.map((i) => ({ path: i.path, message: i.message })) }, { status: 400 }),
        budget,
      );
    }
    // Never log the body or the error's data: results are private.
    logger.error("[security-checks] job route failed", error instanceof Error ? error.name : "unknown");
    return withAgentBudgetHeaders(NextResponse.json({ error: "internal_error", message: "Something went wrong." }, { status: 500 }), budget);
  }
}

export async function readJson(request: NextRequest): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new SecurityJobError(400, "invalid_json", "The request body must be JSON.");
  }
}

export const reportBodySchema = z.object({
  results: z
    .array(
      z.object({
        severity: z.enum(SECURITY_SEVERITIES),
        title: z.string().trim().min(3).max(200),
        description: z.string().trim().min(10).max(10_000),
        howToFix: z.string().trim().min(10).max(10_000),
      }),
    )
    .max(MAX_RESULTS_PER_PART),
});
