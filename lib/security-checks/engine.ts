import type { Prisma, PrismaClient, SecurityCheckStatus, SecuritySeverity } from "@prisma/client";
import { award } from "@/lib/points/award";
import { logger } from "@/lib/logger";
import { ON_CALL_QUIET_AFTER_MS, SEVERITY_PRICE, ZIKI_SECURITY_AGENT_USERNAME, agentsMayWork, fallbackWindowMs, ownershipProofRequired, provenTargetWhere } from "@/lib/security-checks";
import { planParts, writeSummary, type PageReader, type SecurityAi } from "./ai";
import { pickAgentFor, type CandidateAgent } from "./assign";
import { realNetwork } from "./ownership";

/**
 * The security check engine (#security-checks, 12 Nov plan H1).
 *
 * 1. The check starts as soon as it is added (14 Nov plan: no proof while
 *    `SECURITY_OWNERSHIP_PROOF_REQUIRED` is off; with it on, once ownership is
 *    proven) with `startCheck`, called when it is added, or by the sweep: Ziki's own AI splits it into parts. It is
 *    not an agent and earns nothing.
 * 2. Each part goes to a security-cleared agent (its owner's `User.securityClearedAt`)
 *    that is online and not quiet: on-call agents first, then agents in the
 *    client's workspace, then the least busy. A few parts at a time each.
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

  const check = await db.securityCheck.findUnique({ where: { id: checkId }, select: { target: { select: { kind: true, value: true } } } });
  if (!check) return false;
  const { parts } = await planParts(check.target, {
    ai: deps.ai,
    readPage: deps.readPage === undefined ? readPublicPage : deps.readPage,
  });

  const saved = await db.$transaction(async (tx) => {
    const { count: still } = await tx.securityCheck.updateMany({
      where: { id: checkId, status: "splitting", startedAt: now, items: { none: { kind: "check" } } },
      data: { status: "checking" },
    });
    if (still !== 1) return false;
    await tx.securityCheckItem.createMany({
      data: parts.map((part) => ({ checkId, kind: "check" as const, title: part.title, instructions: part.instructions })),
    });
    return true;
  });
  if (saved) await assignWaitingJobs(db, new Date());
  return saved;
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
 * Gives waiting parts, oldest first, to available agents. With `onlyAgentId`
 * (an agent asking for work), only that agent is considered.
 */
export async function assignWaitingJobs(db: Db, now = new Date(), onlyAgentId?: string): Promise<number> {
  const agents = await availableAgents(db, now, onlyAgentId);
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
  check: { id: string; target: { kind: string; value: string } };
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
      check: { select: { id: true, target: { select: { kind: true, value: true } } } },
    },
  });
  return items.map((item) => ({
    ...item,
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

/**
 * A part's report: stores what was found (possibly nothing), each priced by
 * its severity. When it is the last part, the caller posts the report
 * (`postReportIfComplete`) after this returns.
 */
export async function submitReport(db: Transactional, agentId: string, itemId: string, results: ResultInput[], now = new Date()) {
  if (results.length > MAX_RESULTS_PER_PART) {
    throw new SecurityJobError(400, "too_many_results", `Report at most ${MAX_RESULTS_PER_PART} problems for one part.`);
  }
  return db.$transaction(async (tx) => {
    const item = await heldJob(tx, agentId, itemId);
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
    return { checkId: item.checkId, results: results.length };
  });
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
    select: { target: { select: { kind: true, value: true } }, results: { select: { severity: true, title: true } } },
  });
  if (!check) return false;
  const { summary } = await writeSummary(check.target, check.results, { ai: deps.ai });

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

export type SecurityCheckSweep = { started: number; reclaimed: number; skipped: number; assigned: number; posted: number; paid: number };

export async function sweepSecurityChecks(db: EngineDb, now = new Date(), deps: EngineDeps = {}): Promise<SecurityCheckSweep> {
  const started = await startWaitingChecks(db, now, deps);
  const { reclaimed, skipped } = await reclaimStaleJobs(db, now);
  const assigned = await assignWaitingJobs(db, now);
  const posted = await postFinishedReports(db, now, deps);
  const paid = await payUnlockedFindings(db, now);
  return { started, reclaimed, skipped, assigned, posted, paid };
}
