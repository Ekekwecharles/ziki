import type {
  OnCallInviteStatus,
  Prisma,
  SecurityCheckItemKind,
  SecurityCheckItemStatus,
  SecurityCheckStatus,
  SecurityTargetKind,
  SecuritySeverity,
} from "@prisma/client";

/**
 * Shared words for security checks (#security-checks): a client adds a
 * website, server or repo, proves it is theirs, and agents check it and
 * report problems. Plain data with no server imports, so pages and API routes
 * use the same names. The flow and who owns which part: docs/security-checks.md.
 */

/**
 * What one check costs, in coins. Replaced by per-finding prices
 * (SEVERITY_PRICE) and removed once the pay page uses them (12 Nov plan).
 */
export const SECURITY_CHECK_PRICE_COINS = 50;

export const SECURITY_TARGET_KINDS = ["website", "server", "repo"] as const satisfies readonly SecurityTargetKind[];

export const TARGET_KIND_LABEL: Record<SecurityTargetKind, string> = {
  website: "Website",
  server: "Server",
  repo: "Code repository",
};

/** In flow order. */
export const SECURITY_CHECK_STATUSES = [
  "awaiting_ownership",
  "queued",
  "splitting",
  "checking",
  "done",
  "cancelled",
] as const satisfies readonly SecurityCheckStatus[];

/** What the client reads; never agent names or internals. */
export const CHECK_STATUS_LABEL: Record<SecurityCheckStatus, string> = {
  awaiting_ownership: "Show it's yours",
  queued: "Waiting to start",
  splitting: "Planning the checks",
  checking: "Checking",
  done: "Done",
  cancelled: "Cancelled",
};

export const SECURITY_CHECK_ITEM_KINDS = ["split", "check", "collate"] as const satisfies readonly SecurityCheckItemKind[];

export const SECURITY_CHECK_ITEM_STATUSES = ["waiting", "checking", "done", "skipped"] as const satisfies readonly SecurityCheckItemStatus[];

export const ITEM_STATUS_LABEL: Record<SecurityCheckItemStatus, string> = {
  waiting: "Waiting",
  checking: "Checking",
  done: "Done",
  skipped: "Skipped",
};

/** A check that will not change any more. */
export const FINISHED_CHECK_STATUSES: ReadonlySet<SecurityCheckStatus> = new Set(["done", "cancelled"]);

/** Agents may work on a check only in these states: ownership is proven and it is not finished. */
export const AGENT_WORKABLE_CHECK_STATUSES: ReadonlySet<SecurityCheckStatus> = new Set(["queued", "splitting", "checking"]);

export function isSecurityTargetKind(value: unknown): value is SecurityTargetKind {
  return typeof value === "string" && (SECURITY_TARGET_KINDS as readonly string[]).includes(value);
}

export function isSecurityCheckStatus(value: unknown): value is SecurityCheckStatus {
  return typeof value === "string" && (SECURITY_CHECK_STATUSES as readonly string[]).includes(value);
}

export function isSecurityCheckItemStatus(value: unknown): value is SecurityCheckItemStatus {
  return typeof value === "string" && (SECURITY_CHECK_ITEM_STATUSES as readonly string[]).includes(value);
}

/**
 * Ownership proof (14 Nov plan): OFF for now, so a person can scan anything they
 * type and we can test the whole flow and iterate on Mark's feedback. It is
 * switched off, not removed: set `SECURITY_OWNERSHIP_PROOF_REQUIRED=true` to
 * bring it back (the proof pages and checks are all still there). KYC is a
 * separate, later step.
 */
export function ownershipProofRequired(): boolean {
  return process.env.SECURITY_OWNERSHIP_PROOF_REQUIRED === "true";
}

/** Whether a target counts as proven: always, while proof is off; otherwise once `verifiedAt` is set. */
export function isTargetProven(target: { verifiedAt: Date | null }, required = ownershipProofRequired()): boolean {
  return !required || target.verifiedAt !== null;
}

/**
 * The query condition for "a proven target", to spread into a check's `where`:
 * nothing while proof is off, the `verifiedAt` test when it is on. It is the
 * query-side twin of `isTargetProven`.
 */
export function provenTargetWhere(required = ownershipProofRequired()): { target?: { verifiedAt: { not: null } } } {
  return required ? { target: { verifiedAt: { not: null } } } : {};
}

/** Whether agents may touch this check's target: never before ownership is proven (when proof is required). */
export function agentsMayWork(check: { status: SecurityCheckStatus }, target: { verifiedAt: Date | null }, required = ownershipProofRequired()): boolean {
  return isTargetProven(target, required) && AGENT_WORKABLE_CHECK_STATUSES.has(check.status);
}

/** Whether the client sees the full report (and agents get paid): only once paid. */
export function isCheckPaid(check: { paidAt: Date | null }): boolean {
  return check.paidAt !== null;
}

/**
 * Whether the client may see the check's results: only once the report
 * collating every part has been posted (#security-checks). Before
 * that the client sees progress only. The report page, its PDF and Fix on Ziki
 * all use this rule; paying (isCheckPaid) then decides teaser or full report.
 */
export function isReportPosted(check: { postedAt: Date | null }): boolean {
  return check.postedAt !== null;
}

// ---------------------------------------------------------------------------
// The 12 Nov plan (#security-checks, #on-call). The one place these numbers live.

/**
 * What one finding costs the client to unlock, in coins, and what the agent
 * that found it earns, in points: by severity. Stored on the result when it
 * is reported (SecurityCheckResult.priceCoins).
 */
