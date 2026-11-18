import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

const prismaMock = vi.hoisted(() => {
  const mock = {
    securityTarget: { findUnique: vi.fn(), create: vi.fn() },
    securityCheck: { findFirst: vi.fn(), create: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    securityCheckResult: { findMany: vi.fn(), updateMany: vi.fn() },
    coinEntry: { aggregate: vi.fn(), createMany: vi.fn(), count: vi.fn().mockResolvedValue(1) },
    user: { findUnique: vi.fn().mockResolvedValue({ ziksLoanAt: null }) },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  mock.$transaction.mockImplementation((run: (tx: typeof mock) => unknown) => run(mock));
  return mock;
});
vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

import { addTargetAndCheck, agentReportOf, listWorkspaceChecks, newOwnershipToken, nextStepPath, parseSiteFilter, refusedMessage, scanStage, siteStage } from "./entry";
import { findingPrice, unlockFindings } from "./payment";

const site = { kind: "website" as const, value: "settle.ng", input: "https://settle.ng" };

beforeEach(() => {
  vi.clearAllMocks();
  // A wallet with plenty of Ziks, and a ledger that records what is written.
  prismaMock.coinEntry.aggregate.mockResolvedValue({ _sum: { amount: 100 } });
  prismaMock.coinEntry.createMany.mockImplementation(async ({ data }: { data: unknown[] }) => ({ count: data.length }));
  // Free scans left unless a test says otherwise.
  prismaMock.securityCheck.count.mockResolvedValue(0);
});

describe("addTargetAndCheck (#security-checks part 1)", () => {
  it("stores a new target with a fresh token and queues its check at once, with the proof step off", async () => {
    prismaMock.securityTarget.findUnique.mockResolvedValue(null);
    prismaMock.securityTarget.create.mockResolvedValue({ id: "t1", verifiedAt: null });
    prismaMock.securityCheck.findFirst.mockResolvedValue(null);
    prismaMock.securityCheck.create.mockResolvedValue({ id: "c1" });

    const added = await addTargetAndCheck("org1", "u1", site);

    expect(added).toEqual({ targetId: "t1", checkId: "c1", verified: false, reused: false });
    const created = prismaMock.securityTarget.create.mock.calls[0][0].data;
    expect(created).toMatchObject({ organisationId: "org1", kind: "website", value: "settle.ng", input: "https://settle.ng", addedById: "u1" });
    expect(created.ownershipToken).toMatch(/^ziki-verify-[0-9a-f]{32}$/);
    expect(prismaMock.securityCheck.create.mock.calls[0][0].data).toEqual({
      organisationId: "org1", targetId: "t1", requestedById: "u1", free: true, priceCoins: 50, status: "queued",
    });
  });

  it("waits for ownership only while the proof step is switched on", async () => {
    vi.stubEnv("SECURITY_OWNERSHIP_PROOF_REQUIRED", "true");
    prismaMock.securityTarget.findUnique.mockResolvedValue(null);
    prismaMock.securityTarget.create.mockResolvedValue({ id: "t1", verifiedAt: null });
    prismaMock.securityCheck.findFirst.mockResolvedValue(null);
    prismaMock.securityCheck.create.mockResolvedValue({ id: "c1" });

    await addTargetAndCheck("org1", "u1", site);

    expect(prismaMock.securityCheck.create.mock.calls[0][0].data.status).toBe("awaiting_ownership");
    vi.unstubAllEnvs();
  });

  it("reuses the workspace's target, and a proven target skips straight to queued", async () => {
    prismaMock.securityTarget.findUnique.mockResolvedValue({ id: "t1", verifiedAt: new Date() });
    prismaMock.securityCheck.findFirst.mockResolvedValue(null);
    prismaMock.securityCheck.create.mockResolvedValue({ id: "c2" });

    const added = await addTargetAndCheck("org1", "u1", site);

    expect(prismaMock.securityTarget.create).not.toHaveBeenCalled();
    expect(prismaMock.securityCheck.create.mock.calls[0][0].data.status).toBe("queued");
    expect(added).toMatchObject({ checkId: "c2", verified: true, reused: false });
  });

  it("reuses the person's own unfinished check instead of opening a second one", async () => {
    prismaMock.securityTarget.findUnique.mockResolvedValue({ id: "t1", verifiedAt: null });
    prismaMock.securityCheck.findFirst.mockResolvedValue({ id: "c-open" });

    const added = await addTargetAndCheck("org1", "u1", site);

    expect(added).toEqual({ targetId: "t1", checkId: "c-open", verified: false, reused: true });
    expect(prismaMock.securityCheck.create).not.toHaveBeenCalled();
    expect(prismaMock.securityCheck.findFirst.mock.calls[0][0].where).toMatchObject({
      targetId: "t1", organisationId: "org1", requestedById: "u1", status: { notIn: expect.arrayContaining(["done", "cancelled"]) },
    });
  });

  it("uses the winner when two people add the same target at once", async () => {
    prismaMock.securityTarget.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "t-won", verifiedAt: null });
    prismaMock.securityTarget.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "test" }),
    );
    prismaMock.securityCheck.findFirst.mockResolvedValue(null);
    prismaMock.securityCheck.create.mockResolvedValue({ id: "c3" });

    const added = await addTargetAndCheck("org1", "u1", site);
    expect(added.targetId).toBe("t-won");
  });

  it("makes a different token every time", () => {
    expect(newOwnershipToken()).not.toBe(newOwnershipToken());
  });
});

