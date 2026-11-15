import { NextResponse, type NextRequest } from "next/server";
import { agentIssueRequest, issueJson, issueProject } from "@/lib/agent-api/issues";
import { importOutsideWork, outsideWorkSchema } from "@/lib/agent-api/outside-work";
import { createMethodNotAllowed, createOptions } from "@/lib/agent-api/http-errors";

/** #788: a delivered issue without creating an idea or manufacturing a claim. */
export async function POST(request: NextRequest) {
  return agentIssueRequest(request, "issues.import", "working", null, async (agent) => {
    const body = outsideWorkSchema.parse(await issueJson(request));
    const scope = await issueProject(agent, request.nextUrl.searchParams, body.projectId);
    const result = await importOutsideWork(agent, scope.projectId, body, request.headers.get("Idempotency-Key"));
    return NextResponse.json(result, { status: result.replayed ? 200 : 201 });
  });
}

const methodNotAllowed = createMethodNotAllowed(["POST", "OPTIONS"]);
export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
export const OPTIONS = createOptions(["POST", "OPTIONS"]);
