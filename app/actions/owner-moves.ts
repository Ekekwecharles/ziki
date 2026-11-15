"use server";

import { revalidatePath } from "next/cache";
import type { Substatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth-helpers";
import { organisationAccessFor } from "@/lib/organisation-access";
import { moveTo, STATUS_OF } from "@/lib/issue-substatus";
import { OWNER_NOTE_MAX, ownerMove } from "@/lib/owner-moves";
import { activityCreateData, statusChangedSummary } from "@/lib/activity-log";
import { publish } from "@/lib/agent-api/events";
import { issueChangePayload, publishWebEvent } from "@/lib/agent-api/web-events";
import { solverAwardFor } from "@/lib/points/award";
import { holdPayout } from "@/lib/points/payout";
import { notifyLater } from "@/lib/notify";
import { revalidateIssue } from "@/lib/revalidate-issue";
import { IssueApiError } from "@/lib/agent-api/errors";
import { ownerArchiveIdea, ownerConvertIdea, ownerRejectIdea } from "@/lib/agent-api/idea-verdicts";
import { IDEA_ARCHIVE_REASONS, IDEA_WITHDRAWN_REASON, type IdeaArchiveReason } from "@/lib/idea-archive";

export type OwnerMoveResult = { ok: true } | { error: string };

const NOT_OWNER = "Only an owner or admin of this organisation can move an issue by hand.";

/**
 * The organisation owner moves an issue from its Status chip (#owner-control):
 * one of the moves `OWNER_MOVES` offers for where it is now. Moving it out of
 * the work (back to Open, or Closed) stops the agent holding it; into Live,
 * it holds the solver's reward like any resolve. The history says it was the
 * owner, with their note.
 */
export async function ownerMoveIssueAction(bugId: string, to: Substatus, note: string): Promise<OwnerMoveResult> {
  const user = await requireUser();
  const existing = await prisma.bug.findUnique({
    where: { id: bugId },
    select: { id: true, title: true, status: true, substatus: true, isDeleted: true, organisationId: true, assigneeId: true, reporterId: true },
  });
  if (!existing || existing.isDeleted) return { error: "Issue not found" };

  const access = await organisationAccessFor(user.id, existing.organisationId, user.role);
  if (!access.admin) return { error: NOT_OWNER };

  const move = ownerMove(existing.substatus, to);
  if (!move) return { error: "That move isn't available from this step any more. Refresh the page to see where the issue is now." };

  const trimmed = note.trim();
  if (move.needsReason && !trimmed) return { error: "Say why you're closing it. Agents and reporters will see this." };
  if (trimmed.length > OWNER_NOTE_MAX) return { error: `Keep the note under ${OWNER_NOTE_MAX} characters.` };

  const target = STATUS_OF[to];
  const leavesWork = target === "open" || target === "closed";
  const data = {
    ...moveTo(to),
    ...(leavesWork ? { assigneeId: null } : {}),
    ...(target === "closed" ? { closeReason: "not_planned", closeEvidence: trimmed, closedAt: new Date() } : {}),
    ...(existing.status === "closed" && target !== "closed" ? { closeReason: null, closeEvidence: null, closedAt: null } : {}),
    ...(target === "closed" || target === "resolved" ? { isBoosted: false, boostedAt: null } : {}),
  };

  const moved = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Bug" WHERE id = ${bugId} FOR UPDATE`;
    // Someone else may have moved it since the page loaded.
    const fresh = await tx.bug.findUniqueOrThrow({ where: { id: bugId }, select: { substatus: true } });
    if (fresh.substatus !== existing.substatus) return false;

    await tx.bug.update({ where: { id: bugId }, data });

    if (leavesWork) {
      const claims = await tx.issueClaim.findMany({
        where: { bugId, releasedAt: null, status: { in: ["offered", "planning", "active"] } },
        select: { id: true, agentId: true, beneficiaryUserId: true },
      });
      if (claims.length > 0) {
        await tx.issueClaim.updateMany({
          where: { id: { in: claims.map((claim) => claim.id) } },
          data: { status: "released", releasedAt: new Date(), releaseReason: "owner" },
        });
        for (const claim of claims) {
          await publish(tx, {
            organisationId: existing.organisationId,
            type: "claim.released",
            actorAgentId: claim.agentId,
            bugId,
            payload: { claimId: claim.id, issueId: bugId, beneficiaryUserId: claim.beneficiaryUserId, reason: "owner" },
          });
        }
      }
    }

    // Into Live: the solver's reward is held until it's confirmed deployed, as with any resolve.
    if (target === "resolved" && existing.status !== "resolved") {
      const solver = await solverAwardFor(tx, { id: bugId, organisationId: existing.organisationId, assigneeId: existing.assigneeId });
      if (solver) await holdPayout(tx, bugId, [solver]);
    }

    await tx.bugActivity.createMany({
      data: activityCreateData([
        {
          bugId,
          actorId: user.id,
          type: "status_changed",
          summary: `${statusChangedSummary(existing.substatus, to)} as the owner`,
          metadata: { field: "status", from: existing.substatus, to, ...(trimmed ? { note: trimmed } : {}) },
        },
      ]),
    });
    await publishWebEvent(tx, {
      bugId,
      type: "issue.updated",
      actorUserId: user.id,
      payload: issueChangePayload(data as Record<string, unknown>),
    });
    return true;
  });
  if (!moved) return { error: "Someone moved this issue while you were looking. Refresh the page to see where it is now." };

  if (target !== existing.status) {
    notifyLater({
      actorId: user.id,
      actorName: user.name ?? "Someone",
      bugId,
      bugTitle: existing.title,
      kind: "status_changed",
      reporterId: existing.reporterId,
      from: existing.status,
      to: target,
      note: trimmed || undefined,
    });
  }

  revalidatePath("/[org]/[project]", "layout");
  revalidateIssue();
  return { ok: true };
}

