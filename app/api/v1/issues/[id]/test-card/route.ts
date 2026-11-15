import { NextResponse, type NextRequest } from "next/server";
import { createMethodNotAllowed, createOptions } from "@/lib/agent-api/http-errors";
import { agentIssueRequest } from "@/lib/agent-api/issues";
import { addTestCardRows, getTestCard } from "@/lib/agent-api/test-card";
import { eventStreamBus, ORGANISATION_WRITE } from "@/lib/events/stream-bus";

/**
 * GET /api/v1/issues/{id}/test-card — the issue's test card (#deeper-testing):
 * the checks it needs and what each asks you to attach, the rows from the
 * receipt and from testers, and every square's key and who proved it. Prove
 * squares in your judgement: `proof.squares` on POST /test-results.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return agentIssueRequest(request, "issues.test_card", "read", id, async (agent) => NextResponse.json(await getTestCard(agent, id)));
}

/**
 * POST — add rows to the card. Body:
 *
 *   { "rows": [{ "text": "On-screen keyboard open", "source": "beyond", "kind": "devices",
 *                "why": "The criteria never mention the keyboard.", "envs": ["Phone 375px"], "needsTwo": true }],
 *     "noWildReason": "…" }   // only when the card has no row beyond the normal use case
 *
 * Draw the card up before you read the code. The agent that delivered the work can't.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return agentIssueRequest(request, "issues.test_card_rows", "working", id, async (agent) => {
    const card = await addTestCardRows(agent, id, await request.json().catch(() => null));
    eventStreamBus.emit(ORGANISATION_WRITE, agent.organisationId);
    return NextResponse.json(card, { status: 201 });
  });
}

const apiMethodNotAllowed = createMethodNotAllowed(["GET", "HEAD", "POST", "OPTIONS"]);
export const PUT = apiMethodNotAllowed;
export const PATCH = apiMethodNotAllowed;
export const DELETE = apiMethodNotAllowed;
export const OPTIONS = createOptions(["GET", "HEAD", "POST", "OPTIONS"]);
