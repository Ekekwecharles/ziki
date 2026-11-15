"use server";

import { closeSupportThreadsForIssue } from "@/lib/support-threads";
import { revalidatePath } from "next/cache";
import { activeIn } from "@/lib/agents/active-in";
import { revalidateIssue } from "@/lib/revalidate-issue";
import { fieldError, fromZodError } from "@/lib/form-errors";
import { redirect } from "next/navigation";
import {
  activityCreateData,
  areaChangedSummary,
  assigneeChangedSummary,
  boostedSummary,
  commentedSummary,
  commentPreview,
  deletedSummary,
  restoredSummary,
  statusChangedSummary,
  typeChangedSummary,
  unboostedSummary,
  type ActivityMetadata,
} from "@/lib/activity-log";
import { prisma } from "@/lib/prisma";
import { readAgentResolution } from "@/lib/agent-resolution";
import { requireUser } from "@/lib/auth-helpers";
import { canContributeToProject } from "@/lib/project-permissions";
import {
  resolveSessionUserId,
  SESSION_EXPIRED_MESSAGE,
} from "@/lib/session-user";
import {
  extractMentionedUserIds,
  newlyMentionedUserIds,
  normalizeMentions,
} from "@/lib/mentions";
import { resolveOrganisationMentions, organisationMemberWhere } from "@/lib/organisation-mentions";
import { parseIdeaTrack, typeFitsTrack } from "@/lib/marketing/idea-track";
import { structureIdea } from "@/lib/idea-structuring";
import {
  commentSchema,
  createBugSchema,
  editBugContentSchema,
  editProofLinksSchema,
  retestRequestSchema,
  editPullRequestUrlSchema,
  updateBugSchema,
} from "@/lib/validations/issue";
import {
  calculateVoteChange,
  DOWNVOTES_REMOVED_MESSAGE,
  isValidVoteDirection,
  reconcileVoteCount,
  tallyVoteGroups,
} from "@/lib/voting";
import {
  canDeleteTicket,
  canRestoreTicket,
  TICKET_DELETION_ERRORS,
} from "@/lib/ticket-deletion";
import {
  canBoostTicket,
  shouldUnboostOnStatusChange,
  TICKET_BOOST_ERRORS,
} from "@/lib/ticket-boosting";
import { canAssignTicket, TICKET_ASSIGN_ERRORS } from "@/lib/ticket-assignment";
import { canChangeTicketStatus, TICKET_TRIAGE_ERRORS } from "@/lib/ticket-triage";
import {
  canEditTicket,
  formatEditSummary,
  formatProofLinkSummary,
  getChangedEditFields,
  getProofLinkChanges,
  TICKET_EDIT_ERRORS,
} from "@/lib/ticket-editing";
import { Prisma, type ActivityType, type Substatus } from "@prisma/client";
import { notifyLater } from "@/lib/notify";
import { ensureWatching } from "@/lib/watch";
import { parseResolutionNote } from "@/lib/resolution-note";
import { isUntouchedTemplate, UNFILLED_TEMPLATE_MESSAGE } from "@/lib/issue-templates";
import type { NotificationEvent } from "@/lib/notifications";
import { getForeignKeyErrorMessage } from "@/lib/foreign-key-errors";
import { parseAttachmentIds } from "@/lib/attachments";
import { attachmentIdsInMarkdown, linkAttachments } from "@/lib/attachment-link";
import {
  bugInOrganisation,
  currentOrganisationIdFor,
  NO_ORGANISATION_MESSAGE,
} from "@/lib/organisation-context";
import { currentOrganisationAccess } from "@/lib/organisation-access";
import { award, solverAwardFor } from "@/lib/points/award";
import { holdPayout } from "@/lib/points/payout";
import { isConfirmed } from "@/lib/agent-api/confirmations";
import { correct } from "@/lib/points/correct";
import { VOTE_POINTS, importanceSourceKey, pointSourceKey } from "@/lib/points/rules";
import {
  checkRateLimit,
  consumeRateLimit,
  ACTION_RATE_LIMITS,
  RATE_LIMIT_MESSAGE,
} from "@/lib/rate-limit";
import { publish } from "@/lib/agent-api/events";
import { issueChangePayload, publishWebEvent } from "@/lib/agent-api/web-events";
import { firstPullRequestLink } from "@/lib/github/pr-mention";
import { CommentPlacementError, placeComment, type CommentPlacement } from "@/lib/comment-placement";
import { acceptedFixGate, releaseAcceptedFix, standingAcceptance } from "@/lib/accepted-fix";
import { latestPullRequestReport, reportedClosedUnmerged } from "@/lib/agent-api/pull-request-report";
import { isFormerNameOf } from "@/lib/github/former-repos";
import { parsePullRequestUrl, sameRepo } from "@/lib/github/pull-request-url";
import { PROJECT_REPOSITORIES_SELECT, repoForPullRequest } from "@/lib/github/project-repositories";
import {
  agentMentionNames,
  agentOwnerIds,
  mentionedAgents,
  type MentionedAgent,
} from "@/lib/agent-mentions";
import { ideaPath, refOf } from "@/lib/project-paths";
import { moveTo } from "@/lib/issue-substatus";
import { entrySubstatus } from "@/lib/marketing/track";
import { createFinding, isSecuritySeverity, placeholderTitle, PLACEHOLDER_DESCRIPTION, PLACEHOLDER_SUMMARY, isPrivateFinding, PRIVATE_FINDING_EDIT_MESSAGE } from "@/lib/security-findings";
import { checkPostForSecrets } from "@/lib/security/secret-guard";

export type ActionResult = {
  error?: string;
  ok?: boolean;
  /** Which field failed, when there is one (#309). */
  field?: string;
  fieldErrors?: Record<string, string>;
  commentId?: string;
  /** The new idea's page, when the form asked to stay where it is (`stay`). */
  href?: string;
};

/**
 * Resolves `@[Name](userId)` tags against this organisation's members: known ids are
 * rewritten to the current name, anyone else degrades to plain `@Name` (#502).
 * `agents` are the issue organisation's agents the text may keep tags for (#603).
 */
async function normalizeMentionTags(
  text: string,
  organisationId: string,
  agents: MentionedAgent[] = [],
): Promise<string> {
  const mentionedIds = extractMentionedUserIds(text);
  if (mentionedIds.length === 0 && agents.length === 0) return text;

  const validUsers = mentionedIds.length
    ? await prisma.user.findMany({
        where: { id: { in: mentionedIds }, ...organisationMemberWhere(organisationId) },
        select: { id: true, name: true },
      })
    : [];
  const userMap = new Map([
    ...validUsers.map((user) => [user.id, user.name] as [string, string]),
    ...agentMentionNames(agents),
  ]);
  return normalizeMentions(text, userMap);
}

function foreignKeyError(error: unknown): string | null {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") {
    return getForeignKeyErrorMessage(error.meta as Record<string, unknown> | undefined);
  }
  return null;
}

