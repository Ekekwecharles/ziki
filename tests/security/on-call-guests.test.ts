import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  agentApiKey: { findUnique: vi.fn(), update: vi.fn() },
  agentActivation: { findUnique: vi.fn() },
  project: { findUnique: vi.fn() },
  organisation: { findUnique: vi.fn() },
}));
const audit = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/agents/audit", () => ({ audit }));

import { requireAgent } from "@/lib/agents/require-agent";
import { guestOrganisationFor, LIVE_GUEST } from "@/lib/agents/guest-access";
import { addOnCallGuests, GUEST_WORKSPACES_PER_PERSON, pickFreeOnCallPeople } from "@/lib/on-call-guests";
import { ON_CALL_GUESTS_PER_NEW_WORKSPACE } from "@/lib/security-checks";

const NOW = new Date("2026-11-14T12:00:00Z");
/** A fixed "random" so the picks are predictable: always keep the order. */
const noShuffle = () => 0.999;

/** An on-call person as the query returns them: their agents, each with its live guest stays. */
const person = (id: string, agents: { id: string; guestIn?: string[] }[]) => ({
  id,
  agents: agents.map((agent) => ({ id: agent.id, activations: (agent.guestIn ?? []).map((organisationId) => ({ organisationId })) })),
});

beforeEach(() => vi.clearAllMocks());

