"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth-helpers";
import { currentOrganisationAccess } from "@/lib/organisation-access";
import { checkRateLimit, RATE_LIMIT_MESSAGE } from "@/lib/rate-limit";
import { OWNERS_ONLY_MESSAGE } from "@/lib/security-checks";
import { parseSecurityTarget, PRIVATE_TARGET_ERROR, targetAddress } from "@/lib/security-checks/target";
import { addTargetAndCheck, findOwnScan, findScannedCheck, fixPaidSinceQuickScan, refusedMessage, removeOwnScan, saveQuickScan } from "@/lib/security-checks/entry";
import { rescanQuote, startRescan, type RescanOutcome, type RescanQuote } from "@/lib/security-checks/rescan";
import { previewScan } from "@/lib/security-checks/preview";
import { summarisePreview, type PreviewSummary } from "@/lib/security-checks/preview-summary";
import { withSiteAddress } from "@/lib/security-checks/site-address";
import type { ParsedTarget } from "@/lib/security-checks/target";
import {
  ASSISTANT_HISTORY_MAX,
  ASSISTANT_MESSAGE_MAX,
  askAboutSite,
  askSecurityAssistant,
  type AssistantTurn,
} from "@/lib/security-checks/assistant";
import { loadSiteChat, saveSiteMessage, scansContextNote, SITE_CHAT_MESSAGE_MAX, siteChatScan, siteContextNote } from "@/lib/security-checks/site-chat";
import { after } from "next/server";
import { kickCheck } from "@/lib/security-checks/engine";
import { prisma } from "@/lib/prisma";

/**
 * Ziki's security chat, signed in (#security-checks, plan part C3). A plain
 * link is added straight away without asking the AI, so it costs nothing and
 * is instant. Anything else goes to the assistant, which answers and picks
 * out the site. Once a site is clear, Dave's quick scan looks at it and the
 * chat shows what it found as short titles (never the detail or the fix), and the
 * asset is added to the person's scans at once, so the full check starts:
 * no proof step (14 Nov plan, C1/C3). A public GitHub repo gets a quick look
 * too (its file names only); a private one is still added.
 */

export type ChatAnswer =
  | { kind: "reply"; reply: string }
  | { kind: "go"; reply: string; href: string }
  /**
   * The quick scan of a site, already added to the person's scans (`checkId`) unless it couldn't be reached. `summary` is null when the scan couldn't run.
   * `finished` is true when the agents' report is already posted (a site scanned before), so the chat offers "See results".
   */
  | { kind: "scan"; reply: string; target: string; summary: PreviewSummary | null; note: string | null; checkId: string | null; already?: boolean; finished?: boolean }
  | { kind: "error"; error: string };

/**
 * Replace (#security-checks): a site already in the person's scans, scanned
 * again because they chose to replace its result, like "this file already
 * exists, replace it?". The new quick scan is saved over the old one on the
 * same card; nothing else changes.
 */
export async function replaceScan(checkId: string): Promise<{ ok: true; summary: PreviewSummary } | { ok: false; error: string }> {
  const user = await requireUser();
  const access = await currentOrganisationAccess(user.id, user.role);
  if (!access.organisationId) return { ok: false, error: NO_WORKSPACE };
  if (!access.admin) return { ok: false, error: OWNERS_ONLY_MESSAGE };
  const scan = typeof checkId === "string" ? await findOwnScan(access.organisationId, user.id, checkId) : null;
  if (!scan) return { ok: false, error: "That scan isn't in your scans." };
  // A quick scan from the last 10 minutes is reused, unless a fix was paid for since (#security-rescan).
  const fresh = await fixPaidSinceQuickScan(scan.target);
  const result = await previewScan(targetAddress(scan.target), { visitor: `user:${user.id}`, fresh });
  if (!result.ok) return { ok: false, error: result.reason };
  const summary = await withSiteAddress(summarisePreview(result));
  await saveQuickScan(scan.targetId, summary);
  revalidatePath("/security");
  return { ok: true, summary };
}

