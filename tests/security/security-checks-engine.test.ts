import { beforeEach, describe, expect, it, vi } from "vitest";

const award = vi.fn();
vi.mock("@/lib/points/award", () => ({ award: (...args: unknown[]) => award(...args) }));
// The real network is never touched in tests; the AI is passed in as a fake.
vi.mock("@/lib/security-checks/ownership", () => ({ realNetwork: { get: vi.fn() } }));

import { pickAgentFor } from "@/lib/security-checks/assign";
import { defaultParts, defaultSummary, planParts, writeSummary, type SecurityAi } from "@/lib/security-checks/ai";
import {
  JOB_TIMEOUT_MINUTES,
  SecurityJobError,
  assignWaitingJobs,
  listAgentJobs,
  findingSourceKey,
  payUnlockedFindings,
  postReportIfComplete,
  reclaimStaleJobs,
  startCheck,
  startWaitingChecks,
  submitReport,
  sweepSecurityChecks,
} from "@/lib/security-checks/engine";

/** A fake Prisma client: every model method is a mock, and $transaction runs the callback on the same fake. */
function fakeDb() {
  const db = {
    securityCheck: { findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
    securityCheckItem: { findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn(), create: vi.fn(), createMany: vi.fn(), count: vi.fn() },
    // A part holds no earlier findings to recheck unless a test says so.
    securityCheckResult: { createMany: vi.fn(), findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn(), update: vi.fn() },
    agent: { findMany: vi.fn() },
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation((fn: (tx: typeof db) => unknown) => fn(db));
  return db;
}
type FakeDb = ReturnType<typeof fakeDb>;
const asDb = (db: FakeDb) => db as never;

const now = new Date("2026-11-12T10:00:00Z");
const verified = { verifiedAt: new Date("2026-11-12T09:00:00Z") };

/** A fake Ziki AI that records what it was given and answers with `answer`. */
function fakeAi(answer: unknown) {
  const calls: { system: string; user: string }[] = [];
  const ai: SecurityAi = {
    async parse({ system, user }) {
      calls.push({ system, user });
      if (answer instanceof Error) throw answer;
      return answer as never;
    },
  };
  return { ai, calls };
}

function heldItem(overrides: Record<string, unknown> = {}) {
  return { id: "item1", kind: "check", status: "checking", agentId: "agentA", checkId: "check1", check: { status: "checking", target: verified }, ...overrides };
}

beforeEach(() => {
  award.mockReset();
  award.mockResolvedValue(true);
});

describe("who gets a part (#security-checks)", () => {
  const agents = [
    { id: "home", onCall: false, organisationIds: ["client"], openJobs: 0 },
    { id: "oncall-busy", onCall: true, organisationIds: [], openJobs: 1 },
    { id: "oncall", onCall: true, organisationIds: [], openJobs: 0 },
  ];

  it("gives on-call agents priority, then the client's own, then the least busy", () => {
    expect(pickAgentFor("client", agents, 2)?.id).toBe("oncall");
    expect(pickAgentFor("client", agents.filter((a) => !a.onCall), 2)?.id).toBe("home");
  });

  it("never exceeds an agent's open-part limit", () => {
    expect(pickAgentFor("client", [{ id: "full", onCall: true, organisationIds: ["client"], openJobs: 2 }], 2)).toBeNull();
  });

  it("only offers parts to cleared, unpaused agents seen recently", async () => {
    const db = fakeDb();
    db.agent.findMany.mockResolvedValue([]);
    expect(await assignWaitingJobs(asDb(db), now, "agentA")).toBe(0);
    const where = db.agent.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ owner: { securityClearedAt: { not: null } }, revokedAt: null, pausedAt: null });
    expect(where.apiKeys.some.lastUsedAt.gte).toEqual(new Date(now.getTime() - 15 * 60 * 1000));
  });

  it("only considers the agent that asked", async () => {
    const db = fakeDb();
    db.agent.findMany.mockResolvedValue([]);
    await assignWaitingJobs(asDb(db), now, "agentA");
    expect(db.agent.findMany.mock.calls[0][0].where.id).toBe("agentA");
  });

  it("never hands parts out in the sweep, so an agent that doesn't ask for security work can't hold one (16 Nov call)", async () => {
    const db = fakeDb();
    db.securityCheck.findMany.mockResolvedValue([]);
    db.securityCheck.updateMany.mockResolvedValue({ count: 0 });
    db.securityCheckItem.findMany.mockResolvedValue([]);
    db.securityCheckItem.updateMany.mockResolvedValue({ count: 0 });
    db.securityCheckResult.findMany.mockResolvedValue([]);
    db.securityCheckResult.updateMany.mockResolvedValue({ count: 0 });
    db.agent.findMany.mockResolvedValue([{ id: "agentA", owner: { onCallAt: now }, activations: [], _count: { securityCheckItems: 0 } }]);
    const result = await sweepSecurityChecks(asDb(db), now, { ai: null });
    expect(result).not.toHaveProperty("assigned");
    expect(db.agent.findMany).not.toHaveBeenCalled();
    for (const [args] of db.securityCheckItem.updateMany.mock.calls) expect(args.data.status).not.toBe("checking");
  });

  it("gives a waiting part only while it is still free", async () => {
    const db = fakeDb();
    db.agent.findMany.mockResolvedValue([{ id: "agentA", owner: { onCallAt: now }, activations: [], _count: { securityCheckItems: 0 } }]);
    db.securityCheckItem.findMany.mockResolvedValue([
      { id: "j1", check: { organisationId: "client" } },
      { id: "j2", check: { organisationId: "client" } },
    ]);
    db.securityCheckItem.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    expect(await assignWaitingJobs(asDb(db), now, "agentA")).toBe(1);
    expect(db.securityCheckItem.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: "j1", status: "waiting", agentId: null },
      data: { status: "checking", agentId: "agentA", assignedAt: now },
    });
  });

  it("gives agents only parts younger than the fallback time, so a failing agent can't keep old parts from Ziki's own agent", async () => {
    vi.stubEnv("ZIKI_CLAUDE_API_KEY", "key");
    vi.stubEnv("SECURITY_FALLBACK_AFTER_MINUTES", "5");
    try {
      const db = fakeDb();
      db.agent.findMany.mockResolvedValue([{ id: "agentA", owner: { onCallAt: now }, activations: [], _count: { securityCheckItems: 0 } }]);
      db.securityCheckItem.findMany.mockResolvedValue([]);
      await assignWaitingJobs(asDb(db), now, "agentA");
      const where = db.securityCheckItem.findMany.mock.calls[0][0].where;
      expect(where.createdAt).toEqual({ gte: new Date(now.getTime() - 5 * 60_000) });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("gives agents any waiting part when the fallback can't run (no AI key, or turned off)", async () => {
    for (const env of [{ ZIKI_CLAUDE_API_KEY: "", SECURITY_FALLBACK_AFTER_MINUTES: "5" }, { ZIKI_CLAUDE_API_KEY: "key", SECURITY_FALLBACK_AFTER_MINUTES: "0" }]) {
      for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
      try {
        const db = fakeDb();
        db.agent.findMany.mockResolvedValue([{ id: "agentA", owner: { onCallAt: now }, activations: [], _count: { securityCheckItems: 0 } }]);
        db.securityCheckItem.findMany.mockResolvedValue([]);
        await assignWaitingJobs(asDb(db), now, "agentA");
        expect(db.securityCheckItem.findMany.mock.calls[0][0].where).not.toHaveProperty("createdAt");
      } finally {
        vi.unstubAllEnvs();
      }
    }
  });
});

describe("starting a check: Ziki's AI splits it", () => {
  it("claims the proven check, saves the AI's parts and moves it to checking", async () => {
    const db = fakeDb();
    db.securityCheck.updateMany.mockResolvedValue({ count: 1 });
    db.securityCheck.findUnique.mockResolvedValue({ target: { kind: "website", value: "settle.ng" } });
    db.agent.findMany.mockResolvedValue([]);
    const parts = Array.from({ length: 8 }, (_, i) => ({ title: `Part ${i + 1}`, instructions: "Look at it." }));
    const { ai } = fakeAi({ parts });
    expect(await startCheck(asDb(db), "check1", now, { ai, readPage: null })).toBe(true);
    // Proof is off, so the start asks nothing of the target (with it on, it also asks for verifiedAt).
    expect(db.securityCheck.updateMany.mock.calls[0][0].where).toMatchObject({ id: "check1" });
    expect(db.securityCheck.updateMany.mock.calls[0][0].where).not.toHaveProperty("target");
    expect(db.securityCheckItem.createMany.mock.calls[0][0].data).toHaveLength(8);
    expect(db.securityCheckItem.createMany.mock.calls[0][0].data[0]).toMatchObject({ checkId: "check1", kind: "check", title: "Part 1" });
  });

  it("a rescan starts from the last report: one recheck part per area holding its open earlier findings, and new parts planned past them (#security-rescan)", async () => {
    const db = fakeDb();
    db.securityCheck.updateMany.mockResolvedValue({ count: 1 });
    db.securityCheck.findUnique.mockResolvedValue({
      previousCheckId: "check0",
      organisationId: "org1",
      requestedById: "owner",
      targetId: "t1",
      target: { kind: "website", value: "settle.ng" },
    });
    db.securityCheckResult.findMany.mockResolvedValue([
      { id: "r1", title: "Admin page open", item: { title: "Admin pages" } },
      { id: "r2", title: "Debug page open", item: { title: "Admin pages" } },
      { id: "r3", title: "Session cookie not Secure", item: { title: "Cookies" } },
      // Sent to fix and still being fixed (18 Nov): not rechecked while its issue is worked on.
      { id: "r4", title: "Search built from input", item: { title: "Admin pages" }, finding: { bug: { status: "in_progress", isDeleted: false }, idea: null } },
      // Its issue is resolved: rechecked, which confirms the fix.
      { id: "r5", title: "Cookie readable by scripts", item: { title: "Cookies" }, finding: { bug: { status: "resolved", isDeleted: false }, idea: null } },
    ]);
    db.securityCheckItem.create.mockResolvedValueOnce({ id: "recheck-admin" }).mockResolvedValueOnce({ id: "recheck-cookies" });
    const parts = Array.from({ length: 8 }, (_, i) => ({ title: `Part ${i + 1}`, instructions: "Look at it." }));
    const { ai, calls } = fakeAi({ parts });

    expect(await startCheck(asDb(db), "rescan1", now, { ai, readPage: null })).toBe(true);

    // Only this person's earlier findings on the site that no rescan called fixed, never this check's own.
    const where = db.securityCheckResult.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ checkId: { not: "rescan1" }, check: { organisationId: "org1", requestedById: "owner", targetId: "t1" } });
    expect(where.OR).toEqual([{ recheckState: null }, { recheckState: "still_there" }]);
    expect(db.securityCheckItem.create.mock.calls.map(([call]) => call.data.title)).toEqual(["Recheck: Admin pages", "Recheck: Cookies"]);
    expect(db.securityCheckResult.updateMany.mock.calls.map(([call]) => [call.where.id.in, call.data.recheckItemId])).toEqual([
      [["r1", "r2"], "recheck-admin"],
      [["r3", "r5"], "recheck-cookies"],
    ]);
    // The new parts are still planned, and Ziki's AI is told what is already being rechecked.
    expect(db.securityCheckItem.createMany.mock.calls[0][0].data).toHaveLength(8);
    expect(calls[0]!.user).toContain("Admin page open");
    expect(calls[0]!.user).not.toContain("Search built from input");
  });

  it("puts a check whose split failed back to waiting at once, so the next sweep starts it, instead of leaving it stuck for ten minutes", async () => {
    const db = fakeDb();
    db.securityCheck.updateMany.mockResolvedValue({ count: 1 });
    db.securityCheck.findUnique.mockResolvedValue({ target: { kind: "website", value: "settle.ng" } });
    db.securityCheckItem.createMany.mockRejectedValue(new Error("database hiccup"));
    const parts = Array.from({ length: 8 }, (_, i) => ({ title: `Part ${i + 1}`, instructions: "Look at it." }));

    await expect(startCheck(asDb(db), "check1", now, { ai: fakeAi({ parts }).ai, readPage: null })).rejects.toThrow("database hiccup");

    // The last update is the give-back: still ours (splitting since this start), no parts saved, back to queued.
    const giveBack = db.securityCheck.updateMany.mock.calls.at(-1)![0];
    expect(giveBack.where).toMatchObject({ id: "check1", status: "splitting", startedAt: now, items: { none: { kind: "check" } } });
    expect(giveBack.data).toEqual({ status: "queued", startedAt: null });
  });

  it("starts a check still marked as waiting for proof while proof is off, and not when it is required", async () => {
    for (const [required, statuses] of [[false, ["queued", "awaiting_ownership"]], [true, ["queued"]]] as const) {
      vi.stubEnv("SECURITY_OWNERSHIP_PROOF_REQUIRED", required ? "true" : "false");
      const db = fakeDb();
      db.securityCheck.updateMany.mockResolvedValue({ count: 0 });
      await startCheck(asDb(db), "check1", now, { ai: fakeAi({ parts: [] }).ai, readPage: null });
      expect(db.securityCheck.updateMany.mock.calls[0][0].where.OR[0]).toEqual({ status: { in: statuses } });
      db.securityCheck.findMany.mockResolvedValue([]);
      await startWaitingChecks(asDb(db), now);
      expect(db.securityCheck.findMany.mock.calls[0][0].where.OR[0]).toEqual({ status: { in: statuses } });
      vi.unstubAllEnvs();
    }
  });

  it("does nothing when another run already claimed it, or it isn't proven", async () => {
    const db = fakeDb();
    db.securityCheck.updateMany.mockResolvedValue({ count: 0 });
    const { ai, calls } = fakeAi({ parts: [] });
    expect(await startCheck(asDb(db), "check1", now, { ai, readPage: null })).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("falls back to the fixed parts when the AI fails, never back to queued", async () => {
    const result = await planParts({ kind: "website", value: "settle.ng" }, { ai: fakeAi(new Error("down")).ai, readPage: null });
    expect(result.source).toBe("default");
    expect(result.parts).toEqual(defaultParts("website", "settle.ng"));
    expect((await planParts({ kind: "repo", value: "a/b" }, { ai: null })).source).toBe("default");
    // Too few parts from the AI also falls back.
    expect((await planParts({ kind: "server", value: "1.2.3.4" }, { ai: fakeAi({ parts: [{ title: "Only one", instructions: "x" }] }).ai })).source).toBe("default");
  });
});

describe("reporting a part", () => {
  const found = [{ severity: "high" as const, title: "Admin page open", description: "The /admin page loads with no login.", howToFix: "Require a signed-in admin for /admin." }];

  it("stores the results priced by severity", async () => {
    const db = fakeDb();
    db.securityCheckItem.findUnique.mockResolvedValue(heldItem());
    db.securityCheckItem.updateMany.mockResolvedValue({ count: 1 });
    expect(await submitReport(asDb(db), "agentA", "item1", found, now)).toEqual({ checkId: "check1", results: 1, rechecked: 0, addedParts: 0 });
    expect(db.securityCheckResult.createMany.mock.calls[0][0].data[0]).toMatchObject({ checkId: "check1", itemId: "item1", severity: "high", priceCoins: 3 });
  });

  it("saves the extra parts an agent asks for with its report: new titles only, a few per report, none past the check's ceiling", async () => {
    const asked = [
      { title: "Admin path /wp-admin", instructions: "Seen linked from the footer: check what it shows signed out." },
      { title: "login form: rate limits", instructions: "Already a part of this check, so this one is dropped." },
      { title: "Public API docs page", instructions: "Found at /docs: look for internal endpoints listed." },
      { title: "Old staging subdomain", instructions: "staging.example.com answers: check what it exposes." },
      { title: "One too many", instructions: "Past the three allowed per report, so it is not saved." },
    ];
    const db = fakeDb();
    db.securityCheckItem.findUnique.mockResolvedValue(heldItem());
    db.securityCheckItem.updateMany.mockResolvedValue({ count: 1 });
    db.securityCheckItem.findMany.mockResolvedValue([{ title: "Login form: rate limits" }, { title: "Cookies" }]);

    const out = await submitReport(asDb(db), "agentA", "item1", found, now, asked);

    expect(out).toEqual({ checkId: "check1", results: 1, rechecked: 0, addedParts: 3 });
    const saved = db.securityCheckItem.createMany.mock.calls[0][0].data;
    expect(saved.map((part: { title: string }) => part.title)).toEqual(["Admin path /wp-admin", "Public API docs page", "Old staging subdomain"]);
    expect(saved[0]).toMatchObject({ checkId: "check1", kind: "check" });

    // A check already at its ceiling takes none.
    const full = fakeDb();
    full.securityCheckItem.findUnique.mockResolvedValue(heldItem());
    full.securityCheckItem.updateMany.mockResolvedValue({ count: 1 });
    full.securityCheckItem.findMany.mockResolvedValue(Array.from({ length: 40 }, (_, i) => ({ title: "Part " + i })));
    expect((await submitReport(asDb(full), "agentA", "item1", [], now, asked)).addedParts).toBe(0);
    expect(full.securityCheckItem.createMany).not.toHaveBeenCalled();
  });

  it("a rescan's recheck part answers for its earlier findings: fixed only when said, one left out stays still there, a stranger's id is refused (#security-rescan)", async () => {
    const db = fakeDb();
    db.securityCheckItem.findUnique.mockResolvedValue(heldItem({ checkId: "rescan1" }));
    db.securityCheckItem.updateMany.mockResolvedValue({ count: 1 });
    db.securityCheckResult.findMany.mockResolvedValue([{ id: "r1" }, { id: "r2" }]);

    const out = await submitReport(asDb(db), "agentA", "item1", [], now, [], [{ id: "r1", state: "fixed", note: "/admin now asks for a login." }]);

    expect(out).toMatchObject({ checkId: "rescan1", results: 0, rechecked: 2 });
    const saved = new Map(db.securityCheckResult.update.mock.calls.map(([call]) => [call.where.id, call.data]));
    expect(saved.get("r1")).toMatchObject({ recheckState: "fixed", recheckNote: "/admin now asks for a login.", recheckCheckId: "rescan1", recheckedAt: now });
    expect(saved.get("r2")).toMatchObject({ recheckState: "still_there", recheckCheckId: "rescan1" });

    const stray = fakeDb();
    stray.securityCheckItem.findUnique.mockResolvedValue(heldItem());
    stray.securityCheckResult.findMany.mockResolvedValue([{ id: "r1" }]);
    await expect(submitReport(asDb(stray), "agentA", "item1", [], now, [], [{ id: "someone-elses", state: "fixed" }])).rejects.toMatchObject({ status: 400 });
    expect(stray.securityCheckResult.update).not.toHaveBeenCalled();

    // A recheck part takes no new results (18 Nov): re-filing the earlier findings listed every problem twice.
    const refiled = fakeDb();
    refiled.securityCheckItem.findUnique.mockResolvedValue(heldItem({ checkId: "rescan1" }));
    refiled.securityCheckItem.updateMany.mockResolvedValue({ count: 1 });
    refiled.securityCheckResult.findMany.mockResolvedValue([{ id: "r1" }]);
    const copy = [{ severity: "medium" as const, title: "No Content Security Policy", description: "Same as before.", howToFix: "Add one." }];
    await expect(submitReport(asDb(refiled), "agentA", "item1", copy, now, [], [{ id: "r1", state: "still_there" }])).rejects.toMatchObject({ status: 400, code: "recheck_only" });
    expect(refiled.securityCheckResult.createMany).not.toHaveBeenCalled();
    expect(refiled.securityCheckItem.updateMany).not.toHaveBeenCalled();
  });

  it("adds no parts when the part is no longer the agent's (a late report adds nothing)", async () => {
    const db = fakeDb();
    db.securityCheckItem.findUnique.mockResolvedValue(heldItem({ status: "waiting" }));
    await expect(
      submitReport(asDb(db), "agentA", "item1", found, now, [{ title: "Extra part", instructions: "Look at the extra path I saw." }]),
    ).rejects.toMatchObject({ status: 409 });
    expect(db.securityCheckItem.createMany).not.toHaveBeenCalled();
  });

  it("shows an agent what the quick scan already saw on the site with each part, titles only", async () => {
    const db = fakeDb();
    db.agent.findMany.mockResolvedValue([]);
    db.securityCheckItem.findMany.mockResolvedValue([
      {
        id: "item1",
        title: "Cookies",
        instructions: "Look at Set-Cookie.",
        assignedAt: now,
        check: {
          id: "check1",
          target: {
            kind: "website",
            value: "settle.ng",
            previewSummary: { rows: [{ severity: "medium", label: "Security headers", title: "No HSTS", price: 2, area: "headers" }] },
          },
        },
      },
    ]);

    const [job] = await listAgentJobs(asDb(db), "agentA", now);

    expect(job!.check).toEqual({ id: "check1", target: { kind: "website", value: "settle.ng", quickScan: [{ severity: "medium", area: "Security headers", title: "No HSTS" }] } });
    expect(JSON.stringify(job)).not.toContain("previewSummary");
  });

  it("refuses a late report after the part was taken back", async () => {
    const db = fakeDb();
    db.securityCheckItem.findUnique.mockResolvedValue(heldItem({ status: "waiting" }));
    await expect(submitReport(asDb(db), "agentA", "item1", found, now)).rejects.toMatchObject({ status: 409, code: "not_held" });
    expect(db.securityCheckResult.createMany).not.toHaveBeenCalled();
  });

  it("refuses work on a check whose target lost its ownership proof, when proof is required", async () => {
    vi.stubEnv("SECURITY_OWNERSHIP_PROOF_REQUIRED", "true");
    const db = fakeDb();
    db.securityCheckItem.findUnique.mockResolvedValue(heldItem({ check: { status: "checking", target: { verifiedAt: null } } }));
    await expect(submitReport(asDb(db), "agentA", "item1", [], now)).rejects.toBeInstanceOf(SecurityJobError);
    vi.unstubAllEnvs();
  });

  it("takes the work of a target with no proof while proof is off", async () => {
    const db = fakeDb();
    db.securityCheckItem.findUnique.mockResolvedValue(heldItem({ check: { status: "checking", target: { verifiedAt: null } } }));
    db.securityCheckItem.updateMany.mockResolvedValue({ count: 1 });
    expect(await submitReport(asDb(db), "agentA", "item1", found, now)).toEqual({ checkId: "check1", results: 1, rechecked: 0, addedParts: 0 });
  });

  it("serves no old split or collate jobs", async () => {
    const db = fakeDb();
    db.securityCheckItem.findUnique.mockResolvedValue(heldItem({ kind: "split" }));
    await expect(submitReport(asDb(db), "agentA", "item1", [], now)).rejects.toMatchObject({ status: 404 });
  });
});

describe("taking parts back", () => {
  it("returns parts not reported in time, and skips cancelled checks' and old split or collate jobs", async () => {
    const db = fakeDb();
    db.securityCheckItem.updateMany.mockResolvedValueOnce({ count: 2 }).mockResolvedValueOnce({ count: 1 });
    expect(await reclaimStaleJobs(asDb(db), now)).toEqual({ reclaimed: 2, skipped: 1 });
    expect(db.securityCheckItem.updateMany.mock.calls[0][0].where.assignedAt.lt).toEqual(new Date(now.getTime() - JOB_TIMEOUT_MINUTES * 60_000));
    expect(db.securityCheckItem.updateMany.mock.calls[1][0].where.OR).toContainEqual({ kind: { in: ["split", "collate"] } });
  });
});

describe("posting the report: Ziki's AI summary (#security-checks)", () => {
  it("waits while any part is open", async () => {
    const db = fakeDb();
    db.securityCheckItem.count.mockResolvedValueOnce(1).mockResolvedValueOnce(3);
    expect(await postReportIfComplete(asDb(db), "check1", now, { ai: null })).toBe(false);
    expect(db.securityCheck.updateMany).not.toHaveBeenCalled();
  });

  it("posts once every part is in: done, postedAt and the summary", async () => {
    const db = fakeDb();
    db.securityCheckItem.count.mockResolvedValueOnce(0).mockResolvedValueOnce(4);
    db.securityCheck.updateMany.mockResolvedValue({ count: 1 });
    db.securityCheck.findUnique.mockResolvedValue({ target: { kind: "website", value: "settle.ng" }, results: [{ severity: "high", title: "Admin page open" }], rechecked: [] });
    expect(await postReportIfComplete(asDb(db), "check1", now, { ai: null })).toBe(true);
    expect(db.securityCheck.updateMany.mock.calls[1][0]).toMatchObject({
      where: { id: "check1", status: "checking", postedAt: null, collatingAt: now },
      data: { status: "done", finishedAt: now, postedAt: now },
    });
    expect(db.securityCheck.updateMany.mock.calls[1][0].data.summary).toContain("1 high");
  });

  it("never gives the summary writer a finding's details or fix, which stay locked", async () => {
    const { ai, calls } = fakeAi({ summary: "Two problems found; start with the admin page." });
    const results = [{ severity: "high", title: "Admin page open", description: "SECRET-DETAIL", howToFix: "SECRET-FIX" }] as never[];
    await writeSummary({ kind: "website", value: "settle.ng" }, results, { ai });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.user).toContain("Admin page open");
    expect(calls[0]!.user).not.toContain("SECRET-DETAIL");
    expect(calls[0]!.user).not.toContain("SECRET-FIX");
  });

  it("falls back to a plain count summary when the AI is unavailable", async () => {
    expect((await writeSummary({ kind: "website", value: "settle.ng" }, [], { ai: null })).summary).toContain("didn't find any problems");
    expect(defaultSummary({ value: "x.ng" }, [{ severity: "critical", title: "a" }, { severity: "low", title: "b" }])).toContain("1 critical, 1 low");
  });
});

