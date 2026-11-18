import { beforeEach, describe, expect, it, vi } from "vitest";
import { inflateSync } from "node:zlib";
import { Prisma } from "@prisma/client";

const db = vi.hoisted(() => {
  const fake = {
    securityCheck: { findFirst: vi.fn(), create: vi.fn() },
    securityCheckResult: { findMany: vi.fn(), findUnique: vi.fn() },
    $transaction: vi.fn(),
  };
  fake.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(fake));
  return fake;
});
vi.mock("@/lib/prisma", () => ({ prisma: db }));

// The wallet, for Scan again's payment (#security-rescan): what it can spend and the rows it writes.
const coins = vi.hoisted(() => {
  class CoinError extends Error {
    constructor(public code: string, message: string) {
      super(message);
    }
  }
  return { CoinError, appendRows: vi.fn(), lockUser: vi.fn(), walletBalance: vi.fn(), assertCanSpendOnSecurity: vi.fn(), loanState: vi.fn() };
});
vi.mock("@/lib/coins/ledger", () => ({ CoinError: coins.CoinError, appendRows: coins.appendRows, lockUser: coins.lockUser, walletBalance: coins.walletBalance }));
vi.mock("@/lib/coins/loan", () => ({ assertCanSpendOnSecurity: coins.assertCanSpendOnSecurity, loanState: coins.loanState }));

const session = vi.hoisted(() => ({ userId: "owner", organisationId: "org1" }));
vi.mock("@/lib/auth-helpers", () => ({ requireUser: async () => ({ id: session.userId, role: "user" }) }));
vi.mock("@/lib/organisation-access", () => ({
  currentOrganisationAccess: async () => ({ organisationId: session.organisationId, admin: false }),
}));
const renderReportPdf = vi.hoisted(() => vi.fn());
vi.mock("@/components/security-checks/report-pdf", () => ({ renderReportPdf }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));

import { fixOf, loadCheckReport } from "@/lib/security-checks/report";
import { RESCAN_PRICE_ZIKS, startRescan } from "@/lib/security-checks/rescan";
import { GET as downloadReportPdf } from "@/app/(app)/security/checks/[id]/report.pdf/route";
import {
  CHECK_STATUS_LABEL,
  ITEM_STATUS_LABEL,
  SECURITY_CHECK_ITEM_KINDS,
  SECURITY_CHECK_ITEM_STATUSES,
  SECURITY_CHECK_PRICE_COINS,
  SECURITY_CHECK_STATUSES,
  SECURITY_TARGET_KINDS,
  TARGET_KIND_LABEL,
  FREE_SCANS_PER_TARGET,
  FREE_SCANS_PER_WORKSPACE_PER_MONTH,
  ON_CALL_INVITE_STATUSES,
  ON_CALL_QUIET_AFTER_MS,
  SEVERITY_PRICE,
  agentsMayWork,
  freeScanAllowed,
  isTargetProven,
  ownershipProofRequired,
  provenTargetWhere,
  scanLimitsEnabled,
  freeScanMonthStart,
  isCheckPaid,
  isQuiet,
  isResultUnlocked,
  isSecurityCleared,
  unlockTotal,
  isReportPosted,
  isSecurityCheckItemStatus,
  isSecurityCheckStatus,
  isSecurityTargetKind,
} from "@/lib/security-checks";

/** Every compressed stream in a PDF, inflated (fonts' ToUnicode maps live in them). */
function inflatedStreams(pdf: Buffer): string[] {
  const out: string[] = [];
  let at = 0;
  for (;;) {
    const start = pdf.indexOf("stream", at);
    if (start < 0) return out;
    const from = start + (pdf[start + 6] === 0x0d ? 8 : 7);
    const end = pdf.indexOf("endstream", from);
    if (end < 0) return out;
    try {
      out.push(inflateSync(pdf.subarray(from, end)).toString("latin1"));
    } catch {
      // not a compressed stream (the embedded font itself, for example)
    }
    at = end + 9;
  }
}