/** What "Scan again" costs and covers, for its confirm (#security-rescan). Charges nothing. */
export async function rescanCost(checkId: string): Promise<RescanQuote> {
  const user = await requireUser();
  const access = await currentOrganisationAccess(user.id, user.role);
  if (!access.organisationId) return { ok: false, error: NO_WORKSPACE };
  if (!access.admin) return { ok: false, error: OWNERS_ONLY_MESSAGE };
  if (typeof checkId !== "string") return { ok: false, error: "That scan isn't in your scans." };
  return rescanQuote(access.organisationId, user.id, checkId);
}

/**
 * Scan again with agents (#security-rescan, 17 Nov): pays 10 Ziks, starts a follow-up scan whose agents recheck the
 * earlier findings and look for new ones, and runs the quick scan again. The follow-up starts after this answers.
 */
export async function rescanSite(checkId: string): Promise<RescanOutcome> {
  const user = await requireUser();
  const access = await currentOrganisationAccess(user.id, user.role);
  if (!access.organisationId) return { ok: false, reason: "not_found", error: NO_WORKSPACE };
  if (!access.admin) return { ok: false, reason: "not_found", error: OWNERS_ONLY_MESSAGE };
  if (typeof checkId !== "string") return { ok: false, reason: "not_found", error: "That scan isn't in your scans." };
  const outcome = await startRescan(access.organisationId, user.id, checkId);
  if (!outcome.ok) return outcome;
  const next = outcome.checkId;
  const organisationId = access.organisationId;
  after(async () => {
    // The quick scan is part of scanning again (reused for 10 minutes unless a fix was paid for since);
    // a failure here doesn't stop the agents.
    try {
      const scan = await findOwnScan(organisationId, user.id, next);
      if (scan) {
        const result = await previewScan(targetAddress(scan.target), { visitor: `user:${user.id}`, fresh: await fixPaidSinceQuickScan(scan.target) });
        if (result.ok) await saveQuickScan(scan.targetId, await withSiteAddress(summarisePreview(result)));
      }
    } catch {
      // The report still shows the last quick scan.
    }
    await kickCheck(prisma, next);
  });
  revalidatePath("/security");
  return outcome;
}

/** A site's saved chat, as the card shows it, and whether its agents' report is posted ("See results" rather than "See progress"). */
export type SiteChatAnswer = { ok: true; messages: { id: string; role: "user" | "assistant"; text: string }[]; finished: boolean } | { ok: false; error: string };

/** The saved chat under one of your scans (#security-checks): loaded when its result opens. */
export async function siteChat(checkId: string): Promise<SiteChatAnswer> {
  const user = await requireUser();
  const access = await currentOrganisationAccess(user.id, user.role);
  if (!access.organisationId) return { ok: false, error: NO_WORKSPACE };
  if (!access.admin) return { ok: false, error: OWNERS_ONLY_MESSAGE };
  const scan = typeof checkId === "string" ? await siteChatScan(access.organisationId, user.id, checkId) : null;
  if (!scan) return { ok: false, error: "That scan isn't in your scans." };
  const messages = await loadSiteChat(access.organisationId, user.id, scan.targetId);
  return { ok: true, messages: messages.map(({ id, role, text }) => ({ id, role, text })), finished: scan.report.posted };
}

/**
 * Ask about one of your scans (#security-checks): the question is saved, Claude
 * gets the last messages from the database (not the browser) and what's known
 * about the site (counts and public titles only), and the answer is saved too.
 */
export async function askSite(checkId: string, question: string): Promise<SiteChatAnswer> {
  const user = await requireUser();
  const access = await currentOrganisationAccess(user.id, user.role);
  if (!access.organisationId) return { ok: false, error: NO_WORKSPACE };
  if (!access.admin) return { ok: false, error: OWNERS_ONLY_MESSAGE };
  const text = typeof question === "string" ? question.trim().slice(0, SITE_CHAT_MESSAGE_MAX) : "";
  if (!text) return { ok: false, error: "Type a question about this site." };
  const scan = typeof checkId === "string" ? await siteChatScan(access.organisationId, user.id, checkId) : null;
  if (!scan) return { ok: false, error: "That scan isn't in your scans." };
  if (!checkRateLimit(`security-assistant:${user.id}`, ASSISTANT_RATE_LIMIT).allowed) return { ok: false, error: RATE_LIMIT_MESSAGE };

  const { organisationId } = access;
  await saveSiteMessage(organisationId, user.id, scan.targetId, "user", text);
  const history = await loadSiteChat(organisationId, user.id, scan.targetId);
  const reply =
    (await askAboutSite(history.map(({ role, text: said }) => ({ role, text: said })), siteContextNote(scan.site, scan.quick, scan.report))) ??
    "I can't answer just now. Try again in a moment, or open the report for the agents' findings.";
  await saveSiteMessage(organisationId, user.id, scan.targetId, "assistant", reply);
  const messages = await loadSiteChat(organisationId, user.id, scan.targetId);
  return { ok: true, messages: messages.map(({ id, role, text: said }) => ({ id, role, text: said })), finished: scan.report.posted };
}

