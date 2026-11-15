import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { DateRange } from "@/lib/dashboard-range";

/**
 * Every figure on an organisation's overview (/org), aggregated in Postgres.
 * Every query is filtered by that organisation's id: no figure may count
 * another organisation's issues.
 *
 * Nothing here loads rows into JavaScript to count them: on a busy tracker
 * the issue table is the one thing guaranteed to grow, and a page that reads
 * all of it to draw a bar chart gets slower exactly as it gets useful.
 */

export type StatusCount = { status: string; count: number };
export type WeekPoint = { week: Date; opened: number; closed: number };
export type Breakdown = { label: string; count: number };

export type DashboardData = {
  byStatus: StatusCount[];
  weekly: WeekPoint[];
  medianFirstResponseSeconds: number | null;
  medianResolutionSeconds: number | null;
  byProject: Breakdown[];
  byType: Breakdown[];
  totalOpened: number;
  totalClosed: number;
};

/** Rows come back from $queryRaw as bigint for counts; normalise once. */
const num = (value: unknown): number =>
  typeof value === "bigint" ? Number(value) : Number(value ?? 0);

const maybeNum = (value: unknown): number | null =>
  value === null || value === undefined ? null : num(value);

/**
 * The moment each issue was first resolved or closed, derived from the
 * activity log: there is no resolvedAt column, and the issue's own
 * updatedAt moves on every later edit, so it cannot stand in for one.
 */
const FIRST_CLOSE = Prisma.sql`
  SELECT a."bugId" AS bug_id, MIN(a."createdAt") AS closed_at
  FROM "BugActivity" a
  WHERE a.type = 'status_changed'
    AND a.metadata ->> 'to' IN ('resolved', 'on_dev', 'on_staging', 'on_prod', 'published', 'force_merged', 'closed')
  GROUP BY a."bugId"
`;

export async function fetchDashboard(organisationId: string, range: DateRange): Promise<DashboardData> {
  const { from, to } = range;

  const [byStatus, weekly, medians, byProject, byType] =
    await Promise.all([
      prisma.$queryRaw<{ status: string; count: bigint }[]>`
        SELECT b.status::text AS status, COUNT(*) AS count
        FROM "Bug" b
        WHERE b."isDeleted" = false AND b."track" = 'product'
          AND b."organisationId" = ${organisationId}
          AND b."createdAt" >= ${from} AND b."createdAt" < ${to}
        GROUP BY b.status
        ORDER BY b.status
      `,

      // One row per week in range, even where nothing happened, so the chart
      // shows a gap rather than quietly closing it up.
      prisma.$queryRaw<{ week: Date; opened: bigint; closed: bigint }[]>`
        WITH weeks AS (
          SELECT generate_series(
            date_trunc('week', ${from}::timestamptz),
            date_trunc('week', (${to}::timestamptz - interval '1 day')),
            interval '1 week'
          ) AS week
        ),
        opened AS (
          SELECT date_trunc('week', b."createdAt") AS week, COUNT(*) AS n
          FROM "Bug" b
          WHERE b."isDeleted" = false AND b."track" = 'product'
            AND b."organisationId" = ${organisationId}
            AND b."createdAt" >= ${from} AND b."createdAt" < ${to}
          GROUP BY 1
        ),
        closed AS (
          SELECT date_trunc('week', fc.closed_at) AS week, COUNT(*) AS n
          FROM (${FIRST_CLOSE}) fc
          JOIN "Bug" b ON b.id = fc.bug_id AND b."isDeleted" = false AND b."track" = 'product' AND b."organisationId" = ${organisationId}
          WHERE fc.closed_at >= ${from} AND fc.closed_at < ${to}
          GROUP BY 1
        )
        SELECT w.week,
               COALESCE(o.n, 0) AS opened,
               COALESCE(c.n, 0) AS closed
        FROM weeks w
        LEFT JOIN opened o ON o.week = w.week
        LEFT JOIN closed c ON c.week = w.week
        ORDER BY w.week
      `,

      prisma.$queryRaw<
        { first_response: number | null; resolution: number | null }[]
      >`
        WITH first_reply AS (
          -- The reporter answering their own issue is not a response, so
          -- those are excluded rather than counted as an instant reply.
          SELECT c."bugId" AS bug_id, MIN(c."createdAt") AS replied_at
          FROM "Comment" c
          JOIN "Bug" b ON b.id = c."bugId"
          WHERE c."authorId" <> b."reporterId"
            AND c."deletedAt" IS NULL
            AND b."organisationId" = ${organisationId}
          GROUP BY c."bugId"
        )
        SELECT
          (SELECT percentile_cont(0.5) WITHIN GROUP (
             ORDER BY EXTRACT(EPOCH FROM (fr.replied_at - b."createdAt"))
           )
           FROM first_reply fr
           JOIN "Bug" b ON b.id = fr.bug_id AND b."isDeleted" = false AND b."track" = 'product'
           WHERE b."organisationId" = ${organisationId}
             AND b."createdAt" >= ${from} AND b."createdAt" < ${to}
          ) AS first_response,
          (SELECT percentile_cont(0.5) WITHIN GROUP (
             ORDER BY EXTRACT(EPOCH FROM (fc.closed_at - b."createdAt"))
           )
           FROM (${FIRST_CLOSE}) fc
           JOIN "Bug" b ON b.id = fc.bug_id AND b."isDeleted" = false AND b."track" = 'product'
           WHERE b."organisationId" = ${organisationId}
             AND b."createdAt" >= ${from} AND b."createdAt" < ${to}
          ) AS resolution
      `,

      prisma.$queryRaw<{ label: string; count: bigint }[]>`
        SELECT p.name AS label, COUNT(*) AS count
        FROM "Bug" b
        JOIN "Project" p ON p.id = b."projectId"
        WHERE b."isDeleted" = false AND b."track" = 'product'
          AND b."organisationId" = ${organisationId}
          AND b."createdAt" >= ${from} AND b."createdAt" < ${to}
        GROUP BY 1
        ORDER BY count DESC, label
      `,

      prisma.$queryRaw<{ label: string; count: bigint }[]>`
        SELECT COALESCE(t.name, 'No type') AS label, COUNT(*) AS count
        FROM "Bug" b
        LEFT JOIN "IssueType" t ON t.id = b."typeId"
        WHERE b."isDeleted" = false AND b."track" = 'product'
          AND b."organisationId" = ${organisationId}
          AND b."createdAt" >= ${from} AND b."createdAt" < ${to}
        GROUP BY 1
        ORDER BY count DESC, label
      `,
    ]);

  const weeklyPoints: WeekPoint[] = weekly.map((row) => ({
    week: row.week,
    opened: num(row.opened),
    closed: num(row.closed),
  }));

  return {
    byStatus: byStatus.map((r) => ({ status: r.status, count: num(r.count) })),
    weekly: weeklyPoints,
    medianFirstResponseSeconds: maybeNum(medians[0]?.first_response),
    medianResolutionSeconds: maybeNum(medians[0]?.resolution),
    byProject: byProject.map((r) => ({ label: r.label, count: num(r.count) })),
    byType: byType.map((r) => ({ label: r.label, count: num(r.count) })),
    totalOpened: weeklyPoints.reduce((sum, w) => sum + w.opened, 0),
    totalClosed: weeklyPoints.reduce((sum, w) => sum + w.closed, 0),
  };
}
