import { randomBytes } from "node:crypto";
import { Prisma, type SecurityCheckStatus, type SecuritySeverity, type SecurityTargetKind } from "@prisma/client";
import { SECURITY_SEVERITIES } from "@/lib/security-severity";
import { prisma } from "@/lib/prisma";
import type { PreviewSummary } from "./preview-summary";
import { SECURITY_CHECK_PRICE_COINS, FINISHED_CHECK_STATUSES, FREE_SCANS_PER_WORKSPACE_PER_MONTH, freeScanAllowed, freeScanMonthStart, ownershipProofRequired } from "@/lib/security-checks";
import type { ParsedTarget } from "@/lib/security-checks/target";

/**
 * Adding something to check (#security-checks, part 1): store the target once
 * per workspace and open a check for it. Ownership (part 2), agents (part 3)
 * and the report (part 4) take it from there through the database.
 */

export type AddedCheck = {
  targetId: string;
  checkId: string;
  /** Ownership was already proven for this target, so its free scan starts straight away. */
  verified: boolean;
  /** An unfinished check for this target already existed and was reused. */
  reused: boolean;
};

/** No free scan left (#security-checks, plan C1): why, and the site's last check if it had one. */
export type RefusedCheck = {
  refused: "target_used" | "workspace_limit";
  targetId: string;
  lastCheckId: string | null;
};

/** A fresh secret for the DNS TXT record or homepage tag. */
export function newOwnershipToken(): string {
  return `ziki-verify-${randomBytes(16).toString("hex")}`;
}

/**
 * Store the target (or reuse the workspace's existing one) and open a free
 * check (#security-checks, plan C1). The person's own unfinished check on that
 * target is reused rather than opening a second one. Checks are per person:
 * someone else in the workspace gets their own.
 *
 * Every check is free, within limits: a site gets one free scan, and a
 * workspace gets FREE_SCANS_PER_WORKSPACE_PER_MONTH a month. Past either, no
 * check is opened and the client is told why. Clients pay per finding, when
 * they unlock its fix.
 */