/** Remove a scan from the person's list, only while its report isn't posted. */
export async function removeScan(checkId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await requireUser();
  const access = await currentOrganisationAccess(user.id, user.role);
  if (!access.organisationId) return { ok: false, error: NO_WORKSPACE };
  if (!access.admin) return { ok: false, error: OWNERS_ONLY_MESSAGE };
  const removed = typeof checkId === "string" && (await removeOwnScan(access.organisationId, user.id, checkId));
  if (!removed) return { ok: false, error: "This scan is already removed." };
  revalidatePath("/security");
  return { ok: true };
}

/** Messages one person may send the assistant in an hour. */
const ASSISTANT_RATE_LIMIT = { max: 30, windowMs: 60 * 60 * 1000 };

const NO_WORKSPACE = "Join or create a workspace to secure your assets.";
const ASK_FOR_ADDRESS = "Paste your website, a server address or a GitHub repo, and I'll set up a scan.";

export async function talkToSecurityAssistant(history: AssistantTurn[]): Promise<ChatAnswer> {
  const user = await requireUser();
  const access = await currentOrganisationAccess(user.id, user.role);
  if (!access.organisationId) return { kind: "error", error: NO_WORKSPACE };
  if (!access.admin) return { kind: "error", error: OWNERS_ONLY_MESSAGE };

  const turns = cleanHistory(history);
  const last = turns.at(-1);
  if (!last || last.role !== "user") return { kind: "error", error: "Type what you want to secure." };

  // A plain link needs no AI.
  const direct = parseSecurityTarget(last.text);
  if (direct.ok) return scanAndAdd(access.organisationId, user.id, direct.target, `Got it. Here's a quick look at ${direct.target.value}.`, turns);
  if (direct.error === PRIVATE_TARGET_ERROR) return { kind: "reply", reply: PRIVATE_TARGET_ERROR };

  const limit = checkRateLimit(`security-assistant:${user.id}`, ASSISTANT_RATE_LIMIT);
  if (!limit.allowed) return { kind: "error", error: RATE_LIMIT_MESSAGE };

  // Follow-ups about their own scans ("what's happening with my site?"): what's known about them, read here.
  const answer = await askSecurityAssistant(turns, await scansContextNote(access.organisationId, user.id));
  if (!answer) return { kind: "reply", reply: ASK_FOR_ADDRESS };
  if (answer.target) {
    const picked = parseSecurityTarget(answer.target);
    if (picked.ok) return scanAndAdd(access.organisationId, user.id, picked.target, answer.reply, turns);
    if (picked.error === PRIVATE_TARGET_ERROR) return { kind: "reply", reply: PRIVATE_TARGET_ERROR };
  }
  return { kind: "reply", reply: answer.reply };
}

/**
 * Try now from the public page: add the site and start the agents' check, with no chat. The person asked for the
 * agents already, so the Security page opens the scan's progress page straight from here (never the chat box).
 * A site already in their scans goes to its page too.
 */
export async function startFromOutside(site: string): Promise<{ ok: true; checkId: string } | { ok: false; error: string }> {
  const user = await requireUser();
  const access = await currentOrganisationAccess(user.id, user.role);
  if (!access.organisationId) return { ok: false, error: NO_WORKSPACE };
  if (!access.admin) return { ok: false, error: OWNERS_ONLY_MESSAGE };
  const parsed = typeof site === "string" ? parseSecurityTarget(site) : null;
  if (!parsed?.ok) return { ok: false, error: "That address can't be scanned. Try it again from the Security page." };
  const answer = await scanAndAdd(access.organisationId, user.id, parsed.target, "");
  if (answer.kind === "scan" && answer.checkId) return { ok: true, checkId: answer.checkId };
  if (answer.kind === "scan") return { ok: false, error: answer.note ?? `Ziki couldn't reach ${parsed.target.value}.` };
  return { ok: false, error: answer.kind === "error" ? answer.error : answer.reply };
}

