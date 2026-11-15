import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.hoisted(() => vi.fn());
const update = vi.hoisted(() => vi.fn());
const findActivation = vi.hoisted(() => vi.fn());
const registryDb = vi.hoisted(() => ({
  project: { findUnique: vi.fn(), findFirst: vi.fn() },
  expressImportGrant: { findUnique: vi.fn() },
  expressImportRequest: { findUnique: vi.fn() },
  agent: { findUnique: vi.fn() },
  membership: { findUnique: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { agentApiKey: { findUnique, update }, agentActivation: { findUnique: findActivation }, ...registryDb },
}));

import { generateApiKey, hashSecret } from "@/lib/agents/keys";
import { AgentLevelError } from "@/lib/agents/levels";
import { AgentAuthError, agentErrorResponse, requireAgent } from "@/lib/agents/require-agent";
import { activateAgent } from "@/lib/agents/registry";
import { agentCapSummary } from "@/lib/agents/registry-limits";
import { assertExpressImportGrant, expressImportAccess, expressImportRequestSchema, requestExpressImportAccess, setExpressImportGrant } from "@/lib/agents/express-import";

const KEY = "ziki_valid-key-for-tests";
const request = (authorization?: string) => ({
  headers: { get: (name: string) => (name === "authorization" ? (authorization ?? null) : null) },
});

function keyRow(overrides: {
  revokedAt?: Date | null;
  lastUsedAt?: Date | null;
  agent?: Record<string, unknown>;
} = {}) {
  return {
    id: "key1",
    lastUsedAt: overrides.lastUsedAt ?? null,
    revokedAt: overrides.revokedAt ?? null,
    // #user-agents: the organisation the key works in, every project there.
    organisationId: "organisation_zedu",
    agent: {
      id: "agent1",
      name: "Ada's Claude",
      ownerUserId: "ada",
      revokedAt: null,
      // A set-up profile, so the work gate lets the key through.
      username: "adas-claude",
      tagline: "Patient bug hunter",
      about: "I reproduce first.",
      _count: { skills: 1 },
      owner: { role: "user", memberships: [{ organisationId: "organisation_zedu" }] },
      ...overrides.agent,
    },
  };
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as AgentAuthError;
  }
  throw new Error("expected requireAgent to reject");
}

/** The agent switched on in the key's organisation, with its class there. */
const activeHere = { level: "working", burst: false, burstUntil: null, deactivatedAt: null };

beforeEach(() => {
  vi.clearAllMocks();
  update.mockResolvedValue({});
  findActivation.mockResolvedValue(activeHere);
});

