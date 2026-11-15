import type { AgentLevel } from "@prisma/client";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authorizationToken, hashSecret } from "@/lib/agents/keys";
import { guestOrganisationFor, LIVE_GUEST } from "@/lib/agents/guest-access";
import { AgentLevelError } from "@/lib/agents/levels";
import { AgentPlatformDisabledError, agentPlatformDisabledResponse } from "@/lib/agents/platform-gate";
import { isAgentPlatformEnabled } from "@/lib/feature-flags";
import { logger } from "@/lib/logger";
import type { AppRole } from "@/lib/roles";
import { AgentWorkBlockedError, assertAgentMayWork } from "@/lib/agents/work-gate";

export { AgentPlatformDisabledError, agentPlatformDisabledResponse };

/**
 * Who is calling (#427). Every agent route starts with `requireAgent()`.
 * It looks the key up by its hash and checks that the key and the agent are
 * live, that the agent is activated in the key's organisation, and that its
 * owner still belongs there (#user-agents). The call runs as that activation:
 * its organisation, class and rate budget. It writes nothing; routes record
 * what they did with `audit()`.
 *
 * On-call guests (12 Nov plan, D2): an agent added as a guest to a new
 * workspace uses its home key there. When the request names a project or work
 * feed in a workspace where the agent is a live guest, the call runs there
 * instead, always as a working agent, without its owner being a member.
 *
 * The owner always comes from the agent row, never from the request body.
 */
export type AgentContext = {
  agentId: string;
  name: string;
  ownerId: string;
  organisationId: string;
  level: AgentLevel;
  /**
   * The owner's site-wide role, read from the agent's owner row. Routes that
   * mirror the web app's admin gate need it (#512).
   */
  ownerRole?: AppRole | null;
  /** For the rate budget (#440). */
  burst: boolean;
  /** When the higher budget lapses; null means no expiry (#596). */
  burstUntil?: Date | null;
  pausedAt?: Date | null;
  /** The key used for this call, so rotation can revoke exactly it. */
  keyId: string;
  /** This call runs in a workspace where the agent is an on-call guest (D2). */
  guest?: boolean;
};

export type AgentAuthFailure = "missing_key" | "invalid_key" | "revoked";

const MESSAGES: Record<AgentAuthFailure, string> = {
  missing_key: "Send your agent key as Authorization: Bearer <key>.",
  invalid_key: "That agent key is not valid. Send it as Authorization: Bearer <key>.",
  revoked: "That agent key has been revoked.",
};

export class AgentAuthError extends Error {
  readonly code: AgentAuthFailure;

  constructor(code: AgentAuthFailure) {
    super(MESSAGES[code]);
    this.name = "AgentAuthError";
    this.code = code;
  }
}

/** The request: its headers, and its method and URL for the work gate. */
type HeaderSource = { headers: { get(name: string): string | null }; method?: string; url?: string };

const LAST_USED_THROTTLE_MS = 60 * 1000;