/** A ToUnicode target, UTF-16BE hex, as text. */
const hexToText = (hex: string) => Buffer.from(hex, "hex").swap16().toString("utf16le");

const enumValues =(name: string) =>
  Prisma.dmmf.datamodel.enums.find((e) => e.name === name)?.values.map((v) => v.name) ?? [];

describe("security check words (#security-checks)", () => {
  it("match the database enums exactly", () => {
    expect([...SECURITY_TARGET_KINDS].sort()).toEqual(enumValues("SecurityTargetKind").sort());
    expect([...SECURITY_CHECK_STATUSES].sort()).toEqual(enumValues("SecurityCheckStatus").sort());
    expect([...SECURITY_CHECK_ITEM_KINDS].sort()).toEqual(enumValues("SecurityCheckItemKind").sort());
    expect([...SECURITY_CHECK_ITEM_STATUSES].sort()).toEqual(enumValues("SecurityCheckItemStatus").sort());
  });

  it("label every value", () => {
    for (const kind of SECURITY_TARGET_KINDS) expect(TARGET_KIND_LABEL[kind]).toBeTruthy();
    for (const status of SECURITY_CHECK_STATUSES) expect(CHECK_STATUS_LABEL[status]).toBeTruthy();
    for (const status of SECURITY_CHECK_ITEM_STATUSES) expect(ITEM_STATUS_LABEL[status]).toBeTruthy();
  });

  it("guard unknown values", () => {
    expect(isSecurityTargetKind("repo")).toBe(true);
    expect(isSecurityTargetKind("domain")).toBe(false);
    expect(isSecurityCheckStatus("checking")).toBe(true);
    expect(isSecurityCheckStatus(1)).toBe(false);
    expect(isSecurityCheckItemStatus("done")).toBe(true);
    expect(isSecurityCheckItemStatus("finished")).toBe(false);
  });

  it("keep agents off a target until ownership is proven, when proof is required", () => {
    const verified = { verifiedAt: new Date() };
    expect(agentsMayWork({ status: "queued" }, { verifiedAt: null }, true)).toBe(false);
    expect(agentsMayWork({ status: "awaiting_ownership" }, verified, true)).toBe(false);
    expect(agentsMayWork({ status: "queued" }, verified, true)).toBe(true);
    expect(agentsMayWork({ status: "checking" }, verified, true)).toBe(true);
    expect(agentsMayWork({ status: "done" }, verified, true)).toBe(false);
    expect(agentsMayWork({ status: "cancelled" }, verified, true)).toBe(false);
  });

  it("treats every target as proven while proof is off (the default), and only proven ones once it is on", () => {
    const unproven = { verifiedAt: null };
    expect(ownershipProofRequired()).toBe(false);
    expect(isTargetProven(unproven)).toBe(true);
    expect(agentsMayWork({ status: "queued" }, unproven)).toBe(true);
    expect(agentsMayWork({ status: "done" }, unproven)).toBe(false);
    expect(provenTargetWhere()).toEqual({});

    expect(isTargetProven(unproven, true)).toBe(false);
    expect(isTargetProven({ verifiedAt: new Date() }, true)).toBe(true);
    expect(provenTargetWhere(true)).toEqual({ target: { verifiedAt: { not: null } } });
  });

  it("brings proof back with SECURITY_OWNERSHIP_PROOF_REQUIRED=true", () => {
    vi.stubEnv("SECURITY_OWNERSHIP_PROOF_REQUIRED", "true");
    expect(ownershipProofRequired()).toBe(true);
    expect(isTargetProven({ verifiedAt: null })).toBe(false);
    vi.unstubAllEnvs();
  });

  it("show results only once the collated report is posted", () => {
    expect(isReportPosted({ postedAt: null })).toBe(false);
    expect(isReportPosted({ postedAt: new Date() })).toBe(true);
  });

  it("unlock the report only once paid", () => {
    expect(isCheckPaid({ paidAt: null })).toBe(false);
    expect(isCheckPaid({ paidAt: new Date() })).toBe(true);
    expect(SECURITY_CHECK_PRICE_COINS).toBe(50);
  });
});