describe("picking free on-call people (14 Nov plan, D2)", () => {
  it("asks only for on-call people, not the creator, with an agent that is live, unpaused and recently seen", async () => {
    const findMany = vi.fn<(query: { where: unknown; select: { agents: { where: unknown } } }) => Promise<never[]>>(async () => []);
    await pickFreeOnCallPeople({ user: { findMany } } as never, 3, { excludeUserIds: ["creator"], now: NOW });
    const query = findMany.mock.calls[0]![0];
    expect(query.where).toEqual({
      onCallAt: { not: null },
      id: { notIn: ["creator"] },
      agents: { some: { revokedAt: null, pausedAt: null, apiKeys: { some: { revokedAt: null, lastUsedAt: { gte: new Date(NOW.getTime() - 15 * 60 * 1000) } } } } },
    });
    // Every agent of theirs that isn't revoked comes along, paused ones included.
    expect(query.select.agents.where).toEqual({ revokedAt: null });
  });

  it("skips people already guests in enough workspaces, keeps all their agents, and takes at most n", async () => {
    const full = Array.from({ length: GUEST_WORKSPACES_PER_PERSON }, (_, i) => `org${i}`);
    const people = [
      person("ada", [{ id: "a1" }, { id: "a2", guestIn: ["org-x"] }]),
      // Two agents in the same three workspaces count as three workspaces, not six.
      person("bola", [{ id: "b1", guestIn: full }, { id: "b2", guestIn: full }]),
      person("chi", [{ id: "c1", guestIn: ["org-y", "org-z"] }]),
      person("dami", [{ id: "d1" }]),
    ];
    const picked = await pickFreeOnCallPeople({ user: { findMany: async () => people } } as never, 2, { now: NOW, random: noShuffle });
    expect(picked).toEqual([
      { userId: "ada", agentIds: ["a1", "a2"] },
      { userId: "chi", agentIds: ["c1"] },
    ]);
  });

  it("picks nobody when asked for none", async () => {
    const findMany = vi.fn();
    expect(await pickFreeOnCallPeople({ user: { findMany } } as never, 0)).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe("adding guests to a new workspace", () => {
  it("adds each free on-call person with all their agents as working guests, never the creator", async () => {
    const createMany = vi.fn(async () => ({ count: 3 }));
    const findMany = vi.fn<(query: { where: { id: unknown } }) => Promise<ReturnType<typeof person>[]>>(async () => [
      person("ada", [{ id: "a1" }, { id: "a2" }]),
      person("chi", [{ id: "c1" }]),
    ]);
    const added = await addOnCallGuests({ user: { findMany }, agentActivation: { createMany } } as never, { organisationId: "new-org", creatorId: "creator" }, { now: NOW, random: noShuffle });
    expect(added).toEqual(["a1", "a2", "c1"]);
    expect(findMany.mock.calls[0]![0].where.id).toEqual({ notIn: ["creator"] });
    expect(createMany).toHaveBeenCalledWith({
      data: [
        { agentId: "a1", organisationId: "new-org", level: "working", guest: true },
        { agentId: "a2", organisationId: "new-org", level: "working", guest: true },
        { agentId: "c1", organisationId: "new-org", level: "working", guest: true },
      ],
      skipDuplicates: true,
    });
    expect(audit).toHaveBeenCalledTimes(3);
    expect(ON_CALL_GUESTS_PER_NEW_WORKSPACE).toBe(3);
  });

  it("adds nobody when nobody is free, and never fails the workspace on an error", async () => {
    const createMany = vi.fn();
    expect(await addOnCallGuests({ user: { findMany: async () => [] }, agentActivation: { createMany } } as never, { organisationId: "o", creatorId: "c" })).toEqual([]);
    expect(createMany).not.toHaveBeenCalled();

    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const broken = { user: { findMany: async () => { throw new Error("db down"); } } };
    await expect(addOnCallGuests(broken as never, { organisationId: "o", creatorId: "c" })).resolves.toEqual([]);
    spy.mockRestore();
  });
});

describe("which workspace a guest's call is for", () => {
  const stays = [{ organisationId: "client" }];

  it("is the guest workspace when the request names a project or work feed there", async () => {
    db.project.findUnique.mockResolvedValueOnce({ organisationId: "client" });
    expect(await guestOrganisationFor(db as never, "https://ziki.dev/api/v1/issues?projectId=p-client", stays)).toBe("client");
    db.organisation.findUnique.mockResolvedValueOnce({ id: "client" });
    expect(await guestOrganisationFor(db as never, "https://ziki.dev/client-co/web/work", stays)).toBe("client");
  });

  it("stays home for anything else, and costs nothing for agents with no guest stays", async () => {
    db.project.findUnique.mockResolvedValueOnce({ organisationId: "someone-else" });
    expect(await guestOrganisationFor(db as never, "https://ziki.dev/api/v1/issues?projectId=p-other", stays)).toBeNull();
    expect(await guestOrganisationFor(db as never, "https://ziki.dev/api/v1/agents/me", stays)).toBeNull();
    vi.clearAllMocks();
    expect(await guestOrganisationFor(db as never, "https://ziki.dev/api/v1/issues?projectId=p-client", [])).toBeNull();
    expect(db.project.findUnique).not.toHaveBeenCalled();
  });
});

describe("requireAgent for an on-call guest", () => {
  const KEY = "ziki_valid-key-for-tests";
  const keyRow = (activations: { organisationId: string; burst: boolean; burstUntil: Date | null }[]) => ({
    id: "key1",
    lastUsedAt: NOW,
    revokedAt: null,
    organisationId: "home",
    agent: {
      id: "agent1",
      name: "Ada's Claude",
      ownerUserId: "ada",
      revokedAt: null,
      username: "adas-claude",
      tagline: "Patient bug hunter",
      about: "I reproduce first.",
      _count: { skills: 1 },
      pausedAt: null,
      // A super admin at home, and not a member of the client's workspace.
      owner: { role: "super_admin", memberships: [{ organisationId: "home" }] },
      activations,
    },
  });
  const call = (url?: string) => ({
    headers: { get: (name: string) => (name === "authorization" ? `Bearer ${KEY}` : null) },
    method: "GET",
    url,
  });

  beforeEach(() => {
    db.agentActivation.findUnique.mockResolvedValue({ level: "manager", burst: false, burstUntil: null, deactivatedAt: null });
  });

  it("runs in the client's workspace as a working agent, with no admin powers and no membership there", async () => {
    db.agentApiKey.findUnique.mockResolvedValue(keyRow([{ organisationId: "client", burst: false, burstUntil: null }]));
    db.project.findUnique.mockResolvedValue({ organisationId: "client" });
    const agent = await requireAgent(call("https://ziki.dev/api/v1/issues?projectId=p-client"));
    expect(agent).toMatchObject({ organisationId: "client", level: "working", ownerRole: null, guest: true });
    // The key lookup reads only live guest stays.
    expect(db.agentApiKey.findUnique.mock.calls[0]![0].select.agent.select.activations.where).toEqual(LIVE_GUEST);
  });

  it("stays in the key's own workspace, with its own class, everywhere else", async () => {
    db.agentApiKey.findUnique.mockResolvedValue(keyRow([{ organisationId: "client", burst: false, burstUntil: null }]));
    db.project.findUnique.mockResolvedValue({ organisationId: "home" });
    const home = await requireAgent(call("https://ziki.dev/api/v1/issues?projectId=p-home"));
    expect(home).toMatchObject({ organisationId: "home", level: "manager", ownerRole: "super_admin" });
    expect(home.guest).toBeUndefined();

    // A workspace it isn't a guest in can't be reached by naming its project.
    db.project.findUnique.mockResolvedValue({ organisationId: "stranger" });
    expect(await requireAgent(call("https://ziki.dev/api/v1/issues?projectId=p-stranger"))).toMatchObject({ organisationId: "home" });
  });

  it("can't use a stay that has ended: the key lookup only ever returns live ones", async () => {
    // Ended or removed stays aren't returned by the LIVE_GUEST filter, so the agent has none.
    db.agentApiKey.findUnique.mockResolvedValue(keyRow([]));
    db.project.findUnique.mockResolvedValue({ organisationId: "client" });
    expect(await requireAgent(call("https://ziki.dev/api/v1/issues?projectId=p-client"))).toMatchObject({ organisationId: "home" });
    expect(db.project.findUnique).not.toHaveBeenCalled();
  });
});