export async function requireAgent(request: HeaderSource): Promise<AgentContext> {
  if (!isAgentPlatformEnabled()) throw new AgentPlatformDisabledError();
  const auth = authorizationToken(request.headers.get("authorization"));
  // No header (or a Bearer with no token) is a missing key; a header that was
  // sent but cannot be a Ziki key is a bad key, not a missing one (#467).
  if (auth.status === "missing") throw new AgentAuthError("missing_key");
  if (auth.status === "malformed") throw new AgentAuthError("invalid_key");
  const raw = auth.token;

  const key = await prisma.agentApiKey.findUnique({
    where: { keyHash: hashSecret(raw) },
    select: {
      id: true,
      lastUsedAt: true,
      revokedAt: true,
      organisationId: true,
      agent: {
        select: {
          id: true,
          name: true,
          ownerUserId: true,
          revokedAt: true,
          username: true,
          tagline: true,
          about: true,
          _count: { select: { skills: true } },
          pausedAt: true,
          owner: { select: { role: true, memberships: { select: { organisationId: true } } } },
          // Its live on-call guest stays, read with the key so other agents pay nothing extra.
          activations: { where: LIVE_GUEST, select: { organisationId: true, burst: true, burstUntil: true } },
        },
      },
    },
  });
  if (!key) throw new AgentAuthError("invalid_key");
  const { agent } = key;
  if (key.revokedAt || agent.revokedAt) throw new AgentAuthError("revoked");
  // The key works where its agent is active (#user-agents): switched off there, it stops.
  const activation = await prisma.agentActivation.findUnique({
    where: { agentId_organisationId: { agentId: agent.id, organisationId: key.organisationId } },
    select: { level: true, burst: true, burstUntil: true, deactivatedAt: true },
  });
  if (!activation || activation.deactivatedAt) throw new AgentAuthError("revoked");
  // An owner who left the organisation takes their agents' access with them.
  const ownerInOrganisation = agent.owner.memberships.some((m) => m.organisationId === key.organisationId);
  if (!agent.name || !agent.ownerUserId || !ownerInOrganisation) {
    throw new AgentAuthError("invalid_key");
  }
  // An on-call guest working in the workspace it is a guest in: no membership there, working class only.
  const guestOrganisationId = await guestOrganisationFor(prisma, request.url, agent.activations ?? []);
  const guestStay = guestOrganisationId ? agent.activations?.find((stay) => stay.organisationId === guestOrganisationId) : undefined;

  // #agent-work-gate: with the key good, the first check is whether this agent
  // may work at all (assertAgentMayWork below). lastUsedAt is stamped first, so
  // the owner sees a blocked agent is trying.
  const gateAgent = {
    username: agent.username,
    tagline: agent.tagline,
    about: agent.about,
    skillCount: agent._count.skills,
  };

  // Update lastUsedAt on successful auth, throttled to at most once per minute (#535)
  const now = new Date();
  if (
    typeof prisma.agentApiKey?.update === "function" &&
    (!key.lastUsedAt || now.getTime() - key.lastUsedAt.getTime() >= LAST_USED_THROTTLE_MS)
  ) {
    await Promise.resolve(
      prisma.agentApiKey.update({
        where: { id: key.id },
        data: { lastUsedAt: now },
      }),
    ).catch((error) => {
      logger.error("[requireAgent] failed to update lastUsedAt", error);
    });
  }

  assertAgentMayWork(gateAgent, request);

  return {
    agentId: agent.id,
    name: agent.name,
    ownerId: agent.ownerUserId,
    organisationId: guestStay ? guestStay.organisationId : key.organisationId,
    level: guestStay ? "working" : activation.level,
    // A guest never carries its owner's site-wide role into a client's workspace: no admin powers there.
    ownerRole: guestStay ? null : (agent.owner.role ?? null),
    burst: guestStay ? guestStay.burst : activation.burst,
    burstUntil: (guestStay ? guestStay.burstUntil : activation.burstUntil) ?? null,
    pausedAt: agent.pausedAt ?? null,
    keyId: key.id,
    ...(guestStay ? { guest: true } : {}),
  };
}

/**
 * The response for a failed `requireAgent()` or `requireLevel()`: 401 for a
 * missing or bad key, 403 for too low a level. Anything else is rethrown.
 */
export function agentErrorResponse(error: unknown): NextResponse {
  if (error instanceof AgentPlatformDisabledError) return agentPlatformDisabledResponse();
  if (error instanceof AgentAuthError) {
    return NextResponse.json(
      { error: error.code, message: error.message },
      { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="ziki"' } },
    );
  }
  if (error instanceof AgentWorkBlockedError) {
    // #agent-work-gate: the agent may not work until its profile is set up.
    return NextResponse.json(error.toBody(), { status: 403 });
  }
  if (error instanceof AgentLevelError) {
    return NextResponse.json(
      { error: "insufficient_level", message: error.message, required: error.required },
      { status: 403 },
    );
  }
  throw error;
}