describe("paying the finder of an unlocked finding (#security-checks)", () => {
  it("pays its price to the agent's owner exactly once, with no multiplier", async () => {
    const db = fakeDb();
    db.securityCheckResult.findMany.mockResolvedValue([
      { id: "r1", severity: "critical", priceCoins: 5, check: { organisationId: "client" }, item: { agentId: "agentB", agent: { ownerUserId: "ownerB" } } },
      { id: "r2", severity: "medium", priceCoins: null, check: { organisationId: "client" }, item: { agentId: "agentB", agent: { ownerUserId: "ownerB" } } },
      { id: "r3", severity: "low", priceCoins: 1, check: { organisationId: "client" }, item: { agentId: "agentB", agent: { ownerUserId: "ownerB" } } },
    ]);
    // r3 was paid by a concurrent run: its conditional update matches nothing.
    db.securityCheckResult.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    expect(await payUnlockedFindings(asDb(db), now)).toBe(2);
    expect(db.securityCheckResult.findMany.mock.calls[0][0].where).toMatchObject({ unlockedAt: { not: null }, payoutReleasedAt: null });
    // Ziki's own security agent (the fallback) is never paid.
    expect(db.securityCheckResult.findMany.mock.calls[0][0].where.item).toEqual({ agentId: { not: null }, agent: { username: { not: "ziki-security" } } });
    expect(award.mock.calls[0][1]).toEqual({
      organisationId: "client",
      userId: "ownerB",
      agentId: "agentB",
      bugId: null,
      role: "security_check",
      points: 5,
      sourceKey: findingSourceKey("r1"),
      exact: true,
    });
    expect(award.mock.calls[1][1]).toMatchObject({ points: 2, sourceKey: "security-finding:r2" });
  });
});
