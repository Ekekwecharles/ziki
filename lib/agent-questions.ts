import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { resumeAfterWait } from "@/lib/claim-deadline";
import type { AgentContext } from "@/lib/agents/require-agent";
import { audit } from "@/lib/agents/audit";
import { publish } from "@/lib/agent-api/events";
import { notifyAgentQuestion } from "@/lib/agent-notifications";
import { IssueApiError } from "@/lib/agent-api/errors";
import type { WorkTrack } from "@prisma/client";
import { escalationTrackWhere } from "@/lib/my-work-filter";
import { activeIn } from "@/lib/agents/active-in";

/**
 * An agent asking its owner a question (#446). The agent stores the question
 * on `AgentQuestion`, tells its owner with an in-app notification, and writes
 * an event to the organisation feed. Only the owner answers, and the answer is set
 * once: a further question is a new row.
 *
 * Events are organisation-wide (#445), so they carry a reference to the question,
 * never its body or its answer. The asking agent reads the answer with
 * `readAgentQuestion`, which is scoped to that agent.
 */

const id = z.string().trim().min(1).max(191);

/** A question in the organisation: about one of its issues, or asked there by an agent active in it (#user-agents). */
function questionIn(organisationId: string): Prisma.AgentQuestionWhereInput {
  return { OR: [{ bug: { organisationId } }, { bugId: null, agent: activeIn(organisationId) }] };
}

export const escalationTypeValues = [
  "question",
  "work_authorization",
  "blocker",
  "scope_change",
  "human_approval",
  /** Raised by Ziki, not agents (#deeper-testing): the agent keeps judging without proof. */
  "proof",
] as const;

export type EscalationTypeSlug = (typeof escalationTypeValues)[number];

export const escalationTypeSchema = z.enum(escalationTypeValues);

export const agentQuestionSchema = z
  .object({
    /** The issue the question is about, when there is one. */
    bugId: id.optional(),
    body: z.string().trim().min(3).max(2000),
    type: escalationTypeSchema.optional(),
  })
  .strict();

export const agentEscalationSchema = agentQuestionSchema;

export const answerSchema = z.object({ answer: z.string().trim().min(1).max(2000) }).strict();

export type AskAgentQuestionInput = z.infer<typeof agentQuestionSchema>;
export type AskAgentEscalationInput = AskAgentQuestionInput;

export type EscalationStatus = "open" | "resolved" | "dismissed";

export function getEscalationStatus(answeredAt: Date | null | undefined, answer?: string | null): EscalationStatus {
  if (!answeredAt) return "open";
  if (answer && answer.toLowerCase().startsWith("dismissed")) return "dismissed";
  return "resolved";
}

/** A contributor or above asks its owner. */
export async function askAgentQuestion(agent: AgentContext, input: AskAgentQuestionInput) {
  const effectiveBody = input.type ? `[${input.type}] ${input.body}` : input.body;
  const escalationType = input.type ? slugToEscalationType(input.type) : classifyEscalation(input.body);
  const typeSlug = input.type ?? escalationTypeToSlug(escalationType);

  const question = await prisma.$transaction(async (tx) => {
    let bugTitle: string | null = null;
    if (input.bugId) {
      const bug = await tx.bug.findFirst({
        where: { id: input.bugId, organisationId: agent.organisationId, isDeleted: false },
        select: { id: true, title: true, projectId: true },
      });
      if (!bug) throw new IssueApiError(404, "Linked issue not found.");
      // #412: a project-scoped key may only link its own project's issues,
      // checked before anything (like the title) goes back to the caller.
      bugTitle = bug.title;
    }

    const created = await tx.agentQuestion.create({
      data: {
        agentId: agent.agentId,
        ownerUserId: agent.ownerId,
        bugId: input.bugId ?? null,
        body: effectiveBody,
      },
      select: { id: true, bugId: true, body: true, createdAt: true },
    });

    if (created.bugId) {
      // #606: asking about an issue the agent holds pauses that claim's
      // clocks. Claim transitions lock the issue first, like the sweep does.
      await tx.$queryRaw`SELECT "id" FROM "Bug" WHERE "id" = ${created.bugId} FOR NO KEY UPDATE`;
      await tx.issueClaim.updateMany({
        where: { bugId: created.bugId, agentId: agent.agentId, status: "active", releasedAt: null, waitingOnOwnerSince: null },
        data: { waitingOnOwnerSince: created.createdAt },
      });
    }

    await audit(agent, "question.asked", created.id, { bugId: created.bugId, type: typeSlug }, { db: tx, bugId: created.bugId });
    await publish(tx, {
      organisationId: agent.organisationId,
      type: "question.asked",
      payload: { questionId: created.id, agentId: agent.agentId, bugId: created.bugId, type: typeSlug },
      actorAgentId: agent.agentId,
      bugId: created.bugId,
    });

    return { ...created, bugTitle };
  });

  // Queue the owner's notification after the row commits, like #443 does.
  notifyAgentQuestion({
    id: question.id,
    body: question.body,
    organisationId: agent.organisationId,
    ownerUserId: agent.ownerId,
    agent: { name: agent.name },
    bugId: question.bugId,
    bugTitle: question.bugTitle,
  });

  const parsed = parseEscalationBody(question.body);

  return {
    ...question,
    body: parsed.cleanBody,
    type: typeSlug,
    status: "open" as const,
  };
}

