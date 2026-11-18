import { describe, expect, it } from "vitest";
import { THREAT_LABEL, checkListTabs } from "@/lib/security-checks/check-list";
import type { CheckReport } from "@/lib/security-checks/report";

const base = {
  checkId: "c1",
  status: "checking",
  createdAt: new Date("2026-11-16T10:00:00Z"),
  startedAt: new Date("2026-11-16T10:00:00Z"),
  finishedAt: null,
  target: { id: "t1", kind: "website", value: "shop.test", input: "shop.test", verified: true },
  posted: false,
  quickScan: {
    kind: "website",
    target: "shop.test",
    checkedAt: "2026-11-16T10:00:00.000Z",
    total: 1,
    counts: { critical: 0, high: 0, medium: 0, low: 1 },
    risk: "low",
    areas: [{ area: "headers", label: "Security headers", problems: 1 }],
    rows: [{ severity: "low", area: "headers", price: 1, label: "Security headers", title: "No HSTS header" }],
  },
  counts: { critical: 1, high: 0, medium: 0, low: 0 },
  total: 1,
  clearParts: ["Cookies"],
} as const;

function report(parts: CheckReport["parts"], findings: Partial<CheckReport["findings"][number]>[] = []): CheckReport {
  return {
    ...base,
    parts,
    progress: { done: 0, total: parts.length, percent: 0 },
    findings: findings.map((f, i) => ({ id: `r${i}`, partId: "p1", severity: "critical", area: "Login", title: "Admin open", description: "The admin page opens without a password.", howToFix: null, fix: null, checkId: "c1", recheck: null, recheckNote: null, ...f })),
    fixed: [],
    previousCheckId: null,
    nextCheckId: null,
  } as unknown as CheckReport;
}

describe("the check's list: Quick scan and Deeper scan tabs (16 Nov)", () => {
  it("has the quick scan first, then the deeper scan", () => {
    const [quick, deep] = checkListTabs(report([]));
    expect([quick.title, deep.title]).toEqual(["Quick scan", "Deeper scan"]);
    expect(quick.scanRows).toEqual([{ severity: "low", title: "No HSTS header", line: null, area: "Security headers" }]);
    expect(quick.count).toBe(1);
  });

  it("lists every part in the deeper scan: findings as soon as their part is done, unfinished parts with where they stand, clean ones as clear", () => {
    const [, deep] = checkListTabs(
      report([
        { id: "p1", title: "Login", status: "done" },
        { id: "p2", title: "Cookies", status: "done" },
        { id: "p3", title: "Forms", status: "checking" },
        { id: "p4", title: "Admin", status: "waiting" },
      ], [{}]),
    );
    expect(deep.findings!.map((f) => f.title)).toEqual(["Admin open"]);
    expect(deep.count).toBe(1);
    expect(deep.clear).toEqual(["Cookies"]);
    expect(deep.pending).toEqual([
      { id: "p3", title: "Forms", state: "checking" },
      { id: "p4", title: "Admin", state: "waiting" },
    ]);
    expect(deep.state).toEqual({ label: "2 of 4 done", tone: "working" });
  });

  it("says Waiting when no part has started, and Planning before there are parts", () => {
    expect(checkListTabs(report([{ id: "p1", title: "Forms", status: "waiting" }]))[1].state.label).toBe("Waiting");
    expect(checkListTabs(report([]))[1].state.label).toBe("Planning");
  });

  it("a cancelled check doesn't list unfinished parts as still being checked", () => {
    const cancelled = { ...report([{ id: "p3", title: "Forms", status: "waiting" }]), status: "cancelled" } as CheckReport;
    expect(checkListTabs(cancelled)[1].pending).toEqual([]);
  });

  it("a rescan lists no parts under Still checking: only its findings, the progress bar counts the parts (18 Nov)", () => {
    const rescan = { ...report([{ id: "p1", title: "Recheck: Login", status: "waiting" }, { id: "p2", title: "Cookies", status: "checking" }], [{ checkId: "c0", recheck: "checking" }]), previousCheckId: "c0" } as CheckReport;
    const [, deep] = checkListTabs(rescan);
    expect(deep.pending).toEqual([]);
    expect(deep.findings!.map((f) => [f.title, f.recheck])).toEqual([["Admin open", "checking"]]);
    expect(deep.state).toEqual({ label: "0 of 2 done", tone: "working" });
  });

  it("names severities as threats", () => {
    expect(THREAT_LABEL).toEqual({ critical: "Critical threat", high: "High threat", medium: "Medium threat", low: "Low threat" });
  });
});