/** Reads the type, including when the template column has not been migrated yet. */
async function issueTypeForCreate(typeId: string, organisationId: string) {
  try {
    return await prisma.issueType.findUnique({
      where: { id_organisationId: { id: typeId, organisationId } },
      select: { id: true, isActive: true, template: true, track: true },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const missingTemplate =
      (typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === "P2022" &&
        "meta" in error &&
        String((error as { meta?: { column?: unknown } }).meta?.column ?? "").includes("template")) ||
      /column [`'"]?(?:[\w."]+\.)*template[`'"]?/i.test(message);
    if (!missingTemplate) throw error;
    const row = await prisma.issueType.findUnique({
      where: { id_organisationId: { id: typeId, organisationId } },
      select: { id: true, isActive: true },
    });
    return row ? { ...row, template: null, track: "product" as const } : null;
  }
}

/** Redirects to login when the JWT is missing or no longer maps to a User row. */
async function requireUserId() {
  const resolved = await resolveSessionUserId();
  if ("error" in resolved) {
    redirect("/login");
  }
  return resolved.userId;
}

/**
 * Files a report as the signed-in user. Every report is an idea
 * (#idea-table): it takes verdicts until an agent converts it, which
 * creates the issue. Ideas have no assignee.
 */
export async function createBugAction(
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const userId = user.id;

  const limit = await consumeRateLimit(
    `create-bug:${userId}`,
    ACTION_RATE_LIMITS.createBug,
  );
  if (!limit.allowed) {
    return { error: RATE_LIMIT_MESSAGE };
  }

  // Auto-generate title from description if omitted or blank (for simplified report intake)
  const rawTitle = formData.get("title");
  const rawDesc = formData.get("description");
  let titleStr = typeof rawTitle === "string" ? rawTitle.trim() : "";
  const isReport = formData.get("isReport") === "true";

  if (!titleStr && typeof rawDesc === "string" && rawDesc.trim().length >= 3) {
    const firstLine = rawDesc.trim().split(/\r?\n/)[0]?.trim() || "";
    titleStr = firstLine.slice(0, 80);
    if (titleStr.length < 3) {
      titleStr = rawDesc.trim().slice(0, 80);
    }
  }

  const parsed = createBugSchema.safeParse({
    title: titleStr,
    description: formData.get("description"),
    typeId: formData.get("typeId") || "",
    assigneeId: "",
    areaId: formData.get("areaId") || "",
    proofLinks: formData.get("proofLinks") || "",
  });

  if (!parsed.success) {
    return fromZodError(parsed.error);
  }

  // Product (the default) or a marketing task, which must say why it is worth doing.
  const trackFields = parseIdeaTrack({ track: formData.get("track"), rationale: formData.get("rationale") });
  if (!trackFields.ok) {
    return fieldError(trackFields.field, trackFields.message);
  }
  const { track, rationale } = trackFields.value;

  const typeId =
    parsed.data.typeId && parsed.data.typeId.length > 0
      ? parsed.data.typeId
      : null;

  const requestedProjectId = typeof formData.get("projectId") === "string" ? String(formData.get("projectId")).trim() : "";
  const targetProject = requestedProjectId
    ? await prisma.project.findFirst({
        where: { id: requestedProjectId, archivedAt: null },
        select: { id: true, slug: true, organisationId: true, organisation: { select: { slug: true } } },
      })
    : null;
  if (!targetProject) {
    return { error: NO_ORGANISATION_MESSAGE };
  }
  const projectId = targetProject.id;
  const organisationId = targetProject.organisationId;

  const isDirectProjectMember = Boolean(
    await prisma.projectMembership.findUnique({
      where: { projectId_userId: { projectId, userId } },
      select: { id: true },
    })
  );
  const currentOrganisation = await currentOrganisationIdFor(userId);
  if (!currentOrganisation && !isDirectProjectMember && user.role !== "super_admin") {
    return { error: NO_ORGANISATION_MESSAGE };
  }

  if (!(await canContributeToProject(user, projectId, organisationId))) {
    return { error: "You must be a member of this project to submit issues." };
  }

  // #secret-protection: checked before anything else reads it, the idea-writing model included.
  const secrets = await checkPostForSecrets({
    organisationId,
    projectId,
    actor: { kind: "user", userId },
    source: "idea",
    url: null,
    fields: { title: parsed.data.title, description: parsed.data.description, rationale, proofLinks: parsed.data.proofLinks.join("\n") },
    noun: "this idea",
  });
  if (!secrets.ok) {
    return fieldError(secrets.field === "description" || secrets.field === "proofLinks" || secrets.field === "rationale" ? secrets.field : "title", secrets.message);
  }

  if (typeId) {
    const issueType = await issueTypeForCreate(typeId, organisationId);
    if (!issueType || !issueType.isActive) {
      return fieldError("typeId", "That type no longer exists. Please pick another.");
    }
    if (!typeFitsTrack(issueType.track, track)) {
      return fieldError(
        "typeId",
        track === "marketing" ? "Pick one of the marketing task types." : "That type is for marketing tasks. Please pick another.",
      );
    }
    // #307: headings alone pass the length check but say nothing.
    if (isUntouchedTemplate(parsed.data.description, issueType.template)) {
      return fieldError("description", UNFILLED_TEMPLATE_MESSAGE);
    }
  }

  const areaId = parsed.data.areaId && parsed.data.areaId.length > 0
    ? parsed.data.areaId
    : null;
  // #security-findings: a private security report. Its details go to SecurityFinding and
  // the idea keeps a placeholder, so nothing else in Ziki can show them before the fix is live.
  const security = formData.get("security") === "on" || formData.get("security") === "true";
  const rawSeverity = formData.get("severity");
  if (security && !isSecuritySeverity(rawSeverity)) {
    return fieldError("severity", "Choose how serious it is: Critical, High, Medium or Low.");
  }
  const severity = security && isSecuritySeverity(rawSeverity) ? rawSeverity : null;
  // #idea-intake: Claude writes what they typed up as a clear idea (title and the standard
  // headings) before it is saved. Without the key, or if that fails, it is saved as typed.
  // A marketing task is kept as written: the structuring writes a product report's headings.
  // A security report is saved as typed: its details are not sent to any outside service.
  const structured = track === "product" && !severity
    ? await structureIdea({ title: parsed.data.title, description: parsed.data.description })
    : null;
  const ideaTitle = structured?.title ?? parsed.data.title;
  // #502: mentions resolve only to members of the idea's organisation.
  const description = await resolveOrganisationMentions(prisma, organisationId, structured?.description ?? parsed.data.description);

  if (areaId) {
    const area = await prisma.projectArea.findFirst({
      where: { id: areaId, projectId },
      select: { id: true },
    });
    if (!area) return fieldError("areaId", "Area not found in this project.");
  }

  let idea: { id: string; number: number };
  try {
    idea = await prisma.$transaction(async (tx) => {
      const created = await tx.idea.create({
        data: {
          organisationId,
          projectId,
          beneficiaryUserId: userId,
          reporterId: userId,
          title: severity ? placeholderTitle(severity) : ideaTitle,
          description: severity ? PLACEHOLDER_DESCRIPTION : description,
          ...(severity ? { summary: PLACEHOLDER_SUMMARY } : {}),
          track,
          rationale,
          typeId,
          // Proof links can point at the exploit, so a private finding keeps them in its description.
          proofLinks: severity ? [] : parsed.data.proofLinks,
          areaId,
        },
        select: { id: true, number: true },
      });
      const finding = severity
        ? await createFinding(tx, {
            organisationId,
            projectId,
            ideaId: created.id,
            reporterId: userId,
            severity,
            title: ideaTitle,
            description: parsed.data.proofLinks.length
              ? `${description}\n\n**Proof links**\n${parsed.data.proofLinks.map((link) => `- ${link}`).join("\n")}`
              : description,
          })
        : null;
      // Files uploaded while writing the report (#215), and images pasted
      // or dropped into the description (#305). A finding's files stay with the finding.
      await linkAttachments(tx, {
        ids: [
          ...new Set([
            ...parseAttachmentIds(formData.get("attachmentIds")),
            ...attachmentIdsInMarkdown(description),
          ]),
        ],
        uploaderId: userId,
        ...(finding ? { securityFindingId: finding.id } : { ideaId: created.id }),
      });
      // #600 / #534: agents hear about ideas people file.
      await publish(tx, {
        organisationId,
        type: "idea.created",
        projectId,
        payload: {
          ideaId: created.id,
          ideaNumber: created.number,
          projectId,
          reporterId: userId,
          beneficiaryUserId: userId,
          isReport,
          ...(severity ? { security: { severity } } : {}),
          actor: { kind: "user", id: userId, name: user.name ?? null },
        },
      });
      return created;
    });
  } catch (error) {
    const foreignKey = foreignKeyError(error);
    if (foreignKey) return { error: foreignKey };
    throw error;
  }

  revalidatePath("/[org]/[project]", "layout");
  // The Marketing assistant files drafts from its chat and stays on it (#marketing-assistant).
  if (formData.get("stay") === "true") return { ok: true, href: ideaPath(refOf(targetProject), idea.number) };
  redirect(ideaPath(refOf(targetProject), idea.number));
}

/** Updates status (assignee/admin) and type/assignee (admin) and logs activity. */
export async function updateBugAction(
  bugId: string,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const userId = user.id;
  const access = await currentOrganisationAccess(userId, user.role);
  const admin = access.admin;

  const organisationId = await currentOrganisationIdFor(userId);
  const existing = await prisma.bug.findUnique({
    where: { id: bugId, ...bugInOrganisation(organisationId) },
    include: {
      assignee: { select: { id: true, name: true } },
      area: { select: { id: true, name: true } },
      type: { select: { id: true, name: true } },
      milestone: { select: { id: true, title: true } },
    },
  });
  if (!existing || existing.isDeleted) {
    return { error: "Issue not found" };
  }

  const isAssignee = existing.assigneeId === userId;
  const assigneeRaw = formData.get("assigneeId");
  const hasAssigneeField = assigneeRaw !== null && assigneeRaw !== undefined;
  const targetAssigneeId = hasAssigneeField
    ? assigneeRaw === "" || assigneeRaw === "unassigned"
      ? null
      : typeof assigneeRaw === "string"
        ? assigneeRaw.trim()
        : null
    : undefined;

  const isSelfAssigning =
    targetAssigneeId !== undefined && targetAssigneeId === userId;

  // #202: `status` is a triage field and must be gated on the issue's current
  // assignee (or an admin) - never on the assignee this request is trying to
  // set. Without this, a self-assignment satisfied the gate above and the same
  // request could also close/reopen the issue, letting any user close any
  // unassigned issue. Checked before schema parsing so the error is explicit.
  const requestedStatus = formData.get("status") || undefined;
  if (
    requestedStatus &&
    !canChangeTicketStatus({
      actorId: userId,
      actorRole: user.role,
      membershipRole: access.membershipRole,
      currentAssigneeId: existing.assigneeId,
    })
  ) {
    return { error: TICKET_TRIAGE_ERRORS.statusUnauthorized };
  }

  if (!admin && !isAssignee && !isSelfAssigning) {
    return {
      error: "Only the assignee, or an owner or admin of this organisation, can update this issue",
    };
  }

  if (!admin && isSelfAssigning && targetAssigneeId !== existing.assigneeId) {
    return { error: TICKET_ASSIGN_ERRORS.needsAgentClaim };
  }

  // #plan-review: a complex issue is won by a bid and an approved plan; assigning it by hand would skip the plan.
  if (targetAssigneeId && targetAssigneeId !== existing.assigneeId && existing.difficulty === "complex") {
    return { error: "A complex issue can't be assigned by hand: it is won by a bid, and its plan is approved by the agent's owner." };
  }

  if (targetAssigneeId !== undefined && targetAssigneeId !== existing.assigneeId) {
    if (
      !canAssignTicket({
        actorId: userId,
        actorRole: user.role,
        membershipRole: access.membershipRole,
        currentAssigneeId: existing.assigneeId,
        targetAssigneeId,
      })
    ) {
      return { error: TICKET_ASSIGN_ERRORS.unauthorized };
    }
  }

  const areaRaw = formData.get("areaId");
  const typeRaw = formData.get("typeId");
  const parsed = updateBugSchema.safeParse({
    status: requestedStatus,
    typeId: admin
      ? typeRaw === "" || typeRaw === "none"
        ? null
        : typeRaw || undefined
      : undefined,
    assigneeId: targetAssigneeId,
    areaId: admin
      ? areaRaw === "" || areaRaw === "none"
        ? null
        : areaRaw || undefined
      : undefined,
  });

  if (!parsed.success) {
    return fromZodError(parsed.error);
  }

  // Claiming an issue doesn't also grant its status in the same request: a
  // normal user who isn't the assignee yet must assign themselves first
  // (#218, #175). Someone an admin already assigned can move the status
  // from this page; that does not require an agent claim.
  if (
    !admin &&
    !isAssignee &&
    parsed.data.status &&
    parsed.data.status !== existing.status
  ) {
    return { error: TICKET_ASSIGN_ERRORS.statusNeedsAssignment };
  }

  // #316: an optional note, only for a change into resolved or closed.
  const parsedNote = parseResolutionNote(formData.get("resolutionNote"), {
    from: existing.status,
    to: parsed.data.status,
  });
  if ("error" in parsedNote) return { error: parsedNote.error, field: "resolutionNote" };
  const resolutionNote = parsedNote.note;

  // #642: a pull request reported closed without merging cannot resolve the
  // issue (#pr-reports: the latest independent report, not GitHub).
  if (
    parsed.data.status === "resolved" &&
    existing.status !== "resolved" &&
    existing.pullRequestUrl &&
    (await reportedClosedUnmerged(existing.id, existing.pullRequestUrl))
  ) {
    return { error: "The linked pull request is reported closed without being merged." };
  }

  const data: {
    status?: typeof parsed.data.status;
    substatus?: Substatus;
    typeId?: string | null;
    assigneeId?: string | null;
    areaId?: string | null;
    milestoneId?: string | null;
    isBoosted?: boolean;
    boostedAt?: Date | null;
    priority?: string;
  } = {};

  if (parsed.data.status && parsed.data.status !== existing.status) Object.assign(data, moveTo(entrySubstatus(existing.track, parsed.data.status)));
  if (admin) {
    if (parsed.data.typeId !== undefined) {
      data.typeId = parsed.data.typeId === "" ? null : parsed.data.typeId;
    }
    if (parsed.data.areaId !== undefined) {
      data.areaId = parsed.data.areaId === "" ? null : parsed.data.areaId;
    }
  }
  if (parsed.data.assigneeId !== undefined) {
    data.assigneeId =
      parsed.data.assigneeId === "" ? null : parsed.data.assigneeId;
  }
  if (parsed.data.priority !== undefined) {
    data.priority = parsed.data.priority;
  }

  type PendingActivity = {
    type: ActivityType;
    summary: string;
    metadata?: ActivityMetadata;
  };
  const pending: PendingActivity[] = [];

  if (data.substatus && data.substatus !== existing.substatus) {
    pending.push({
      type: "status_changed",
      summary: statusChangedSummary(existing.substatus, data.substatus),
      metadata: {
        field: "status",
        from: existing.substatus,
        to: data.substatus,
        ...(resolutionNote ? { note: resolutionNote } : {}),
      },
    });
  }

  // #256: a resolved or closed issue shouldn't stay pinned above open work.
  if (
    shouldUnboostOnStatusChange({
      isBoosted: existing.isBoosted,
      from: existing.status,
      to: data.status,
    })
  ) {
    data.isBoosted = false;
    data.boostedAt = null;
    pending.push({
      type: "unboosted",
      summary: unboostedSummary(),
      metadata: { field: "isBoosted", to: "false" },
    });
  }

  if (
    data.assigneeId !== undefined &&
    data.assigneeId !== existing.assigneeId
  ) {
    let toName: string | null = null;
    if (data.assigneeId) {
      const nextAssignee = await prisma.user.findFirst({
        where: { id: data.assigneeId, memberships: { some: { organisationId: existing.organisationId } } },
        select: { name: true },
      });
      if (!nextAssignee) {
        return { error: "Assignee not found in this organisation" };
      }
      toName = nextAssignee.name ?? null;
    }
    pending.push({
      type: "assignee_changed",
      summary: assigneeChangedSummary(existing.assignee?.name ?? null, toName),
      metadata: {
        field: "assigneeId",
        from: existing.assigneeId,
        to: data.assigneeId,
      },
    });
  }

  if (data.typeId !== undefined && data.typeId !== existing.typeId) {
    let toName: string | null = null;
    if (data.typeId) {
      const nextType = await prisma.issueType.findUnique({
        where: { id_organisationId: { id: data.typeId, organisationId: existing.organisationId } },
        select: { id: true, name: true, isActive: true },
      });
      if (!nextType || !nextType.isActive) {
        return { error: "That type no longer exists. Please pick another." };
      }
      toName = nextType.name;
    }
    pending.push({
      type: "type_changed",
      summary: typeChangedSummary(existing.type?.name ?? null, toName),
      metadata: {
        field: "type",
        from: existing.type?.name ?? null,
        to: toName,
      },
    });
  }

  if (data.areaId !== undefined) {
    let toName: string | null = null;
    if (data.areaId) {
      const area = await prisma.projectArea.findFirst({
        where: { id: data.areaId, projectId: existing.projectId },
        select: { id: true, name: true },
      });
      if (!area) return { error: "Area not found in this project." };
      toName = area.name;
    }
    if (data.areaId !== existing.areaId) {
      pending.push({
        type: "area_changed",
        summary: areaChangedSummary(existing.area?.name ?? null, toName),
        metadata: { field: "area", from: existing.area?.name ?? null, to: toName },
      });
    }
  }

  // #289: admins put an issue in at most one milestone. Absent from the
  // form means "leave it"; "" or "none" takes it out.
  const milestoneRaw = admin ? formData.get("milestoneId") : null;
  if (typeof milestoneRaw === "string") {
    const nextMilestoneId = milestoneRaw === "" || milestoneRaw === "none" ? null : milestoneRaw.trim();
    if (nextMilestoneId !== existing.milestoneId) {
      let toTitle: string | null = null;
      if (nextMilestoneId) {
        const milestone = await prisma.milestone.findUnique({
          where: { id_organisationId: { id: nextMilestoneId, organisationId: existing.organisationId } },
          select: { title: true, isClosed: true },
        });
        if (!milestone) return fieldError("milestoneId", "That milestone no longer exists.");
        if (milestone.isClosed) {
          return fieldError("milestoneId", `"${milestone.title}" is closed. Reopen it to add issues.`);
        }
        toTitle = milestone.title;
      }
      data.milestoneId = nextMilestoneId;
      const fromTitle = existing.milestone?.title ?? null;
      pending.push({
        type: "milestone_changed",
        summary: toTitle
          ? fromTitle
            ? `moved this from milestone "${fromTitle}" to "${toTitle}"`
            : `added this to milestone "${toTitle}"`
          : `removed this from milestone "${fromTitle}"`,
        metadata: { field: "milestone", from: fromTitle, to: toTitle },
      });
    }
  }

  if (data.priority !== undefined && data.priority !== existing.priority) {
    pending.push({
      type: "commented",
      summary: `Priority changed to ${data.priority}`,
      metadata: { field: "priority", from: existing.priority, to: data.priority },
    });
  }

  if (pending.length === 0 && Object.keys(data).length === 0) {
    return { ok: true };
  }

  try {
    await prisma.$transaction(async (tx) => {
      // #676: Row lock the Bug to serialize concurrent updates and prevent voteCount races.
      if (typeof tx.$queryRaw === "function") {
        await tx.$queryRaw`SELECT id FROM "Bug" WHERE id = ${bugId} FOR UPDATE`;
      }

      if (Object.keys(data).length > 0) {
        await tx.bug.update({
          where: { id: bugId },
          data,
        });
      }
      if (data.status === "resolved" || data.status === "closed") {
        const activeClaims = typeof tx.issueClaim?.findMany === "function"
          ? await tx.issueClaim.findMany({
            where: { bugId, status: "active", releasedAt: null },
            select: { id: true, agentId: true, beneficiaryUserId: true },
          })
          : [];
        await tx.issueClaim.updateMany({
          where: { bugId, status: "active", releasedAt: null },
          data: { status: "released", releasedAt: new Date(), releaseReason: data.status },
        });
        for (const claim of activeClaims) {
          await publish(tx, {
            organisationId: existing.organisationId,
            type: "claim.released",
            actorAgentId: claim.agentId,
            bugId,
            payload: { claimId: claim.id, issueId: bugId, beneficiaryUserId: claim.beneficiaryUserId, reason: data.status },
          });
        }
      }
      if (data.assigneeId) {
        // The new assignee starts watching (#216).
        await ensureWatching(tx, bugId, [data.assigneeId]);
      }
      // Admin assignment follows the offer flow: creating or
      // reassigning an assignee produces an offered IssueClaim for that
      // user's agent, as an awarded bid does. Releasing
      // any prior active/offered claim first keeps the cap slot free.
      const assigneeChanged =
        data.assigneeId !== undefined && data.assigneeId !== existing.assigneeId;
      if (assigneeChanged) {
        // Release prior claims held by the previous assignee's agent.
        if (existing.assigneeId && typeof tx.issueClaim?.updateMany === "function") {
          const priorClaims =
            typeof tx.issueClaim.findMany === "function"
              ? await tx.issueClaim.findMany({
                where: {
                  bugId,
                  beneficiaryUserId: existing.assigneeId,
                  status: { in: ["offered", "planning", "active"] },
                  releasedAt: null,
                },
                select: { id: true, agentId: true, beneficiaryUserId: true },
              })
              : [];
          await tx.issueClaim.updateMany({
            where: {
              bugId,
              beneficiaryUserId: existing.assigneeId,
              status: { in: ["offered", "planning", "active"] },
              releasedAt: null,
            },
            data: { status: "released", releasedAt: new Date(), releaseReason: "reassigned" },
          });
          for (const claim of priorClaims) {
            await publish(tx, {
              organisationId: existing.organisationId,
              type: "claim.released",
              actorAgentId: claim.agentId,
              bugId,
              payload: { claimId: claim.id, issueId: bugId, beneficiaryUserId: claim.beneficiaryUserId, reason: "reassigned" },
            });
          }
        }
        // Create an offered claim for the new assignee's agent, if any.
        if (data.assigneeId && typeof tx.issueClaim?.create === "function") {
          const agent = await tx.agent.findFirst({
            // #user-agents: their oldest agent active in this organisation.
            where: { ownerUserId: data.assigneeId, revokedAt: null, ...activeIn(existing.organisationId) },
            orderBy: { createdAt: "asc" },
            select: { id: true },
          });
          if (agent) {
            const claim = await tx.issueClaim.create({
              data: {
                bugId,
                beneficiaryUserId: data.assigneeId,
                agentId: agent.id,
                status: "offered",
                offeredAt: new Date(),
                dispatcherUserId: userId,
              },
            });
            await publish(tx, {
              organisationId: existing.organisationId,
              type: "claim.offered",
              actorAgentId: agent.id,
              bugId,
              payload: { claimId: claim.id, issueId: bugId, beneficiaryUserId: data.assigneeId },
            });
          }
        }
      }
      // #428, #rewards: resolving an issue earns its assignee the issue's reward, once,
      // held until enough people report the work deployed (#live-payout).
      if (data.status === "resolved" && existing.status !== "resolved") {
        const solver = await solverAwardFor(tx, {
          id: bugId,
          organisationId: existing.organisationId,
          assigneeId: data.assigneeId !== undefined ? data.assigneeId : existing.assigneeId,
        });
        if (solver) await holdPayout(tx, bugId, [solver]);
      }
      if (pending.length > 0) {
        await tx.bugActivity.createMany({
          data: activityCreateData(
            pending.map((entry) => ({
              bugId,
              actorId: userId,
              ...entry,
            })),
          ),
        });
      }
      // #600: triage from the web app reaches agents too.
      if (Object.keys(data).length > 0) {
        await publishWebEvent(tx, {
          bugId,
          type: "issue.updated",
          actorUserId: userId,
          payload: issueChangePayload(data as Record<string, unknown>),
        });
      }
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2003"
    ) {
      return {
        error: getForeignKeyErrorMessage(
          error.meta as Record<string, unknown> | undefined,
        ),
      };
    }
    throw error;
  }

  const events: NotificationEvent[] = [];
  const actor = { actorId: userId, actorName: user.name ?? "Someone", bugId, bugTitle: existing.title };
  if (data.assigneeId !== undefined && data.assigneeId !== existing.assigneeId) {
    events.push({ ...actor, kind: "assignee_changed", fromUserId: existing.assigneeId, toUserId: data.assigneeId });
  }
  if (data.status && data.status !== existing.status) {
    events.push({ ...actor, kind: "status_changed", reporterId: existing.reporterId, from: existing.status, to: data.status, note: resolutionNote });
  }
  if (events.length > 0) notifyLater(...events);

  revalidatePath("/[org]/[project]", "layout");
  revalidateIssue();
  revalidatePath("/bugs");
  revalidatePath(`/bugs/${bugId}`);
  return { ok: true };
}

/**
 * Closes an issue with an optional resolution note.
 */
export async function closeBugAction(
  bugId: string,
  note?: string,
): Promise<ActionResult> {
  const formData = new FormData();
  formData.append("status", "closed");
  if (note) {
    formData.append("resolutionNote", note);
  }
  return updateBugAction(bugId, formData);
}

/**
 * Reopens an issue by setting its status back to open.
 */
export async function reopenBugAction(
  bugId: string,
): Promise<ActionResult> {
  const formData = new FormData();
  formData.append("status", "open");
  return updateBugAction(bugId, formData);
}

/**
 * Ziki #515: undo an agent's resolve in one click, back to the status the
 * issue had before, while that resolve is still the latest status change.
 *
 * Authorized like any status change (assignee or admin, #202), but not routed
 * through updateBugAction: that also wants a non-admin to hold an active
 * claim, and the agent resolve released it (a person-assigned issue never had
 * one), so the assignee could never undo it.
 */
export async function reopenAgentResolvedAction(bugId: string): Promise<ActionResult> {
  const user = await requireUser();
  const access = await currentOrganisationAccess(user.id, user.role);
  const organisationId = await currentOrganisationIdFor(user.id);
  const existing = await prisma.bug.findUnique({
    where: { id: bugId, ...bugInOrganisation(organisationId) },
    select: { id: true, status: true, substatus: true, assigneeId: true, isDeleted: true },
  });
  if (!existing || existing.isDeleted) return { error: "Issue not found" };
  if (
    !canChangeTicketStatus({
      actorId: user.id,
      actorRole: user.role,
      membershipRole: access.membershipRole,
      currentAssigneeId: existing.assigneeId,
    })
  ) {
    return { error: TICKET_TRIAGE_ERRORS.statusUnauthorized };
  }

  const latest = await prisma.bugActivity.findFirst({
    where: { bugId, type: "status_changed" },
    orderBy: { createdAt: "desc" },
    select: { metadata: true },
  });
  const resolution = existing.status === "resolved" ? readAgentResolution(latest?.metadata) : null;
  if (!resolution) return { error: "This issue wasn't resolved by an agent, so there is nothing to undo." };
  const to = resolution.previousStatus;

  const reopened = await prisma.$transaction(async (tx) => {
    // Someone may have changed the status since the read above.
    const changed = await tx.bug.updateMany({ where: { id: bugId, status: "resolved" }, data: moveTo(to) });
    if (changed.count !== 1) return false;
    await tx.bugActivity.create({
      data: {
        bugId,
        actorId: user.id,
        type: "status_changed",
        summary: statusChangedSummary(existing.substatus, to),
        metadata: { field: "status", from: existing.substatus, to, via: "reopen_agent_resolve" },
      },
    });
    await publishWebEvent(tx, { bugId, type: "issue.updated", actorUserId: user.id, payload: issueChangePayload(moveTo(to)) });
    return true;
  });
  if (!reopened) return { error: "The issue's status changed meanwhile. Refresh and try again." };

  revalidatePath("/[org]/[project]", "layout");
  revalidateIssue();
  revalidatePath("/bugs");
  revalidatePath(`/bugs/${bugId}`);
  return { ok: true };
}

/**
 * Assigns an issue to a user or clears the assignee if null or empty.
 */
export async function assignBugAction(
  bugId: string,
  assigneeId: string | null,
): Promise<ActionResult> {
  const formData = new FormData();
  formData.append("assigneeId", assigneeId ?? "");
  return updateBugAction(bugId, formData);
}

/** Allows the reporter or an admin to edit an issue's title and description. */
export async function editBugContentAction(
  bugId: string,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const userId = user.id;

  const limit = checkRateLimit(
    `edit-bug:${userId}`,
    ACTION_RATE_LIMITS.editBug,
  );
  if (!limit.allowed) {
    return { error: RATE_LIMIT_MESSAGE };
  }

  const existing = await prisma.bug.findUnique({
    where: { id: bugId, ...bugInOrganisation(await currentOrganisationIdFor(userId)) },
    select: {
      id: true,
      title: true,
      description: true,
      reporterId: true,
      beneficiaryUserId: true,
      status: true,
      substatus: true,
      organisationId: true,
      isDeleted: true,
    },
  });

  if (!existing || existing.isDeleted) {
    return { error: TICKET_EDIT_ERRORS.notFound };
  }
  // #security-findings: the shared row of a private finding only ever holds the placeholder.
  if (await isPrivateFinding({ bugId: existing.id })) {
    return { error: PRIVATE_FINDING_EDIT_MESSAGE };
  }

  if (
    !canEditTicket({
      actorId: userId,
      actorRole: user.role,
      membershipRole: (await currentOrganisationAccess(userId, user.role)).membershipRole,
      reporterId: existing.reporterId,
    })
  ) {
    return { error: TICKET_EDIT_ERRORS.unauthorized };
  }

  const parsed = editBugContentSchema.safeParse({
    title: formData.get("title"),
    description: formData.get("description"),
  });

  if (!parsed.success) {
    return fromZodError(parsed.error);
  }

  // #secret-protection: an edit is a post too.
  const secrets = await checkPostForSecrets({
    organisationId: existing.organisationId,
    actor: { kind: "user", userId },
    source: "issue",
    bugId: existing.id,
    fields: { title: parsed.data.title, description: parsed.data.description },
    noun: "this issue",
  });
  if (!secrets.ok) return fieldError(secrets.field === "title" ? "title" : "description", secrets.message);

  const normalizedDescription = await resolveOrganisationMentions(prisma, existing.organisationId, parsed.data.description);
  const changedFields = getChangedEditFields(existing, {
    title: parsed.data.title,
    description: normalizedDescription,
  });

  if (changedFields.length === 0) {
    return { ok: true };
  }

  const summary = formatEditSummary(changedFields);

  await prisma.$transaction(async (tx) => {
    // #303: keep the version this edit replaces. Read again under a row
    // lock so two edits at once each store the version they replaced and
    // none goes missing from the history.
    const [previous] = await tx.$queryRaw<{ title: string; description: string }[]>`
      SELECT "title", "description" FROM "Bug" WHERE "id" = ${bugId} FOR UPDATE`;
    // Read before the revision below voids the confirmations.
    const wasConfirmed = await isConfirmed(bugId, tx);
    await tx.bugRevision.create({
      data: {
        bugId,
        title: previous?.title ?? existing.title,
        description: previous?.description ?? existing.description,
        editedById: userId,
      },
    });

    // #713: Editing an issue voids its confirmations and reverses any
    // reporter points awarded for the replaced report. The entries and their
    // replies stay (a person wrote them), but only entries given after the
    // latest edit count (lib/issue-stage.ts), so this revision clears them:
    // each person gives theirs again to count.
    type OptionalTxExtensions = {
      pointEntry?: {
        findFirst?: (args: unknown) => Promise<{ id: string; organisationId: string; userId: string; bugId: string | null; role: "solver" | "reporter" | "reviewer"; points: number } | null>;
        update?: (args: unknown) => Promise<unknown>;
      };
    };
    const txExtensions = tx as unknown as OptionalTxExtensions;

    if (wasConfirmed) {
      const recipientId = existing.beneficiaryUserId ?? existing.reporterId;
      const organisationId = existing.organisationId ?? (await currentOrganisationIdFor(userId));
      if (recipientId && typeof txExtensions.pointEntry?.findFirst === "function") {
        const entry = await txExtensions.pointEntry.findFirst({
          where: {
            organisationId,
            sourceKey: pointSourceKey("reporter", bugId, recipientId),
          },
          select: { id: true, organisationId: true, userId: true, bugId: true, role: true, points: true },
        });
        if (entry) {
          await correct(tx, { entry });
          if (typeof txExtensions.pointEntry?.update === "function") {
            await txExtensions.pointEntry.update({
              where: { id: entry.id },
              data: {
                sourceKey: `${pointSourceKey("reporter", bugId, recipientId)}:invalidated:${entry.id}`,
              },
            });
          }
        }
      }
    }

    await tx.bug.update({
      where: { id: bugId },
      data: {
        title: parsed.data.title,
        description: normalizedDescription,
        updatedAt: new Date(),
        // #requires-confirmation: the edit voided its confirmations, so an Open issue needs confirming again.
        ...(existing.substatus === "open" ? moveTo("requires_confirmation") : {}),
      },
    });

    // Images pasted into the edited description (#305); only the editor's
    // own, not-yet-linked uploads are claimed.
    await linkAttachments(tx, {
      ids: attachmentIdsInMarkdown(normalizedDescription),
      uploaderId: userId,
      bugId,
    });
    await publishWebEvent(tx, {
      bugId,
      type: "issue.updated",
      actorUserId: userId,
      payload: issueChangePayload(
        Object.fromEntries(
          changedFields.map((field) => [field, field === "title" ? parsed.data.title : normalizedDescription]),
        ),
      ),
    });

    await tx.bugActivity.create({
      data: {
        bugId,
        actorId: userId,
        type: "edited",
        summary,
        metadata: {
          fields: changedFields,
        },
      },
    });
  });

  const newlyMentioned = newlyMentionedUserIds(
    existing.description,
    normalizedDescription,
  );
  if (newlyMentioned.length > 0) {
    notifyLater({
      kind: "mentioned",
      actorId: userId,
      actorName: user.name ?? "Someone",
      bugId,
      bugTitle: parsed.data.title,
      place: "description",
      recipientIds: newlyMentioned,
    });
  }

  revalidatePath("/[org]/[project]", "layout");
  revalidateIssue();
  revalidatePath("/bugs");
  revalidatePath(`/bugs/${bugId}`);
  return { ok: true };
}

/**
 * Lets the reporter or an admin add, correct, or remove an issue's proof
 * links after filing (#737). Same rules as create: GitHub URLs, at most 20.
 */
export async function editProofLinksAction(
  bugId: string,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const userId = user.id;

  const limit = checkRateLimit(
    `edit-bug:${userId}`,
    ACTION_RATE_LIMITS.editBug,
  );
  if (!limit.allowed) {
    return { error: RATE_LIMIT_MESSAGE };
  }

  const existing = await prisma.bug.findUnique({
    where: { id: bugId, ...bugInOrganisation(await currentOrganisationIdFor(userId)) },
    select: {
      id: true,
      proofLinks: true,
      pullRequestUrl: true,
      reporterId: true,
      assigneeId: true,
      isDeleted: true,
    },
  });

  if (!existing || existing.isDeleted) {
    return { error: TICKET_EDIT_ERRORS.notFound };
  }

  const mayEditLinks =
    existing.assigneeId === userId ||
    canEditTicket({
      actorId: userId,
      actorRole: user.role,
      membershipRole: (await currentOrganisationAccess(userId, user.role)).membershipRole,
      reporterId: existing.reporterId,
    });
  if (!mayEditLinks) {
    return { error: TICKET_EDIT_ERRORS.unauthorized };
  }

  const parsed = editProofLinksSchema.safeParse({
    proofLinks: formData.get("proofLinks") || "",
  });

  if (!parsed.success) {
    return fromZodError(parsed.error);
  }

  const proofLinks = parsed.data.proofLinks;
  const changes = getProofLinkChanges(existing.proofLinks ?? [], proofLinks);
  if (changes.added.length === 0 && changes.removed.length === 0) {
    return { ok: true };
  }

  const accepted = await standingAcceptance(prisma, bugId);
  const nextPullRequest = firstPullRequestLink(proofLinks);
  if (accepted && existing.pullRequestUrl && nextPullRequest !== existing.pullRequestUrl) {
    return {
      error:
        "This issue's accepted fix is bound to a different pull request — link the accepted one again.",
    };
  }

  const updatePullRequest = !accepted && nextPullRequest !== existing.pullRequestUrl;

  await prisma.$transaction(async (tx) => {
    await tx.bug.update({
      where: { id: bugId },
      data: {
        proofLinks,
        updatedAt: new Date(),
        ...(updatePullRequest ? { pullRequestUrl: nextPullRequest } : {}),
      },
    });

    await publishWebEvent(tx, {
      bugId,
      type: "issue.updated",
      actorUserId: userId,
      payload: issueChangePayload({ proofLinks, ...(updatePullRequest ? { pullRequestUrl: nextPullRequest } : {}) }),
    });

    await tx.bugActivity.create({
      data: {
        bugId,
        actorId: userId,
        type: "edited",
        summary: formatProofLinkSummary(changes),
        metadata: {
          fields: ["proofLinks"],
          added: changes.added,
          removed: changes.removed,
        },
      },
    });

    if (updatePullRequest) {
      await tx.bugActivity.create({
        data: {
          bugId,
          actorId: userId,
          type: "edited",
          summary: nextPullRequest
            ? `linked PR ${nextPullRequest}`
            : `unlinked PR ${existing.pullRequestUrl}`,
          metadata: { field: "pullRequestUrl", pullRequestUrl: nextPullRequest, via: "proofLinks" },
        },
      });
    }
  });

  revalidatePath("/[org]/[project]", "layout");
  revalidateIssue();
  revalidatePath("/bugs");
  revalidatePath(`/bugs/${bugId}`);
  return { ok: true };
}

/**
 * Updates or replaces the submitted GitHub pull request URL on an issue
 * (#edit-pr-link). Allowed for the contributor who submitted the PR (or whose
 * agent delivered it / holds the claim), the assignee, the reporter, or a
 * tenant admin. Validates that the URL is a pull request in the project's
 * repository and refreshes `pullRequestHeadSha`.
 */
export async function editPullRequestUrlAction(
  bugId: string,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const userId = user.id;

  const limit = checkRateLimit(
    `edit-bug:${userId}`,
    ACTION_RATE_LIMITS.editBug,
  );
  if (!limit.allowed) {
    return { error: RATE_LIMIT_MESSAGE };
  }

  const existing = await prisma.bug.findUnique({
    where: { id: bugId, ...bugInOrganisation(await currentOrganisationIdFor(userId)) },
    select: {
      id: true,
      status: true,
      proofLinks: true,
      pullRequestUrl: true,
      pullRequestHeadSha: true,
      reporterId: true,
      assigneeId: true,
      isDeleted: true,
      project: { select: { repoUrl: true, ...PROJECT_REPOSITORIES_SELECT } },
      claims: {
        where: { releasedAt: null, status: { in: ["active", "offered"] } },
        select: { status: true, beneficiaryUserId: true, agent: { select: { ownerUserId: true } } },
      },
      deliveries: {
        select: { beneficiaryUserId: true, pullRequestUrl: true, agent: { select: { ownerUserId: true } } },
      },
    },
  });

  if (!existing || existing.isDeleted) {
    return { error: TICKET_EDIT_ERRORS.notFound };
  }

  if (existing.status === "resolved" || existing.status === "closed") {
    return { error: "A resolved or closed issue's pull request link can't be replaced." };
  }

  const activeClaim = existing.claims.find(
    (c) => c.status === "active" || c.status === "offered",
  );
  const holdsActiveClaim = existing.claims.some(
    (c) => c.beneficiaryUserId === userId || c.agent.ownerUserId === userId,
  );
  const currentDelivery = existing.pullRequestUrl
    ? existing.deliveries.find(
      (d) => d.pullRequestUrl === existing.pullRequestUrl,
    )
    : null;
  const deliveredCurrent = Boolean(
    currentDelivery &&
    (currentDelivery.beneficiaryUserId === userId ||
      currentDelivery.agent.ownerUserId === userId),
  );
  const isAssignee = Boolean(existing.assigneeId && existing.assigneeId === userId);

  // An actor owns the current contribution if they hold the active claim, or,
  // when no active claim exists, if they are the current assignee or delivered
  // the currently linked pull request. A former deliverer whose delivery was
  // for an earlier pull request or who lost their claim is refused once another
  // contributor owns the work.
  const isCurrentContributor =
    holdsActiveClaim || (!activeClaim && (isAssignee || deliveredCurrent));

  const mayEditPullRequest =
    isCurrentContributor ||
    canEditTicket({
      actorId: userId,
      actorRole: user.role,
      membershipRole: (await currentOrganisationAccess(userId, user.role)).membershipRole,
      reporterId: existing.reporterId,
    });
  if (!mayEditPullRequest) {
    return { error: TICKET_EDIT_ERRORS.unauthorized };
  }

  const parsed = editPullRequestUrlSchema.safeParse({
    pullRequestUrl: formData.get("pullRequestUrl") ?? "",
  });
  if (!parsed.success) {
    return fromZodError(parsed.error);
  }

  const parsedPr = parsePullRequestUrl(parsed.data.pullRequestUrl);
  if (!parsedPr) {
    return fieldError(
      "pullRequestUrl",
      "Enter a valid GitHub pull request URL (https://github.com/owner/repo/pull/123).",
    );
  }

  // The repository it is in: the main one or any the project lists (#2).
  const repo = repoForPullRequest(existing.project, parsed.data.pullRequestUrl);
  if (repo && !sameRepo(parsedPr, repo)) {
    return fieldError(
      "pullRequestUrl",
      "That pull request is not in this project's repository.",
    );
  }

  const nextPullRequestUrl = `https://github.com/${repo ? repo.owner : parsedPr.owner}/${repo ? repo.repo : parsedPr.repo}/pull/${parsedPr.number}`;
  const previousPullRequestUrl = existing.pullRequestUrl;
  if (nextPullRequestUrl === previousPullRequestUrl) {
    return { ok: true };
  }

  const oldPr = previousPullRequestUrl ? parsePullRequestUrl(previousPullRequestUrl) : null;
  const samePullRequest = Boolean(
    oldPr &&
    oldPr.number === parsedPr.number &&
    repo &&
    (sameRepo(oldPr, repo) || isFormerNameOf(oldPr, repo)),
  );

  // #replacement-pr: an accepted fix is bound to its pull request unless that one
  // was closed without merging; then a replacement may be linked and is reviewed afresh.
  let replacingAcceptanceId: string | null = null;
  if (!samePullRequest) {
    const gate = await acceptedFixGate(bugId, previousPullRequestUrl);
    if (gate.acceptance && previousPullRequestUrl) {
      if (!gate.replaceable) {
        return {
          error:
            "This issue's accepted fix is bound to a different pull request — link the accepted one again. (A replacement is accepted only when the accepted pull request is reported closed without merging.)",
        };
      }
      replacingAcceptanceId = gate.acceptance.id;
    }
  }

  const latestReport = !samePullRequest
    ? await latestPullRequestReport(bugId, nextPullRequestUrl)
    : null;
  const nextHeadSha = samePullRequest
    ? existing.pullRequestHeadSha
    : (latestReport?.headSha ?? null);

  const existingProofLinks = existing.proofLinks ?? [];
  const nextProofLinks =
    previousPullRequestUrl && existingProofLinks.includes(previousPullRequestUrl)
      ? [...new Set(existingProofLinks.map((link) => (link === previousPullRequestUrl ? nextPullRequestUrl : link)))]
      : existingProofLinks;

  const updated = await prisma.$transaction(async (tx) => {
    const changed = await tx.bug.updateMany({
      where: { id: bugId, pullRequestUrl: previousPullRequestUrl },
      data: {
        pullRequestUrl: nextPullRequestUrl,
        pullRequestHeadSha: nextHeadSha,
        proofLinks: nextProofLinks,
        updatedAt: new Date(),
      },
    });
    if (changed.count !== 1) return false;

    if (previousPullRequestUrl) {
      if (samePullRequest) {
        await tx.delivery.updateMany({
          where: { bugId, pullRequestUrl: previousPullRequestUrl },
          data: { pullRequestUrl: nextPullRequestUrl },
        });
      } else if (isCurrentContributor) {
        await tx.delivery.updateMany({
          where: {
            bugId,
            pullRequestUrl: previousPullRequestUrl,
            OR: [
              { beneficiaryUserId: userId },
              { agent: { ownerUserId: userId } },
            ],
          },
          data: {
            pullRequestUrl: nextPullRequestUrl,
            headSha: nextHeadSha,
          },
        });
      }
    }

    if (replacingAcceptanceId && previousPullRequestUrl) {
      await releaseAcceptedFix(tx, {
        bugId,
        acceptanceId: replacingAcceptanceId,
        previous: previousPullRequestUrl,
        next: nextPullRequestUrl,
        actorUserId: userId,
      });
    }

    await publishWebEvent(tx, {
      bugId,
      type: "issue.updated",
      actorUserId: userId,
      payload: issueChangePayload({
        pullRequestUrl: nextPullRequestUrl,
        ...(nextProofLinks !== existingProofLinks ? { proofLinks: nextProofLinks } : {}),
      }),
    });

    await tx.bugActivity.create({
      data: {
        bugId,
        actorId: userId,
        type: "edited",
        summary: previousPullRequestUrl
          ? `updated PR link to ${nextPullRequestUrl}`
          : `linked PR ${nextPullRequestUrl}`,
        metadata: {
          field: "pullRequestUrl",
          from: previousPullRequestUrl,
          to: nextPullRequestUrl,
          pullRequestUrl: nextPullRequestUrl,
          headSha: nextHeadSha,
          via: "editPullRequest",
          ...(replacingAcceptanceId ? { replacesPullRequestUrl: previousPullRequestUrl } : {}),
        },
      },
    });

    return true;
  });

  if (!updated) {
    return { error: "The pull request link was modified by another update. Please refresh the page." };
  }

  revalidatePath("/[project]", "layout");
  revalidateIssue();
  revalidatePath("/bugs");
  revalidatePath(`/bugs/${bugId}`);
  return { ok: true };
}

/**
 * Adds a comment to a bug and records the activity: a reply to one stage
 * entry, or a comment on the issue itself (at any stage) or a reply to one.
 */
export async function addCommentAction(
  bugId: string,
  formData: FormData,
): Promise<ActionResult> {
  const userId = await requireUserId();

  const limit = await consumeRateLimit(
    `add-comment:${userId}`,
    ACTION_RATE_LIMITS.addComment,
  );
  if (!limit.allowed) {
    return { error: RATE_LIMIT_MESSAGE };
  }

  const parsed = commentSchema.safeParse({
    body: formData.get("body"),
    confirmationId: formData.get("confirmationId") || undefined,
    bidId: formData.get("bidId") || undefined,
    deliveryId: formData.get("deliveryId") || undefined,
    testVerdictId: formData.get("testVerdictId") || undefined,
    mergeReviewId: formData.get("mergeReviewId") || undefined,
    planId: formData.get("planId") || undefined,
    parentId: formData.get("parentId") || undefined,
  });

  if (!parsed.success) {
    return fromZodError(parsed.error, "Invalid comment");
  }

  const bug = await prisma.bug.findUnique({
    where: { id: bugId },
    select: {
      id: true,
      isDeleted: true,
      title: true,
      reporterId: true,
      assigneeId: true,
      organisationId: true,
      projectId: true,
      status: true,
      substatus: true,
      pullRequestUrl: true,
    },
  });
  if (!bug || bug.isDeleted) {
    return { error: "Issue not found" };
  }

  const currentUser = await requireUser();
  if (!(await canContributeToProject(currentUser, bug.projectId, bug.organisationId))) {
    return { error: "You must be a member of this project to comment." };
  }

  // #secret-protection: stopped before it is saved, or sent to anyone watching.
  const secrets = await checkPostForSecrets({
    organisationId: bug.organisationId,
    projectId: bug.projectId,
    actor: { kind: "user", userId },
    source: "comment",
    bugId: bug.id,
    fields: { body: parsed.data.body },
    noun: "this comment",
  });
  if (!secrets.ok) return fieldError("body", secrets.message);

  // One rule for where a comment may go, as for agents (lib/comment-placement.ts).
  let placement: CommentPlacement;
  try {
    placement = await placeComment(prisma, bug, parsed.data);
  } catch (error) {
    if (error instanceof CommentPlacementError) return { error: error.message };
    throw error;
  }
  const { confirmationId, bidId, deliveryId, testVerdictId, mergeReviewId, planId, parentId, parentAuthorId } = placement;

  // #603: only agents in this issue's organisation can be mentioned.
  const agents = await mentionedAgents(prisma, bug.organisationId, parsed.data.body);
  const normalizedBody = await normalizeMentionTags(parsed.data.body, bug.organisationId, agents);

  const commentId = await prisma.$transaction(async (tx) => {
    const created = await tx.comment.create({
      data: {
        bugId,
        authorId: userId,
        body: normalizedBody,
        confirmationId,
        bidId,
        deliveryId,
        testVerdictId,
        mergeReviewId,
        planId,
        parentId,
      },
      select: { id: true },
    });
    // Files uploaded with the comment (#215).
    await linkAttachments(tx, {
      ids: [
        ...new Set([
          ...parseAttachmentIds(formData.get("attachmentIds")),
          ...attachmentIdsInMarkdown(normalizedBody),
        ]),
      ],
      uploaderId: userId,
      bugId,
      commentId: created.id,
    });
    await tx.bugActivity.create({
      data: {
        bugId,
        actorId: userId,
        type: "commented",
        summary: commentedSummary(normalizedBody),
        metadata: {
          field: "comment",
          commentId: created.id,
          commentPreview: commentPreview(normalizedBody),
        } as Prisma.InputJsonValue,
      },
    });
    await tx.bug.update({ where: { id: bugId }, data: { updatedAt: new Date() } });
    // Commenting on an issue means you want to hear about replies (#216).
    await ensureWatching(tx, bugId, [userId]);
    // #600: a person's reply reaches the agents polling /api/v1/events.
    await publishWebEvent(tx, {
      bugId,
      type: "comment.created",
      actorUserId: userId,
      payload: {
        commentId: created.id,
        parentId,
        authorId: userId,
      },
    });
    return created.id;
  });

  // A mentioned agent's owner hears about it like a mention of them (#603).
  const mentioned = [...new Set([...extractMentionedUserIds(normalizedBody), ...agentOwnerIds(agents)])];
  const author = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  const actor = {
    actorId: userId,
    actorName: author?.name ?? "Someone",
    bugId,
    bugTitle: bug.title,
  };
  const excerpt = commentPreview(normalizedBody);
  const events: NotificationEvent[] = [];
  if (mentioned.length > 0) {
    events.push({ ...actor, kind: "mentioned", place: "comment", recipientIds: mentioned, excerpt, commentId });
  }
  // Watchers hear about every new comment (#216). The reporter and assignee
  // are the default audience; delivery adds anyone else watching.
  events.push({
    ...actor,
    kind: "comment_added",
    commentId,
    excerpt,
    parentAuthorId,
    recipientIds: [bug.reporterId, bug.assigneeId].filter((id): id is string => Boolean(id)),
    excludeIds: mentioned,
  });
  notifyLater(...events);

  revalidatePath("/[org]/[project]", "layout");
  revalidateIssue();
  revalidatePath("/bugs");
  revalidatePath(`/bugs/${bugId}`);
  return { ok: true, commentId };
}

/**
 * Saves a guided retest request as a comment on the original Live issue.
 * The existing comment path owns attachment checks, activity, notifications
 * and agent events; this action never changes workflow or payout state.
 */
export async function requestRetestAction(
  bugId: string,
  formData: FormData,
): Promise<ActionResult> {
  const userId = await requireUserId();
  const parsed = retestRequestSchema.safeParse({
    operatingSystem: formData.get("operatingSystem"),
    installedVersion: formData.get("installedVersion") ?? "",
    currentBehavior: formData.get("currentBehavior"),
  });
  if (!parsed.success) return fromZodError(parsed.error, "Check the retest request details");

  const issue = await prisma.bug.findUnique({
    where: { id: bugId, ...bugInOrganisation(await currentOrganisationIdFor(userId)) },
    select: { id: true, status: true, isDeleted: true },
  });
  if (!issue || issue.isDeleted) return { error: "Issue not found" };
  if (issue.status !== "resolved") {
    return { error: "Retest requests are available after an issue is Live." };
  }

  const comment = new FormData();
  comment.set("body", [
    "Retest request",
    "",
    `Operating system: ${parsed.data.operatingSystem}`,
    `Installed version: ${parsed.data.installedVersion}`,
    "",
    "What happens now:",
    parsed.data.currentBehavior,
    "",
    "Release information: No fixed version or update link is connected to this issue yet.",
  ].join("\n"));
  const attachmentIds = formData.get("attachmentIds");
  if (typeof attachmentIds === "string") comment.set("attachmentIds", attachmentIds);
  return addCommentAction(bugId, comment);
}

export type ToggleVoteResult = ActionResult & {
  voted?: boolean;
  userVote?: number;
  voteCount?: number;
  likeCount?: number;
  dislikeCount?: number;
};

/**
 * Toggles the current user's importance mark on an issue (#importance; once an
 * upvote). Rejects any direction other than
 * 1 or -1, and -1 because downvotes are gone.
 */
export async function toggleVoteAction(
  bugId: string,
  direction: unknown = 1,
): Promise<ToggleVoteResult> {
  if (!isValidVoteDirection(direction)) {
    return { error: "Invalid vote" };
  }
  // #1059: only upvotes now. A stale page can still send -1; refuse it.
  if (direction === -1) {
    return { error: DOWNVOTES_REMOVED_MESSAGE };
  }

  // Do not redirect here — VoteButton needs a clear error for stale JWTs
  // after a DB reseed (old cuid no longer exists → Vote_userId_fkey).
  const resolved = await resolveSessionUserId();
  if ("error" in resolved) {
    return { error: SESSION_EXPIRED_MESSAGE };
  }
  const { userId } = resolved;

  const limit = await consumeRateLimit(
    `toggle-vote:${userId}`,
    ACTION_RATE_LIMITS.toggleVote,
  );
  if (!limit.allowed) {
    return { error: RATE_LIMIT_MESSAGE };
  }

  const bug = await prisma.bug.findUnique({
    where: { id: bugId },
    select: { id: true, isDeleted: true, organisationId: true, projectId: true },
  });
  if (!bug || bug.isDeleted) {
    return { error: "Issue not found" };
  }
  const votingUser = await requireUser();
  if (!(await canContributeToProject(votingUser, bug.projectId, bug.organisationId))) {
    return { error: "You must be a member of this project to vote." };
  }

  const result = await prisma.$transaction(async (tx) => {
    // Acquire a row lock on the Bug to serialize concurrent vote updates
    // and prevent race-condition drift in voteCount (#362).
    await tx.$queryRaw`SELECT id FROM "Bug" WHERE id = ${bugId} FOR UPDATE`;

    const existing = await tx.vote.findUnique({
      where: { userId_bugId: { userId, bugId } },
    });

    const currentVote = existing?.value ?? 0;
    const { nextVote } = calculateVoteChange(currentVote, direction);

    if (nextVote === 0 && existing) {
      await tx.vote.delete({ where: { id: existing.id } });
    } else if (existing) {
      // #importance: a person's own click; no agent made it.
      await tx.vote.update({
        where: { id: existing.id },
        data: { value: nextVote, agentId: null },
      });
    } else {
      await tx.vote.create({
        data: { userId, bugId, value: nextVote },
      });
      // The first mark on an issue earns a point, once per person (#vote-points).
      await award(tx, {
        organisationId: bug.organisationId,
        userId,
        bugId,
        role: "vote",
        points: VOTE_POINTS,
        sourceKey: importanceSourceKey(bugId, userId),
      });
    }

    const voteCounts = await tx.vote.groupBy({
      by: ["value"],
      where: { bugId },
      _count: { _all: true },
    });

    const { likeCount, dislikeCount } = tallyVoteGroups(voteCounts);
    const voteCount = reconcileVoteCount(likeCount, dislikeCount);

    await tx.bug.update({
      where: { id: bugId },
      data: { voteCount },
    });

    return {
      voted: nextVote === 1,
      userVote: nextVote,
      voteCount,
      likeCount,
      dislikeCount,
    };
  });

  revalidatePath("/[org]/[project]", "layout");
  revalidateIssue();
  revalidatePath("/bugs");
  revalidatePath(`/bugs/${bugId}`);
  return { ok: true, ...result };
}

/**
 * Soft deletes a bug. Admins and super admins only.
 * The issue is hidden from normal views, but can be restored.
 */
export async function deleteBugAction(bugId: string): Promise<ActionResult> {
  const user = await requireUser();
  const access = await currentOrganisationAccess(user.id, user.role);
  if (!canDeleteTicket(user.role, access.membershipRole)) {
    return { error: TICKET_DELETION_ERRORS.unauthorized };
  }

  if (!bugId || typeof bugId !== "string" || bugId.trim().length === 0) {
    return { error: TICKET_DELETION_ERRORS.invalidId };
  }

  const existing = await prisma.bug.findUnique({
    where: { id: bugId, ...bugInOrganisation(await currentOrganisationIdFor(user.id)) },
    select: { id: true, isDeleted: true },
  });

  if (!existing) {
    return { error: TICKET_DELETION_ERRORS.notFound };
  }

  if (existing.isDeleted) {
    return { error: TICKET_DELETION_ERRORS.alreadyDeleted };
  }

  try {
    await prisma.$transaction(async (tx) => {
      // #676: Row lock the Bug to serialize with concurrent vote / update actions.
      if (typeof tx.$queryRaw === "function") {
        await tx.$queryRaw`SELECT id FROM "Bug" WHERE id = ${bugId} FOR UPDATE`;
      }

      await tx.bug.update({
        where: { id: bugId },
        data: {
          isDeleted: true,
          deletedAt: new Date(),
        },
      });
      await closeSupportThreadsForIssue(tx, { bugId, reason: "issue_closed" });
      // Release any unreleased claims on the soft-deleted issue (#627), a plan review's planning claim included.
      await tx.issueClaim.updateMany({
        where: { bugId, releasedAt: null, status: { in: ["active", "offered", "planning"] } },
        data: { status: "released", releasedAt: new Date(), releaseReason: "deleted" },
      });
      // Delete attachments associated with the issue to prevent storage bloat (#658)
      await tx.attachment.deleteMany({ where: { bugId } });

      await publishWebEvent(tx, { bugId, type: "issue.deleted", actorUserId: user.id });

      await tx.bugActivity.create({
        data: {
          bugId,
          actorId: user.id,
          type: "deleted",
          summary: deletedSummary(),
        },
      });
    });
  } catch (error) {
    console.error("Failed to delete bug:", error);
    return { error: TICKET_DELETION_ERRORS.failed };
  }

  revalidatePath("/[org]/[project]", "layout");
  revalidateIssue();
  revalidatePath("/bugs");
  revalidatePath(`/bugs/${bugId}`);
  redirect("/home");
}

/**
 * Restores a soft-deleted bug. Admins and super admins only.
 * Returns the issue back to active status in views and searches.
 */
export async function restoreBugAction(bugId: string): Promise<ActionResult> {
  const user = await requireUser();
  const access = await currentOrganisationAccess(user.id, user.role);
  if (!canRestoreTicket(user.role, access.membershipRole)) {
    return { error: TICKET_DELETION_ERRORS.unauthorizedRestore };
  }

  if (!bugId || typeof bugId !== "string" || bugId.trim().length === 0) {
    return { error: TICKET_DELETION_ERRORS.invalidId };
  }

  const existing = await prisma.bug.findUnique({
    where: { id: bugId, ...bugInOrganisation(await currentOrganisationIdFor(user.id)) },
    select: { id: true, isDeleted: true },
  });

  if (!existing) {
    return { error: TICKET_DELETION_ERRORS.notFound };
  }

  if (!existing.isDeleted) {
    return { error: TICKET_DELETION_ERRORS.notDeleted };
  }

  try {
    await prisma.$transaction(async (tx) => {
      // #676: Row lock the Bug to serialize with concurrent vote / update actions.
      if (typeof tx.$queryRaw === "function") {
        await tx.$queryRaw`SELECT id FROM "Bug" WHERE id = ${bugId} FOR UPDATE`;
      }

      // Reconcile voteCount from existing votes upon restoration (#676)
      let voteCount: number | undefined;
      if (tx.vote && typeof tx.vote.groupBy === "function") {
        const voteCounts = await tx.vote.groupBy({
          by: ["value"],
          where: { bugId },
          _count: { _all: true },
        });

        const { likeCount, dislikeCount } = tallyVoteGroups(voteCounts);
        voteCount = reconcileVoteCount(likeCount, dislikeCount);
      }

      await tx.bug.update({
        where: { id: bugId },
        data: {
          isDeleted: false,
          deletedAt: null,
          ...(voteCount !== undefined ? { voteCount } : {}),
        },
      });
      await publishWebEvent(tx, { bugId, type: "issue.restored", actorUserId: user.id });

      await tx.bugActivity.create({
        data: {
          bugId,
          actorId: user.id,
          type: "restored",
          summary: restoredSummary(),
        },
      });
    });
  } catch (error) {
    console.error("Failed to restore bug:", error);
    return { error: TICKET_DELETION_ERRORS.failedRestore };
  }

  revalidatePath("/[org]/[project]", "layout");
  revalidateIssue();
  revalidatePath("/bugs");
  revalidatePath(`/bugs/${bugId}`);
  return { ok: true };
}

/**
 * Toggles the boosted status of a bug. Admins and super admins only.
 * When boosted, the ticket appears pinned to the top of the list regardless of vote count.
 */
export async function toggleBoostBugAction(
  bugId: string,
): Promise<ActionResult & { isBoosted?: boolean }> {
  const user = await requireUser();
  const access = await currentOrganisationAccess(user.id, user.role);
  if (!canBoostTicket(user.role, access.membershipRole)) {
    return { error: TICKET_BOOST_ERRORS.unauthorized };
  }

  if (!bugId || typeof bugId !== "string" || bugId.trim().length === 0) {
    return { error: TICKET_BOOST_ERRORS.invalidId };
  }

  const existing = await prisma.bug.findUnique({
    where: { id: bugId, ...bugInOrganisation(await currentOrganisationIdFor(user.id)) },
    select: { id: true, isBoosted: true, isDeleted: true },
  });

  if (!existing || existing.isDeleted) {
    return { error: TICKET_BOOST_ERRORS.notFound };
  }

  const nextBoosted = !existing.isBoosted;
  const now = new Date();

  try {
    await prisma.$transaction(async (tx) => {
      await tx.bug.update({
        where: { id: bugId },
        data: {
          isBoosted: nextBoosted,
          boostedAt: nextBoosted ? now : null,
        },
      });

      await tx.bugActivity.create({
        data: {
          bugId,
          actorId: user.id,
          type: nextBoosted ? "boosted" : "unboosted",
          summary: nextBoosted ? boostedSummary() : unboostedSummary(),
          metadata: {
            field: "isBoosted",
            to: String(nextBoosted),
          } as Prisma.InputJsonValue,
        },
      });

      await publishWebEvent(tx, {
        bugId,
        type: "issue.updated",
        actorUserId: user.id,
        payload: issueChangePayload({ isBoosted: nextBoosted }),
      });
    });
  } catch (error) {
    console.error("Failed to toggle bug boost:", error);
    return { error: TICKET_BOOST_ERRORS.failed };
  }

  revalidatePath("/[org]/[project]", "layout");
  revalidateIssue();
  revalidatePath("/bugs");
  revalidatePath(`/bugs/${bugId}`);
  return { ok: true, isBoosted: nextBoosted };
}

/**
 * Allows a user to assign an issue to themselves, or unassign if currently assigned.
 * Validates permission via canAssignTicket.
 */
export async function setIssuePriorityAction(
  bugId: string,
  priority: string,
): Promise<ActionResult & { priority?: string }> {
  const user = await requireUser();
  const access = await currentOrganisationAccess(user.id, user.role);

  if (!bugId || typeof bugId !== "string" || bugId.trim().length === 0) {
    return { error: "Invalid issue id" };
  }
  if (!["low", "medium", "high", "urgent"].includes(priority)) {
    return { error: "Invalid priority" };
  }

  const organisationId = await currentOrganisationIdFor(user.id);
  const existing = await prisma.bug.findUnique({
    where: { id: bugId, ...bugInOrganisation(organisationId) },
    select: { id: true, priority: true, isDeleted: true, assigneeId: true },
  });
  if (!existing || existing.isDeleted) {
    return { error: "Issue not found" };
  }

  const isAssignee = existing.assigneeId === user.id;
  if (!access.admin && !isAssignee) {
    return { error: "Only the assignee or an admin can change priority" };
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.bug.update({
        where: { id: bugId },
        data: { priority },
      });
      await tx.bugActivity.create({
        data: {
          bugId,
          actorId: user.id,
          type: "commented",
          summary: `Priority changed to ${priority}`,
          metadata: {
            field: "priority",
            from: existing.priority,
            to: priority,
          } as Prisma.InputJsonValue,
        },
      });
      await publishWebEvent(tx, {
        bugId,
        type: "issue.updated",
        actorUserId: user.id,
        payload: { priority },
      });
    });
  } catch (error) {
    console.error("Failed to set issue priority:", error);
    return { error: "Failed to update priority" };
  }

  revalidatePath("/[org]/[project]", "layout");
  revalidateIssue();
  revalidatePath("/bugs");
  revalidatePath(`/bugs/${bugId}`);
  return { ok: true, priority };
}

export async function selfAssignBugAction(
  bugId: string,
  assign: boolean = true,
): Promise<ActionResult> {
  const user = await requireUser();
  const userId = user.id;

  const limit = checkRateLimit(
    `self-assign:${userId}`,
    ACTION_RATE_LIMITS.selfAssign,
  );
  if (!limit.allowed) {
    return { error: RATE_LIMIT_MESSAGE };
  }

  if (!bugId || typeof bugId !== "string" || bugId.trim().length === 0) {
    return { error: TICKET_ASSIGN_ERRORS.invalidId };
  }

  const existing = await prisma.bug.findUnique({
    where: { id: bugId, ...bugInOrganisation(await currentOrganisationIdFor(userId)) },
    select: {
      id: true,
      title: true,
      assigneeId: true,
      isDeleted: true,
      assignee: { select: { name: true } },
    },
  });

  if (!existing || existing.isDeleted) {
    return { error: TICKET_ASSIGN_ERRORS.notFound };
  }

  const targetAssigneeId = assign ? userId : null;

  if (assign && existing.assigneeId !== userId) {
    return { error: TICKET_ASSIGN_ERRORS.needsAgentClaim };
  }

  if (
    !canAssignTicket({
      actorId: userId,
      actorRole: user.role,
      membershipRole: (await currentOrganisationAccess(userId, user.role)).membershipRole,
      currentAssigneeId: existing.assigneeId,
      targetAssigneeId,
    })
  ) {
    return { error: TICKET_ASSIGN_ERRORS.unauthorized };
  }

  if (existing.assigneeId === targetAssigneeId) {
    return { ok: true };
  }

  const toName = targetAssigneeId ? user.name ?? null : null;

  try {
    await prisma.$transaction(async (tx) => {
      // #676: Row lock the Bug to serialize concurrent assignment and vote checks.
      if (typeof tx.$queryRaw === "function") {
        await tx.$queryRaw`SELECT id FROM "Bug" WHERE id = ${bugId} FOR UPDATE`;
      }

      await tx.bug.update({
        where: { id: bugId },
        data: { assigneeId: targetAssigneeId },
      });
      // Taking an issue means watching it (#216).
      await ensureWatching(tx, bugId, [targetAssigneeId]);

      await tx.bugActivity.create({
        data: {
          bugId,
          actorId: userId,
          type: "assignee_changed",
          summary: assigneeChangedSummary(
            existing.assignee?.name ?? null,
            toName,
          ),
          metadata: {
            field: "assigneeId",
            from: existing.assigneeId,
            to: targetAssigneeId,
          },
        },
      });
      await publishWebEvent(tx, {
        bugId,
        type: "issue.updated",
        actorUserId: userId,
        payload: issueChangePayload({ assigneeId: targetAssigneeId }),
      });
    });
  } catch (error) {
    console.error("Failed to self-assign issue:", error);
    return { error: TICKET_ASSIGN_ERRORS.failed };
  }

  notifyLater({
    kind: "assignee_changed",
    actorId: userId,
    actorName: user.name ?? "Someone",
    bugId,
    bugTitle: existing.title,
    fromUserId: existing.assigneeId,
    toUserId: targetAssigneeId,
  });

  revalidateIssue();
  revalidatePath("/[org]/[project]", "layout");
  revalidatePath(`/bugs/${bugId}`);
  revalidatePath("/bugs");
  return { ok: true };
}


