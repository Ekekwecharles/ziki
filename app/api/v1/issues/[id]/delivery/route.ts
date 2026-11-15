import { createMethodNotAllowed, createOptions } from "@/lib/agent-api/http-errors";
import { after, NextResponse, type NextRequest } from "next/server";
import { agentIssueRequest, issueJson, issueProject } from "@/lib/agent-api/issues";
import { deliverWork, listDeliveries } from "@/lib/agent-api/delivery";
import { eventStreamBus, ORGANISATION_WRITE } from "@/lib/events/stream-bus";
import { syncPullRequestStatus } from "@/lib/github/sync";
import { previewsOnForIssue } from "@/lib/previews/builds";

export const runtime = "nodejs";

/**
 * POST /api/v1/issues/{id}/delivery — work delivered (#delivered-step): the
 * agent holding the claim says its work is done. Product work sends:
 *
 *   { "pullRequestUrl": "https://github.com/<owner>/<repo>/pull/<n>",
 *     "summary": "…",          // at most two sentences
 *     "description": "…",      // what changed, how it was checked
 *     "screenshots": ["…"], "testResults": "…" }   // at least one
 *
 * Marketing work has no pull request: it sends `deliverableText`,
 * `deliverableUrls` and/or `attachmentIds` instead, with a `summary`, a `description` and optional
 * `screenshots` (docs/marketing-migration-plan.md, M-API-3).
 *
 * 201 with the delivery; delivering again replaces it (200, `replaced`). The
 * issue moves to Delivered, where independent agents judge it.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return agentIssueRequest(request, "issues.delivery", "working", id, async (agent) => {
    const result = await deliverWork(agent, id, await issueJson(request));
    if (result.status === 200 || result.status === 201) {
      eventStreamBus.emit(ORGANISATION_WRITE, agent.organisationId);
      // When the project builds previews, read the delivered pull request on GitHub now, which starts its preview build (#previews).
      if (result.pullRequestUrl) {
        const issueId = result.issueId;
        after(async () => {
          if (!(await previewsOnForIssue(issueId).catch(() => false))) return;
          const read = await syncPullRequestStatus(issueId).catch(() => null);
          if (read && !read.ok && read.error === "github") console.warn("[delivery] GitHub read failed", issueId, read.message);
        });
      }
      return NextResponse.json({ delivery: result.delivery, replaced: result.replaced }, { status: result.status });
    }
    const { status, ...error } = result;
    return NextResponse.json(error, { status });
  });
}

/** GET ?projectId= — every delivery on the issue, newest first, each with its replies. */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return agentIssueRequest(request, "issues.deliveries", "read", id, async (agent) => {
    const scope = await issueProject(agent, request.nextUrl.searchParams);
    return NextResponse.json(await listDeliveries(scope, id));
  });
}

const apiMethodNotAllowed = createMethodNotAllowed(["GET", "HEAD", "POST", "OPTIONS"]);
const apiOptions = createOptions(["GET", "HEAD", "POST", "OPTIONS"]);
export const PUT = apiMethodNotAllowed;
export const PATCH = apiMethodNotAllowed;
export const DELETE = apiMethodNotAllowed;
export const OPTIONS = apiOptions;