describe("free-scan limits (plan C1)", () => {
  // The limits are off by default (14 Nov plan); these tests are about the limits themselves.
  beforeEach(() => {
    vi.stubEnv("SECURITY_SCAN_LIMITS_ENABLED", "true");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("opens no check once the site has had its free scan, and says so", async () => {
    prismaMock.securityTarget.findUnique.mockResolvedValue({ id: "t1", verifiedAt: new Date() });
    prismaMock.securityCheck.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "c-old" });
    prismaMock.securityCheck.count.mockResolvedValueOnce(1).mockResolvedValueOnce(1);

    const added = await addTargetAndCheck("org1", "u1", site);

    expect(added).toEqual({ refused: "target_used", targetId: "t1", lastCheckId: "c-old" });
    expect(prismaMock.securityCheck.create).not.toHaveBeenCalled();
    expect(refusedMessage("target_used", "settle.ng")).toBe("settle.ng has already been scanned. Open its report to unlock fixes.");
  });

  it("stops at the workspace's monthly free scans, counted from the 1st of the month", async () => {
    prismaMock.securityTarget.findUnique.mockResolvedValue({ id: "t2", verifiedAt: null });
    prismaMock.securityCheck.findFirst.mockResolvedValue(null);
    prismaMock.securityCheck.count.mockResolvedValueOnce(0).mockResolvedValueOnce(3);
    const now = new Date("2026-11-12T10:00:00Z");

    const added = await addTargetAndCheck("org1", "u1", site, now);

    expect(added).toMatchObject({ refused: "workspace_limit" });
    expect(prismaMock.securityCheck.count.mock.calls[1][0].where).toEqual({
      organisationId: "org1", free: true, createdAt: { gte: new Date("2026-11-01T00:00:00Z") },
    });
    expect(refusedMessage("workspace_limit", "settle.ng", now)).toBe("You've used this month's 3 scans. More start on 1 December.");
  });
});

describe("nextStepPath", () => {
  it("goes back to the Security page for every new check while the proof step is off", () => {
    expect(nextStepPath({ targetId: "t1", checkId: "c1", verified: false })).toBe("/security?check=c1");
    expect(nextStepPath({ targetId: "t1", checkId: "c1", verified: true })).toBe("/security?check=c1");
  });

  it("sends an unproven target to show it's yours only while the proof step is on", () => {
    vi.stubEnv("SECURITY_OWNERSHIP_PROOF_REQUIRED", "true");
    expect(nextStepPath({ targetId: "t1", checkId: "c1", verified: false })).toBe("/security/targets/t1/verify");
    vi.unstubAllEnvs();
  });
});