/**
 * Every asset (a website, a server or a public repo) gets the quick scan, and
 * is added to the person's scans straight away, so the full check starts. A
 * site the scan couldn't reach isn't added; a private repo (the scan can't
 * see it) or a scan that only hit the limit still is.
 */
async function scanAndAdd(organisationId: string, userId: string, target: ParsedTarget, reply: string, conversation: AssistantTurn[] = []): Promise<ChatAnswer> {
  const address = targetAddress(target);
  // Scanned before: don't scan it again, just point to its card.
  const scanned = await findScannedCheck(organisationId, userId, target);
  if (scanned) {
    return {
      kind: "scan",
      reply: "",
      target: address,
      summary: scanned.summary,
      note: `${target.value} is already in your scans. This is its saved result. Replace it with a new scan?`,
      checkId: scanned.checkId,
      already: true,
      finished: scanned.finished,
    };
  }
  const result = await previewScan(address, { visitor: `user:${userId}` });
  const summary = result.ok ? await withSiteAddress(summarisePreview(result)) : null;
  const addable = result.ok || target.kind === "repo" || result.retryAfterSeconds !== undefined;
  // Couldn't reach it: say so plainly, with no "here's a quick look" before it.
  if (!addable) return { kind: "scan", reply: "", target: address, summary: null, note: result.ok ? null : result.reason, checkId: null };
  const added = await addTargetAndCheck(organisationId, userId, target);
  if ("refused" in added) return { kind: "reply", reply: refusedMessage(added.refused, target.value) };
  // Start it as soon as this answers. Waiting for the one-minute sweep left a new scan on "Waiting to start" for minutes
  // (the sweep can be busy for a long time), and once for ten (15 Nov test); kickCheck never throws, and the sweep still catches a miss.
  after(() => kickCheck(prisma, added.checkId));
  if (summary) await saveQuickScan(added.targetId, summary);
  // The conversation that led to this scan becomes the start of the site's saved chat,
  // so "See result" later carries on from it (14 Nov call).
  await keepConversation(organisationId, userId, added.targetId, conversation, reply, summary);
  revalidatePath("/security");
  return { kind: "scan", reply, target: address, summary, note: result.ok ? null : result.reason, checkId: added.checkId };
}

/**
 * Save the chat that led to a scan, and the reply with what the quick scan found, as the start of that site's chat.
 * The agents' report later replaces the quick scan's numbers, so the saved line says when it was true.
 */
async function keepConversation(organisationId: string, userId: string, targetId: string, conversation: AssistantTurn[], reply: string, summary: PreviewSummary | null) {
  if (!conversation.length) return;
  const counts = summary
    ? (["critical", "high", "medium", "low"] as const).filter((s) => summary.counts[s]).map((s) => `${summary.counts[s]} ${s}`).join(", ")
    : "";
  const found = summary ? (summary.total ? ` When you added it, the quick scan found ${summary.total} ${summary.total === 1 ? "problem" : "problems"} (${counts}).` : " When you added it, the quick scan found nothing.") : "";
  for (const turn of conversation) await saveSiteMessage(organisationId, userId, targetId, turn.role, turn.text);
  const said = `${reply}${found}`.trim();
  if (said) await saveSiteMessage(organisationId, userId, targetId, "assistant", said);
}

/** Only well-formed turns, trimmed to the limits, at most the last few. */
function cleanHistory(history: unknown): AssistantTurn[] {
  if (!Array.isArray(history)) return [];
  return history
    .filter((turn): turn is AssistantTurn =>
      typeof turn === "object" && turn !== null &&
      ((turn as AssistantTurn).role === "user" || (turn as AssistantTurn).role === "assistant") &&
      typeof (turn as AssistantTurn).text === "string",
    )
    .map((turn) => ({ role: turn.role, text: turn.text.trim().slice(0, ASSISTANT_MESSAGE_MAX) }))
    .filter((turn) => turn.text)
    .slice(-ASSISTANT_HISTORY_MAX);
}