export const askAgentEscalation = askAgentQuestion;

/** The asking agent reads its own question and the answer, once there is one. */
export async function readAgentQuestion(agent: AgentContext, questionId: string) {
  const question = await prisma.agentQuestion.findFirst({
    where: { id: questionId, agentId: agent.agentId },
    select: { id: true, body: true, answer: true, answeredAt: true, bugId: true, createdAt: true },
  });
  if (!question) throw new IssueApiError(404, "Question not found.");
  const parsed = parseEscalationBody(question.body);
  const typeSlug = escalationTypeToSlug(parsed.type);
  const status = getEscalationStatus(question.answeredAt, question.answer);
  return {
    id: question.id,
    bugId: question.bugId,
    body: parsed.cleanBody,
    type: typeSlug,
    status,
    resolution: question.answer,
    resolvedAt: question.answeredAt,
    createdAt: question.createdAt,
  };
}

export async function readAgentEscalation(agent: AgentContext, escalationId: string) {
  const question = await readAgentQuestion(agent, escalationId);
  return {
    id: question.id,
    bugId: question.bugId,
    body: question.body,
    type: question.type,
    status: question.status,
    resolution: question.resolution,
    resolvedAt: question.resolvedAt,
    createdAt: question.createdAt,
  };
}

/**
 * Only the owner answers, and only once. The update is guarded on `answer:
 * null` so two answers racing can't both win.
 */
export async function answerAgentQuestion(userId: string, organisationId: string, questionId: string, answer: string) {
  return prisma.$transaction(async (tx) => {
    const member = await tx.membership.findUnique({
      where: { organisationId_userId: { organisationId, userId } },
      select: { userId: true },
    });
    if (!member) throw new IssueApiError(403, "Organisation membership required.");

    const question = await tx.agentQuestion.findFirst({
      where: { id: questionId, ...questionIn(organisationId) },
      select: { id: true, agentId: true, bugId: true, ownerUserId: true },
    });
    if (!question) throw new IssueApiError(404, "Question not found.");
    if (question.ownerUserId !== userId) throw new IssueApiError(403, "Only the owner can answer this question.");

    const answeredAt = new Date();
    const updated = await tx.agentQuestion.updateMany({
      where: { id: questionId, answer: null },
      data: { answer, answeredAt },
    });
    if (!updated.count) throw new IssueApiError(409, "That question has already been answered.");
    if (question.bugId) await resumeWaitingClaim(tx, question.agentId, question.bugId, answeredAt);

    await audit({ agentId: question.agentId, organisationId }, "question.answered", questionId, { answeredAt }, {
      db: tx,
      actorUserId: userId,
      bugId: question.bugId,
    });
    await publish(tx, {
      organisationId,
      type: "question.answered",
      payload: { questionId, agentId: question.agentId, bugId: question.bugId, answeredAt },
      bugId: question.bugId,
    });

    return { id: questionId, answer, answeredAt };
  });
}

/**
 * #606: once the agent has no unanswered question left on the issue, its
 * paused claim runs again. The time spent waiting is added back to the
 * delivery deadline and to the silence clock, so the wait costs the agent
 * nothing.
 */
async function resumeWaitingClaim(tx: Prisma.TransactionClient, agentId: string, bugId: string, now: Date) {
  await tx.$queryRaw`SELECT "id" FROM "Bug" WHERE "id" = ${bugId} FOR NO KEY UPDATE`;
  const stillOpen = await tx.agentQuestion.count({ where: { agentId, bugId, answeredAt: null } });
  if (stillOpen) return;
  const claim = await tx.issueClaim.findFirst({
    where: { bugId, agentId, status: "active", releasedAt: null, waitingOnOwnerSince: { not: null } },
    select: { id: true, waitingOnOwnerSince: true, deliverBy: true, lastHeartbeatAt: true, claimedAt: true },
  });
  if (!claim?.waitingOnOwnerSince) return;
  const since = claim.waitingOnOwnerSince;
  const lastSeen = resumeAfterWait(claim.lastHeartbeatAt ?? claim.claimedAt, since, now);
  await tx.issueClaim.update({
    where: { id: claim.id },
    data: {
      waitingOnOwnerSince: null,
      deliverBy: resumeAfterWait(claim.deliverBy, since, now),
      // A heartbeat sent during the wait would land in the future; cap it at now.
      lastHeartbeatAt: lastSeen && lastSeen.getTime() > now.getTime() ? now : lastSeen,
    },
  });
}

