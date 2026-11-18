import type { Prisma, PrismaClient, SecurityCheckStatus, SecuritySeverity } from "@prisma/client";
import { award } from "@/lib/points/award";
import { logger } from "@/lib/logger";
import { ON_CALL_QUIET_AFTER_MS, SEVERITY_PRICE, ZIKI_SECURITY_AGENT_USERNAME, agentsMayWork, fallbackWindowMs, ownershipProofRequired, provenTargetWhere } from "@/lib/security-checks";
import { cleanParts, planParts, writeSummary, type PageReader, type PlannedPart, type SecurityAi } from "./ai";
import { pickAgentFor, type CandidateAgent } from "./assign";
import { quickScanForAgents, type QuickScanLine } from "./preview-summary";
import { fixBucketOf } from "./fix-bucket";
import { realNetwork } from "./ownership";

/**
 * The security check engine (#security-checks, 12 Nov plan H1).
 *
 * 1. The check starts as soon as it is added (14 Nov plan: no proof while
 *    `SECURITY_OWNERSHIP_PROOF_REQUIRED` is off; with it on, once ownership is
 *    proven) with `startCheck`, called when it is added, or by the sweep: Ziki's own AI splits it into parts. It is
 *    not an agent and earns nothing.
 * 2. Each part goes to a security-cleared agent (its owner's `User.securityClearedAt`)
 *    when that agent asks for security work (`listAgentJobs`), never pushed by the
 *    sweep: an agent that only does normal Ziki work would hold a part it never sees
 *    (16 Nov call). On-call agents first, then agents in the client's workspace, then
 *    the least busy. A few parts at a time each.
 * 3. Each part's agent reports what it found. Each result's price is set from
 *    its severity (`SEVERITY_PRICE`).
 * 4. When every part is in, Ziki's AI writes the summary from severities and
 *    titles only, and the report is posted (`postedAt`, `done`). Only then
 *    does the client see anything.
 * 5. A part not reported within JOB_TIMEOUT_MINUTES goes back to waiting, for
 *    another agent.
 * 6. When the client unlocks a finding, the agent that found it earns its price,
 *    once (`payoutReleasedAt`, source key `security-finding:<resultId>`). Free
 *    scans that are never unlocked pay nobody.
 *
 * Every state change is a conditional update checked by its count, because the
 * sweep, an agent asking for work and the timeout can reach the same row. AI
 * calls never run inside a transaction. Results are private: nothing here logs
 * or publishes their text.
 */

type Db = PrismaClient | Prisma.TransactionClient;
type Tx = Prisma.TransactionClient;
type Transactional = Pick<PrismaClient, "$transaction">;
type EngineDb = Db & Transactional;

export const JOB_TIMEOUT_MINUTES = 60;
/** How many open parts one agent may hold, so a check's parts spread across agents. */
export const MAX_OPEN_JOBS_PER_AGENT = 2;
/** A split or summary whose run crashed is retried after this long. */
export const STUCK_AFTER_MINUTES = 10;
export const MAX_RESULTS_PER_PART = 20;
/**
 * Ziki's list is where a check starts; an agent that finds something worth looking at that no part covers
 * may add parts with its report (15 Nov call). A few per report, and a ceiling per check so it can't grow for ever.
 */
export const MAX_MORE_PARTS_PER_REPORT = 3;
/** How many earlier findings one recheck part may hold on a rescan (#security-rescan): one area's worth. */
export const MAX_RECHECKS_PER_PART = 40;
export const MAX_PARTS_PER_CHECK = 40;
/**
 * Shown on Your work until it moves to per-finding earnings (12 Nov plan C1).
 * Parts no longer pay by themselves: the finder of each unlocked finding earns its price.
 */
export const SPLIT_JOB_POINTS = 5;
export const PART_JOB_POINTS = 3;

export class SecurityJobError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SecurityJobError";
  }
}

/** Source key for a finding's pay: one per finding, so it pays once. */
export function findingSourceKey(resultId: string): string {
  return `security-finding:${resultId}`;
}

/** Dependencies for the AI steps; real ones by default, fakes in tests. */
export type EngineDeps = { ai?: SecurityAi | null; readPage?: PageReader | null };

