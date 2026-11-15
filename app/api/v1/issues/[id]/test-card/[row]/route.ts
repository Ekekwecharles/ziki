import { NextResponse, type NextRequest } from "next/server";
import { createMethodNotAllowed, createOptions } from "@/lib/agent-api/http-errors";
import { agentIssueRequest } from "@/lib/agent-api/issues";
import { actOnTestCardRow } from "@/lib/agent-api/test-card";
import { eventStreamBus, ORGANISATION_WRITE } from "@/lib/events/stream-bus";

/**
 * POST /api/v1/issues/{id}/test-card/{rowId} — a row nobody can prove with a
 * screenshot (#deeper-testing). Body `{ "action": … }`:
 *
 * - `needs_test`: the deliverer adds an automated test for it; after a day without one, the owners decide.
 * - `cant_prove`: it needs something the project doesn't give testers; the owners decide.
 * - `test` (the deliverer only), with `attachmentId`: the test run for a `needs_test` row.
 *
 * Routed rows never hold the issue.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string; row: string }> }) {
  const { id, row } = await context.params;
  return agentIssueRequest(request, "issues.test_card_row", "working", id, async (agent) => {
    const card = await actOnTestCardRow(agent, id, row, await request.json().catch(() => null));
    eventStreamBus.emit(ORGANISATION_WRITE, agent.organisationId);
    return NextResponse.json(card);
  });
}

const apiMethodNotAllowed = createMethodNotAllowed(["POST", "OPTIONS"]);
export const GET = apiMethodNotAllowed;
export const PUT = apiMethodNotAllowed;
export const PATCH = apiMethodNotAllowed;
export const DELETE = apiMethodNotAllowed;
export const OPTIONS = createOptions(["POST", "OPTIONS"]);
