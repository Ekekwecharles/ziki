"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth-helpers";
import { currentOrganisationAccess } from "@/lib/organisation-access";
import { checkRateLimit, RATE_LIMIT_MESSAGE } from "@/lib/rate-limit";
import { OWNERS_ONLY_MESSAGE } from "@/lib/security-checks";
import { parseSecurityTarget, PRIVATE_TARGET_ERROR, targetAddress } from "@/lib/security-checks/target";
import { addTargetAndCheck, findOwnScan, findScannedCheck, refusedMessage, removeOwnScan, saveQuickScan } from "@/lib/security-checks/entry";
import { previewScan } from "@/lib/security-checks/preview";
import { summarisePreview, type PreviewSummary } from "@/lib/security-checks/preview-summary";
import type { ParsedTarget } from "@/lib/security-checks/target";
import {
  ASSISTANT_HISTORY_MAX,
  ASSISTANT_MESSAGE_MAX,
  askAboutSite,
  askSecurityAssistant,
  type AssistantTurn,
} from "@/lib/security-checks/assistant";
import { loadSiteChat, saveSiteMessage, SITE_CHAT_MESSAGE_MAX, siteChatScan, siteContextNote } from "@/lib/security-checks/site-chat";

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
  /** The quick scan of a site, already added to the person's scans (`checkId`) unless it couldn't be reached. `summary` is null when the scan couldn't run. */
  | { kind: "scan"; reply: string; target: string; summary: PreviewSummary | null; note: string | null; checkId: string | null; already?: boolean }
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
  const result = await previewScan(targetAddress(scan.target), { visitor: `user:${user.id}` });
  if (!result.ok) return { ok: false, error: result.reason };
  const summary = summarisePreview(result);
  await saveQuickScan(scan.targetId, summary);
  revalidatePath("/security");
  return { ok: true, summary };
}

/** A site's saved chat, as the card shows it. */
export type SiteChatAnswer = { ok: true; messages: { id: string; role: "user" | "assistant"; text: string }[] } | { ok: false; error: string };

/** The saved chat under one of your scans (#security-checks): loaded when its result opens. */
export async function siteChat(checkId: string): Promise<SiteChatAnswer> {
  const user = await requireUser();
  const access = await currentOrganisationAccess(user.id, user.role);
  if (!access.organisationId) return { ok: false, error: NO_WORKSPACE };
  if (!access.admin) return { ok: false, error: OWNERS_ONLY_MESSAGE };
  const scan = typeof checkId === "string" ? await siteChatScan(access.organisationId, user.id, checkId) : null;
  if (!scan) return { ok: false, error: "That scan isn't in your scans." };
  const messages = await loadSiteChat(access.organisationId, user.id, scan.targetId);
  return { ok: true, messages: messages.map(({ id, role, text }) => ({ id, role, text })) };
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
  return { ok: true, messages: messages.map(({ id, role, text: said }) => ({ id, role, text: said })) };
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

  const answer = await askSecurityAssistant(turns);
  if (!answer) return { kind: "reply", reply: ASK_FOR_ADDRESS };
  if (answer.target) {
    const picked = parseSecurityTarget(answer.target);
    if (picked.ok) return scanAndAdd(access.organisationId, user.id, picked.target, answer.reply, turns);
    if (picked.error === PRIVATE_TARGET_ERROR) return { kind: "reply", reply: PRIVATE_TARGET_ERROR };
  }
  return { kind: "reply", reply: answer.reply };
}

/** Add a site to the person's scans from outside the chat (the public page, signed in): scan, add, then back to Security. */
export async function addSecurityAsset(link: string): Promise<ChatAnswer> {
  const user = await requireUser();
  const access = await currentOrganisationAccess(user.id, user.role);
  if (!access.organisationId) return { kind: "error", error: NO_WORKSPACE };
  if (!access.admin) return { kind: "error", error: OWNERS_ONLY_MESSAGE };
  const parsed = parseSecurityTarget(typeof link === "string" ? link : "");
  if (!parsed.ok) return { kind: "error", error: parsed.error };
  const answer = await scanAndAdd(access.organisationId, user.id, parsed.target, "");
  if (answer.kind !== "scan" || !answer.checkId) return answer;
  return { kind: "go", reply: "", href: `/security?check=${encodeURIComponent(answer.checkId)}` };
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
    };
  }
  const result = await previewScan(address, { visitor: `user:${userId}` });
  const summary = result.ok ? summarisePreview(result) : null;
  const addable = result.ok || target.kind === "repo" || result.retryAfterSeconds !== undefined;
  // Couldn't reach it: say so plainly, with no "here's a quick look" before it.
  if (!addable) return { kind: "scan", reply: "", target: address, summary: null, note: result.ok ? null : result.reason, checkId: null };
  const added = await addTargetAndCheck(organisationId, userId, target);
  if ("refused" in added) return { kind: "reply", reply: refusedMessage(added.refused, target.value) };
  if (summary) await saveQuickScan(added.targetId, summary);
  // The conversation that led to this scan becomes the start of the site's saved chat,
  // so "See result" later carries on from it (14 Nov call).
  await keepConversation(organisationId, userId, added.targetId, conversation, reply, summary);
  revalidatePath("/security");
  return { kind: "scan", reply, target: address, summary, note: result.ok ? null : result.reason, checkId: added.checkId };
}

/** Save the chat that led to a scan, and the reply with what the quick scan found, as the start of that site's chat. */
async function keepConversation(organisationId: string, userId: string, targetId: string, conversation: AssistantTurn[], reply: string, summary: PreviewSummary | null) {
  if (!conversation.length) return;
  const counts = summary
    ? (["critical", "high", "medium", "low"] as const).filter((s) => summary.counts[s]).map((s) => `${summary.counts[s]} ${s}`).join(", ")
    : "";
  const found = summary ? (summary.total ? ` The quick scan found ${summary.total} ${summary.total === 1 ? "problem" : "problems"} (${counts}).` : " The quick scan found nothing.") : "";
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