/** Agent keys (#427): a valid key resolves its agent; missing, malformed, wrong, revoked and foreign keys are refused. */
describe("requireAgent (#427)", () => {
  it("rejects a request with no key without touching the database", async () => {
    expect((await failure(requireAgent(request()))).code).toBe("missing_key");
    expect((await failure(requireAgent(request("Bearer")))).code).toBe("missing_key");
    expect((await failure(requireAgent(request("   ")))).code).toBe("missing_key");
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("calls a sent-but-unusable header a bad key, not a missing one (#467)", async () => {
    // Each of these *did* send a key; only its shape is wrong.
    for (const header of ["Basic abc", "Bearer bad", "Bearer a b", 'Bearer "ziki_abc"', "Bearer sk-other"]) {
      expect((await failure(requireAgent(request(header)))).code).toBe("invalid_key");
    }
    // A malformed header never reaches the database.
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("rejects a key that matches nothing", async () => {
    findUnique.mockResolvedValue(null);
    expect((await failure(requireAgent(request("Bearer ziki_wrong")))).code).toBe("invalid_key");
    expect(findUnique.mock.calls[0][0].where).toEqual({ keyHash: hashSecret("ziki_wrong") });
  });

  it("resolves a valid key to the agent, its owner, organisation and level", async () => {
    findUnique.mockResolvedValue(keyRow());
    await expect(requireAgent(request(`Bearer ${KEY}`))).resolves.toEqual({
      agentId: "agent1",
      name: "Ada's Claude",
      ownerId: "ada",
      organisationId: "organisation_zedu",
      level: "working",
      ownerRole: "user",
      burst: false,
      burstUntil: null,
      pausedAt: null,
      keyId: "key1",
    });
    // Looked up by hash only; the raw key never reaches the query.
    expect(JSON.stringify(findUnique.mock.calls[0][0])).not.toContain(KEY);
  });

  it("rejects a revoked key, and every key of a revoked agent", async () => {
    findUnique.mockResolvedValue(keyRow({ revokedAt: new Date() }));
    expect((await failure(requireAgent(request(`Bearer ${KEY}`)))).code).toBe("revoked");
    findUnique.mockResolvedValue(keyRow({ agent: { revokedAt: new Date() } }));
    expect((await failure(requireAgent(request(`Bearer ${KEY}`)))).code).toBe("revoked");
  });

  it("runs as the agent's activation in the key's organisation: its class there (#user-agents)", async () => {
    findUnique.mockResolvedValue(keyRow());
    findActivation.mockResolvedValue({ ...activeHere, level: "manager" });
    await expect(requireAgent(request(`Bearer ${KEY}`))).resolves.toMatchObject({ organisationId: "organisation_zedu", level: "manager" });
    expect(findActivation.mock.calls[0][0].where).toEqual({ agentId_organisationId: { agentId: "agent1", organisationId: "organisation_zedu" } });
  });

  it("stops a key once its agent is taken out of that organisation, or was never brought in", async () => {
    findUnique.mockResolvedValue(keyRow());
    findActivation.mockResolvedValue({ ...activeHere, deactivatedAt: new Date() });
    expect((await failure(requireAgent(request(`Bearer ${KEY}`)))).code).toBe("revoked");
    findActivation.mockResolvedValue(null);
    expect((await failure(requireAgent(request(`Bearer ${KEY}`)))).code).toBe("revoked");
  });

  it("rejects an agent whose owner has left its organisation", async () => {
    findUnique.mockResolvedValue(keyRow({ agent: { owner: { memberships: [{ organisationId: "other" }] } } }));
    expect((await failure(requireAgent(request(`Bearer ${KEY}`)))).code).toBe("invalid_key");
  });

  it("keeps only a key's hash, never the raw key", () => {
    const key = generateApiKey();
    expect(key.hash).toBe(hashSecret(key.raw));
    expect(key.hash).not.toContain(key.raw);
    expect(generateApiKey().raw).not.toBe(key.raw);
  });
});

describe("agentErrorResponse", () => {
  it("is 401 for key problems and 403 for a low level", async () => {
    const unauthorized = agentErrorResponse(new AgentAuthError("missing_key"));
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("WWW-Authenticate")).toContain("Bearer");
    const forbidden = agentErrorResponse(new AgentLevelError("manager"));
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ error: "insufficient_level", required: "manager" });
  });
});

describe("the work gate (#agent-work-gate)", () => {
  const ready = { tagline: "Patient bug hunter", about: "I reproduce first.", skillCount: 1 };

  it("lets an agent with a set-up profile work, and names what an unfinished one lacks", async () => {
    const { missingProfileFields } = await import("@/lib/agents/work-gate");
    expect(missingProfileFields(ready)).toEqual([]);
    expect(missingProfileFields({ tagline: null, about: "  ", skillCount: 0 })).toEqual(["tagline", "about", "skills"]);
  });

  it("refuses every route to an unfinished profile except setting the profile up", async () => {
    const { assertAgentMayWork, AgentWorkBlockedError } = await import("@/lib/agents/work-gate");
    const agent = { username: "ada-claude", tagline: null, about: null, skillCount: 0 };
    const at = (method: string, path: string) => ({ method, url: `http://localhost${path}` });
    for (const [method, path] of [
      ["GET", "/api/v1/agents/me"],
      ["PATCH", "/api/v1/agents/me"],
      ["PUT", "/api/v1/agents/me/skills"],
      ["PUT", "/api/v1/agents/me/skills/postgres"],
      ["PUT", "/api/v1/agents/me/picture"],
      ["GET", "/api/v1/skill-tags"],
      ["GET", "/api/v1/agents/someone"],
    ]) {
      expect(() => assertAgentMayWork(agent, at(method, path)), `${method} ${path}`).not.toThrow();
    }
    for (const [method, path] of [
      ["GET", "/zedu/demo/work"],
      ["POST", "/api/v1/ideas"],
      ["POST", "/api/v1/issues/abc/bid"],
      ["GET", "/api/v1/projects"],
      ["POST", "/api/v1/agents/me/skills"],
      ["GET", "/api/v1/agents/me/history"],
    ]) {
      expect(() => assertAgentMayWork(agent, at(method, path)), `${method} ${path}`).toThrow(AgentWorkBlockedError);
    }
    expect(() => assertAgentMayWork({ ...ready, username: "ada-claude" }, at("POST", "/api/v1/ideas"))).not.toThrow();
  });
});

/** #user-agents: a person brings their agent into an organisation only where they belong; the key it gets works there. */
describe("activateAgent", () => {
  const owner = { id: "ada", role: "user" as const };
  const agent = { id: "agent1", name: "Ada's Claude", ownerUserId: "ada", revokedAt: null, activations: [] };

  it("refuses an organisation its owner isn't a member of, and someone else's agent", async () => {
    registryDb.agent.findUnique.mockResolvedValue(agent);
    registryDb.membership.findUnique.mockResolvedValue(null);
    await expect(activateAgent(owner, "agent1", "organisation_other")).resolves.toMatchObject({ ok: false });
    registryDb.agent.findUnique.mockResolvedValue({ ...agent, ownerUserId: "bob" });
    await expect(activateAgent(owner, "agent1", "organisation_zedu")).resolves.toMatchObject({ ok: false });
    expect(registryDb.$transaction).not.toHaveBeenCalled();
  });

  it("switches it on where they belong, keeping the class that organisation gave it, with one live key there", async () => {
    registryDb.agent.findUnique.mockResolvedValue(agent);
    registryDb.membership.findUnique.mockResolvedValue({ userId: "ada" });
    // The key is sealed so its owner can copy it again.
    vi.stubEnv("AUTH_SECRET", "a-test-secret-of-enough-length");
    const tx = {
      agentActivation: { upsert: vi.fn().mockResolvedValue({ level: "manager" }) },
      agentApiKey: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), create: vi.fn().mockResolvedValue({}) },
      agentAuditEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    registryDb.$transaction.mockImplementation((run: (db: typeof tx) => unknown) => run(tx));
    const result = await activateAgent(owner, "agent1", "organisation_zedu");
    expect(result).toMatchObject({ ok: true, key: { agentId: "agent1", level: "manager" } });
    expect(tx.agentActivation.upsert.mock.calls[0][0]).toMatchObject({
      where: { agentId_organisationId: { agentId: "agent1", organisationId: "organisation_zedu" } },
      update: { deactivatedAt: null },
    });
    expect(tx.agentApiKey.updateMany.mock.calls[0][0].where).toMatchObject({ agentId: "agent1", organisationId: "organisation_zedu", revokedAt: null });
    expect(tx.agentApiKey.create.mock.calls[0][0].data).toMatchObject({ agentId: "agent1", organisationId: "organisation_zedu" });
  });
});

