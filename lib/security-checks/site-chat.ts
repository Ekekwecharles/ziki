import { prisma } from "@/lib/prisma";
import type { PreviewSummary } from "./preview-summary";
import { readQuickScan } from "./entry";
import { targetAddress } from "./target";

/**
 * The saved chat under one site's scan on Security (#security-checks, 14 Nov
 * call): one per site per person, kept in the database so it carries on after
 * a refresh or on another device. The history sent to Claude is read here,
 * on the server, never taken from the browser.
 */

/** Most messages loaded and sent to Claude; older ones stay saved but aren't sent. */
export const SITE_CHAT_HISTORY = 20;
/** Longest message a person may send. */
export const SITE_CHAT_MESSAGE_MAX = 600;

export type SiteChatMessage = { id: string; role: "user" | "assistant"; text: string; createdAt: Date };

/** This person's chat about one site, oldest first: the last `take` messages. */
export async function loadSiteChat(organisationId: string, userId: string, targetId: string, take = SITE_CHAT_HISTORY): Promise<SiteChatMessage[]> {
  const rows = await prisma.securityChatMessage.findMany({
    where: { organisationId, userId, targetId },
    orderBy: { createdAt: "desc" },
    take,
    select: { id: true, role: true, text: true, createdAt: true },
  });
  return rows.reverse().map((row) => ({ ...row, role: row.role === "assistant" ? "assistant" : "user" }));
}

export async function saveSiteMessage(organisationId: string, userId: string, targetId: string, role: "user" | "assistant", text: string): Promise<void> {
  await prisma.securityChatMessage.create({ data: { organisationId, userId, targetId, role, text: text.slice(0, 2000) } });
}

/**
 * What Claude is told about the site: the quick scan's counts and the titles of
 * what it found (what any browser can see, already shown on the page), and the
 * report's counts. Never a finding's detail or fix.
 */
export function siteContextNote(site: string, quick: PreviewSummary | null, report: { posted: boolean; findings: number; unlocked: number }): string {
  const lines = [`Site: ${site}.`];
  if (quick) {
    const counts = (["critical", "high", "medium", "low"] as const).filter((s) => quick.counts[s]).map((s) => `${quick.counts[s]} ${s}`).join(", ");
    lines.push(`Quick browser scan: ${quick.total ? `${quick.total} problems (${counts})` : "nothing found"}.`);
    for (const row of quick.rows ?? []) if (row.title) lines.push(`- ${row.severity}: ${row.title} (${row.label})`);
  } else {
    lines.push("No quick browser scan for this one.");
  }
  lines.push(
    report.posted
      ? `Agents' report: ready, ${report.findings} findings, ${report.unlocked} unlocked.`
      : "Agents' report: agents are still checking it.",
  );
  return lines.join("\n");
}

/** One of this person's scans, with what the chat needs: its site, quick scan and report counts. Null if not theirs. */
export async function siteChatScan(organisationId: string, userId: string, checkId: string) {
  const check = await prisma.securityCheck.findFirst({
    where: { id: checkId, organisationId, requestedById: userId },
    select: {
      postedAt: true,
      target: { select: { id: true, kind: true, value: true, previewSummary: true } },
      results: { select: { unlockedAt: true } },
    },
  });
  if (!check) return null;
  return {
    targetId: check.target.id,
    site: targetAddress(check.target),
    quick: readQuickScan(check.target.previewSummary),
    report: { posted: check.postedAt !== null, findings: check.results.length, unlocked: check.results.filter((r) => r.unlockedAt !== null).length },
  };
}