/** The owner's list, unanswered questions first. */
export async function listOwnerQuestions(userId: string, organisationId: string, track: WorkTrack | "all" = "all") {
  return prisma.agentQuestion.findMany({
    where: { ownerUserId: userId, AND: [questionIn(organisationId), escalationTrackWhere(track)] },
    orderBy: [{ answeredAt: { sort: "asc", nulls: "first" } }, { createdAt: "desc" }, { id: "desc" }],
    take: 100,
    select: {
      id: true,
      body: true,
      answer: true,
      answeredAt: true,
      bugId: true,
      createdAt: true,
      agent: { select: { id: true, name: true } },
      bug: { select: { id: true, number: true, title: true, track: true, project: { select: { slug: true, organisation: { select: { slug: true } } } } } },
    },
  });
}

/** Count unresolved / pending escalations for an owner in the organisation (#763). */
export async function countPendingEscalations(userId: string, organisationId: string): Promise<number> {
  return prisma.agentQuestion.count({
    where: {
      ownerUserId: userId,
      answeredAt: null,
      ...questionIn(organisationId),
    },
  });
}

/** Escalations linked to a specific issue/ticket (#763). */
export async function listBugEscalations(bugId: string, organisationId: string) {
  return prisma.agentQuestion.findMany({
    where: {
      bugId,
      ...questionIn(organisationId),
    },
    orderBy: [{ answeredAt: { sort: "asc", nulls: "first" } }, { createdAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      body: true,
      answer: true,
      answeredAt: true,
      createdAt: true,
      agent: { select: { id: true, name: true } },
    },
  });
}

export type EscalationType =
  | "Blocker"
  | "Work Authorization"
  | "Question"
  | "Scope Expansion"
  | "Human Approval"
  | "No Proof";

export function escalationTypeToSlug(type: EscalationType): EscalationTypeSlug {
  switch (type) {
    case "Blocker":
      return "blocker";
    case "Work Authorization":
      return "work_authorization";
    case "Scope Expansion":
      return "scope_change";
    case "Human Approval":
      return "human_approval";
    case "No Proof":
      return "proof";
    case "Question":
    default:
      return "question";
  }
}

export function slugToEscalationType(slug: EscalationTypeSlug | string): EscalationType {
  switch (slug) {
    case "blocker":
      return "Blocker";
    case "work_authorization":
      return "Work Authorization";
    case "scope_change":
      return "Scope Expansion";
    case "human_approval":
      return "Human Approval";
    case "proof":
      return "No Proof";
    case "question":
    default:
      return "Question";
  }
}

export function parseEscalationBody(rawBody: string): { type: EscalationType; cleanBody: string } {
  const match = rawBody.match(/^\[([a-zA-Z\s_]+)\]\s*([\s\S]*)$/);
  if (match) {
    const tag = match[1].toLowerCase().replace(/\s+/g, "_");
    if (tag === "blocker") return { type: "Blocker", cleanBody: match[2] };
    if (tag === "work_authorization" || tag === "authorization") return { type: "Work Authorization", cleanBody: match[2] };
    if (tag === "scope_change" || tag === "scope_expansion") return { type: "Scope Expansion", cleanBody: match[2] };
    if (tag === "human_approval" || tag === "approval") return { type: "Human Approval", cleanBody: match[2] };
    if (tag === "proof") return { type: "No Proof", cleanBody: match[2] };
    if (tag === "question") return { type: "Question", cleanBody: match[2] };
  }
  return { type: classifyEscalation(rawBody), cleanBody: rawBody };
}

/**
 * Classifies an agent escalation into a standard human-actionable type (#763).
 */
export function classifyEscalation(body: string): EscalationType {
  const lower = body.toLowerCase();
  if (
    lower.includes("block") ||
    lower.includes("stuck") ||
    lower.includes("impediment") ||
    lower.startsWith("[blocker]")
  ) {
    return "Blocker";
  }
  if (
    lower.includes("authoriz") ||
    lower.includes("permission") ||
    lower.includes("start work") ||
    lower.includes("bid") ||
    lower.startsWith("[work authorization]")
  ) {
    return "Work Authorization";
  }
  if (
    lower.includes("scope") ||
    lower.includes("expand") ||
    lower.includes("out of scope") ||
    lower.includes("refactor") ||
    lower.startsWith("[scope expansion]")
  ) {
    return "Scope Expansion";
  }
  if (
    lower.includes("approv") ||
    lower.includes("sign off") ||
    lower.includes("confirm") ||
    lower.includes("review") ||
    lower.startsWith("[human approval]")
  ) {
    return "Human Approval";
  }
  return "Question";
}

/** One question for its owner, or `null` so the page can 404 anyone else. */
export async function ownerQuestion(userId: string, organisationId: string, questionId: string) {
  return prisma.agentQuestion.findFirst({
    where: { id: questionId, ownerUserId: userId, ...questionIn(organisationId) },
    select: {
      id: true,
      body: true,
      answer: true,
      answeredAt: true,
      createdAt: true,
      agent: { select: { name: true } },
      bug: { select: { id: true, number: true, title: true, project: { select: { slug: true, organisation: { select: { slug: true } } } } } },
    },
  });
}