/** Reads a target's public home page through the ownership step's safe network: public addresses only, one same-site redirect. */
export const readPublicPage: PageReader = async (url) => {
  try {
    let res = await realNetwork.get(url);
    if (res.status >= 300 && res.status < 400 && res.location) {
      const next = new URL(res.location, url);
      if (next.hostname.replace(/^www\./, "") !== new URL(url).hostname.replace(/^www\./, "")) return null;
      res = await realNetwork.get(next.toString());
    }
    return res.status === 200 ? res.body : null;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// 1. Starting a check: Ziki's AI splits it.

/**
 * Starts a proven check: claims it (`queued` → `splitting`), has Ziki's AI plan
 * the parts outside any transaction, then saves them and moves it to
 * `checking`. Also starts a check whose earlier split crashed (`splitting`, no
 * parts, started more than STUCK_AFTER_MINUTES ago). True when it started.
 *
 * The ownership step calls this right after proof, so a check starts in
 * seconds; run it after the response (Next's `after()`), not inside it.
 */
export async function startCheck(db: EngineDb, checkId: string, now = new Date(), deps: EngineDeps = {}): Promise<boolean> {
  const stuckBefore = new Date(now.getTime() - STUCK_AFTER_MINUTES * 60_000);
  const { count } = await db.securityCheck.updateMany({
    where: {
      id: checkId,
      ...provenTargetWhere(),
      OR: [
        { status: { in: startableStatuses() } },
        { status: "splitting", startedAt: { lt: stuckBefore }, items: { none: { kind: "check" } } },
      ],
    },
    data: { status: "splitting", startedAt: now },
  });
  if (count !== 1) return false;

  let saved: boolean;
  try {
    const check = await db.securityCheck.findUnique({
      where: { id: checkId },
      select: { previousCheckId: true, organisationId: true, requestedById: true, targetId: true, target: { select: { kind: true, value: true } } },
    });
    if (!check) return false;
    // A rescan (#security-rescan) starts from what was found before: those findings are rechecked, and the new parts look past them.
    const earlier = check.previousCheckId ? await openEarlierFindings(db, check, checkId) : [];
    const { parts } = await planParts(check.target, {
      ai: deps.ai,
      readPage: deps.readPage === undefined ? readPublicPage : deps.readPage,
      earlier: earlier.map((finding) => finding.title),
    });
    const rechecks = recheckParts(earlier);

    saved = await db.$transaction(async (tx) => {
      const { count: still } = await tx.securityCheck.updateMany({
        where: { id: checkId, status: "splitting", startedAt: now, items: { none: { kind: "check" } } },
        data: { status: "checking" },
      });
      if (still !== 1) return false;
      for (const part of rechecks) {
        const created = await tx.securityCheckItem.create({
          data: { checkId, kind: "check", title: part.title, instructions: part.instructions },
          select: { id: true },
        });
        await tx.securityCheckResult.updateMany({ where: { id: { in: part.resultIds } }, data: { recheckItemId: created.id } });
      }
      await tx.securityCheckItem.createMany({
        data: parts.map((part) => ({ checkId, kind: "check" as const, title: part.title, instructions: part.instructions })),
      });
      return true;
    });
  } catch (error) {
    // Claimed but never split: give it back to waiting now, so the next sweep starts it again, instead of
    // leaving it on "Planning the checks" until the stuck-split recovery (STUCK_AFTER_MINUTES).
    await db.securityCheck.updateMany({ where: { id: checkId, status: "splitting", startedAt: now, items: { none: { kind: "check" } } }, data: { status: "queued", startedAt: null } }).catch(() => undefined);
    throw error;
  }
  // The parts wait for agents that ask for work (they ask every few seconds); none are pushed (16 Nov call).
  return saved;
}

/** An earlier finding a rescan looks at again, with the area (part title) that found it. */
export type EarlierFinding = { id: string; title: string; area: string };

/**
 * The findings a rescan rechecks (#security-rescan): every finding on this person's earlier scans of the same site,
 * in the same workspace, that no rescan has called fixed. Removed scans don't count. A finding already sent to fix
 * whose fix is still in progress is skipped (18 Nov): its issue is being worked on, so checking it again tells
 * nobody anything. Once that issue is resolved or closed, the next rescan rechecks it, which confirms the fix.
 */
export async function openEarlierFindings(
  db: Db,
  check: { organisationId: string; requestedById: string; targetId: string },
  excludeCheckId: string,
): Promise<EarlierFinding[]> {
  const rows = await db.securityCheckResult.findMany({
    where: {
      checkId: { not: excludeCheckId },
      check: { organisationId: check.organisationId, requestedById: check.requestedById, targetId: check.targetId, status: { not: "cancelled" } },
      OR: [{ recheckState: null }, { recheckState: "still_there" }],
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      title: true,
      item: { select: { title: true } },
      finding: { select: { bug: { select: { status: true, isDeleted: true } }, idea: { select: { status: true, isDeleted: true } } } },
    },
  });
  return rows
    .filter((row) => !row.finding || fixBucketOf(row.finding) !== "fixing")
    .map((row) => ({ id: row.id, title: row.title, area: row.item.title }));
}

/** One recheck part per area of the earlier report, split so no part holds more than MAX_RECHECKS_PER_PART. */
export function recheckParts(earlier: ReadonlyArray<EarlierFinding>): { title: string; instructions: string; resultIds: string[] }[] {
  const byArea = new Map<string, string[]>();
  for (const finding of earlier) byArea.set(finding.area, [...(byArea.get(finding.area) ?? []), finding.id]);
  const parts: { title: string; instructions: string; resultIds: string[] }[] = [];
  for (const [area, ids] of byArea) {
    for (let at = 0; at < ids.length; at += MAX_RECHECKS_PER_PART) {
      parts.push({
        title: `Recheck: ${area}`.slice(0, 200),
        instructions:
          "Look again at each earlier finding this part lists (`recheck`) and answer each one in `rechecks`: `still_there` if you can still see it, `fixed` only if you checked and it's gone, with a short note of what you saw. Send no `results` here: this part only rechecks, and the scan's other parts look for anything new. Look only.",
        resultIds: ids.slice(at, at + MAX_RECHECKS_PER_PART),
      });
    }
  }
  return parts;
}

/**
 * The states a check may start from: waiting to start, and, while ownership
 * proof is off (14 Nov plan), also a check created waiting for proof, since
 * nothing will ever prove it. So a check starts as soon as it is added, whatever
 * state the add step left it in.
 */
function startableStatuses(): SecurityCheckStatus[] {
  return ownershipProofRequired() ? ["queued"] : ["queued", "awaiting_ownership"];
}

/**
 * Starts the check in the background and never throws. Call it right after a
 * check is added (inside Next's `after()`), and, with proof on, after proof.
 * If it isn't called, the sweep (every minute) starts the check anyway.
 */
export function kickCheck(db: EngineDb, checkId: string): Promise<void> {
  return startCheck(db, checkId).then(
    () => undefined,
    () => logger.error("[security-checks] starting a check failed; the sweep retries it"),
  );
}

/** Starts every proven check still waiting, and any whose split crashed. A few per sweep. */
export async function startWaitingChecks(db: EngineDb, now = new Date(), deps: EngineDeps = {}): Promise<number> {
  const stuckBefore = new Date(now.getTime() - STUCK_AFTER_MINUTES * 60_000);
  const waiting = await db.securityCheck.findMany({
    where: {
      ...provenTargetWhere(),
      OR: [{ status: { in: startableStatuses() } }, { status: "splitting", startedAt: { lt: stuckBefore }, items: { none: { kind: "check" } } }],
    },
    orderBy: { createdAt: "asc" },
    select: { id: true },
    take: 5,
  });
  let started = 0;
  for (const { id } of waiting) if (await startCheck(db, id, now, deps)) started++;
  return started;
}

// ---------------------------------------------------------------------------
// 2. Parts go back when an agent sits on them, or when the check stopped.

/**
 * Takes back parts not reported in time, and skips open jobs that no longer
 * apply: those of cancelled checks, and the old split and collate jobs
 * (Ziki's AI does both now).
 */
export async function reclaimStaleJobs(db: Db, now = new Date()): Promise<{ reclaimed: number; skipped: number }> {
  const cutoff = new Date(now.getTime() - JOB_TIMEOUT_MINUTES * 60_000);
  const reclaimed = await db.securityCheckItem.updateMany({
    where: { kind: "check", status: "checking", assignedAt: { lt: cutoff } },
    data: { status: "waiting", agentId: null, assignedAt: null },
  });
  const skipped = await db.securityCheckItem.updateMany({
    where: {
      status: { in: ["waiting", "checking"] },
      OR: [{ check: { status: "cancelled" } }, { kind: { in: ["split", "collate"] } }],
    },
    data: { status: "skipped" },
  });
  return { reclaimed: reclaimed.count, skipped: skipped.count };
}

// ---------------------------------------------------------------------------
// 3. Waiting parts go to cleared agents.

/** Security-cleared agents that are online, not quiet and not paused, with room for another part. */
export async function availableAgents(db: Db, now = new Date(), onlyAgentId?: string): Promise<CandidateAgent[]> {
  const seenSince = new Date(now.getTime() - ON_CALL_QUIET_AFTER_MS);
  const agents = await db.agent.findMany({
    where: {
      ...(onlyAgentId ? { id: onlyAgentId } : {}),
      owner: { securityClearedAt: { not: null } },
      revokedAt: null,
      pausedAt: null,
      apiKeys: { some: { revokedAt: null, lastUsedAt: { gte: seenSince } } },
    },
    select: {
      id: true,
      owner: { select: { onCallAt: true } },
      activations: { where: { deactivatedAt: null }, select: { organisationId: true } },
      _count: { select: { securityCheckItems: { where: { status: "checking" } } } },
    },
  });
  return agents
    .map((agent) => ({
      id: agent.id,
      onCall: agent.owner.onCallAt !== null,
      organisationIds: agent.activations.map((a) => a.organisationId),
      openJobs: agent._count.securityCheckItems,
    }))
    .filter((agent) => agent.openJobs < MAX_OPEN_JOBS_PER_AGENT);
}

/**
 * Gives waiting parts, oldest first, to the agent asking for security work, if it is available and has room.
 * Only an agent that asks gets a part (16 Nov call): before, the sweep handed parts to any cleared agent seen
 * in the last 15 minutes, including ones that never ask for security work, and those parts sat for
 * JOB_TIMEOUT_MINUTES with nobody checking them.
 */
export async function assignWaitingJobs(db: Db, now: Date, agentId: string): Promise<number> {
  const agents = await availableAgents(db, now, agentId);
  if (agents.length === 0) return 0;
  // Real agents get a part only while it is young: after the fallback time only Ziki's own agent takes it
  // (lib/security-checks/fallback.ts), so an agent that keeps failing can't hold on to old parts for ever.
  const window = fallbackWindowMs();
  const waiting = await db.securityCheckItem.findMany({
    where: {
      kind: "check",
      status: "waiting",
      agentId: null,
      ...(window === null ? {} : { createdAt: { gte: new Date(now.getTime() - window) } }),
      check: { status: "checking", ...provenTargetWhere() },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, check: { select: { organisationId: true } } },
    take: agents.length * MAX_OPEN_JOBS_PER_AGENT,
  });
  let assigned = 0;
  for (const item of waiting) {
    const agent = pickAgentFor(item.check.organisationId, agents, MAX_OPEN_JOBS_PER_AGENT);
    if (!agent) break;
    const { count } = await db.securityCheckItem.updateMany({
      where: { id: item.id, status: "waiting", agentId: null },
      data: { status: "checking", agentId: agent.id, assignedAt: now },
    });
    if (count === 1) {
      agent.openJobs++;
      assigned++;
    }
  }
  return assigned;
}

// ---------------------------------------------------------------------------
// The agent's side.

export type SecurityJob = {
  id: string;
  kind: "check";
  title: string;
  instructions: string | null;
  assignedAt: Date | null;
  reportBy: Date | null;
  /** `quickScan`: what the quick browser scan already saw on this site (short titles only), so your report agrees with it where you look at the same thing. */
  check: { id: string; target: { kind: string; value: string; quickScan: QuickScanLine[] } };
  /**
   * A rescan's recheck part (#security-rescan): the earlier findings to look at again. Answer each with
   * `rechecks` in the report, `still_there` or `fixed`. Empty on every other part.
   */
  recheck: { id: string; severity: SecuritySeverity; title: string; description: string }[];
};

/** The parts this agent holds now. It is given waiting parts first if it has room. */
export async function listAgentJobs(db: Db, agentId: string, now = new Date()): Promise<SecurityJob[]> {
  await assignWaitingJobs(db, now, agentId);
  const items = await db.securityCheckItem.findMany({
    where: { agentId, status: "checking", kind: "check" },
    orderBy: [{ assignedAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      title: true,
      instructions: true,
      assignedAt: true,
      check: { select: { id: true, target: { select: { kind: true, value: true, previewSummary: true } } } },
      recheckResults: { orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, severity: true, title: true, description: true } },
    },
  });
  return items.map(({ check, recheckResults, ...item }) => ({
    ...item,
    recheck: recheckResults,
    check: { id: check.id, target: { kind: check.target.kind, value: check.target.value, quickScan: quickScanForAgents(check.target.previewSummary) } },
    kind: "check" as const,
    reportBy: item.assignedAt ? new Date(item.assignedAt.getTime() + JOB_TIMEOUT_MINUTES * 60_000) : null,
  }));
}

/** The part, if this agent holds it now and its check still allows work; otherwise a 404 or 409. */
async function heldJob(tx: Tx, agentId: string, itemId: string) {
  const item = await tx.securityCheckItem.findUnique({
    where: { id: itemId },
    select: {
      id: true,
      kind: true,
      status: true,
      agentId: true,
      checkId: true,
      check: { select: { status: true, target: { select: { verifiedAt: true } } } },
    },
  });
  if (!item || item.agentId !== agentId || item.kind !== "check") throw new SecurityJobError(404, "not_found", "No such job is held by this agent.");
  if (item.status !== "checking") throw new SecurityJobError(409, "not_held", "This job is no longer yours: it was reported, given back or timed out.");
  if (!agentsMayWork(item.check, item.check.target)) {
    throw new SecurityJobError(409, "check_closed", "This check no longer takes work.");
  }
  return item;
}

export type ResultInput = { severity: SecuritySeverity; title: string; description: string; howToFix: string };

/** A recheck part's answer for one earlier finding (#security-rescan). */
export type RecheckInput = { id: string; state: "still_there" | "fixed"; note?: string };

/**
 * A part's report: stores what was found (possibly nothing), each priced by
 * its severity, and any more parts the agent asks for (`moreParts`: new, not already
 * on the check, a few per report, up to MAX_PARTS_PER_CHECK in all). They are saved
 * in the same step as the report, while the agent's own part is still the one holding the
 * check open, so a check never finishes with parts waiting to be saved. When it is the last
 * part, the caller posts the report (`postReportIfComplete`) after this returns.
 */
export async function submitReport(
  db: Transactional,
  agentId: string,
  itemId: string,
  results: ResultInput[],
  now = new Date(),
  moreParts: ReadonlyArray<PlannedPart> = [],
  rechecks: ReadonlyArray<RecheckInput> = [],
) {
  if (results.length > MAX_RESULTS_PER_PART) {
    throw new SecurityJobError(400, "too_many_results", `Report at most ${MAX_RESULTS_PER_PART} problems for one part.`);
  }
  return db.$transaction(async (tx) => {
    const item = await heldJob(tx, agentId, itemId);
    // A rescan's recheck part answers for the earlier findings it holds, and only those.
    const held = await tx.securityCheckResult.findMany({ where: { recheckItemId: itemId }, select: { id: true } });
    const heldIds = new Set(held.map((row) => row.id));
    const stray = rechecks.find((answer) => !heldIds.has(answer.id));
    if (stray) throw new SecurityJobError(400, "not_in_part", `Finding ${stray.id} isn't one this part rechecks.`);
    // A recheck part only answers for the earlier findings it holds (18 Nov): agents re-filing them as new results
    // listed every problem twice, the copies the only ones that could be ticked. New problems come from the other parts.
    if (heldIds.size > 0 && results.length > 0) {
      throw new SecurityJobError(
        400,
        "recheck_only",
        "This part only rechecks earlier findings: answer each one in `rechecks` (`still_there` or `fixed`) and send no `results`. The scan's other parts look for anything new.",
      );
    }
    const { count } = await tx.securityCheckItem.updateMany({
      where: { id: itemId, agentId, status: "checking" },
      data: { status: "done", reportedAt: now },
    });
    if (count !== 1) throw new SecurityJobError(409, "not_held", "This job is no longer yours: it was reported, given back or timed out.");
    if (results.length > 0) {
      await tx.securityCheckResult.createMany({
        data: results.map((r) => ({
          checkId: item.checkId,
          itemId,
          severity: r.severity,
          title: r.title,
          description: r.description,
          howToFix: r.howToFix,
          priceCoins: SEVERITY_PRICE[r.severity],
        })),
      });
    }
    if (heldIds.size > 0) {
      const answers = new Map(rechecks.map((answer) => [answer.id, answer]));
      for (const id of heldIds) {
        // One left out counts as still there: a security problem isn't called fixed unless someone saw it gone.
        const answer = answers.get(id);
        await tx.securityCheckResult.update({
          where: { id },
          data: { recheckState: answer?.state ?? "still_there", recheckNote: answer?.note || null, recheckedAt: now, recheckCheckId: item.checkId },
        });
      }
    }
    const addedParts = await addMoreParts(tx, item.checkId, moreParts);
    return { checkId: item.checkId, results: results.length, rechecked: heldIds.size, addedParts };
  });
}

/** Saves the parts an agent asked to add: only new titles, a few per report, within the check's ceiling. Returns how many. */
async function addMoreParts(tx: Tx, checkId: string, asked: ReadonlyArray<PlannedPart>): Promise<number> {
  if (asked.length === 0) return 0;
  const existing = await tx.securityCheckItem.findMany({ where: { checkId, kind: "check" }, select: { title: true } });
  const taken = new Set(existing.map((part) => part.title.trim().toLowerCase()));
  const room = Math.max(0, MAX_PARTS_PER_CHECK - existing.length);
  const fresh = cleanParts(asked)
    .filter((part) => !taken.has(part.title.toLowerCase()))
    .slice(0, Math.min(MAX_MORE_PARTS_PER_REPORT, room));
  if (fresh.length === 0) return 0;
  await tx.securityCheckItem.createMany({
    data: fresh.map((part) => ({ checkId, kind: "check" as const, title: part.title, instructions: part.instructions })),
  });
  return fresh.length;
}

/** Gives a part back for another agent. */
export async function releaseJob(db: Db, agentId: string, itemId: string): Promise<void> {
  const { count } = await db.securityCheckItem.updateMany({
    where: { id: itemId, agentId, status: "checking" },
    data: { status: "waiting", agentId: null, assignedAt: null },
  });
  if (count !== 1) throw new SecurityJobError(409, "not_held", "This job is not held by this agent.");
}

// ---------------------------------------------------------------------------
// 4. Posting the report: Ziki's AI writes the summary.

/**
 * Once the check has parts and none is still open, posts the report: claims it
 * (`collatingAt`, or a claim older than STUCK_AFTER_MINUTES), has Ziki's AI
 * write the summary outside any transaction from severities and titles only,
 * then marks the check `done` with `postedAt`. True when this call posted it.
 */
export async function postReportIfComplete(db: EngineDb, checkId: string, now = new Date(), deps: EngineDeps = {}): Promise<boolean> {
  const [open, parts] = await Promise.all([
    db.securityCheckItem.count({ where: { checkId, kind: "check", status: { in: ["waiting", "checking"] } } }),
    db.securityCheckItem.count({ where: { checkId, kind: "check" } }),
  ]);
  if (open > 0 || parts === 0) return false;
  const stuckBefore = new Date(now.getTime() - STUCK_AFTER_MINUTES * 60_000);
  const { count } = await db.securityCheck.updateMany({
    where: { id: checkId, status: "checking", postedAt: null, OR: [{ collatingAt: null }, { collatingAt: { lt: stuckBefore } }] },
    data: { collatingAt: now },
  });
  if (count !== 1) return false;

  const check = await db.securityCheck.findUnique({
    where: { id: checkId },
    select: {
      target: { select: { kind: true, value: true } },
      results: { select: { severity: true, title: true } },
      // On a rescan, the earlier findings still there count too; the fixed ones don't.
      rechecked: { where: { recheckState: "still_there" }, select: { severity: true, title: true } },
    },
  });
  if (!check) return false;
  const { summary } = await writeSummary(check.target, [...check.results, ...check.rechecked], { ai: deps.ai });

  const { count: posted } = await db.securityCheck.updateMany({
    where: { id: checkId, status: "checking", postedAt: null, collatingAt: now },
    data: { status: "done", finishedAt: now, postedAt: now, summary },
  });
  return posted === 1;
}

/** Posts every finished report not posted yet, including ones whose summary run crashed. */
export async function postFinishedReports(db: EngineDb, now = new Date(), deps: EngineDeps = {}): Promise<number> {
  const stuckBefore = new Date(now.getTime() - STUCK_AFTER_MINUTES * 60_000);
  const ready = await db.securityCheck.findMany({
    where: {
      status: "checking",
      postedAt: null,
      OR: [{ collatingAt: null }, { collatingAt: { lt: stuckBefore } }],
      items: { some: { kind: "check" }, none: { kind: "check", status: { in: ["waiting", "checking"] } } },
    },
    select: { id: true },
    take: 10,
  });
  let posted = 0;
  for (const { id } of ready) if (await postReportIfComplete(db, id, now, deps)) posted++;
  return posted;
}

// ---------------------------------------------------------------------------
// 6. Pay per finding, once the client unlocks it.

/**
 * Pays the finder of every unlocked, unpaid finding: its price, to the agent's
 * owner, in the client's workspace ledger, once (the source key and the
 * conditional `payoutReleasedAt` both guard it). The price is exact: the
 * workspace's points multiplier doesn't apply, because the finder earns what
 * the client paid.
 */
export async function payUnlockedFindings(db: EngineDb, now = new Date()): Promise<number> {
  const due = await db.securityCheckResult.findMany({
    // Ziki's own security agent (the fallback) earns nothing.
    where: { unlockedAt: { not: null }, payoutReleasedAt: null, item: { agentId: { not: null }, agent: { username: { not: ZIKI_SECURITY_AGENT_USERNAME } } } },
    select: {
      id: true,
      severity: true,
      priceCoins: true,
      check: { select: { organisationId: true } },
      item: { select: { agentId: true, agent: { select: { ownerUserId: true } } } },
    },
    take: 200,
  });
  let paid = 0;
  for (const result of due) {
    const agentId = result.item.agentId;
    const owner = result.item.agent?.ownerUserId;
    if (!agentId || !owner) continue;
    const done = await db.$transaction(async (tx) => {
      const { count } = await tx.securityCheckResult.updateMany({
        where: { id: result.id, payoutReleasedAt: null },
        data: { payoutReleasedAt: now },
      });
      if (count !== 1) return false;
      await award(tx, {
        organisationId: result.check.organisationId,
        userId: owner,
        agentId,
        bugId: null,
        role: "security_check",
        points: result.priceCoins ?? SEVERITY_PRICE[result.severity],
        sourceKey: findingSourceKey(result.id),
        exact: true,
      });
      return true;
    });
    if (done) paid++;
  }
  return paid;
}

// ---------------------------------------------------------------------------
// The sweep, run by the platform cron (every minute). It recovers and catches up;
// the fast path is startCheck after proof and agents polling for work.

export type SecurityCheckSweep = { started: number; reclaimed: number; skipped: number; posted: number; paid: number };

export async function sweepSecurityChecks(db: EngineDb, now = new Date(), deps: EngineDeps = {}): Promise<SecurityCheckSweep> {
  const started = await startWaitingChecks(db, now, deps);
  const { reclaimed, skipped } = await reclaimStaleJobs(db, now);
  // No handing out here: parts go only to agents that ask (listAgentJobs), and Ziki's own agent takes
  // any still waiting after the fallback time (fallback.ts).
  const posted = await postFinishedReports(db, now, deps);
  const paid = await payUnlockedFindings(db, now);
  return { started, reclaimed, skipped, posted, paid };
}
