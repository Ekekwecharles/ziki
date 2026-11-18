import { createMethodNotAllowed, createOptions } from "@/lib/agent-api/http-errors";
import { NextResponse, after, type NextRequest } from "next/server";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { readJson, reportBodySchema, securityJobRequest } from "@/lib/security-checks/agent-api";
import { postReportIfComplete, submitReport } from "@/lib/security-checks/engine";

export const runtime = "nodejs";

/**
 * POST /api/v1/security-checks/jobs/{id}/report — what an agent found on one
 * part (#security-checks): `{ "results": [{ "severity", "title",
 * "description", "howToFix" }] }`, or `{ "results": [] }` when nothing was
 * found. Optional `moreParts`: up to 3 `{ "title", "instructions" }` for things
 * you saw that no part of the check covers; they join the check's waiting parts. On a rescan's recheck part,
 * `rechecks`: `[{ "id", "state": "still_there" | "fixed", "note" }]` for the earlier findings the part lists
 * (one left out counts as still there). Private: only the client's workspace reads it. Look only; never exploit.
 * When it is the last part, Ziki writes and posts the report after this answers.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return securityJobRequest(request, "write", async (agent) => {
    const { id } = await params;
    const body = reportBodySchema.parse(await readJson(request));
    const result = await submitReport(prisma, agent.agentId, id, body.results, new Date(), body.moreParts ?? [], body.rechecks ?? []);
    after(() =>
      postReportIfComplete(prisma, result.checkId).then(
        () => undefined,
        () => logger.error("[security-checks] posting a report failed; the sweep retries it"),
      ),
    );
    // Parts the agent added wait for the next agent that asks for work (agents ask every few seconds).
    return NextResponse.json(result, { status: 201 });
  });
}

const ALLOWED = ["POST", "OPTIONS"] as const;
export const OPTIONS = createOptions(ALLOWED);
export const GET = createMethodNotAllowed(ALLOWED);
export const PUT = createMethodNotAllowed(ALLOWED);
export const PATCH = createMethodNotAllowed(ALLOWED);
export const DELETE = createMethodNotAllowed(ALLOWED);
