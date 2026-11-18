import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/agent-api/idea-verdicts", () => ({ convertClientVettedIdea: vi.fn() }));

import { convertClientVettedIdea } from "@/lib/agent-api/idea-verdicts";
import { PLACEHOLDER_DESCRIPTION, PLACEHOLDER_SUMMARY } from "@/lib/security-findings";
import { listFixProjects, sendCheckFindings } from "./fix";

const client = { userId: "u1", organisationId: "o1", superAdmin: false };
const selection = { checkId: "c1", projectId: "p1", resultIds: ["r1"] };

const tx = {
  $queryRaw: vi.fn(),
  $executeRaw: vi.fn(),
  project: { findFirst: vi.fn() },
  securityCheck: { update: vi.fn() },
  securityCheckResult: { findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  coinEntry: { aggregate: vi.fn(), createMany: vi.fn(), count: vi.fn().mockResolvedValue(1) },
  user: { findUnique: vi.fn().mockResolvedValue({ ziksLoanAt: null }) },
  idea: { create: vi.fn() },
  securityFinding: { create: vi.fn() },
};
/** The report's results (what is being sent), and the ones still locked among them (what is paid for). */
let resultRows: unknown[] = [];
let lockedRows: unknown[] = [];
const db = { $transaction: vi.fn((work: (client: typeof tx) => unknown) => work(tx)) };
const send = (input = selection) => sendCheckFindings(client, input, db as never);

beforeEach(() => {
  vi.clearAllMocks();
  tx.$queryRaw.mockResolvedValue([{ postedAt: new Date(), projectId: null }]);
  tx.$executeRaw.mockResolvedValue(1);
  tx.project.findFirst.mockResolvedValue({ slug: "web", organisation: { slug: "ziki" } });
  resultRows = [{ id: "r1", checkId: "c1", severity: "high", unlockedAt: new Date(), finding: null }];
  lockedRows = [];
  tx.securityCheckResult.findMany.mockImplementation(async (args: { where: { unlockedAt?: null } }) => (args.where.unlockedAt === null ? lockedRows : resultRows));
  tx.securityCheckResult.updateMany.mockResolvedValue({ count: 0 });
  // A wallet with plenty of Ziks, and a ledger that records what is written.
  tx.coinEntry.aggregate.mockResolvedValue({ _sum: { amount: 100 } });
  tx.coinEntry.createMany.mockImplementation(async ({ data }: { data: unknown[] }) => ({ count: data.length }));
  tx.idea.create.mockResolvedValue({ id: "i1" });
  tx.securityFinding.create.mockResolvedValue({ id: "f1" });
  vi.mocked(convertClientVettedIdea).mockResolvedValue({ issueNumber: 42 } as never);
});

describe("Fix on Ziki", () => {
  it("charges Ziks for only the newly unlocked results in a mixed selection", async () => {
    resultRows = [
      { id: "r1", checkId: "c1", severity: "high", unlockedAt: null, finding: null },
      { id: "r2", checkId: "c1", severity: "low", unlockedAt: new Date(), finding: null },
    ];
    lockedRows = [{ id: "r1", severity: "high", priceCoins: 7 }];
    tx.securityCheckResult.updateMany.mockResolvedValue({ count: 1 });

    await expect(send({ ...selection, resultIds: ["r1", "r2"] })).resolves.toMatchObject({
      ok: true, created: 2, coins: 7,
    });
    expect(tx.securityCheckResult.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["r1"] }, checkId: { in: ["c1"] }, unlockedAt: null },
      data: { unlockedAt: expect.any(Date) },
    });
    const rows = tx.coinEntry.createMany.mock.calls[0][0].data;
    expect(rows.map((r: { account: string; userId?: string; amount: number }) => [r.account, r.userId, r.amount])).toEqual([
      ["wallet", "u1", -7],
      ["revenue", undefined, 7],
    ]);
  });

  it("sends nothing and charges nothing when the wallet can't cover the findings", async () => {
    resultRows = [{ id: "r1", checkId: "c1", severity: "high", unlockedAt: null, finding: null }];
    lockedRows = [{ id: "r1", severity: "high", priceCoins: 7 }];
    tx.coinEntry.aggregate.mockResolvedValue({ _sum: { amount: 3 } });

    await expect(send()).resolves.toMatchObject({ ok: false, error: expect.stringContaining("Ziks") });
    expect(tx.securityCheckResult.updateMany).not.toHaveBeenCalled();
    expect(tx.coinEntry.createMany).not.toHaveBeenCalled();
    expect(tx.idea.create).not.toHaveBeenCalled();
  });

  it("offers projects for a posted report", async () => {
    const lookup = {
      securityCheck: { findFirst: vi.fn().mockResolvedValue({ postedAt: new Date(), projectId: null }) },
      project: { findMany: vi.fn().mockResolvedValue([{ id: "p1", name: "Web" }]) },
    };
    await expect(listFixProjects(client, "c1", lookup as never)).resolves.toEqual({
      projectId: null, projects: [{ id: "p1", name: "Web" }],
    });
    expect(lookup.securityCheck.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "c1", requestedById: "u1", organisationId: "o1" },
    }));
  });

  it("sends ready findings before the whole report is posted (16 Nov call)", async () => {
    tx.$queryRaw.mockResolvedValue([{ postedAt: null, projectId: null }]);
    await send();
    // Not refused for being unposted: it goes on to check the project, as for a posted report.
    expect(tx.project.findFirst).toHaveBeenCalled();
  });

  it("lists projects before the report is posted, so ready findings can be sent", async () => {
    const lookup = {
      securityCheck: { findFirst: vi.fn().mockResolvedValue({ postedAt: null, projectId: null }) },
      project: { findMany: vi.fn().mockResolvedValue([{ id: "p1", name: "Web" }]) },
    };
    await expect(listFixProjects(client, "c1", lookup as never)).resolves.toEqual({ projects: [{ id: "p1", name: "Web" }], projectId: null });
  });

  it("lists no projects for a check that isn't the requester's", async () => {
    const lookup = { securityCheck: { findFirst: vi.fn().mockResolvedValue(null) }, project: { findMany: vi.fn() } };
    await expect(listFixProjects(client, "c1", lookup as never)).resolves.toBeNull();
    expect(lookup.project.findMany).not.toHaveBeenCalled();
  });

  it("scopes the locked check to the requester and workspace", async () => {
    tx.$queryRaw.mockResolvedValue([]);
    await expect(send()).resolves.toMatchObject({ ok: false });
    const [sql, ...params] = tx.$queryRaw.mock.calls[0];
    expect(sql.join(" ")).toContain('AND "requestedById"');
    expect(sql.join(" ")).toContain("FOR NO KEY UPDATE");
    expect(params).toEqual(["c1", "o1", "u1"]);
    expect(tx.project.findFirst).not.toHaveBeenCalled();
  });

  it("rejects a destination outside the workspace or without access", async () => {
    tx.project.findFirst.mockResolvedValue(null);
    await expect(send()).resolves.toMatchObject({ ok: false });
    expect(tx.project.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: "p1", organisationId: "o1", archivedAt: null,
        organisation: { archivedAt: null, memberships: { some: { userId: "u1" } } },
      },
    }));
    expect(tx.idea.create).not.toHaveBeenCalled();
  });

  it("rejects a mixed batch with unrelated results before making any writes", async () => {
    await expect(send({ ...selection, resultIds: ["r1", "other-check-result"] })).resolves.toMatchObject({ ok: false });
    expect(tx.securityCheckResult.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: ["r1", "other-check-result"] }, OR: [{ checkId: "c1" }, { recheckItem: { checkId: "c1" }, NOT: { recheckState: "fixed" } }] },
    }));
    expect(tx.idea.create).not.toHaveBeenCalled();
    expect(tx.securityCheck.update).not.toHaveBeenCalled();
  });

  it("a rescan sends an earlier finding still there, paid with its own in one payment, copied from the scan that found it (18 Nov)", async () => {
    resultRows = [
      { id: "r1", checkId: "c1", severity: "high", unlockedAt: null, finding: null },
      { id: "old1", checkId: "c0", severity: "medium", unlockedAt: null, finding: null },
    ];
    lockedRows = [{ id: "r1", severity: "high", priceCoins: 7 }, { id: "old1", severity: "medium", priceCoins: 4 }];
    tx.securityCheckResult.updateMany.mockResolvedValue({ count: 2 });

    await expect(send({ ...selection, resultIds: ["r1", "old1"] })).resolves.toMatchObject({ ok: true, created: 2, coins: 11 });
    // One payment covering both scans.
    expect(tx.securityCheckResult.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.securityCheckResult.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["r1", "old1"] }, checkId: { in: ["c1", "c0"] }, unlockedAt: null },
      data: { unlockedAt: expect.any(Date) },
    });
    // Each finding's text is copied from the scan that found it.
    expect(tx.$executeRaw.mock.calls.map((call) => call.slice(1))).toEqual([["f1", "r1", "c1"], ["f1", "old1", "c0"]]);
  });

  it("keeps the first destination on subsequent submissions", async () => {
    tx.$queryRaw.mockResolvedValue([{ postedAt: new Date(), projectId: "p2" }]);
    await expect(send()).resolves.toMatchObject({ ok: false, error: expect.stringContaining("already has a destination") });
    expect(tx.idea.create).not.toHaveBeenCalled();
  });

  it("uses placeholders on the idea and reuses the result link on repeat submissions", async () => {
    await expect(send({ ...selection, resultIds: ["r1", "r1"] })).resolves.toEqual({
      ok: true, created: 1, reused: 0, coins: 0, issues: [{ resultId: "r1", number: 42, href: "/ziki/web/42" }],
    });
    expect(tx.idea.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        title: "Private security finding (High)", summary: PLACEHOLDER_SUMMARY, description: PLACEHOLDER_DESCRIPTION,
      }),
    }));
    expect(tx.$executeRaw.mock.calls[0].slice(1)).toEqual(["f1", "r1", "c1"]);
    expect(convertClientVettedIdea).toHaveBeenCalledWith(tx, { organisationId: "o1", projectId: "p1" }, "i1", "u1");
    expect(tx.securityCheckResult.update).toHaveBeenCalledWith({ where: { id: "r1" }, data: { findingId: "f1" } });
    expect(tx.securityCheck.update).toHaveBeenCalledWith({ where: { id: "c1" }, data: { projectId: "p1" } });

    tx.$queryRaw.mockResolvedValue([{ postedAt: new Date(), projectId: "p1" }]);
    resultRows = [{ id: "r1", checkId: "c1", severity: "high", unlockedAt: new Date(), finding: { bug: { number: 42 } } }];
    await expect(send()).resolves.toEqual({ ok: true, created: 0, reused: 1, coins: 0, issues: [{ resultId: "r1", number: 42, href: "/ziki/web/42" }] });
    expect(tx.idea.create).toHaveBeenCalledTimes(1);
    expect(tx.securityFinding.create).toHaveBeenCalledTimes(1);
    expect(convertClientVettedIdea).toHaveBeenCalledTimes(1);
  });

  it("propagates conversion failure so the transaction rolls back", async () => {
    vi.mocked(convertClientVettedIdea).mockRejectedValueOnce(new Error("Conversion failed"));
    await expect(send()).rejects.toThrow("Conversion failed");
    expect(tx.securityCheckResult.update).not.toHaveBeenCalled();
    expect(tx.securityCheck.update).not.toHaveBeenCalled();
  });
});