describe("agentReportOf (a posted scan's card)", () => {
  it("lists findings worst first, then by id, and says which are unlocked or moved", () => {
    const report = agentReportOf("Two things.", [
      { id: "b", severity: "low", title: "Low one", unlockedAt: null, findingId: null },
      { id: "d", severity: "high", title: "High two", unlockedAt: new Date(), findingId: "f1" },
      { id: "c", severity: "high", title: "High one", unlockedAt: null, findingId: null },
    ]);
    expect(report.summary).toBe("Two things.");
    expect(report.findings).toEqual([
      { id: "c", severity: "high", title: "High one", unlocked: false, moved: false },
      { id: "d", severity: "high", title: "High two", unlocked: true, moved: true },
      { id: "b", severity: "low", title: "Low one", unlocked: false, moved: false },
    ]);
  });
});

describe("listWorkspaceChecks", () => {
  it("lists only the checks this person asked for, newest first, with how many findings are unlocked", async () => {
    const createdAt = new Date("2026-11-11T10:00:00Z");
    prismaMock.securityCheck.findMany.mockResolvedValue([
      { id: "c1", status: "queued", postedAt: null, createdAt, target: { id: "t1", kind: "website", value: "settle.ng", verifiedAt: null, previewSummary: null }, results: [] },
      { id: "c2", status: "done", postedAt: createdAt, createdAt, summary: "Two things.", target: { id: "t2", kind: "repo", value: "settle/app", verifiedAt: createdAt, previewSummary: null }, results: [{ id: "r1", severity: "high", title: "Secret in a file", unlockedAt: createdAt, findingId: "i1" }, { id: "r2", severity: "low", title: "No policy", unlockedAt: null, findingId: null }] },
    ]);

    const rows = await listWorkspaceChecks("org1", "u1");

    const query = prismaMock.securityCheck.findMany.mock.calls[0][0];
    // A scan that was scanned again (#security-rescan) leaves the list, so each site shows once, as its newest scan.
    expect(query.where).toEqual({ organisationId: "org1", requestedById: "u1", nextCheck: { is: null } });
    expect(query.orderBy).toEqual({ createdAt: "desc" });
    // A finding's id, severity, title and whether it is unlocked or moved (what the report page already shows its owner): never its description or how to fix it.
    expect(query.select.results).toEqual({ select: { id: true, severity: true, title: true, unlockedAt: true, findingId: true } });
    expect(rows.map((r) => [r.id, r.verified, r.posted, r.findings, r.unlocked, r.moved, r.preview])).toEqual([
      ["c1", false, false, 0, 0, 0, null],
      ["c2", true, true, 2, 1, 1, null],
    ]);
    expect(rows.map(scanStage)).toEqual(["scanning", "in_app"]);
    // The agents' result only exists once the report is posted.
    expect(rows[0]!.agentReport).toBeNull();
    expect(rows[1]!.agentReport).toMatchObject({ summary: "Two things.", findings: [{ id: "r1", title: "Secret in a file", unlocked: true, moved: true }, { id: "r2", unlocked: false, moved: false }] });
  });
});