/** An open idea the signed-in owner may decide, with its scope; or why not. */
async function ownedIdea(ideaId: string) {
  const user = await requireUser();
  const idea = await prisma.idea.findFirst({
    where: { id: ideaId, isDeleted: false },
    select: { id: true, organisationId: true, projectId: true },
  });
  if (!idea) return { error: "Idea not found" } as const;
  const access = await organisationAccessFor(user.id, idea.organisationId, user.role);
  if (!access.admin) return { error: "Only an owner or admin of this organisation can decide an idea by hand." } as const;
  return { user, scope: { organisationId: idea.organisationId, projectId: idea.projectId }, ideaId: idea.id } as const;
}

async function ideaStep(step: () => Promise<unknown>): Promise<OwnerMoveResult> {
  try {
    await step();
  } catch (error) {
    if (error instanceof IssueApiError) return { error: error.message };
    console.error("[owner-idea] failed", error);
    return { error: "That didn't work. Please try again." };
  }
  revalidatePath("/[org]/[project]", "layout");
  return { ok: true };
}

/** The owner turns an idea into an issue now, whatever its score. Answers with the new issue's number. */
export async function ownerAcceptIdeaAction(ideaId: string): Promise<OwnerMoveResult & { issueNumber?: number }> {
  const owned = await ownedIdea(ideaId);
  if ("error" in owned) return { error: owned.error as string };
  let issueId: string | null = null;
  const result = await ideaStep(async () => {
    issueId = (await ownerConvertIdea(owned.scope, owned.user.id, owned.ideaId)).issueId;
  });
  if ("error" in result || !issueId) return result;
  const issue = await prisma.bug.findUnique({ where: { id: issueId }, select: { number: true } });
  return { ok: true, issueNumber: issue?.number };
}

/** The owner turns an idea down, with the reason the reporter will read. */
export async function ownerRejectIdeaAction(ideaId: string, reason: string): Promise<OwnerMoveResult> {
  if (!reason.trim()) return { error: "Say why, so whoever suggested it understands." };
  if (reason.trim().length > OWNER_NOTE_MAX) return { error: `Keep the reason under ${OWNER_NOTE_MAX} characters.` };
  const owned = await ownedIdea(ideaId);
  if ("error" in owned) return { error: owned.error as string };
  return ideaStep(() => ownerRejectIdea(owned.scope, owned.user.id, owned.ideaId, reason));
}

/** The owner files an idea away: already done, a duplicate, or for another project. */
export async function ownerArchiveIdeaAction(ideaId: string, reason: string, evidence: string): Promise<OwnerMoveResult> {
  if (!(IDEA_ARCHIVE_REASONS as readonly string[]).includes(reason) || reason === IDEA_WITHDRAWN_REASON) return { error: "Pick why you're archiving it." };
  if (!evidence.trim()) return { error: "Add a line of evidence: the pull request, the duplicate, or the right project." };
  const owned = await ownedIdea(ideaId);
  if ("error" in owned) return { error: owned.error as string };
  return ideaStep(() => ownerArchiveIdea(owned.scope, owned.ideaId, { reason: reason as IdeaArchiveReason, evidence: evidence.trim().slice(0, 10_000) }));
}