/** The agents page counts live agents, paused ones included, because the cap does (#860, #511). */
const agent = (paused: boolean, revoked = false) => ({ pausedAt: paused ? "2026-11-07T00:00:00Z" : null, revokedAt: revoked ? "2026-11-07T00:00:00Z" : null });

describe("agentCapSummary", () => {
  it("counts live agents, paused included, and leaves revoked ones out", () => {
    const summary = agentCapSummary([agent(false), agent(true), agent(true, true)], 5);
    expect(summary).toMatchObject({ live: 2, paused: 1, running: 1, over: 0, max: 5, note: null });
  });
  it("says pausing doesn't free a slot at the limit", () => {
    const summary = agentCapSummary(Array.from({ length: 5 }, (_, i) => agent(i % 2 === 0)), 5);
    expect(summary.note).toContain("at the limit");
    expect(summary.note).toContain("Pausing doesn't free a slot");
  });
  it("names how far over the limit an owner is", () => {
    const over = agentCapSummary(Array.from({ length: 10 }, (_, i) => agent(i >= 6)), 5);
    expect(over).toMatchObject({ live: 10, paused: 4, running: 6, over: 5 });
    expect(over.note).toContain("5 over the limit");
  });
});

describe("project-scoped express import grants (#788)", () => {
  const grantTx = {
    $queryRaw: vi.fn(), agentActivation: { findUnique: vi.fn() }, membership: { findUnique: vi.fn() },
    project: { findUnique: vi.fn() },
    expressImportRequest: { findUnique: vi.fn(), upsert: vi.fn(), updateMany: vi.fn() },
    expressImportGrant: { findUnique: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() }, agentAuditEvent: { create: vi.fn() },
  };
  beforeEach(() => {
    vi.clearAllMocks();
    registryDb.project.findUnique.mockResolvedValue({ organisationId: "org-1", archivedAt: null });
    registryDb.project.findFirst.mockResolvedValue({ archivedAt: null });
    registryDb.membership.findUnique.mockResolvedValue({ role: "admin" });
    registryDb.$transaction.mockImplementation(async (run) => run(grantTx));
    grantTx.agentActivation.findUnique.mockResolvedValue({ deactivatedAt: null, agent: { revokedAt: null, ownerUserId: "worker" } });
    grantTx.membership.findUnique.mockResolvedValue({ id: "member", role: "admin" });
    grantTx.project.findUnique.mockResolvedValue({ organisationId: "org-1", archivedAt: null });
    grantTx.expressImportGrant.findUnique.mockResolvedValue(null);
    grantTx.expressImportRequest.findUnique.mockResolvedValue(null);
  });
  it("allows an organisation admin to grant and revoke one project's access with an audit", async () => {
    await setExpressImportGrant({ id: "admin" }, "agent-1", "project-1", true);
    expect(grantTx.expressImportGrant.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: { agentId: "agent-1", projectId: "project-1", grantedByUserId: "admin" } }));
    await setExpressImportGrant({ id: "admin" }, "agent-1", "project-1", false);
    expect(grantTx.expressImportGrant.deleteMany).toHaveBeenCalledWith({ where: { agentId: "agent-1", projectId: "project-1" } });
    expect(grantTx.agentAuditEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ actorUserId: "admin", action: "agent.express_import_changed", payload: { enabled: false } }) }));
  });
  it("refuses ordinary members even when they own the agent", async () => {
    registryDb.membership.findUnique.mockResolvedValue({ role: "member" });
    await expect(setExpressImportGrant({ id: "worker" }, "agent-1", "project-1", true)).rejects.toMatchObject({ status: 403 });
    expect(grantTx.expressImportGrant.upsert).not.toHaveBeenCalled();
  });
  it("records an owner's request without granting access, and prevents duplicate pending requests", async () => {
    await requestExpressImportAccess({ id: "worker" }, "agent-1", "project-1", "Import work already delivered with the project owner.");
    expect(grantTx.expressImportRequest.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ agentId: "agent-1", projectId: "project-1", reason: expect.any(String) }) }));
    expect(grantTx.expressImportGrant.upsert).not.toHaveBeenCalled();
    grantTx.expressImportRequest.findUnique.mockResolvedValue({ decision: "pending" });
    await expect(requestExpressImportAccess({ id: "worker" }, "agent-1", "project-1", "Again")).rejects.toMatchObject({ status: 409 });
  });
  it("rejects requests for somebody else's agent or without an explanation", async () => {
    await expect(requestExpressImportAccess({ id: "other-owner" }, "agent-1", "project-1", "Please grant access.")).rejects.toMatchObject({ status: 403 });
    await expect(requestExpressImportAccess({ id: "worker" }, "agent-1", "project-1", " ")).rejects.toMatchObject({ status: 400 });
    expect(grantTx.expressImportRequest.upsert).not.toHaveBeenCalled();
  });
  it("records admin approval or decline on the pending request", async () => {
    await setExpressImportGrant({ id: "admin" }, "agent-1", "project-1", true, "Approved for owner-directed work.");
    expect(grantTx.expressImportRequest.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ decision: "approved", reviewedByUserId: "admin", response: "Approved for owner-directed work." }) }));
    await setExpressImportGrant({ id: "admin" }, "agent-1", "project-1", false, "Use the normal board workflow for now.");
    expect(grantTx.expressImportRequest.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ decision: "declined", response: "Use the normal board workflow for now." }) }));
  });
  it("reports a pending or declined decision without treating it as permission", async () => {
    registryDb.expressImportGrant.findUnique.mockResolvedValue(null);
    for (const decision of ["pending", "declined"]) {
      registryDb.expressImportRequest.findUnique.mockResolvedValue({ decision, response: "Admin feedback" });
      expect(await expressImportAccess({ agentId: "agent-1", organisationId: "org-1" }, "project-1")).toMatchObject({ expressImportAllowed: false, request: { decision, response: "Admin feedback" } });
    }
    expect(registryDb.expressImportRequest.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { agentId_projectId: { agentId: "agent-1", projectId: "project-1" } } }));
  });
  it("distinguishes a current grant from an approved request whose access was revoked", async () => {
    registryDb.expressImportRequest.findUnique.mockResolvedValue({ decision: "approved", response: "Approved" });
    registryDb.expressImportGrant.findUnique.mockResolvedValue({ createdAt: new Date() });
    expect(await expressImportAccess({ agentId: "agent-1", organisationId: "org-1" }, "project-1")).toMatchObject({ expressImportAllowed: true });
    registryDb.expressImportGrant.findUnique.mockResolvedValue(null);
    expect(await expressImportAccess({ agentId: "agent-1", organisationId: "org-1" }, "project-1")).toMatchObject({ expressImportAllowed: false, request: { decision: "approved" } });
    registryDb.project.findFirst.mockResolvedValue(null);
    await expect(expressImportAccess({ agentId: "agent-1", organisationId: "another-org" }, "project-1")).rejects.toMatchObject({ status: 404 });
    expect(expressImportRequestSchema.safeParse({ reason: "Please approve", agentId: "somebody-else" }).success).toBe(false);
  });
  it("refuses inactive agents and archived projects", async () => {
    grantTx.agentActivation.findUnique.mockResolvedValue(null);
    await expect(setExpressImportGrant({ id: "admin" }, "agent-1", "project-1", true)).rejects.toMatchObject({ status: 404 });
    registryDb.project.findUnique.mockResolvedValue({ organisationId: "org-1", archivedAt: new Date() });
    await expect(setExpressImportGrant({ id: "admin" }, "agent-1", "project-1", true)).rejects.toMatchObject({ status: 409 });
  });
  it("requires the exact project grant and rejects another organisation's project", async () => {
    registryDb.expressImportGrant.findUnique.mockResolvedValue(null);
    const caller = { agentId: "agent-1", organisationId: "org-1" };
    const { prisma } = await import("@/lib/prisma");
    await expect(assertExpressImportGrant(prisma, caller, "project-2")).rejects.toMatchObject({ status: 403 });
    registryDb.project.findFirst.mockResolvedValue(null);
    await expect(assertExpressImportGrant(prisma, caller, "foreign-project")).rejects.toMatchObject({ status: 404 });
  });
});
