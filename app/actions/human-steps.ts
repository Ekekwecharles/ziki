"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth-helpers";
import { IssueApiError } from "@/lib/agent-api/errors";
import { openConfirmedIssue } from "@/lib/agent-api/confirmations";
import { submitTestVerdict } from "@/lib/agent-api/test-verdict";
import { acceptFix } from "@/lib/agent-api/merge";
import { acceptOffer, releaseClaim } from "@/lib/agent-api/offer";
import { extendClaim } from "@/lib/agent-api/deadline";
import { voteForBid } from "@/lib/agent-api/bid-votes";
import { deliverWork } from "@/lib/agent-api/delivery";
import { heldByMyAgent, webAgentFor } from "@/lib/web-agent";
import { revalidateIssue } from "@/lib/revalidate-issue";
import { checkPostForSecrets } from "@/lib/security/secret-guard";

/**
 * Steps a person takes from the issue page through their own agent
 * (#owner-control). Each one calls the same function the agent API calls,
 * with the person's agent as the actor, so the website can't do anything
 * the agent couldn't: the same checks, the same records, the same events.
 */
export type StepResult = { ok: true } | { error: string };

const NO_AGENT = "You need an agent in this organisation to do this. Add one from Agents.";

async function issueFor(bugId: string) {
  return prisma.bug.findFirst({
    where: { id: bugId, isDeleted: false },
    select: { id: true, organisationId: true, projectId: true },
  });
}

/** #secret-protection: an entry's text is read by everyone on the issue. */
async function secretIn(bug: { id: string; organisationId: string; projectId: string }, userId: string, source: string, fields: Record<string, string>) {
  const check = await checkPostForSecrets({
    organisationId: bug.organisationId,
    projectId: bug.projectId,
    actor: { kind: "user", userId },
    source,
    bugId: bug.id,
    fields,
    noun: "this entry",
  });
  return check.ok ? null : check.message;
}

async function run(step: () => Promise<unknown>): Promise<StepResult> {
  try {
    // Some steps (test verdicts, merge reviews) answer a refusal as a result
    // with an HTTP status and a message instead of throwing.
    const result = await step();
    if (result && typeof result === "object" && "status" in result && typeof result.status === "number" && result.status >= 400) {
      const message = "message" in result && typeof result.message === "string" ? result.message : "That wasn't accepted.";
      return { error: message };
    }
  } catch (error) {
    if (error instanceof IssueApiError) return { error: error.message };
    console.error("[human-steps] failed", error);
    return { error: "That didn't work. Please try again." };
  }
  revalidatePath("/[org]/[project]", "layout");
  revalidateIssue();
  return { ok: true };
}

/** Open · Requires confirmation → Open, once the confirmations are in. */
export async function openForBidsAction(bugId: string): Promise<StepResult> {
  const user = await requireUser();
  const bug = await issueFor(bugId);
  if (!bug) return { error: "Issue not found" };
  const agent = await webAgentFor(user.id, bug.organisationId);
  if (!agent) return { error: NO_AGENT };
  return run(() => openConfirmedIssue(agent, { organisationId: bug.organisationId, projectId: bug.projectId }, bug.id));
}

/** A test verdict on delivered work: good to merge or not, with why. */
export async function giveTestVerdictAction(
  bugId: string,
  input: { goodToMerge: boolean; summary: string; description: string; files: string },
): Promise<StepResult> {
  const user = await requireUser();
  const bug = await issueFor(bugId);
  if (!bug) return { error: "Issue not found" };
  const agent = await webAgentFor(user.id, bug.organisationId);
  if (!agent) return { error: NO_AGENT };
  const secret = await secretIn(bug, user.id, "test_verdict", { summary: input.summary, description: input.description });
  if (secret) return { error: secret };
  // One file per line: "app/page.tsx" or "app/page.tsx:40-58".
  const files = input.files
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^(.*?):(\d+(?:\s*-\s*\d+)?(?:\s*,\s*\d+(?:\s*-\s*\d+)?)*)$/.exec(line);
      return match ? { path: match[1].trim(), lines: match[2] } : { path: line };
    });
  const { goodToMerge, summary, description } = input;
  return run(() => submitTestVerdict(agent, bug.id, { goodToMerge, summary, description, files, projectId: bug.projectId }));
}

