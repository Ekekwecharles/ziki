import "server-only";
import { readQuickScan } from "@/lib/security-checks/entry";
import type { PreviewSummary } from "@/lib/security-checks/preview-summary";
import type {
  IdeaStatus,
  Prisma,
  SecurityCheckItemStatus,
  SecurityCheckStatus,
  SecuritySeverity,
  SecurityTargetKind,
  Status,
} from "@prisma/client";
import { issuePath } from "@/lib/issue-ref";
import { prisma } from "@/lib/prisma";
import { refOf } from "@/lib/project-paths";
import { isReportPosted, isTargetProven } from "@/lib/security-checks";
import { SECURITY_SEVERITIES } from "@/lib/security-severity";

/**
 * What a client may see of one security check (#security-checks, 12 and 14
 * Nov plans, part S): the page and the PDF both read the report through
 * `loadCheckReport`, so they always show the same thing. A report never goes
 * away: moving findings to the client's app leaves it as it is.
 *
 * - Until Ziki has posted the report (`isReportPosted`), no result is read at
 *   all: the client sees progress, and the quick scan's short titles (which
 *   are never findings: nothing in it can be paid for).
 * - Once posted, the report is free (14 Nov call): every finding shows in
 *   full. Clients pay only to have a finding fixed, by moving it to their app.
 * - "How to fix" is only for a finding the client paid to have fixed (Hamzat,
 *   14 Nov): for any other finding it is never read, so it can't reach the
 *   page, the HTML or the PDF.
 */

export type SeverityCounts = Record<SecuritySeverity, number>;

/** One part of the check, as the client sees it on the progress screen. */
export type ReportPart = { id: string; title: string; status: SecurityCheckItemStatus };

/** One finding, as the client sees it. */
export type ReportFinding = {
  id: string;
  severity: SecuritySeverity;
  /** The part of the check that found it ("Login form"). */
  area: string;
  title: string;
  description: string;
  /** Only for a finding the client paid to have fixed (moved to their app); null otherwise. */
  howToFix: string | null;
  /** Where its fix is, once it was moved to the client's app and became a private finding; null until then. */
  fix: ResultFix | null;
};

export type FixBucket = "fixing" | "fixed" | "closed";

/** A moved problem's fix, read from its private finding (#security-findings). */
export type ResultFix = {
  /** The private finding's page: where the mark links while there is no issue yet. */
  findingHref: string;
  bucket: FixBucket;
  issue: { number: number; href: string } | null;
  /** The latest independent re-check (Independent verification on the finding's page). */
  recheck: { passed: boolean; by: string | null } | null;
};

type FindingRow = {
  id: string;
  project: { slug: string; organisation: { slug: string } };
  bug: { number: number; status: Status; isDeleted: boolean } | null;
  idea: { status: IdeaStatus; isDeleted: boolean } | null;
  verifications: { passed: boolean; reviewer: { name: string | null } | null }[];
};

/** A finding's fix, as its own page and the Findings dashboard see it. Deleted ideas and issues don't count. */
export function fixOf(finding: FindingRow | null): ResultFix | null {
  if (!finding) return null;
  const bug = finding.bug && !finding.bug.isDeleted ? finding.bug : null;
  const idea = finding.idea && !finding.idea.isDeleted ? finding.idea : null;
  const latest = finding.verifications[0];
  const bucket: FixBucket =
    bug?.status === "resolved"
      ? "fixed"
      : bug?.status === "closed" || (!bug && (idea?.status === "rejected" || idea?.status === "archived"))
        ? "closed"
        : "fixing";
  return {
    findingHref: `/security/findings/${finding.id}`,
    bucket,
    issue: bug ? { number: bug.number, href: issuePath(refOf(finding.project), bug.number) } : null,
    recheck: latest ? { passed: latest.passed, by: latest.reviewer?.name ?? null } : null,
  };
}

const FINDING_OF_RESULT = {
  finding: {
    select: {
      id: true,
      project: { select: { slug: true, organisation: { select: { slug: true } } } },
      bug: { select: { number: true, status: true, isDeleted: true } },
      idea: { select: { status: true, isDeleted: true } },
      verifications: {
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 1,
        select: { passed: true, reviewer: { select: { name: true } } },
      },
    },
  },
} satisfies Prisma.SecurityCheckResultSelect;

type ReportBase = {
  checkId: string;
  status: SecurityCheckStatus;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  /** `value` is the tidy form ("settle.ng"); `input` is what the client typed. */
  target: { id: string; kind: SecurityTargetKind; value: string; input: string; verified: boolean };
  parts: ReportPart[];
  progress: { done: number; total: number; percent: number };
};

/**
 * Before the report is posted: progress, and the quick scan run when the asset
 * was added (`SecurityTarget.previewSummary`), shown first on the scan's page
 * until the agents' report replaces it. Nothing about the agents' results.
 */
