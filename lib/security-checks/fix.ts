import "server-only";

import type { Prisma, PrismaClient, SecuritySeverity } from "@prisma/client";
import { z } from "zod";
import { convertClientVettedIdea } from "@/lib/agent-api/idea-verdicts";
import { issuePath } from "@/lib/issue-ref";
import { prisma } from "@/lib/prisma";
import { refOf } from "@/lib/project-paths";
import { CoinError } from "@/lib/coins/ledger";
import { payForFindings } from "@/lib/security-checks/payment";
import { createFinding, PLACEHOLDER_DESCRIPTION, PLACEHOLDER_SUMMARY, placeholderTitle } from "@/lib/security-findings";

const id = z.string().trim().min(1).max(128);
export const fixCheckId = id;
export const fixSelection = z.object({
  checkId: id,
  projectId: id,
  resultIds: z.array(id).min(1),
});

export type FixProject = { id: string; name: string };
export type FixOptions = { projects: FixProject[]; projectId: string | null };
export type FixOutcome =
  | { ok: true; created: number; reused: number; coins: number; issues: { resultId: string; number: number; href: string }[] }
  | { ok: false; error: string; canBorrow?: boolean };

type Client = { userId: string; organisationId: string; superAdmin: boolean };
type Check = { postedAt: Date | null; projectId: string | null };
/** `checkId` is the scan that found it: this one, or for a rescan an earlier scan whose finding it rechecks. */
type Result = { id: string; checkId: string; severity: SecuritySeverity; finding: { bug: { number: number } | null } | null };

const unavailable = { ok: false, error: "This check is unavailable in your workspace." } as const;


// Workspace members can contribute to its projects under the board's existing
// access rules. Recheck membership in the same query that scopes the project.
function eligibleProjects(client: Client): Prisma.ProjectWhereInput {
  return {
    organisationId: client.organisationId,
    archivedAt: null,
    organisation: {
      archivedAt: null,
      ...(client.superAdmin ? {} : { memberships: { some: { userId: client.userId } } }),
    },
  };
}

export async function listFixProjects(client: Client, checkId: string, db = prisma): Promise<FixOptions | null> {
  const check = await db.securityCheck.findFirst({
    where: {
      id: checkId,
      requestedById: client.userId,
      organisationId: client.organisationId,

    },
    select: { postedAt: true, projectId: true },
  });
  // A finding can be sent as soon as its part is done (16 Nov call); a result exists only once reported.
  if (!check) return null;
  const projects = await db.project.findMany({
    where: { ...eligibleProjects(client), ...(check.projectId ? { id: check.projectId } : {}) },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    select: { id: true, name: true },
  });
  return { projects, projectId: check.projectId };
}

export async function sendCheckFindings(
  client: Client,
  selection: z.infer<typeof fixSelection>,
  db: Pick<PrismaClient, "$transaction"> = prisma,
): Promise<FixOutcome> {
  const { checkId, projectId } = selection;
  const resultIds = [...new Set(selection.resultIds)];
  return db.$transaction(async (tx) => {
    // The check row serializes all submissions for this report. A waiter reads
    // the committed destination and finding links after the preceding commit.
    const [check] = await tx.$queryRaw<Check[]>`
      SELECT "postedAt", "projectId" FROM "SecurityCheck"
      WHERE "id" = ${checkId} AND "organisationId" = ${client.organisationId}
        AND "requestedById" = ${client.userId}
      FOR NO KEY UPDATE
    `;
    if (!check) return unavailable;
    const project = await tx.project.findFirst({
      where: { ...eligibleProjects(client), id: projectId },
      select: { slug: true, organisation: { select: { slug: true } } },
    });
    if (!project) return { ok: false, error: "Choose an available project in this workspace." };
    if (check.projectId && check.projectId !== projectId) {
      return { ok: false, error: "This check already has a destination project. Refresh and choose that project." };
    }

    // This check's own findings, and on a rescan the earlier findings it rechecks and didn't find fixed (18 Nov, Tolu):
    // a problem still there can be sent to fix from the rescan. The rescan's own part holds them, so they're this
    // person's, in this workspace, through the check row locked above.
    const results = await tx.securityCheckResult.findMany({
      where: {
        id: { in: resultIds },
        OR: [{ checkId }, { recheckItem: { checkId }, NOT: { recheckState: "fixed" } }],
      },
      select: { id: true, checkId: true, severity: true, finding: { select: { bug: { select: { number: true } } } } },
    });
    if (results.length !== resultIds.length) {
      return { ok: false, error: "One or more selected findings are unavailable in this check." };
    }

    // The findings being sent are paid for in Ziks from the client's wallet, in this same transaction, all in one
    // payment whichever scan found them. Short of Ziks, nothing is charged, unlocked or created.
    let paid;
    try {
      const sources = [...new Set(results.map((result) => result.checkId))];
      paid = await payForFindings(tx, client.userId, sources, results.filter((result) => !result.finding).map((result) => result.id));
    } catch (error) {
      if (error instanceof CoinError && error.code === "closed") return { ok: false, error: "These findings changed while you were sending them. Try again." };
      throw error;
    }
    if (!paid.ok) {
      return { ok: false, error: `You need ${paid.needed.toLocaleString("en-US")} Ziks to send these findings and have ${paid.balance.toLocaleString("en-US")}. Buy Ziks on your Ziks page.`, canBorrow: paid.canBorrow };
    }
    const { coins } = paid;

    let created = 0;
    const issues: { resultId: string; number: number; href: string }[] = [];
    for (const result of results) {
      const number = result.finding
        ? result.finding.bug?.number
        : await createResultIssue(tx, client, projectId, result.checkId, result);
      if (!result.finding) created += 1;
      if (number !== undefined) issues.push({ resultId: result.id, number, href: issuePath(refOf(project), number) });
    }
    if (!check.projectId) await tx.securityCheck.update({ where: { id: checkId }, data: { projectId } });
    return { ok: true, created, reused: results.length - created, coins, issues };
  }, { timeout: 30_000, isolationLevel: "ReadCommitted" });
}

async function createResultIssue(tx: Prisma.TransactionClient, client: Client, projectId: string, checkId: string, result: Result) {
  const scope = { organisationId: client.organisationId, projectId };
  const title = placeholderTitle(result.severity);
  const idea = await tx.idea.create({
    data: {
      ...scope,
      reporterId: client.userId,
      beneficiaryUserId: client.userId,
      title,
      summary: PLACEHOLDER_SUMMARY,
      description: PLACEHOLDER_DESCRIPTION,
    },
    select: { id: true },
  });
  const finding = await createFinding(tx, {
    ...scope,
    ideaId: idea.id,
    reporterId: client.userId,
    severity: result.severity,
    title,
    description: PLACEHOLDER_DESCRIPTION,
  });
  // Copy private text inside PostgreSQL. It never becomes a query parameter,
  // a client response, or an input to shared issue and event code.
  const copied = await tx.$executeRaw`
    UPDATE "SecurityFinding" AS f
    SET "title" = r."title",
        "description" = CASE WHEN r."howToFix" = '' THEN r."description"
          ELSE r."description" || E'\\n\\n## How to fix\\n\\n' || r."howToFix" END
    FROM "SecurityCheckResult" AS r
    WHERE f."id" = ${finding.id} AND r."id" = ${result.id} AND r."checkId" = ${checkId}
  `;
  if (copied !== 1) throw new Error("Security finding could not be linked.");
  const issue = await convertClientVettedIdea(tx, scope, idea.id, client.userId);
  await tx.securityCheckResult.update({ where: { id: result.id }, data: { findingId: finding.id } });
  return issue.issueNumber;
}
