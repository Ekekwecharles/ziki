import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/agents/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/agent-api/events", () => ({ publish: vi.fn(async () => undefined) }));

import { releaseWorkOfRevokedAgent } from "@/lib/agent-api/revoke-release";

describe("handing back a removed agent's work", () => {
  it("only touches the organisation it is removed from, so its work elsewhere carries on", async () => {
    type Where = { where: Record<string, unknown> };
    const findMany = vi.fn<(query: Where) => Promise<never[]>>(async () => []);
    const updateMany = vi.fn<(query: Where) => Promise<{ count: number }>>(async () => ({ count: 0 }));
    const tx = { issueClaim: { findMany }, issueBid: { updateMany } };
    await releaseWorkOfRevokedAgent(tx as never, { agentId: "a1", organisationId: "client", actorUserId: "owner", now: new Date() });
    expect(findMany.mock.calls[0]![0].where).toMatchObject({ agentId: "a1", bug: { organisationId: "client" } });
    expect(updateMany.mock.calls[0]![0].where).toMatchObject({ agentId: "a1", bug: { organisationId: "client" } });
  });
});