/** The manager's merge review on accepted work: accept it for merge, or send it back. */
export async function giveMergeReviewAction(
  bugId: string,
  input: { verdict: "accept" | "reject"; summary: string; description: string },
): Promise<StepResult> {
  const user = await requireUser();
  const bug = await issueFor(bugId);
  if (!bug) return { error: "Issue not found" };
  const agent = await webAgentFor(user.id, bug.organisationId);
  if (!agent) return { error: NO_AGENT };
  const secret = await secretIn(bug, user.id, "merge_review", { summary: input.summary, description: input.description });
  if (secret) return { error: secret };
  return run(() => acceptFix(agent, bug.id, { ...input, projectId: bug.projectId }));
}

/**
 * Deliver my agent's work: the pull request, a summary, and how it was
 * checked. The same delivery the agent sends (POST /issues/{id}/delivery),
 * so it needs a real pull request and moves the issue to Delivered.
 */
export async function deliverForMyAgentAction(
  bugId: string,
  input: { pullRequestUrl: string; summary: string; description: string; proof: string },
): Promise<StepResult> {
  const user = await requireUser();
  const held = await heldByMyAgent(user.id, bugId);
  if (!held || held.status !== "active") return { error: "Your agent isn't working on this issue, so there's nothing to deliver." };
  const bug = await issueFor(bugId);
  if (!bug) return { error: "Issue not found" };
  const secret = await secretIn(bug, user.id, "delivery", { summary: input.summary, description: input.description, proof: input.proof });
  if (secret) return { error: secret };
  return run(() =>
    deliverWork(held.agent, bug.id, {
      pullRequestUrl: input.pullRequestUrl.trim(),
      summary: input.summary,
      description: input.description,
      ...(input.proof.trim() ? { testResults: input.proof.trim() } : {}),
    }),
  );
}

/** Accept the issue my agent was offered, as my agent. */
export async function acceptOfferForMyAgentAction(bugId: string): Promise<StepResult> {
  const user = await requireUser();
  const held = await heldByMyAgent(user.id, bugId);
  if (!held || held.status !== "offered") return { error: "None of your agents has an offer on this issue." };
  return run(() => acceptOffer(held.agent, held.claimId));
}

/** Stop my agent working on it: the issue goes back to Open for new bids. */
export async function releaseMyAgentAction(bugId: string, reason: string): Promise<StepResult> {
  const user = await requireUser();
  const held = await heldByMyAgent(user.id, bugId);
  if (!held) return { error: "None of your agents is working on this issue." };
  return run(() => releaseClaim(held.agent, held.projectId, bugId, reason.trim() || undefined));
}

/** Give my agent more time on it (the project's extension, with a reason). */
export async function extendMyAgentAction(bugId: string, reason: string): Promise<StepResult> {
  const user = await requireUser();
  if (!reason.trim()) return { error: "Say why your agent needs more time." };
  const held = await heldByMyAgent(user.id, bugId);
  if (!held) return { error: "None of your agents is working on this issue." };
  return run(() => extendClaim(held.agent, held.projectId, bugId, reason.trim()));
}

/** A vote for a bid, as my agent: guidance for whoever awards it. */
export async function voteForBidAction(bidId: string): Promise<StepResult> {
  const user = await requireUser();
  const bid = await prisma.issueBid.findUnique({ where: { id: bidId }, select: { bug: { select: { organisationId: true, projectId: true } } } });
  if (!bid) return { error: "That bid no longer exists." };
  const agent = await webAgentFor(user.id, bid.bug.organisationId);
  if (!agent) return { error: NO_AGENT };
  return run(() => voteForBid(agent, bid.bug.projectId, bidId));
}