describe("what a client sees of a check (12 and 14 Nov plans, part S)", () => {
  const at = (minutes: number) => new Date(Date.UTC(2026, 10, 12, 9, minutes));
  const QUICK_SCAN = {
    kind: "website",
    target: "shop.example.test",
    checkedAt: "2026-11-14T09:00:00.000Z",
    total: 1,
    counts: { critical: 0, high: 0, medium: 0, low: 1 },
    risk: "low",
    areas: [{ area: "headers", label: "Security headers", problems: 1 }],
    rows: [{ severity: "low", area: "headers", price: 1, label: "Security headers", title: "No HSTS header" }],
  };
  function check(postedAt: Date | null = at(9), target: { verifiedAt?: Date | null; previewSummary?: unknown } = {}) {
    return {
      id: "check1",
      status: postedAt ? "done" : "checking",
      free: true,
      postedAt,
      summary: "We checked 5 parts and found 3 problems, one of them critical. Start with the critical one.",
      createdAt: at(0),
      finishedAt: postedAt,
      startedAt: at(0),
      target: { id: "t1", kind: "website", value: "shop.example.test", input: "https://shop.example.test", verifiedAt: at(0), previewSummary: null, ...target },
      items: [
        { id: "i1", title: "Login", status: "done", agentId: "a1" },
        { id: "i2", title: "TLS", status: "skipped", agentId: "a1" },
        { id: "i3", title: "Headers", status: postedAt ? "done" : "checking", agentId: "a2" },
        { id: "i4", title: "CORS", status: postedAt ? "done" : "waiting", agentId: null },
        { id: "i5", title: "Cookies", status: "done", agentId: "a2" },
      ],
    };
  }
  const PART_TITLE: Record<string, string> = { i1: "Login", i3: "Headers", i4: "CORS" };
  /** A client's issue a finding was moved to (Sanmi's "Move to your app"): what paying to fix it leaves behind. */
  const MOVED = {
    id: "f1",
    project: { slug: "web", organisation: { slug: "acme" } },
    bug: { number: 150, status: "in_progress", isDeleted: false },
    idea: null,
    verifications: [],
  };
  /** A result as the report's query returns it: everything but how to fix. */
  const row = (id: string, severity: string, minute: number, opts: { itemId?: string; moved?: boolean } = {}) => {
    const itemId = opts.itemId ?? "i1";
    return {
      id,
      itemId,
      severity,
      createdAt: at(minute),
      title: `${id} title`,
      description: `${id} description`,
      finding: opts.moved ? MOVED : null,
      item: { title: PART_TITLE[itemId] },
    };
  };
  /** The results table: the report's query gets every row; the how-to-fix query only the ids it asks for. */
  function results(rows: ReturnType<typeof row>[]) {
    db.securityCheckResult.findMany.mockImplementation(async ({ where }: { where: { id?: { in: string[] } } }) =>
      where.id ? rows.filter((r) => where.id?.in.includes(r.id)).map((r) => ({ id: r.id, howToFix: `${r.id} fix` })) : rows,
    );
  }

  beforeEach(() => {
    db.securityCheck.findFirst.mockReset();
    db.securityCheckResult.findMany.mockReset();
    db.securityCheckResult.findUnique.mockReset();
    renderReportPdf.mockReset();
    session.userId = "owner";
  });

  it("is the requester's alone: another person, even in the same workspace, gets nothing", async () => {
    db.securityCheck.findFirst.mockResolvedValue(null);
    expect(await loadCheckReport("check1", "org1", "teammate")).toBeNull();
    expect(db.securityCheck.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "check1", organisationId: "org1", requestedById: "teammate" } }),
    );
    expect(db.securityCheckResult.findMany).not.toHaveBeenCalled();
  });

  it("before the report is posted: progress, the quick scan, and the findings of parts already done (16 Nov call); the PDF goes back to the check", async () => {
    db.securityCheck.findFirst.mockResolvedValue(check(null, { previewSummary: QUICK_SCAN }));
    results([row("crit", "critical", 1)]);

    const report = await loadCheckReport("check1", "org1", "owner");

    // The quick scan from when it was added is the list's first phase.
    expect(report).toMatchObject({ posted: false, quickScan: { total: 1, rows: [{ title: "No HSTS header" }] } });
    // A finding shows as soon as its part is done, without waiting for the rest.
    expect(report?.findings.map((f) => [f.id, f.partId])).toEqual([["crit", "i1"]]);
    expect(report?.counts).toEqual({ critical: 1, high: 0, medium: 0, low: 0 });
    expect(report).not.toHaveProperty("summary");
    // A skipped part counts as finished (3 of 5).
    expect(report?.progress).toEqual({ done: 3, total: 5, percent: 60 });

    const params = { params: Promise.resolve({ id: "check1" }) };
    await expect(downloadReportPdf(new Request("http://localhost/x"), params)).rejects.toThrow(/^redirect:\/security\/checks\/check1$/);
    expect(renderReportPdf).not.toHaveBeenCalled();
  });

  it("posted: free, every finding in full; how to fix only on the one the client paid to fix, never read for the others", async () => {
    db.securityCheck.findFirst.mockResolvedValue(check());
    results([
      row("low", "low", 1, { itemId: "i4" }),
      row("crit", "critical", 2, { moved: true }),
      row("high", "high", 3, { itemId: "i3" }),
    ]);

    const report = await loadCheckReport("check1", "org1", "owner");

    // The report's query never reads how to fix; the second asks only for the paid (moved) finding's.
    const [first, second] = db.securityCheckResult.findMany.mock.calls.map((call) => call[0]);
    expect(first.select).not.toHaveProperty("howToFix");
    expect(second.where).toEqual({ id: { in: ["crit"] } });

    if (!report?.posted) throw new Error("expected a posted report");
    expect(report.findings.map((f) => f.id)).toEqual(["crit", "high", "low"]);
    const [crit, high, low] = report.findings;
    expect(crit).toMatchObject({ title: "crit title", howToFix: "crit fix", fix: { bucket: "fixing", issue: { number: 150, href: "/acme/web/150" } } });
    // Not paid for: shown in full, without how to fix, and without the agent that found it.
    expect(high).toEqual({ id: "high", partId: "i3", severity: "high", area: "Headers", title: "high title", description: "high description", howToFix: null, fix: null, price: 3, checkId: "check1", recheck: null, recheckNote: null });
    expect(low).toMatchObject({ area: "CORS", howToFix: null });
    expect(report.counts).toEqual({ critical: 1, high: 1, medium: 0, low: 1 });
    expect(report.clearParts).toEqual(["Cookies"]);
  });

  it("a check still marked as waiting for proof shows as waiting to start while proof is off, and keeps the proof step once it is on", async () => {
    const waiting = { ...check(null, { verifiedAt: null }), status: "awaiting_ownership" };
    db.securityCheck.findFirst.mockResolvedValue(waiting);
    results([]);
    expect(await loadCheckReport("check1", "org1", "owner")).toMatchObject({ status: "queued" });

    vi.stubEnv("SECURITY_OWNERSHIP_PROOF_REQUIRED", "true");
    try {
      expect(await loadCheckReport("check1", "org1", "owner")).toMatchObject({ status: "awaiting_ownership" });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("with nothing paid for, how to fix is never even asked for", async () => {
    db.securityCheck.findFirst.mockResolvedValue(check());
    results([row("crit", "critical", 1), row("low", "low", 2)]);

    const report = await loadCheckReport("check1", "org1", "owner");

    expect(db.securityCheckResult.findMany).toHaveBeenCalledTimes(1);
    if (!report?.posted) throw new Error("expected a posted report");
    expect(report.findings.map((f) => [f.title, f.howToFix])).toEqual([["crit title", null], ["low title", null]]);
  });

  it("PDF: free once posted, made from the same report (no how to fix unless paid for); a stranger gets 404", async () => {
    const params = { params: Promise.resolve({ id: "check1" }) };
    db.securityCheck.findFirst.mockResolvedValue(check());
    results([row("crit", "critical", 1)]);
    renderReportPdf.mockResolvedValue(Buffer.from("%PDF-1.3"));

    const response = await downloadReportPdf(new Request("http://localhost/x"), params);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    const [[printed]] = renderReportPdf.mock.calls;
    expect(printed.findings[0]).toEqual(expect.objectContaining({ title: "crit title", howToFix: null }));

    renderReportPdf.mockReset();
    session.userId = "stranger";
    db.securityCheck.findFirst.mockResolvedValue(null);
    expect((await downloadReportPdf(new Request("http://localhost/x"), params)).status).toBe(404);
    expect(renderReportPdf).not.toHaveBeenCalled();
  });

  it("PDF: when the PDF can't be made, the cause goes to the server log and the person gets a plain message, not an empty 500", async () => {
    const params = { params: Promise.resolve({ id: "check1" }) };
    db.securityCheck.findFirst.mockResolvedValue(check());
    results([row("crit", "critical", 1)]);
    renderReportPdf.mockRejectedValue(new Error("font file missing"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await downloadReportPdf(new Request("http://localhost/x"), params);

    expect(response.status).toBe(500);
    expect(await response.text()).toContain("couldn't make the PDF");
    expect(logged.mock.calls.join(" ")).toContain("font file missing");
    logged.mockRestore();
  });

  it("PDF: prints ₦ and Yoruba in the site's font (Inter), embedded, not Helvetica", async () => {
    const { renderReportPdf: render } = await vi.importActual<typeof import("@/components/security-checks/report-pdf")>(
      "@/components/security-checks/report-pdf",
    );
    const yoruba = "Ọjọ́ àti ẹ̀ṣọ́";
    const report = {
      checkId: "check1",
      status: "done",
      free: true,
      createdAt: at(0),
      startedAt: at(0),
      finishedAt: at(9),
      posted: true,
      summary: "Refunds of ₦50,000 skip the owner check.",
      target: { id: "t1", kind: "website", value: "ọjà.example.test", input: "https://ọjà.example.test", verified: true },
      parts: [],
      progress: { done: 2, total: 2, percent: 100 },
      clearParts: [],
      counts: { critical: 1, high: 1, medium: 0, low: 0 },
      total: 2,
      findings: [
        { id: "crit", severity: "critical", area: "Login", title: yoruba, description: "d", howToFix: "f", fix: null },
        { id: "high", severity: "high", area: "Payments", title: "Owó sísan", description: "d", howToFix: null, fix: null },
      ],
    } as never;

    const pdf = await render(report);
    const raw = pdf.toString("latin1");
    expect(raw.startsWith("%PDF")).toBe(true);
    expect(raw).toMatch(/\/BaseFont \/[A-Z]{6}\+Inter-Regular/);
    expect(raw).toMatch(/\/BaseFont \/[A-Z]{6}\+Inter-Bold/);
    expect(raw).not.toContain("Helvetica");

    // The embedded fonts' ToUnicode maps list the characters drawn with a real
    // glyph: ₦, the Yoruba letters and their tone marks are among them. (A
    // dotted letter whose plain letter is already used, like ṣ beside "sísan",
    // is drawn as that letter plus the dot, so it isn't listed on its own.)
    const maps = inflatedStreams(pdf).filter((stream) => stream.includes("begincmap")).join("\n");
    const printed = new Set([...maps.matchAll(/<([0-9a-f]{4,})>/gi)].map((m) => hexToText(m[1])));
    for (const char of ["₦", "Ọ", "ọ", "à", "́", "̀"]) expect(printed, char).toContain(char);
  });

  it("a moved problem's fix follows its finding: Live is fixed, a deleted issue doesn't count, a rejected idea is closed", () => {
    const project = { slug: "web", organisation: { slug: "ziki" } };
    const finding = (bug: object | null, idea: object | null = null, verifications: object[] = []) =>
      fixOf({ id: "f1", project, bug, idea, verifications } as never);
    const bug = (status: string, isDeleted = false) => ({ number: 912, status, isDeleted });

    expect(fixOf(null)).toBeNull();
    expect(finding(bug("in_progress"))).toMatchObject({ bucket: "fixing", issue: { number: 912 }, findingHref: "/security/findings/f1" });
    expect(finding(bug("resolved"), null, [{ passed: true, reviewer: { name: "Hana" } }])).toMatchObject({
      bucket: "fixed", recheck: { passed: true, by: "Hana" },
    });
    // A deleted issue doesn't count: the mark then links to the private finding.
    expect(finding(bug("resolved", true), { status: "open", isDeleted: false })).toMatchObject({ bucket: "fixing", issue: null });
    expect(finding(null, { status: "rejected", isDeleted: false })).toMatchObject({ bucket: "closed" });
  });
});

describe("scanning again (#security-rescan, 17 Nov)", () => {
  const finished = {
    id: "check0",
    organisationId: "org1",
    requestedById: "owner",
    targetId: "t1",
    postedAt: new Date("2026-11-16T10:00:00Z"),
    nextCheck: null,
    target: { value: "settle.ng", verifiedAt: null },
  };
  beforeEach(() => {
    db.securityCheck.findFirst.mockReset();
    db.securityCheck.create.mockReset();
    coins.appendRows.mockReset();
    coins.assertCanSpendOnSecurity.mockReset();
    coins.walletBalance.mockResolvedValue(3);
    coins.loanState.mockResolvedValue({ canBorrow: true, overdraft: 0 });
  });

  it("charges 10 Ziks and starts a follow-up of the finished scan, in one step", async () => {
    db.securityCheck.findFirst.mockResolvedValue(finished);
    db.securityCheck.create.mockResolvedValue({ id: "rescan1" });

    expect(await startRescan("org1", "owner", "check0")).toEqual({ ok: true, checkId: "rescan1" });

    expect(RESCAN_PRICE_ZIKS).toBe(10);
    expect(db.securityCheck.create.mock.calls[0]![0].data).toMatchObject({ previousCheckId: "check0", targetId: "t1", free: false, priceCoins: 10, status: "queued" });
    expect(coins.appendRows.mock.calls[0]![1]).toEqual([
      { account: "wallet", userId: "owner", kind: "check_payment", amount: -10, sourceKey: "rescan:rescan1:wallet" },
      { account: "revenue", kind: "check_payment", amount: 10, sourceKey: "rescan:rescan1:revenue" },
    ]);
  });

  it("charges nothing and starts nothing when the wallet can't cover it, and says whether the loan is open", async () => {
    db.securityCheck.findFirst.mockResolvedValue(finished);
    coins.assertCanSpendOnSecurity.mockRejectedValue(new coins.CoinError("insufficient_ziks", "short"));

    expect(await startRescan("org1", "owner", "check0")).toMatchObject({ ok: false, reason: "insufficient_ziks", needed: 10, balance: 3, canBorrow: true });
    expect(db.securityCheck.create).not.toHaveBeenCalled();
    expect(coins.appendRows).not.toHaveBeenCalled();
  });

  it("follows only the newest finished scan: one still being checked, or already scanned again, is refused without a charge", async () => {
    db.securityCheck.findFirst.mockResolvedValueOnce({ ...finished, postedAt: null });
    expect(await startRescan("org1", "owner", "check0")).toMatchObject({ ok: false, reason: "not_finished" });
    db.securityCheck.findFirst.mockResolvedValueOnce({ ...finished, nextCheck: { id: "rescan1" } });
    expect(await startRescan("org1", "owner", "check0")).toMatchObject({ ok: false, reason: "already_rescanned", checkId: "rescan1" });
    db.securityCheck.findFirst.mockResolvedValueOnce(null);
    expect(await startRescan("org1", "owner", "someone-elses")).toMatchObject({ ok: false, reason: "not_found" });
    expect(coins.assertCanSpendOnSecurity).not.toHaveBeenCalled();
    expect(db.securityCheck.create).not.toHaveBeenCalled();
  });
});

describe("the 12 Nov plan's rules (#security-checks, #on-call)", () => {
  it("prices a finding by severity, worst costs most", () => {
    expect(SEVERITY_PRICE).toEqual({ critical: 5, high: 3, medium: 2, low: 1 });
    expect(unlockTotal([
      { severity: "critical", priceCoins: 5 },
      { severity: "high", priceCoins: null },
      { severity: "low", priceCoins: 1 },
    ])).toBe(9);
    expect(unlockTotal([])).toBe(0);
  });

  it("shows a finding's details only once it is unlocked", () => {
    expect(isResultUnlocked({ unlockedAt: null })).toBe(false);
    expect(isResultUnlocked({ unlockedAt: new Date() })).toBe(true);
  });

  it("allows one free scan per target and a few per workspace a month, when the limits are on", () => {
    expect(freeScanAllowed({ targetFreeScans: 0, workspaceFreeScansThisMonth: 0 }, true)).toEqual({ allowed: true });
    expect(freeScanAllowed({ targetFreeScans: FREE_SCANS_PER_TARGET, workspaceFreeScansThisMonth: 0 }, true)).toEqual({ allowed: false, reason: "target_used" });
    expect(freeScanAllowed({ targetFreeScans: 0, workspaceFreeScansThisMonth: FREE_SCANS_PER_WORKSPACE_PER_MONTH }, true)).toEqual({ allowed: false, reason: "workspace_limit" });
    expect(freeScanMonthStart(new Date("2026-11-30T23:59:00Z"))).toEqual(new Date("2026-11-01T00:00:00Z"));
  });

  it("has no scan limit by default, and brings the limits back with SECURITY_SCAN_LIMITS_ENABLED=true", () => {
    const spent = { targetFreeScans: FREE_SCANS_PER_TARGET, workspaceFreeScansThisMonth: FREE_SCANS_PER_WORKSPACE_PER_MONTH };
    expect(scanLimitsEnabled()).toBe(false);
    expect(freeScanAllowed(spent)).toEqual({ allowed: true });
    vi.stubEnv("SECURITY_SCAN_LIMITS_ENABLED", "true");
    expect(scanLimitsEnabled()).toBe(true);
    expect(freeScanAllowed(spent)).toEqual({ allowed: false, reason: "target_used" });
    vi.unstubAllEnvs();
  });

  it("flags an on-call agent as quiet after 15 minutes unseen, or when never seen", () => {
    const now = new Date("2026-11-12T20:00:00Z");
    expect(isQuiet(null, now)).toBe(true);
    expect(isQuiet(new Date(now.getTime() - ON_CALL_QUIET_AFTER_MS + 1000), now)).toBe(false);
    expect(isQuiet(new Date(now.getTime() - ON_CALL_QUIET_AFTER_MS), now)).toBe(true);
  });

  it("gives security work only to cleared agents", () => {
    expect(isSecurityCleared({ securityClearedAt: null })).toBe(false);
    expect(isSecurityCleared({ securityClearedAt: new Date() })).toBe(true);
  });

  it("lists every on-call invite status the database has", () => {
    expect([...ON_CALL_INVITE_STATUSES].sort()).toEqual(enumValues("OnCallInviteStatus").sort());
  });
});
