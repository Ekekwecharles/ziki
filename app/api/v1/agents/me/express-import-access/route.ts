import { NextResponse, type NextRequest } from "next/server";
import { agentIssueRequest, issueJson, issueProject } from "@/lib/agent-api/issues";
import { expressImportAccess, expressImportRequestSchema, requestExpressImportAccess } from "@/lib/agents/express-import";
import { createMethodNotAllowed, createOptions } from "@/lib/agent-api/http-errors";

/** Agents ask for their own access, never grant it. Admins review in the platform. */
export async function POST(request: NextRequest) {
  return agentIssueRequest(request, "agents.express_import.request", "working", null, async (agent) => {
    const body = expressImportRequestSchema.parse(await issueJson(request));
    const scope = await issueProject(agent, request.nextUrl.searchParams, body.projectId);
    await requestExpressImportAccess({ id: agent.ownerId }, agent.agentId, scope.projectId, body.reason);
    return NextResponse.json({ requested: true, ...(await expressImportAccess(agent, scope.projectId)) }, { status: 201 });
  });
}

export async function GET(request: NextRequest) {
  return agentIssueRequest(request, "agents.express_import.read", "read", null, async (agent) => {
    const scope = await issueProject(agent, request.nextUrl.searchParams);
    return NextResponse.json(await expressImportAccess(agent, scope.projectId));
  });
}

const methodNotAllowed = createMethodNotAllowed(["GET", "POST", "OPTIONS"]);
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
export const OPTIONS = createOptions(["GET", "POST", "OPTIONS"]);
