import { createMethodNotAllowed, createOptions } from "@/lib/agent-api/http-errors";
import { absoluteUrl } from "@/lib/site-url";
import { WATCH_WORK_MESSAGE } from "@/lib/agents/pairing-link";
import { NextResponse, type NextRequest } from "next/server";
import { agentErrorResponse, requireAgent } from "@/lib/agents/require-agent";
import { agentBudgetExceededResponse, consumeAgentBudget } from "@/lib/agents/rate-budget";
import { withAgentBudgetHeaders } from "@/lib/agents/rate-budget-headers";
import { listAgentProjectSummaries, organisationSlugOf } from "@/lib/agent-api/projects";
import { readAgentInstructions } from "@/lib/agent-messages";
import { prisma } from "@/lib/prisma";
import { projectPath, projectRef } from "@/lib/project-paths";
import { readAgentProfile, updateAgentProfile } from "@/lib/agents/profile";
import { profileErrorResponse } from "@/lib/agent-api/agent-profiles";
import { agentIssueRequest } from "@/lib/agent-api/issues";
import { agentWorkStatus } from "@/lib/agents/work-gate";

/**
 * GET /api/v1/agents/me — who this key belongs to (#427). Any level may call
 * it; it is the quickest way for an agent to check its key works. It also
 * lists the organisation's projects (#607) so an agent can pick the `projectId`
 * every issue route needs (each with its `workUrl`), the organisations the
 * agent is active in (#user-agents), and the owner's standing `instructions` (#605).
 */
export async function GET(req: NextRequest) {
  try {
    const agent = await requireAgent(req);
    // A read like the other list/get routes, so every authenticated agent
    // response carries its own quota headers (#596).
    const budget = await consumeAgentBudget(
      { id: agent.agentId, burst: agent.burst, burstUntil: agent.burstUntil ?? null },
      "read",
    );
    if (!budget.allowed) return agentBudgetExceededResponse(budget.retryAfterSeconds, budget);
    const [projects, instructions, profile, orgSlug, activations, expressGrants] = await Promise.all([
      listAgentProjectSummaries(agent.organisationId),
      readAgentInstructions(agent.agentId),
      readAgentProfile(agent.agentId),
      organisationSlugOf(agent.organisationId),
      // #user-agents: every organisation its owner switched it on in. This key works in this one.
      prisma.agentActivation.findMany({
        where: { agentId: agent.agentId, deactivatedAt: null },
        orderBy: { activatedAt: "asc" },
        select: { level: true, guest: true, guestEndedAt: true, organisation: { select: { id: true, slug: true, name: true } } },
      }),
      prisma.expressImportGrant.findMany({
        where: { agentId: agent.agentId, project: { organisationId: agent.organisationId, archivedAt: null } },
        select: { projectId: true },
      }),
    ]);
    // On-call guests (12 Nov plan, D2): the workspaces it is a guest in, each with its projects'
    // work feeds. This same key works there: pass ?projectId= on every call.
    const guestWorkspaces = await Promise.all(
      activations
        .filter((row) => row.guest && !row.guestEndedAt)
        .map(async (row) => ({
          organisation_id: row.organisation.id,
          org_slug: row.organisation.slug,
          name: row.organisation.name,
          projects: (await listAgentProjectSummaries(row.organisation.id)).map((project) => ({
            ...project,
            workUrl: absoluteUrl(projectPath(projectRef(row.organisation.slug, project.slug), "/work")),
          })),
        })),
    );
    return withAgentBudgetHeaders(
      NextResponse.json({
        id: agent.agentId,
        name: agent.name,
        owner_id: agent.ownerId,
        organisation_id: agent.organisationId,
        // The organisation's slug, the first segment of every project address (`/<org>/<project>/work`).
        org_slug: orgSlug,
        level: agent.level,
        paused: agent.pausedAt !== null,
        // #user-agents: where it is active. A key works in its own organisation, in every project there.
        activations: activations.map((row) => ({
          organisation_id: row.organisation.id,
          org_slug: row.organisation.slug,
          name: row.organisation.name,
          level: row.level,
          guest: row.guest,
        })),
        guest_workspaces: guestWorkspaces,
        // #owner-history: the owner's entries and comments, newest first, with how to replace each.
        history_url: absoluteUrl("/api/v1/agents/me/history"),
        next_step: WATCH_WORK_MESSAGE,
        // #work-feed: each project's `workUrl` is the URL to watch. The key works in all of them (#user-agents).
        projects: projects.map((project) => ({
          ...project,
          expressImportAllowed: expressGrants.some((grant) => grant.projectId === project.id),
          workUrl: orgSlug ? absoluteUrl(projectPath(projectRef(orgSlug, project.slug), "/work")) : null,
        })),
        instructions,
        // #agent-profile: who it says it is. Set with PATCH here, /me/skills and /me/picture.
        profile: profile
          ? { ...profile, picture_url: profile.picture_url ? absoluteUrl(profile.picture_url) : null }
          : null,
        profile_help_url: absoluteUrl("/llms.txt#agent-profile"),
        // #agent-work-gate: whether this agent may work, and what to set up first when it may not.
        work_status: agentWorkStatus({
          username: profile?.username ?? "",
          tagline: profile?.tagline ?? null,
          about: profile?.about ?? null,
          skillCount: profile?.skills.length ?? 0,
        }),
      }),
      budget,
    );
  } catch (error) {
    return agentErrorResponse(error);
  }
}

/**
 * PATCH /api/v1/agents/me — set any of `username`, `tagline` and `about`
 * (#agent-profile). `username` is 3–30 lowercase letters, digits and dashes,
 * unique in the organisation (409 if taken); `tagline` at most 120 characters;
 * `about` at most 2,000. An empty string or null clears tagline or about.
 * 200 with the whole profile.
 */
export async function PATCH(req: NextRequest) {
  return agentIssueRequest(req, "agents.profile_update", "working", "agent:me", async (agent) => {
    const body = await req.json().catch(() => null);
    const result = await updateAgentProfile({ agentId: agent.agentId, organisationId: agent.organisationId }, body);
    if (!result.ok) return profileErrorResponse(result);
    const profile = result.profile;
    return NextResponse.json({ ...profile, picture_url: profile.picture_url ? absoluteUrl(profile.picture_url) : null });
  });
}

const apiMethodNotAllowed = createMethodNotAllowed(["GET", "HEAD", "PATCH", "OPTIONS"]);
const apiOptions = createOptions(["GET", "HEAD", "PATCH", "OPTIONS"]);
export const POST = apiMethodNotAllowed;
export const PUT = apiMethodNotAllowed;
export const DELETE = apiMethodNotAllowed;
export const OPTIONS = apiOptions;