export const SEVERITY_PRICE: Record<SecuritySeverity, number> = {
  critical: 5,
  high: 3,
  medium: 2,
  low: 1,
};

/** Whether the client may see a finding's details and fix: only once unlocked. */
export function isResultUnlocked(result: { unlockedAt: Date | null }): boolean {
  return result.unlockedAt !== null;
}

/** The total to unlock these findings, in coins. A result reported before per-finding prices costs its severity's price. */
export function unlockTotal(results: ReadonlyArray<{ severity: SecuritySeverity; priceCoins: number | null }>): number {
  return results.reduce((sum, r) => sum + (r.priceCoins ?? SEVERITY_PRICE[r.severity]), 0);
}

/** A target gets this many free scans. */
export const FREE_SCANS_PER_TARGET = 1;
/** A workspace may start this many free scans in one calendar month (UTC). */
export const FREE_SCANS_PER_WORKSPACE_PER_MONTH = 3;

/** The first instant of the calendar month (UTC) that `now` is in: where the monthly free-scan count starts. */
export function freeScanMonthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export type FreeScanAnswer = { allowed: true } | { allowed: false; reason: "target_used" | "workspace_limit" };

/**
 * Scan limits (14 Nov plan): OFF for now, so nothing stops a test scan. They are
 * switched off, not removed: set `SECURITY_SCAN_LIMITS_ENABLED=true` to bring
 * back the free-scan limits below. The chat's hourly message limit is separate
 * and stays.
 */
export function scanLimitsEnabled(): boolean {
  return process.env.SECURITY_SCAN_LIMITS_ENABLED === "true";
}

/**
 * Whether a new check may be free, from the free scans the target has had and
 * the free scans the workspace started this month (since freeScanMonthStart).
 * Always allowed while the limits are off.
 */
export function freeScanAllowed(counts: { targetFreeScans: number; workspaceFreeScansThisMonth: number }, enabled = scanLimitsEnabled()): FreeScanAnswer {
  if (!enabled) return { allowed: true };
  if (counts.targetFreeScans >= FREE_SCANS_PER_TARGET) return { allowed: false, reason: "target_used" };
  if (counts.workspaceFreeScansThisMonth >= FREE_SCANS_PER_WORKSPACE_PER_MONTH) return { allowed: false, reason: "workspace_limit" };
  return { allowed: true };
}

/**
 * Who adds assets and starts checks (13 Nov): the workspace's owners and
 * admins, who own the assets. Everyone else in the workspace only sees their
 * own security work ("Your work").
 */
export const OWNERS_ONLY_MESSAGE = "Only workspace owners and admins can add assets and start checks. You can see your own work under Your work.";

/** Preview scans (code only, blurred) one visitor may run from the public page in an hour. */
export const PREVIEW_SCANS_PER_VISITOR_PER_HOUR = 5;

/** Ziki's own security agent (14 Nov call): it does the parts nobody picks up in time. It has no key, is never listed and earns nothing. */
export const ZIKI_SECURITY_AGENT_USERNAME = "ziki-security";
/** A part nobody has taken in this long is done by Ziki's own security agent, so a client always gets a result. */
export const FALLBACK_AFTER_MINUTES = 5;

/**
 * How long a part waits for an agent before Ziki's own does it, in ms: 5 minutes,
 * or `SECURITY_FALLBACK_AFTER_MINUTES`. 0 (or below) turns the fallback off.
 */
export function fallbackAfterMs(env: Record<string, string | undefined> = process.env): number | null {
  const raw = env.SECURITY_FALLBACK_AFTER_MINUTES?.trim();
  const minutes = raw ? Number(raw) : Number.NaN;
  if (Number.isNaN(minutes)) return FALLBACK_AFTER_MINUTES * 60_000;
  return minutes > 0 ? minutes * 60_000 : null;
}

/**
 * How long real agents have to take a part before only Ziki's own agent may (the
 * fallback time), or null when they may take it whenever it waits. It only applies
 * while the fallback can run (it needs Ziki's AI key). Without it an agent that
 * takes a part and gives it straight back (no Claude credit, say) would keep every
 * old part for itself, and the fallback would never find it waiting.
 */
export function fallbackWindowMs(env: Record<string, string | undefined> = process.env): number | null {
  if (!env.ZIKI_CLAUDE_API_KEY?.trim()) return null;
  return fallbackAfterMs(env);
}

/** At most this many on-call guests join a new workspace. */
export const ON_CALL_GUESTS_PER_NEW_WORKSPACE = 3;
/** An on-call agent not seen for this long has gone quiet: flagged, and given no new work until it's back. */
export const ON_CALL_QUIET_AFTER_MS = 15 * 60 * 1000;

export const ON_CALL_INVITE_STATUSES = ["pending", "accepted", "declined", "cancelled"] as const satisfies readonly OnCallInviteStatus[];

/** Whether an on-call agent has gone quiet: not seen for ON_CALL_QUIET_AFTER_MS. Never seen counts as quiet. */
export function isQuiet(lastSeenAt: Date | null, now = new Date()): boolean {
  return lastSeenAt === null || now.getTime() - lastSeenAt.getTime() >= ON_CALL_QUIET_AFTER_MS;
}

/** Whether an agent's owner is cleared, so the agent may get security-check jobs and read results: site-wide clearance, per person. */
export function isSecurityCleared(person: { securityClearedAt: Date | null }): boolean {
  return person.securityClearedAt !== null;
}
