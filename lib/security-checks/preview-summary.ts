import type { SecuritySeverity, SecurityTargetKind } from "@prisma/client";
import { SEVERITY_PRICE } from "@/lib/security-checks";
import type { PreviewArea, PreviewFinding, PreviewResult } from "./preview";

/**
 * What a quick scan may show while its findings are locked (#security-checks,
 * 14 Nov plan): the areas looked at, how many problems each has, the counts by
 * severity, an overall risk, and each finding as a row with its short title
 * (what any browser can already see, so it's shown: product call on 14 Nov).
 * Never a finding's detail: that stays on the server until it is unlocked, so
 * it can't be read from the page's HTML or network traffic.
 */

export type PreviewRisk = "minimal" | "low" | "medium" | "high" | "critical";

export const PREVIEW_AREA_ORDER: PreviewArea[] = ["https", "certificate", "headers", "cookies", "email", "secrets", "policy", "updates"];

export const PREVIEW_AREA_LABEL: Record<PreviewArea, string> = {
  https: "HTTPS",
  certificate: "Certificate",
  headers: "Security headers",
  cookies: "Cookies",
  email: "Email settings",
  secrets: "Secrets in files",
  policy: "Security policy",
  updates: "Dependency updates",
};

export const PREVIEW_RISK_LABEL: Record<PreviewRisk, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};

export type PreviewSummary = {
  kind: SecurityTargetKind;
  target: string;
  checkedAt: string;
  total: number;
  counts: Record<SecuritySeverity, number>;
  risk: PreviewRisk;
  /** Each area looked at, in a fixed order, with how many problems it has. */
  areas: { area: PreviewArea; label: string; problems: number }[];
  /**
   * Each finding as a locked row, worst first: severity, area and price only.
   * Absent on quick scans saved before 14 Nov, so read it as `rows ?? []`.
   */
  rows?: (PreviewRow & { label: string; title?: string })[];
};

/**
 * One finding as the page may list it while it is locked (14 Nov plan, D3):
 * how serious, which general area, and what unlocking it costs. Never its
 * title, detail or id, which would say what the problem is.
 */
export type PreviewRow = { severity: SecuritySeverity; area: PreviewArea; price: number };

const WORST_FIRST: Record<SecuritySeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** The findings as locked rows, worst first, priced as a report's findings are (SEVERITY_PRICE). */
export function previewRows(findings: readonly Pick<PreviewFinding, "severity" | "area">[]): PreviewRow[] {
  return [...findings]
    .sort((a, b) => WORST_FIRST[a.severity] - WORST_FIRST[b.severity])
    .map(({ severity, area }) => ({ severity, area, price: SEVERITY_PRICE[severity] }));
}

export function previewRisk(counts: Record<SecuritySeverity, number>): PreviewRisk {
  if (counts.critical > 0) return "critical";
  if (counts.high > 0) return "high";
  if (counts.medium > 0) return "medium";
  if (counts.low > 0) return "low";
  return "minimal";
}

/** The shown part of a quick scan: counts, and each finding's row with its short title; never its detail. */
export function summarisePreview(result: Extract<PreviewResult, { ok: true }>): PreviewSummary {
  const problemsIn = (area: PreviewArea) => result.findings.filter((finding) => finding.area === area).length;
  const looked = new Set(result.checked);
  return {
    kind: result.kind,
    target: result.target,
    checkedAt: result.checkedAt,
    total: result.findings.length,
    counts: { ...result.counts },
    risk: previewRisk(result.counts),
    areas: PREVIEW_AREA_ORDER.filter((area) => looked.has(area)).map((area) => ({ area, label: PREVIEW_AREA_LABEL[area], problems: problemsIn(area) })),
    rows: [...result.findings]
      .sort((a, b) => WORST_FIRST[a.severity] - WORST_FIRST[b.severity])
      .map((finding) => ({ ...previewRows([finding])[0], label: PREVIEW_AREA_LABEL[finding.area], title: finding.title })),
  };
}
