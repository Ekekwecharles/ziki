import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const requireAgent = vi.hoisted(() => vi.fn());
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/agents/require-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agents/require-agent")>()),
  requireAgent,
}));
vi.mock("@/lib/agents/rate-budget", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agents/rate-budget")>()),
  consumeAgentBudget: vi.fn(async () => ({ allowed: true, remaining: 100, limit: 100, retryAfterSeconds: 0 })),
}));
vi.mock("@/lib/agents/audit", () => ({ audit: vi.fn(async () => undefined) }));

import { agentIssueRequest } from "@/lib/agent-api/issues";
import { GUEST_BLOCKED_ACTIONS, guestHomeFor, homeWorkspaceFor } from "@/lib/agents/guest-access";
import { award } from "@/lib/points/award";

const guest = { agentId: "a1", name: "Ada's Claude", ownerId: "ada", organisationId: "client", level: "working", burst: false, keyId: "k1", guest: true };

beforeEach(() => vi.clearAllMocks());

describe("what an on-call guest may not do (12 Nov plan, D2)", () => {
  it("can't set up webhooks, goals or research jobs in the workspace it's visiting", async () => {
    requireAgent.mockResolvedValue(guest);
    const run = vi.fn(async () => new Response("made"));
    for (const action of GUEST_BLOCKED_ACTIONS) {
      const response = await agentIssueRequest(new NextRequest("https://ziki.dev/api/v1/webhooks?projectId=p"), action, "working", null, run, { budget: "none" });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: "guest_not_allowed" });
    }
    expect(run).not.toHaveBeenCalled();
    expect([...GUEST_BLOCKED_ACTIONS]).toEqual(expect.arrayContaining(["webhooks.create", "goals.create", "jobs.create"]));
  });

  it("still does ordinary work there, and a normal agent can still set up webhooks at home", async () => {
    const run = vi.fn(async () => new Response("ok"));
    requireAgent.mockResolvedValue(guest);
    expect((await agentIssueRequest(new NextRequest("https://ziki.dev/x"), "issues.list", "read", null, run, { budget: "none" })).status).toBe(200);
    requireAgent.mockResolvedValue({ ...guest, organisationId: "home", guest: undefined });
    expect((await agentIssueRequest(new NextRequest("https://ziki.dev/x"), "webhooks.create", "working", null, run, { budget: "none" })).status).toBe(200);
  });
});

/** A ledger with activations: `stays` are the agent's workspaces, `members` who belongs where. */
function ledger(stays: { agentId: string; ownerUserId: string; organisationId: string; guest: boolean; deactivated?: boolean; at: number }[], members: { userId: string; organisationId: string }[]) {
  const written: { organisationId: string; userId: string; points: number }[] = [];
  type Where = {
    agentId?: string;
    organisationId?: string;
    guest?: boolean;
    deactivatedAt?: null;
    agent?: { ownerUserId: string };
    organisation?: { memberships: { none: { userId: string } } };
  };
  const db = {
    agentActivation: {
      findFirst: vi.fn(async ({ where }: { where: Where }) => {
        const found = stays
          .filter((s) => (where.agentId === undefined || s.agentId === where.agentId)
            && (where.organisationId === undefined || s.organisationId === where.organisationId)
            && (where.guest === undefined || s.guest === where.guest)
            && (where.deactivatedAt === undefined || !s.deactivated)
            && (where.agent === undefined || s.ownerUserId === where.agent.ownerUserId)
            && (where.organisation === undefined || !members.some((m) => m.organisationId === s.organisationId && m.userId === where.organisation!.memberships.none.userId)))
          .sort((x, y) => x.at - y.at)[0];
        return found ? { agentId: found.agentId, organisationId: found.organisationId } : null;
      }),
    },
    organisation: { findUnique: vi.fn(async () => ({ pointsMultiplier: 1 })) },
    pointEntry: {
      createMany: vi.fn(async ({ data }: { data: { organisationId: string; userId: string; points: number }[] }) => {
        written.push(...data);
        return { count: data.length };
      }),
    },
  };
  return { db, written };
}

// Ada is a member of "home" and "side"; her agent a1 visits "client" as a guest.
const stays = [
  { agentId: "a1", ownerUserId: "ada", organisationId: "side", guest: false, at: 2 },
  { agentId: "a1", ownerUserId: "ada", organisationId: "home", guest: false, at: 1 },
  { agentId: "a1", ownerUserId: "ada", organisationId: "client", guest: true, at: 3 },
];
const members = [{ userId: "ada", organisationId: "home" }, { userId: "ada", organisationId: "side" }, { userId: "kemi", organisationId: "client" }];

describe("where a guest's points land", () => {
  it("in its home workspace: the earliest normal workspace its agent is active in", async () => {
    const { db } = ledger(stays, members);
    expect(await homeWorkspaceFor("a1", db as never)).toBe("home");
  });

  it("sends a guest's points home, named by agent or only by its owner", async () => {
    const { db, written } = ledger(stays, members);
    await award(db as never, { organisationId: "client", userId: "ada", agentId: "a1", bugId: "b1", role: "solver", points: 5, sourceKey: "solver:b1:ada", exact: true });
    // The solver award names only the person: the guest agent is found through its owner.
    await award(db as never, { organisationId: "client", userId: "ada", bugId: "b2", role: "solver", points: 3, sourceKey: "solver:b2:ada", exact: true });
    expect(written.map((w) => w.organisationId)).toEqual(["home", "home"]);
  });

  it("still sends them home after the guest has left (points can arrive on deploy)", async () => {
    const left = stays.map((s) => (s.organisationId === "client" ? { ...s, deactivated: true } : s));
    const { db } = ledger(left, members);
    expect(await guestHomeFor(db as never, { organisationId: "client", userId: "ada", agentId: "a1" })).toBe("home");
  });

  it("leaves everyone else's points where they were earned", async () => {
    const { db, written } = ledger(stays, members);
    // The client's own member, and Ada earning at home.
    await award(db as never, { organisationId: "client", userId: "kemi", bugId: "b3", role: "solver", points: 2, sourceKey: "solver:b3:kemi", exact: true });
    await award(db as never, { organisationId: "home", userId: "ada", agentId: "a1", bugId: "b4", role: "solver", points: 2, sourceKey: "solver:b4:ada", exact: true });
    expect(written.map((w) => w.organisationId)).toEqual(["client", "home"]);

    // Once Ada joins the client's workspace herself, she earns there like any member.
    const joined = ledger(stays, [...members, { userId: "ada", organisationId: "client" }]);
    expect(await guestHomeFor(joined.db as never, { organisationId: "client", userId: "ada", agentId: "a1" })).toBeNull();
  });
});