export type UnpostedReport = ReportBase & { posted: false; quickScan: PreviewSummary | null };

/** The posted report: Ziki's summary, then every finding worst first. */
export type PostedReport = ReportBase & {
  posted: true;
  /** Ziki AI's plain summary. */
  summary: string | null;
  findings: ReportFinding[];
  counts: SeverityCounts;
  total: number;
  /** Finished parts that found nothing, by title. */
  clearParts: string[];
};

export type CheckReport = UnpostedReport | PostedReport;

/** Lower is worse: critical first. */
function severityRank(severity: SecuritySeverity): number {
  return SECURITY_SEVERITIES.indexOf(severity);
}

/** Worst first, then the oldest, then by id so the order never wobbles. */
export function worstFirst<T extends { id: string; severity: SecuritySeverity; createdAt: Date }>(rows: readonly T[]): T[] {
  return [...rows].sort(
    (a, b) =>
      severityRank(a.severity) - severityRank(b.severity) ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

export function countBySeverity(rows: readonly { severity: SecuritySeverity }[]): SeverityCounts {
  const counts: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const row of rows) counts[row.severity] += 1;
  return counts;
}

/** Finished parts out of all parts. A skipped part counts as finished. */
export function partsProgress(parts: readonly { status: SecurityCheckItemStatus }[]): ReportBase["progress"] {
  const total = parts.length;
  const done = parts.filter((part) => part.status === "done" || part.status === "skipped").length;
  return { done, total, percent: total === 0 ? 0 : Math.round((done / total) * 100) };
}

/** Parts an agent finished without finding anything. */
export function clearPartTitles(parts: readonly ReportPart[], results: readonly { itemId: string }[]): string[] {
  const withResults = new Set(results.map((result) => result.itemId));
  return parts.filter((part) => part.status === "done" && !withResults.has(part.id)).map((part) => part.title);
}

/**
 * The report for one check, or null when the check doesn't exist, belongs to
 * another workspace, or was asked for by someone else: each check is its
 * requester's alone, as on the pay page (#640). Callers answer "not found".
 */
export async function loadCheckReport(checkId: string, organisationId: string, userId: string): Promise<CheckReport | null> {
  const check = await prisma.securityCheck.findFirst({
    where: { id: checkId, organisationId, requestedById: userId },
    select: {
      id: true,
      status: true,
      postedAt: true,
      summary: true,
      createdAt: true,
      startedAt: true,
      finishedAt: true,
      target: { select: { id: true, kind: true, value: true, input: true, verifiedAt: true, previewSummary: true } },
      items: {
        where: { kind: "check" },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, title: true, status: true },
      },
    },
  });
  if (!check) return null;

  const parts = check.items.map(({ id, title, status }) => ({ id, title, status }));
  const base: ReportBase = {
    checkId: check.id,
    // While ownership proof is off (14 Nov plan), a check still marked as waiting for it is simply waiting to start.
    status: check.status === "awaiting_ownership" && isTargetProven(check.target) ? "queued" : check.status,
    createdAt: check.createdAt,
    startedAt: check.startedAt,
    finishedAt: check.finishedAt,
    target: {
      id: check.target.id,
      kind: check.target.kind,
      value: check.target.value,
      input: check.target.input,
      verified: check.target.verifiedAt !== null,
    },
    parts,
    progress: partsProgress(parts),
  };

  // Not posted yet: progress and the quick scan only, so no result is read, not even a count.
  if (!isReportPosted(check)) return { ...base, posted: false, quickScan: readQuickScan(check.target.previewSummary) };

  // Every finding, in full: the report is free.
  const rows = await prisma.securityCheckResult.findMany({
    where: { checkId: check.id },
    select: {
      id: true,
      itemId: true,
      severity: true,
      createdAt: true,
      title: true,
      description: true,
      ...FINDING_OF_RESULT,
      item: { select: { title: true } },
    },
  });
  // "How to fix" only for the findings the client paid to have fixed.
  const paid = rows.filter((row) => fixOf(row.finding)).map((row) => row.id);
  const howToFix = paid.length
    ? new Map(
        (
          await prisma.securityCheckResult.findMany({ where: { id: { in: paid } }, select: { id: true, howToFix: true } })
        ).map((row) => [row.id, row.howToFix]),
      )
    : new Map<string, string>();

  return {
    ...base,
    posted: true,
    summary: check.summary,
    counts: countBySeverity(rows),
    total: rows.length,
    clearParts: clearPartTitles(parts, rows),
    findings: worstFirst(rows).map(
      (row): ReportFinding => ({
        id: row.id,
        severity: row.severity,
        area: row.item.title,
        title: row.title,
        description: row.description,
        howToFix: howToFix.get(row.id) ?? null,
        fix: fixOf(row.finding),
      }),
    ),
  };
}