describe("unlocking fixes per finding (plan C1, paid in Ziks)", () => {
  const posted = { postedAt: new Date("2026-11-12T09:00:00Z") };

  it("unlocks every locked finding and totals its price by severity", async () => {
    prismaMock.securityCheck.findFirst.mockResolvedValue(posted);
    prismaMock.securityCheckResult.findMany.mockResolvedValue([
      { id: "r1", severity: "critical", priceCoins: 5 },
      { id: "r2", severity: "low", priceCoins: null },
    ]);
    prismaMock.securityCheckResult.updateMany.mockResolvedValue({ count: 2 });
    const now = new Date("2026-11-12T12:00:00Z");

    expect(await unlockFindings("c1", "org1", "u1", "all", now)).toEqual({ ok: true, unlocked: 2, coins: 6 });
    expect(prismaMock.securityCheck.findFirst.mock.calls[0][0].where).toEqual({ id: "c1", organisationId: "org1", requestedById: "u1" });
    expect(prismaMock.securityCheckResult.findMany.mock.calls[0][0].where).toEqual({ checkId: "c1", unlockedAt: null });
    expect(prismaMock.securityCheckResult.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["r1", "r2"] }, checkId: "c1", unlockedAt: null },
      data: { unlockedAt: now },
    });
  });

  it("takes the Ziks from the wallet for what it unlocks, and for nothing else", async () => {
    prismaMock.securityCheck.findFirst.mockResolvedValue(posted);
    prismaMock.securityCheckResult.findMany.mockResolvedValue([
      { id: "r1", severity: "critical", priceCoins: 5 },
      { id: "r2", severity: "low", priceCoins: 1 },
    ]);
    prismaMock.securityCheckResult.updateMany.mockResolvedValue({ count: 2 });

    await unlockFindings("c1", "org1", "u1", "all");

    const rows = prismaMock.coinEntry.createMany.mock.calls[0][0].data;
    expect(rows.map((r: { account: string; amount: number; sourceKey: string }) => [r.account, r.amount, r.sourceKey])).toEqual([
      ["wallet", -5, "check:r1:wallet"],
      ["revenue", 5, "check:r1:revenue"],
      ["wallet", -1, "check:r2:wallet"],
      ["revenue", 1, "check:r2:revenue"],
    ]);
  });

  it("unlocks nothing and charges nothing when the wallet can't cover it", async () => {
    prismaMock.securityCheck.findFirst.mockResolvedValue(posted);
    prismaMock.securityCheckResult.findMany.mockResolvedValue([{ id: "r1", severity: "critical", priceCoins: 5 }]);
    prismaMock.coinEntry.aggregate.mockResolvedValue({ _sum: { amount: 3 } });

    // Has bought Ziks before (the default here), so no loan is offered.
    expect(await unlockFindings("c1", "org1", "u1", "all")).toEqual({ ok: false, reason: "insufficient_ziks", needed: 5, balance: 3, canBorrow: false });
    expect(prismaMock.securityCheckResult.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.coinEntry.createMany).not.toHaveBeenCalled();
  });

  it("unlocks only the chosen findings", async () => {
    prismaMock.securityCheck.findFirst.mockResolvedValue(posted);
    prismaMock.securityCheckResult.findMany.mockResolvedValue([{ id: "r2", severity: "high", priceCoins: 3 }]);
    prismaMock.securityCheckResult.updateMany.mockResolvedValue({ count: 1 });

    expect(await unlockFindings("c1", "org1", "u1", ["r2"])).toEqual({ ok: true, unlocked: 1, coins: 3 });
    expect(prismaMock.securityCheckResult.findMany.mock.calls[0][0].where).toEqual({ checkId: "c1", unlockedAt: null, id: { in: ["r2"] } });
  });

  it("refuses someone else's check and findings already unlocked; an unposted check is fine (16 Nov call)", async () => {
    prismaMock.securityCheck.findFirst.mockResolvedValueOnce(null);
    expect(await unlockFindings("c1", "org1", "u1", "all")).toEqual({ ok: false, reason: "not_found" });
    prismaMock.securityCheck.findFirst.mockResolvedValueOnce(posted);
    prismaMock.securityCheckResult.findMany.mockResolvedValueOnce([]);
    expect(await unlockFindings("c1", "org1", "u1", "all")).toEqual({ ok: false, reason: "nothing_to_unlock" });
    expect(prismaMock.securityCheckResult.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.coinEntry.createMany).not.toHaveBeenCalled();
  });

  it("prices a finding by its stored price, or its severity's for older ones", () => {
    expect(findingPrice({ severity: "critical", priceCoins: null })).toBe(5);
    expect(findingPrice({ severity: "medium", priceCoins: null })).toBe(2);
    expect(findingPrice({ severity: "high", priceCoins: 3 })).toBe(3);
  });
});

describe("siteStage and parseSiteFilter (Your sites sidebar)", () => {
  it("puts each site in one place", () => {
    expect(siteStage({ status: "awaiting_ownership", verified: false, posted: false })).toBe("prove");
    expect(siteStage({ status: "checking", verified: true, posted: false })).toBe("checking");
    expect(siteStage({ status: "done", verified: true, posted: true })).toBe("fix");
    expect(siteStage({ status: "cancelled", verified: true, posted: false })).toBe("cancelled");
  });

  it("falls back to all for anything unknown", () => {
    expect(parseSiteFilter("fix")).toBe("fix");
    expect(parseSiteFilter("nope")).toBe("all");
    expect(parseSiteFilter(undefined)).toBe("all");
  });
});
