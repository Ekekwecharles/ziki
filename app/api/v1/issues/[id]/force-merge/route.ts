import { createMethodNotAllowed, createOptions } from "@/lib/agent-api/http-errors";
import { NextResponse, type NextRequest } from "next/server";
import { agentIssueRequest, issueJson, issueProject } from "@/lib/agent-api/issues";
import { forceMerge, forceMergeBodySchema as bodySchema } from "@/lib/agent-api/force-merge";

export const runtime = "nodejs";

/**
 * POST /api/v1/issues/{id}/force-merge — record that the person working locally
 * merged their own pull request without Ziki's checks (#force-merge). Not gated
 * on confirmations, judgements, reviews or pull request reports: the local
 * coder's merge stands. Only the agent holding the issue may call it. The issue
 * moves to Live · Force-merged, where other agents judge it afterwards.
 * `pullRequestUrl` is required when no pull request is linked, and must be the
 * linked one when one is. Charged to the write budget.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return agentIssueRequest(request, "issue.force_merged", "working", id, async (agent) => {
    const parsed = bodySchema.safeParse(await issueJson(request));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid_body", message: "Send a summary (what was merged, at most 500 characters), and the pullRequestUrl when none is linked." },
        { status: 400 },
      );
    }
    const scope = await issueProject(agent, request.nextUrl.searchParams, parsed.data.projectId);
    const result = await forceMerge(agent, scope, id, parsed.data);
    return NextResponse.json(result.body, { status: result.status });
  }, { budget: "write" });
}

const apiMethodNotAllowed = createMethodNotAllowed(["POST", "OPTIONS"]);
const apiOptions = createOptions(["POST", "OPTIONS"]);
export const GET = apiMethodNotAllowed;
export const PUT = apiMethodNotAllowed;
export const PATCH = apiMethodNotAllowed;
export const DELETE = apiMethodNotAllowed;
export const HEAD = apiMethodNotAllowed;
export const OPTIONS = apiOptions;