export async function addTargetAndCheck(
  organisationId: string,
  userId: string,
  target: ParsedTarget,
  now = new Date(),
): Promise<AddedCheck | RefusedCheck> {
  const stored = await findOrCreateTarget(organisationId, userId, target);
  const verified = stored.verifiedAt !== null;

  const open = await prisma.securityCheck.findFirst({
    where: { targetId: stored.id, organisationId, requestedById: userId, status: { notIn: [...FINISHED_CHECK_STATUSES] } },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (open) return { targetId: stored.id, checkId: open.id, verified, reused: true };

  const [targetFreeScans, workspaceFreeScansThisMonth] = await Promise.all([
    prisma.securityCheck.count({ where: { targetId: stored.id, free: true } }),
    prisma.securityCheck.count({ where: { organisationId, free: true, createdAt: { gte: freeScanMonthStart(now) } } }),
  ]);
  const answer = freeScanAllowed({ targetFreeScans, workspaceFreeScansThisMonth });
  if (!answer.allowed) {
    const last = await prisma.securityCheck.findFirst({
      where: { targetId: stored.id, organisationId, requestedById: userId },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    return { refused: answer.reason, targetId: stored.id, lastCheckId: last?.id ?? null };
  }

  const check = await prisma.securityCheck.create({
    data: {
      organisationId,
      targetId: stored.id,
      requestedById: userId,
      free: true,
      priceCoins: SECURITY_CHECK_PRICE_COINS,
      // A target proven once never asks again: its new checks are ready for agents.
      // No proof step while it's switched off (14 Nov plan): the check is queued at once.
      status: verified || !ownershipProofRequired() ? "queued" : "awaiting_ownership",
    },
    select: { id: true },
  });
  return { targetId: stored.id, checkId: check.id, verified, reused: false };
}

/** What to tell the client when there's no free scan left, in plain words. */
export function refusedMessage(refused: RefusedCheck["refused"], site: string, now = new Date()): string {
  if (refused === "target_used") return `${site} has already been scanned. Open its report to unlock fixes.`;
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const day = next.toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });
  return `You've used this month's ${FREE_SCANS_PER_WORKSPACE_PER_MONTH} scans. More start on ${day}.`;
}

/**
 * Remove one of this person's scans (#security-checks), finished or not (15 Nov:
 * people can always remove their scans). It's cancelled, so agents stop and it
 * leaves the list; findings already moved to the app stay there. False when it
 * isn't theirs or is already removed.
 */
export async function removeOwnScan(organisationId: string, userId: string, checkId: string): Promise<boolean> {
  const removed = await prisma.securityCheck.updateMany({
    where: { id: checkId, organisationId, requestedById: userId, status: { not: "cancelled" } },
    data: { status: "cancelled" },
  });
  return removed.count > 0;
}

/**
 * A site this person has already scanned in this workspace (#security-checks):
 * its latest check that wasn't cancelled, so the same site isn't scanned again.
 */
export async function findScannedCheck(organisationId: string, userId: string, target: ParsedTarget): Promise<{ checkId: string; summary: PreviewSummary | null; finished: boolean } | null> {
  const check = await prisma.securityCheck.findFirst({
    where: {
      organisationId,
      requestedById: userId,
      status: { not: "cancelled" },
      target: { organisationId, kind: target.kind, value: target.value },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, postedAt: true, target: { select: { previewSummary: true } } },
  });
  // Its saved quick scan, so the person sees that result again instead of a new scan,
  // and whether the agents' report is posted, so the chat offers "See results" rather than "See progress".
  return check ? { checkId: check.id, summary: readQuickScan(check.target.previewSummary), finished: check.postedAt !== null } : null;
}

/**
 * Whether a fix was paid for on this site since its last quick scan (#security-rescan, 17 Nov): a finding unlocked,
 * or moved to the app, after the quick scan ran. Then scanning again looks at the site afresh instead of reusing a
 * quick scan from the last 10 minutes. True when it never had a quick scan.
 */
export async function fixPaidSinceQuickScan(target: { id: string; previewAt: Date | null }): Promise<boolean> {
  if (!target.previewAt) return true;
  const paid = await prisma.securityCheckResult.count({
    where: {
      check: { targetId: target.id },
      OR: [{ unlockedAt: { gt: target.previewAt } }, { finding: { createdAt: { gt: target.previewAt } } }],
    },
  });
  return paid > 0;
}

/** One of this person's scans in this workspace, with its site, for replacing its quick scan. */
export async function findOwnScan(organisationId: string, userId: string, checkId: string) {
  const check = await prisma.securityCheck.findFirst({
    where: { id: checkId, organisationId, requestedById: userId },
    select: { id: true, target: { select: { id: true, kind: true, value: true, previewAt: true } } },
  });
  return check
    ? { checkId: check.id, targetId: check.target.id, target: { id: check.target.id, kind: check.target.kind, value: check.target.value, previewAt: check.target.previewAt } }
    : null;
}

async function findOrCreateTarget(organisationId: string, userId: string, target: ParsedTarget) {
  const where = { organisationId_kind_value: { organisationId, kind: target.kind, value: target.value } };
  const select = { id: true, verifiedAt: true } as const;
  const existing = await prisma.securityTarget.findUnique({ where, select });
  if (existing) return existing;
  try {
    return await prisma.securityTarget.create({
      data: {
        organisationId,
        kind: target.kind,
        value: target.value,
        input: target.input,
        addedById: userId,
        ownershipToken: newOwnershipToken(),
      },
      select,
    });
  } catch (error) {
    // Two people added the same target at once: use the one that won.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const winner = await prisma.securityTarget.findUnique({ where, select });
      if (winner) return winner;
    }
    throw error;
  }
}

/** Keep the quick scan's counts with the asset (#security-checks), so the client can see it again later. Never what was found. */
export async function saveQuickScan(targetId: string, summary: PreviewSummary, now = new Date()): Promise<void> {
  await prisma.securityTarget.update({ where: { id: targetId }, data: { previewSummary: summary, previewAt: now } });
}

/** Where the client goes next for a new check: the Security page with it open, or, only while the proof step is switched on, show it's theirs. */
export function nextStepPath(check: { targetId: string; checkId: string; verified: boolean }): string {
  if (ownershipProofRequired() && !check.verified) return `/security/targets/${check.targetId}/verify`;
  return `/security?check=${encodeURIComponent(check.checkId)}`;
}

export type WorkspaceCheckRow = {
  id: string;
  targetId: string;
  kind: SecurityTargetKind;
  value: string;
  status: SecurityCheckStatus;
  verified: boolean;
  /** The report has been posted (isReportPosted), so findings can be unlocked. */
  posted: boolean;
  /** Findings reported, and how many of them the client has unlocked. */
  findings: number;
  unlocked: number;
  /** Findings already moved to the client's app as issues. */
  moved: number;
  /** The quick scan from when it was added, if any: counts and locked rows only. */
  preview: PreviewSummary | null;
  /**
   * The agents' result once the report is posted (null before): the card shows it
   * in place of the quick scan, which only stays while no agent has reported.
   */
  agentReport: AgentReport | null;
  createdAt: Date;
};

/** What a card shows of a posted report: Ziki's summary and each finding, worst first. */
export type AgentReport = {
  summary: string | null;
  findings: { id: string; severity: SecuritySeverity; title: string; unlocked: boolean; moved: boolean }[];
};

/** A posted check's findings for its card, worst first and then by id so the order never wobbles. */
export function agentReportOf(
  summary: string | null,
  results: readonly { id: string; severity: SecuritySeverity; title: string; unlockedAt: Date | null; findingId: string | null }[],
): AgentReport {
  const findings = results
    .map((result) => ({ id: result.id, severity: result.severity, title: result.title, unlocked: result.unlockedAt !== null, moved: result.findingId !== null }))
    .sort((a, b) => SECURITY_SEVERITIES.indexOf(a.severity) - SECURITY_SEVERITIES.indexOf(b.severity) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { summary, findings };
}

/** A scan's place, on its card: being checked, its report ready, or findings moved to the app (14 Nov plan, C1). */
export type ScanStage = "scanning" | "report" | "in_app" | "cancelled";

export function scanStage(check: Pick<WorkspaceCheckRow, "status" | "posted" | "moved">): ScanStage {
  if (check.status === "cancelled") return "cancelled";
  if (check.moved > 0) return "in_app";
  return check.posted ? "report" : "scanning";
}

/** Where a site was in the old steps (kept for when the proof step comes back). */
export type SiteStage = "prove" | "checking" | "fix" | "cancelled";
export const SITE_FILTERS = ["all", "prove", "checking", "fix"] as const;
export type SiteFilter = (typeof SITE_FILTERS)[number];

export function siteStage(check: Pick<WorkspaceCheckRow, "status" | "verified" | "posted">): SiteStage {
  if (check.status === "cancelled") return "cancelled";
  if (check.status === "awaiting_ownership" && !check.verified) return "prove";
  return check.posted ? "fix" : "checking";
}

export function parseSiteFilter(value: unknown): SiteFilter {
  return SITE_FILTERS.includes(value as SiteFilter) ? (value as SiteFilter) : "all";
}

/** The workspace's checks, newest first: the returning user's list on the Security page. */
export async function listWorkspaceChecks(organisationId: string, userId: string, take = 20): Promise<WorkspaceCheckRow[]> {
  const rows = await prisma.securityCheck.findMany({
    // Only the checks this person asked for: others in the workspace don't see them. A scan followed by a
    // rescan (#security-rescan) leaves the list: the site shows once, as its newest scan.
    where: { organisationId, requestedById: userId, nextCheck: { is: null } },
    orderBy: { createdAt: "desc" },
    take,
    select: {
      id: true,
      status: true,
      postedAt: true,
      summary: true,
      createdAt: true,
      target: { select: { id: true, kind: true, value: true, verifiedAt: true, previewSummary: true } },
      results: { select: { id: true, severity: true, title: true, unlockedAt: true, findingId: true } },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    targetId: row.target.id,
    kind: row.target.kind,
    value: row.target.value,
    status: row.status,
    verified: row.target.verifiedAt !== null,
    posted: row.postedAt !== null,
    findings: row.results.length,
    unlocked: row.results.filter((result) => result.unlockedAt !== null).length,
    moved: row.results.filter((result) => result.findingId !== null).length,
    preview: readQuickScan(row.target.previewSummary),
    agentReport: row.postedAt !== null ? agentReportOf(row.summary, row.results) : null,
    createdAt: row.createdAt,
  }));
}

/** A saved quick scan, read back from the database: anything that isn't one comes back as null. */
export function readQuickScan(value: unknown): PreviewSummary | null {
  if (!value || typeof value !== "object") return null;
  const summary = value as Partial<PreviewSummary>;
  if (typeof summary.target !== "string" || typeof summary.total !== "number" || !Array.isArray(summary.areas) || !summary.counts || !summary.risk) return null;
  return summary as PreviewSummary;
}
