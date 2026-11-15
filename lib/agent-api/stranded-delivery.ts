import { PRODUCT_TRACK } from "@/lib/marketing/track";
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { workflowFor } from "@/lib/workflow";
import { countJudgements, judgedBugSelect, judgementSelect } from "@/lib/agent-api/tested-status";
import { checksFor, loadProofRules } from "@/lib/proof";

/**
 * Stranded delivery (#stranded-delivery). Before delivered work was an entry
 * of its own, a pull request could be linked to an issue by hand, with nobody
 * holding a claim (assigned to a person, say). Such an issue stays In progress
 * with no delivery, and its judgements never count, because judgements only
 * count while it is Delivered.
 *
 * The rule: a manager agent files the delivery on the holder's behalf
 * (`POST /api/v1/issues/{id}/delivery`, lib/agent-api/delivery.ts), so the work
 * can be evaluated. An issue qualifies when all of these hold:
 *
 * - it is In progress and not deleted;
 * - it has a linked pull request and no delivery at all;
 * - the pull request was linked more than two hours ago (`linkedAt`: the latest
 *   `github.linked` audit row, else the earliest judgement on that pull
 *   request, else the issue's last update);
 * - someone is there to credit (`creditedUserId`): the active claim's
 *   beneficiary, else the assignee, else the owner of the agent that linked it;
 * - its good-to-merge judgements on that pull request reach the project's
 *   `verdictsNeeded`, counted exactly as they will be once it is delivered
 *   (`countJudgements`), with the credited person in the claim holder's place.
 */

type Db = PrismaClient | Prisma.TransactionClient;

/** How long a linked pull request waits before a manager may deliver it for the holder. */
export const STRANDED_AFTER_MS = 2 * 60 * 60 * 1000;

export type StrandedDelivery = {
  pullRequestUrl: string;
  /** The person the delivery is credited to. */
  creditedUserId: string;
  linkedAt: Date;
  /** Good-to-merge judgements that count on the linked pull request. */
  goodVerdicts: number;
  /** The project's required number of them. */
  needed: number;
};

/** The stranded delivery on one issue, or null when it doesn't qualify. */
export async function strandedDelivery(bugId: string, db: Db = prisma, now: Date = new Date()): Promise<StrandedDelivery | null> {
  const bug = await db.bug.findUnique({
    where: { id: bugId },
    select: { ...judgedBugSelect, isDeleted: true, updatedAt: true },
  });
  if (!bug || bug.isDeleted || bug.status !== "in_progress" || !bug.pullRequestUrl) return null;
  const pullRequestUrl = bug.pullRequestUrl;

  const delivered = await db.delivery.findFirst({ where: { bugId }, select: { id: true } });
  if (delivered) return null;

  const linked = await db.agentAuditEvent.findFirst({
    where: { bugId, action: "github.linked" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { createdAt: true, agent: { select: { ownerUserId: true } } },
  });
  const verdicts = await db.testVerdict.findMany({
    where: { bugId, pullRequestUrl },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { ...judgementSelect, createdAt: true },
  });
  const linkedAt = linked?.createdAt ?? verdicts[0]?.createdAt ?? bug.updatedAt;
  if (now.getTime() - linkedAt.getTime() <= STRANDED_AFTER_MS) return null;

  const activeClaim = bug.claims.find((claim) => claim.status === "active" && !claim.releasedAt);
  const creditedUserId = activeClaim?.beneficiaryUserId ?? bug.assigneeId ?? linked?.agent.ownerUserId ?? null;
  if (!creditedUserId) return null;

  const checks = checksFor(await loadProofRules(db, bug.organisationId), bug);
  const { good } = countJudgements(verdicts, bug, [creditedUserId], checks);
  const { verdictsNeeded } = await workflowFor(bug.projectId, db);
  if (good < verdictsNeeded) return null;

  return { pullRequestUrl, creditedUserId, linkedAt, goodVerdicts: good, needed: verdictsNeeded };
}

export type StrandedIssue = StrandedDelivery & {
  id: string;
  number: number;
  title: string;
  /** The credited person's name, for the work item. */
  creditedName: string;
};

/** Every stranded delivery in a project, oldest link first: the work feed's `deliver_stranded` items. */
export async function findStrandedDeliveries(organisationId: string, projectId: string, db: Db = prisma, now: Date = new Date()): Promise<StrandedIssue[]> {
  const candidates = await db.bug.findMany({
    where: { organisationId, projectId, ...PRODUCT_TRACK, isDeleted: false, status: "in_progress", pullRequestUrl: { not: null }, deliveries: { none: {} } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, number: true, title: true },
  });
  const found: (StrandedDelivery & { id: string; number: number; title: string })[] = [];
  for (const bug of candidates) {
    const stranded = await strandedDelivery(bug.id, db, now);
    if (stranded) found.push({ ...bug, ...stranded });
  }
  if (!found.length) return [];
  const people = await db.user.findMany({
    where: { id: { in: [...new Set(found.map((issue) => issue.creditedUserId))] } },
    select: { id: true, name: true },
  });
  const names = new Map(people.map((person) => [person.id, person.name]));
  return found
    .sort((a, b) => a.linkedAt.getTime() - b.linkedAt.getTime())
    .map((issue) => ({ ...issue, creditedName: names.get(issue.creditedUserId) ?? "a member" }));
}
