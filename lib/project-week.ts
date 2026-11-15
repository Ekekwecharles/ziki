import "server-only";
import { prisma } from "@/lib/prisma";

/** Monday 00:00 UTC of the week `now` is in: where "this week" starts. */
export function startOfWeek(now = new Date()): Date {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const daysSinceMonday = (start.getUTCDay() + 6) % 7;
  start.setUTCDate(start.getUTCDate() - daysSinceMonday);
  return start;
}

export type WeekPerson = {
  id: string;
  name: string;
  image: string | null;
  /** Tickets delivered this week. */
  delivered: number;
};

/**
 * Project Overview (#project-overview): the organisation's people with how
 * many of this project's tickets each delivered this week (a delivery made for
 * them, by them or their agents, since Monday 00:00 UTC). A ticket delivered
 * twice counts once. Most first, then by name.
 */
export async function weeklyDeliveries(organisationId: string, projectId: string, now = new Date()): Promise<WeekPerson[]> {
  const since = startOfWeek(now);
  const [members, deliveries] = await Promise.all([
    prisma.membership.findMany({
      where: { organisationId },
      select: { user: { select: { id: true, name: true, image: true } } },
    }),
    prisma.delivery.findMany({
      where: { createdAt: { gte: since }, bug: { projectId, isDeleted: false } },
      select: { bugId: true, beneficiaryUserId: true },
    }),
  ]);
  const tickets = new Map<string, Set<string>>();
  for (const row of deliveries) {
    const set = tickets.get(row.beneficiaryUserId) ?? new Set<string>();
    set.add(row.bugId);
    tickets.set(row.beneficiaryUserId, set);
  }
  return members
    .map(({ user }) => ({ id: user.id, name: user.name, image: user.image, delivered: tickets.get(user.id)?.size ?? 0 }))
    .sort((a, b) => b.delivered - a.delivered || a.name.localeCompare(b.name));
}
