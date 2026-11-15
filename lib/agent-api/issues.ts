import { parseTrackFilter, trackFilter } from "@/lib/marketing/track";
import { GUEST_BLOCKED_ACTIONS, GUEST_BLOCKED_MESSAGE } from "@/lib/agents/guest-access";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import type { AgentLevel, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { agentErrorResponse, requireAgent, type AgentContext } from "@/lib/agents/require-agent";
import { requireLevel } from "@/lib/agents/levels";
import { audit } from "@/lib/agents/audit";
import { consumeAgentBudget, agentBudgetExceededResponse } from "@/lib/agents/rate-budget";
import { withAgentBudgetHeaders, type AgentBudgetQuota } from "@/lib/agents/rate-budget-headers";
import { commentSchema, statusSchema, substatusSchema, commentLabel } from "@/lib/validations/issue";
import { rewardView } from "@/lib/agent-api/reward-estimates";
import { boundSearchTerm, escapeSearchQuery } from "@/lib/search";
import { parseProjectAreaFilter, projectAreaFilterWhere } from "@/lib/project-area-filter";
import { currentHold } from "@/lib/issue-holders";
import { currentPlan } from "@/lib/agent-api/plan";
import { OPEN_BID_WHERE } from "@/lib/open-bids";
import { eventStreamBus, ORGANISATION_WRITE } from "@/lib/events/stream-bus";
import { issueIdFor, parseIssueRef } from "@/lib/issue-ref";
import { cursorOrderBy, cursorWhere, decodeCursor, LIMIT_RANGE_ERROR, pageSize, toPage, type IssueCursor } from "@/lib/agent-api/create-policy";
import { commentedSummary, commentPreview } from "@/lib/activity-log";
import { extractMentionedUserIds, normalizeMentions } from "@/lib/mentions";
import { attachmentIdsInMarkdown, linkAttachments } from "@/lib/attachment-link";
import { MAX_ATTACHMENTS_PER_ITEM } from "@/lib/attachments";
import { publish } from "@/lib/agent-api/events";
import { STAGE_ENTRY_ROUTES, TYPED_COMMENT_MESSAGE } from "@/lib/stage-entry-route";
import { CommentPlacementError, placeComment, type CommentPlacement } from "@/lib/comment-placement";
import { isConfirmed } from "@/lib/agent-api/confirmations";
import { notifyLater } from "@/lib/notify";
import type { NotificationEvent } from "@/lib/notifications";
import { logger } from "@/lib/logger";
import { IssueApiError } from "@/lib/agent-api/errors";
import { latestPullRequestReport, pullRequestStateView } from "@/lib/agent-api/pull-request-report";
import { agentAttachmentUrl } from "@/lib/agent-api/attachment-read";
import { entrySummary } from "@/lib/agent-api/entry-fields";
import { actionReason } from "@/lib/agent-api/action-reason";
import { findingForBug, findingView, type FindingRow, type FindingViewer } from "@/lib/security-findings";
import { searchWorkItems } from "@/lib/search-index";
import { checkPostForSecrets, stringsIn } from "@/lib/security/secret-guard";
import { findSecretsInFields } from "@/lib/security/secrets";

export { IssueApiError };

const idSchema = z.string().trim().min(1).max(191);

/** #406: name the bad query parameter instead of returning a pathless Zod dump. */
function enumFilter<T extends string>(name: string, raw: string | null, allowed: readonly T[]): T | null {
  if (!raw) return null;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new IssueApiError(400, `${name} must be one of ${allowed.join(", ")}.`);
  }
  return raw as T;
}

/** Files uploaded with POST /api/v1/attachments, linked on save (#645). */
const attachmentIdsSchema = z.array(idSchema).max(MAX_ATTACHMENTS_PER_ITEM).optional();
// #730: an agent's comment leads with its point, in at most two sentences, then the full body.
export const agentCommentSchema = commentSchema.extend({ summary: entrySummary, label: commentLabel.optional(), reason: actionReason, projectId: idSchema.optional(), attachmentIds: attachmentIdsSchema }).strict();

/**
 * Push protection for agents (#secret-protection): every string in a write's
 * JSON body is checked for credentials before the route sees it. A body with
 * one is answered 422 `secret_detected`, naming the field, line and kind (never
 * the secret), and nothing is saved. Other bodies, and unreadable JSON (the
 * route reports that itself), pass on unchanged.
 */
async function secretInRequest(request: NextRequest, agent: AgentContext, action: string, target: string | null): Promise<Response | null> {
  if (!["POST", "PUT", "PATCH"].includes(request.method)) return null;
  if (!(request.headers.get("content-type") ?? "").toLowerCase().includes("json")) return null;
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return null;
  }
  const fields = stringsIn(body);
  // The common case reads no database at all: only a body with a secret in it
  // goes on to have its issue looked up, for the alert's link.
  if (findSecretsInFields(fields).length === 0) return null;
  const check = await checkPostForSecrets({
    organisationId: agent.organisationId,
    actor: { kind: "agent", agentId: agent.agentId, agentName: agent.name, ownerId: agent.ownerId },
    source: action,
    bugId: target ? await issueInOrganisation(target, agent.organisationId) : null,
    fields,
  });
  if (check.ok) return null;
  return secretDetectedResponse(check);
}

/** The 422 an agent gets when a write is stopped for a credential in it (#secret-protection). */
export function secretDetectedResponse(check: { message: string; secrets: unknown[] }): Response {
  return NextResponse.json(
    { error: check.message, code: "secret_detected", secrets: check.secrets },
    { status: 422 },
  );
}

/** The issue a route's target names, when it is an issue in this organisation; for linking an alert. */
async function issueInOrganisation(target: string, organisationId: string): Promise<string | null> {
  try {
    const id = await issueIdFor(prisma, target, organisationId);
    if (!id) return null;
    const bug = await prisma.bug.findFirst({ where: { id, organisationId }, select: { id: true } });
    return bug?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Authenticate before parsing input, charge the shared budget, and audit outcomes including denials.
 *
 * `level` is the agent class the route needs. `"read"` is a route any agent may
 * call that only reads, so it is charged to the read budget rather than write.
 */
export async function agentIssueRequest(
  request: NextRequest, action: string, level: AgentLevel | "read", target: string | null,
  run: (agent: AgentContext) => Promise<Response>,
  // `write` charges a `"read"` route that changes data (#515) to the write budget.
  // `heartbeat` charges the claim-keeping-ping budget instead of write (#556), so an
  // agent at its write cap can still heartbeat the claims it's actively working.
  options: { budget?: "none" | "write" | "heartbeat" } = {},
): Promise<Response> {
  let agent: AgentContext | undefined;
  let response: Response | undefined;
  let quota: AgentBudgetQuota | undefined;
  try {
    agent = await requireAgent(request);
    requireLevel(agent, level === "read" ? "working" : level);
    // On-call guests (12 Nov plan, D2): nothing that outlasts the stay.
    if (agent.guest && GUEST_BLOCKED_ACTIONS.has(action)) {
      throw new IssueApiError(403, GUEST_BLOCKED_MESSAGE, { error: "guest_not_allowed", message: GUEST_BLOCKED_MESSAGE });
    }
    if (agent.pausedAt && action !== "claims.heartbeat" && (action === "work.read" || level !== "read" || options.budget === "write")) {
      throw new IssueApiError(423, "This agent is paused by its owner.");
    }
    if (options.budget === "none") {
      // Retired or non-working routes must not spend the caller's budget (#554).
      response = await run(agent);
    } else {
      const budgetKind = options.budget === "heartbeat"
        ? "heartbeat"
        : level === "read" && options.budget !== "write" ? "read" : "write";
      const budget = await consumeAgentBudget(
        { id: agent.agentId, burst: agent.burst, burstUntil: agent.burstUntil ?? null },
        budgetKind,
      );
      quota = budget;
      // #secret-protection: a write carrying a credential is stopped before the route reads it.
      const stopped = budget.allowed && budgetKind === "write" ? await secretInRequest(request, agent, action, target) : null;
      response = !budget.allowed
        ? agentBudgetExceededResponse(budget.retryAfterSeconds, budget)
        : stopped ?? await run(agent);
    }
  } catch (error) {
    if (error instanceof IssueApiError) response = NextResponse.json(error.body ? { error: error.message, ...error.body } : { error: error.message }, { status: error.status });
    else if (error instanceof z.ZodError) response = NextResponse.json({ error: "Invalid input.", details: error.issues }, { status: 422 });
    else response = agentErrorResponse(error);
  } finally {
    if (agent) {
      // `request: true` marks the supplementary row so the audit page can hide
      // it by default: the domain audit already records successful writes (#575).
      const payload = { status: response?.status ?? 500, request: true as const };
      try {
        // Required domain audits commit inside the domain transaction. This
        // supplementary request log must not turn a committed write into a failure.
        await audit(agent, action, target, payload);
      } catch (error) {
        // Retain the failed record in server logs for investigation/recovery.
        logger.error("[agent-api] request audit failed", {
          organisationId: agent.organisationId, agentId: agent.agentId, action, target, payload,
        }, error);
      }
    }
  }
  // A committed agent write changes what the work feed lists. Say so now, so
  // the agent's next poll is fresh; the event broadcast follows a moment later.
  if (agent && response.status < 400 && (level !== "read" || options.budget === "write")) {
    eventStreamBus.emit(ORGANISATION_WRITE, agent.organisationId);
  }
  // #646/#596: every charged response — success, validation failure, or a
  // domain error thrown after the charge — reports the same quota.
  if (quota) response = withAgentBudgetHeaders(response, quota);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export async function issueJson(request: NextRequest): Promise<unknown> {
  try { return await request.json(); }
  catch { throw new IssueApiError(400, "Send a valid JSON body."); }
}

/** The 400 for an issue route called without a project. */
export const PROJECT_ID_REQUIRED =
  "projectId is required. Pass it as ?projectId= or in the JSON body. Your owner can copy it from Settings, under Agents.";

/** Every call names a project; a project id alone never grants access to its organisation. */
export async function issueProject(agent: AgentContext, params: URLSearchParams, bodyProjectId?: string) {
  const queryId = params.get("projectId");
  if (queryId && bodyProjectId && queryId !== bodyProjectId) throw new IssueApiError(400, "Conflicting projectId values.");
  // #563: name the missing parameter instead of a raw validation dump.
  if (!queryId?.trim() && !bodyProjectId?.trim()) throw new IssueApiError(400, PROJECT_ID_REQUIRED);
  const projectId = idSchema.parse(queryId || bodyProjectId);
  const project = await prisma.project.findFirst({ where: { id: projectId, organisationId: agent.organisationId }, select: { id: true } });
  if (!project) throw new IssueApiError(404, "Project not found.");
  // #user-agents: a key works in every project of its organisation, never another organisation's.
  return { organisationId: agent.organisationId, projectId: project.id };
}

type Scope = { organisationId: string; projectId: string };
export const issueSelect = {
  outsideWork: { select: { agentId: true, initialState: true, createdAt: true } },
  id: true, number: true, title: true, summary: true, description: true, status: true, substatus: true, difficulty: true, track: true,
  // Marketing work: the revision rounds used so far (D4).
  revisionCount: true,
  // D6: the related product issue a marketing issue links to, or null.
  linkedIssue: { select: { id: true, number: true, title: true } },
  // #close-reasons: why, on what evidence and when a closed issue was closed.
  closeReason: true, closeEvidence: true, closedAt: true,
  typeId: true, reporterId: true, assigneeId: true, beneficiaryUserId: true,
  createdByAgentId: true, projectId: true, areaId: true, createdAt: true, updatedAt: true, proofLinks: true,
  voteCount: true,
  // #idea-table: the idea this issue was converted from.
  idea: { select: { id: true, number: true, score: true, convertedAt: true } },
  // #544: whether a fix is linked, and at which commit. Without these a
  // reviewer cannot tell a linked fix from an unlinked one, and `proofLinks`
  // is misleading because it is free text set at create/edit, not the field
  // the verdict and merge gates read.
  pullRequestUrl: true,
  pullRequestHeadSha: true,
  area: { select: { id: true, name: true, slug: true } },
  // #rewards: what solving it pays, in $, and how far the estimating has got.
  reward: true, rewardEstimateCount: true, rewardFixedAt: true,
} satisfies Prisma.BugSelect;

/**
 * #409: the shared parsers turn an unknown id into "no filter" so a stale web
 * link shows everything. An API client that sends a mistyped id must be told,
 * not handed the whole backlog.
 */
export function requireKnownFilter(name: "area", raw: string | null, parsed: string | null): string | null {
  if (raw?.trim() && parsed === null) {
    throw new IssueApiError(422, `Unknown ${name} id "${raw.trim()}". Use an id from this project, or "none".`);
  }
  return parsed;
}

export async function listAgentIssues(scope: Scope, params: URLSearchParams) {
  const parsedTrack = parseTrackFilter(params.get("track"));
  if (!parsedTrack.ok) throw new IssueApiError(400, parsedTrack.message, { error: "invalid_request", field: "track" });
  const status = enumFilter("status", params.get("status"), statusSchema.options);
  const substatus = enumFilter("substatus", params.get("substatus"), substatusSchema.options);
  const assignee = params.get("assignee");
  let assigneeId: string | null | undefined;
  if (assignee) {
    if (assignee === "none") assigneeId = null;
    else {
      const parsed = idSchema.safeParse(assignee);
      if (!parsed.success) throw new IssueApiError(400, 'assignee must be "none" or a valid user id.');
      assigneeId = parsed.data;
    }
  }
  const requestedArea = params.get("area");
  const areas = requestedArea
    ? await prisma.projectArea.findMany({ where: { projectId: scope.projectId }, select: { id: true, name: true } })
    : [];
  const cursorRaw = params.get("cursor");
  const cursor = decodeCursor(cursorRaw);
  if (cursorRaw !== null && !cursor) throw new IssueApiError(400, "Invalid cursor.");
  const limit = pageSize(params.get("limit"));
  if (limit === null) throw new IssueApiError(422, LIMIT_RANGE_ERROR);
  const q = params.get("q")?.trim();
  // #460: same escaped, bounded title/description match the app list uses. AND keeps it apart from the cursor's OR.
  const search: Prisma.BugWhereInput = q
    ? { AND: [{ OR: [
        { title: { contains: escapeSearchQuery(boundSearchTerm(q)), mode: "insensitive" } },
        { description: { contains: escapeSearchQuery(boundSearchTerm(q)), mode: "insensitive" } },
      ] }] }
    : {};
  const baseFiltered: Prisma.BugWhereInput = {
    ...scope, ...trackFilter(parsedTrack.track), isDeleted: false,
    ...(status ? { status } : {}),
    ...(substatus ? { substatus } : {}),
    ...(assigneeId !== undefined ? { assigneeId } : {}),
    ...projectAreaFilterWhere(requireKnownFilter("area", requestedArea, parseProjectAreaFilter(requestedArea, areas))),
  };
  let rows;
  if (q && boundSearchTerm(q).length >= 3) {
    try {
      const selectedArea = requireKnownFilter("area", requestedArea, parseProjectAreaFilter(requestedArea, areas));
      const filters = [
        ...(status ? [`status:=${status}`] : []),
        ...(substatus ? [`substatus:=${substatus}`] : []),
        ...(assigneeId === null ? ["hasAssignee:=false"] : typeof assigneeId === "string" ? [`assigneeId:=${assigneeId}`] : []),
        ...(selectedArea === "none" ? ["hasArea:=false"] : selectedArea ? [`areaId:=${selectedArea}`] : []),
        // Typesense supports numeric ranges, not string range filters. Fetch
        // through the cursor timestamp, then apply the full (time, id) cursor
        // predicate in PostgreSQL before counting the page.
        ...(cursor ? [`createdAt:<=${cursor.createdAt.getTime()}`] : []),
      ];
      const batchSize = limit + 1;
      const ids: string[] = [];
      let page = 1;
      let found = 0;
      while (true) {
        const batch = await searchWorkItems({ query: boundSearchTerm(q), kind: "bug", organisationId: scope.organisationId, projectId: scope.projectId, track: parsedTrack.track, page, perPage: batchSize, sortBy: "createdAt:desc,sourceId:desc", queryBy: "title(infix:always),description(infix:always)", extraFilters: filters });
        found = batch.found;
        if (page === 1 && found === 0) throw new Error("Typesense returned no candidates; verifying with PostgreSQL.");
        ids.push(...batch.hits.map((hit) => hit.id));
        const currentRows = await prisma.bug.findMany({
          where: { ...baseFiltered, ...cursorWhere(cursor), id: { in: ids } },
          orderBy: cursorOrderBy(), take: limit + 1, select: issueSelect,
        });
        const literalQuery = boundSearchTerm(q).toLocaleLowerCase();
        rows = currentRows.filter((row) => row.title.toLocaleLowerCase().includes(literalQuery) || row.description.toLocaleLowerCase().includes(literalQuery));
        if (rows.length > limit || page * batchSize >= found || batch.hits.length === 0) break;
        page += 1;
      }
      const sourceCount = await prisma.bug.count({ where: { ...baseFiltered, ...search, ...cursorWhere(cursor) } });
      if (rows.length < Math.min(limit + 1, sourceCount)) throw new Error("Typesense candidate page is incomplete; verifying with PostgreSQL.");
    } catch (error) {
      console.error("[agent-api/issues] Typesense search failed; using PostgreSQL", error);
      const where: Prisma.BugWhereInput = { ...baseFiltered, ...search, ...cursorWhere(cursor) };
      rows = await prisma.bug.findMany({ where, orderBy: cursorOrderBy(), take: limit + 1, select: issueSelect });
    }
  } else {
    const where: Prisma.BugWhereInput = { ...baseFiltered, ...search, ...cursorWhere(cursor) };
    rows = await prisma.bug.findMany({ where, orderBy: cursorOrderBy(), take: limit + 1, select: issueSelect });
  }
  return toPage(rows.map(withImportance), limit);
}

/**
 * #importance: an issue's importance, read from `Bug.voteCount`, which keeps its
 * column name.
 */
export function withImportance<T extends { voteCount: number; reward?: { toNumber(): number } | number; rewardEstimateCount?: number; rewardFixedAt?: Date | null }>(
  row: T,
): Omit<T, "voteCount" | "reward" | "rewardEstimateCount" | "rewardFixedAt"> & { importance: number; reward: ReturnType<typeof rewardView> | null } {
  const { voteCount, reward, rewardEstimateCount, rewardFixedAt, ...rest } = row;
  // #rewards: the reward in $, with how many estimates it averages and whether it is fixed.
  const rewardJson = reward === undefined ? null : rewardView({ reward, rewardEstimateCount: rewardEstimateCount ?? 0, rewardFixedAt: rewardFixedAt ?? null });
  return { ...rest, importance: voteCount, reward: rewardJson } as Omit<T, "voteCount" | "reward" | "rewardEstimateCount" | "rewardFixedAt"> & { importance: number; reward: ReturnType<typeof rewardView> | null };
}

/** A comment's upvotes (#comment-votes) as `votes`, in place of Prisma's `_count`. */
export function withCommentVotes<T extends { _count?: { votes: number } }>(row: T): Omit<T, "_count"> & { votes: number } {
  const { _count, ...rest } = row;
  return { ...rest, votes: _count?.votes ?? 0 };
}

const confirmationSelect = {
  id: true,
  verdict: true,
  summary: true,
  description: true,
  duplicateOfId: true,
  agentId: true,
  onBehalfOfUserId: true,
  undoneAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.IssueConfirmationSelect;

/**
 * #security-findings: a private finding's block on an issue or idea read. Always its
 * severity and whether it is disclosed; the real title, summary, description and
 * files only when the asking agent may see them (`canView`).
 */
export function securityJson(row: FindingRow | null, viewer: FindingViewer | null) {
  if (!row) return null;
  const view = findingView(row, viewer);
  return {
    severity: view.severity,
    disclosed: view.disclosed,
    disclosedAt: view.disclosedAt,
    canView: view.canView,
    details: view.details
      ? { ...view.details, attachments: view.details.attachments.map((file) => ({ ...file, url: agentAttachmentUrl(file.id) })) }
      : null,
  };
}

/** The issue's plan as the issue read shows it: the entry's fields without its revisions and replies. */
async function planSummary(bugId: string) {
  const plan = await currentPlan(bugId);
  if (!plan) return null;
  const summary: Partial<typeof plan> = { ...plan };
  delete summary.revisions;
  delete summary.replies;
  return summary;
}

export async function readAgentIssue(scope: Scope, id: string, viewer: FindingViewer | null = null) {
  // #457: the path may be the readable number (`123`, `ZE-123`) or the id.
  const ref = parseIssueRef(id);
  const issue = await prisma.bug.findFirst({
    where: { ...scope, ...(ref.kind === "number" ? { number: ref.number } : { id: ref.id }), isDeleted: false },
    select: { ...issueSelect, voteCount: true, comments: {
      where: { deletedAt: null }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 100,
      select: { id: true, summary: true, body: true, reason: true, authorId: true, agentId: true, parentId: true, confirmationId: true, bidId: true, deliveryId: true, testVerdictId: true, mergeReviewId: true, createdAt: true, editedAt: true, _count: { select: { votes: true } } },
    }, attachments: {
      // #645: metadata only; agents read the bytes at `url` (#722).
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, filename: true, contentType: true, size: true, commentId: true, createdAt: true },
    }, confirmations: {
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      select: confirmationSelect,
    }, bids: {
      // #issue-bids: the open bids (GET /issues/{id}/bid has their replies).
      where: OPEN_BID_WHERE,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, agentId: true, beneficiaryUserId: true, summary: true, description: true, createdAt: true, updatedAt: true },
    }, _count: { select: { comments: { where: { deletedAt: null } } } } },
  });
  if (!issue) throw new IssueApiError(404, "Issue not found.");
  const confirmed = await isConfirmed(issue.id);
  return {
    ...withImportance(issue),
    // #comment-votes: each comment carries its upvotes as `votes`.
    comments: (issue.comments ?? []).map(withCommentVotes),
    // #722: each file with the URL an agent reads it from, with its key.
    attachments: (issue.attachments ?? []).map((file) => ({ ...file, url: agentAttachmentUrl(file.id) })),
    confirmed,
    // Who has the issue now (its claim), or null: the agent and the person it works for.
    holder: await currentHold(issue.id),
    // #plan-review: the current plan on a complex issue (steps, decision, round, reviewBy), or null.
    plan: await planSummary(issue.id),
    // #pr-reports: the latest independent report on the linked pull request, with who filed it and its age, or null.
    pullRequestState: pullRequestStateView(await latestPullRequestReport(issue.id, issue.pullRequestUrl)),
    // #security-findings: null for an ordinary issue.
    security: securityJson(await findingForBug(issue.id), viewer),
  };
}

/**
 * How many issues sit in each status, and ideas in each idea status, in one
 * project and track: the numbers the issue tabs show. Deleted ones are not counted.
 * `all` is every issue.
 */
export async function countAgentIssues(scope: Scope, params: URLSearchParams) {
  const parsedTrack = parseTrackFilter(params.get("track"));
  if (!parsedTrack.ok) throw new IssueApiError(400, parsedTrack.message, { error: "invalid_request", field: "track" });
  const selectedTrack = trackFilter(parsedTrack.track);
  const [issueRows, substatusRows, ideaRows] = await Promise.all([
    prisma.bug.groupBy({ by: ["status"], where: { ...scope, ...selectedTrack, isDeleted: false }, _count: { _all: true } }),
    prisma.bug.groupBy({ by: ["substatus"], where: { ...scope, ...selectedTrack, isDeleted: false }, _count: { _all: true } }),
    prisma.idea.groupBy({ by: ["status"], where: { ...scope, ...selectedTrack, isDeleted: false }, _count: { _all: true } }),
  ]);
  const issues = Object.fromEntries(statusSchema.options.map((status) => [status, 0])) as Record<(typeof statusSchema.options)[number], number>;
  for (const row of issueRows) issues[row.status] = row._count._all;
  const bySubstatus = Object.fromEntries(substatusSchema.options.map((substatus) => [substatus, 0])) as Record<(typeof substatusSchema.options)[number], number>;
  for (const row of substatusRows) bySubstatus[row.substatus] = row._count._all;
  const ideas = { open: 0, converted: 0, rejected: 0, archived: 0 };
  for (const row of ideaRows) ideas[row.status] = row._count._all;
  return {
    projectId: scope.projectId,
    issues: { ...issues, all: Object.values(issues).reduce((sum, n) => sum + n, 0) },
    substatuses: bySubstatus,
    ideas,
  };
}

/** What a paged comment carries: the embedded read's fields plus who wrote it. */
const commentSelect = {
  id: true, summary: true, body: true, reason: true, authorId: true, agentId: true, parentId: true, confirmationId: true, bidId: true, deliveryId: true, testVerdictId: true, mergeReviewId: true, createdAt: true, editedAt: true,
  author: { select: { id: true, name: true } },
  agent: { select: { id: true, name: true } },
  _count: { select: { votes: true } },
} satisfies Prisma.CommentSelect;

/** Comments strictly after `cursor` in the older-first paging order (#604). */
function commentsAfter(cursor: IssueCursor): Prisma.CommentWhereInput {
  return {
    OR: [
      { createdAt: { gt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { gt: cursor.id } },
    ],
  };
}

/**
 * Non-deleted comments on one issue, oldest first, so an agent can read a long
 * thread from the start (the issue read itself keeps returning the latest 100).
 * The cursor is the same shared (createdAt, id) one; `after` returns only newer
 * comments. The result follows the shared list shape: `{ items, nextCursor }`.
 */
export async function listAgentIssueComments(scope: Scope, issueRef: string, params: URLSearchParams) {
  const cursorRaw = params.get("after");
  const cursor = decodeCursor(cursorRaw);
  if (cursorRaw !== null && !cursor) throw new IssueApiError(400, "Invalid cursor.");
  const limit = pageSize(params.get("limit"));
  if (limit === null) throw new IssueApiError(422, LIMIT_RANGE_ERROR);
  // #entry-replies-only: comments have no type to filter by.
  if (params.has("type")) throw new IssueApiError(400, "comment_has_no_type", { message: TYPED_COMMENT_MESSAGE });

  // #457: the path may be the readable number (`123`, `ZE-123`) or the id.
  const id = await issueIdFor(prisma, issueRef, scope.organisationId);
  const issue = id ? await prisma.bug.findFirst({ where: { ...scope, id, isDeleted: false }, select: { id: true } }) : null;
  if (!issue) throw new IssueApiError(404, "Issue not found.");
  const rows = await prisma.comment.findMany({
    where: {
      bugId: issue.id,
      deletedAt: null,
      ...(cursor ? commentsAfter(cursor) : {}),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: limit + 1,
    select: commentSelect,
  });
  const page = toPage(rows, limit);
  return { ...page, items: page.items.map(withCommentVotes) };
}

async function normalizeOrganisationMentions(db: Prisma.TransactionClient, organisationId: string, body: string) {
  const ids = extractMentionedUserIds(body);
  const users = ids.length ? await db.user.findMany({
    where: { id: { in: ids }, memberships: { some: { organisationId } } }, select: { id: true, name: true },
  }) : [];
  return normalizeMentions(body, new Map(users.map((user) => [user.id, user.name])));
}

export async function commentOnAgentIssue(agent: AgentContext, request: NextRequest, issueRef: string) {
  const raw = await issueJson(request);
  // Comments have no type or metadata. Say why, instead of the bare
  // unknown-key error the strict schema would give.
  if (raw && typeof raw === "object" && !Array.isArray(raw) && ("type" in raw || "metadata" in raw)) {
    throw new IssueApiError(400, "comment_has_no_type", { message: TYPED_COMMENT_MESSAGE, entryRoutes: [...STAGE_ENTRY_ROUTES] });
  }
  const input = agentCommentSchema.parse(raw);
  const scope = await issueProject(agent, request.nextUrl.searchParams, input.projectId);
  let bug: { id: string; title: string; reporterId: string; assigneeId: string | null } | null = null;
  let parentAuthorId: string | null = null;
  const comment = await prisma.$transaction(async (tx) => {
    // #457: the path may be the readable number (`123`, `ZE-123`) or the id.
    const resolvedId = await issueIdFor(tx, issueRef, scope.organisationId);
    const found = resolvedId ? await tx.bug.findFirst({
      where: { ...scope, id: resolvedId, isDeleted: false },
      select: { id: true, title: true, reporterId: true, assigneeId: true, status: true, substatus: true, pullRequestUrl: true },
    }) : null;
    if (!found) throw new IssueApiError(404, "Issue not found.");
    const bugId = found.id;
    bug = found;
    let placement: CommentPlacement;
    try {
      placement = await placeComment(tx, found, input);
    } catch (error) {
      if (!(error instanceof CommentPlacementError)) throw error;
      throw new IssueApiError(error.status, error.message);
    }
    parentAuthorId = placement.parentAuthorId;
    const body = await normalizeOrganisationMentions(tx, scope.organisationId, input.body);
    const created = await tx.comment.create({
      data: {
        bugId,
        authorId: agent.ownerId,
        agentId: agent.agentId,
        summary: input.summary,
        label: input.label ?? null,
        body,
        reason: input.reason ?? null,
        confirmationId: placement.confirmationId,
        bidId: placement.bidId,
        deliveryId: placement.deliveryId,
        testVerdictId: placement.testVerdictId,
        mergeReviewId: placement.mergeReviewId,
        planId: placement.planId,
        parentId: placement.parentId,
      },
      select: {
        id: true,
        bugId: true,
        authorId: true,
        agentId: true,
        summary: true,
        label: true,
        body: true,
        reason: true,
        parentId: true,
        confirmationId: true,
        bidId: true,
        deliveryId: true,
        testVerdictId: true,
        mergeReviewId: true,
        createdAt: true,
      },
    });
    await linkAgentAttachments(tx, agent, { requested: input.attachmentIds, text: body, bugId, commentId: created.id });
    await tx.bugActivity.create({ data: {
      bugId, actorId: agent.ownerId, type: "commented", summary: commentedSummary(body),
      metadata: { commentId: created.id, commentPreview: commentPreview(body) },
    } });
    await tx.bug.update({ where: { id: bugId }, data: { updatedAt: new Date() } });
    await tx.issueWatch.upsert({ where: { userId_bugId: { bugId, userId: agent.ownerId } },
      create: { bugId, userId: agent.ownerId }, update: {} });
    await audit(agent, "comment.created", created.id, { authorId: agent.ownerId }, { db: tx, bugId });
    await publish(tx, {
      organisationId: scope.organisationId,
      type: "comment.created",
      payload: { commentId: created.id, issueId: bugId, authorId: agent.ownerId },
      actorAgentId: agent.agentId,
      bugId,
    });
    return created;
  });
  notifyAgentComment(agent, bug, comment, parentAuthorId);
  return NextResponse.json({ comment }, { status: 201 });
}

/**
 * #533: an agent's comment notifies the same people a person's would:
 * anyone it @mentions, and the issue's watchers (reporter, assignee and
 * watch rows), with a "replied to your comment" for the parent's author.
 * The agent's owner is the actor, so they aren't told about their own agent.
 */
function notifyAgentComment(
  agent: AgentContext,
  bug: { id: string; title: string; reporterId: string; assigneeId: string | null } | null,
  comment: { id: string; body: string },
  parentAuthorId: string | null,
): void {
  if (!bug) return;
  const actor = { actorId: agent.ownerId, actorName: agent.name, bugId: bug.id, bugTitle: bug.title };
  const excerpt = commentPreview(comment.body);
  const mentioned = extractMentionedUserIds(comment.body);
  const events: NotificationEvent[] = [];
  if (mentioned.length > 0) {
    events.push({ ...actor, kind: "mentioned", place: "comment", recipientIds: mentioned, excerpt, commentId: comment.id });
  }
  events.push({
    ...actor,
    kind: "comment_added",
    commentId: comment.id,
    excerpt,
    parentAuthorId,
    recipientIds: [bug.reporterId, bug.assigneeId].filter((id): id is string => Boolean(id)),
    excludeIds: mentioned,
  });
  notifyLater(...events);
}

/**
 * Link uploads to an agent's new issue or comment (#645), the same way the web
 * forms do: only the owner's own uploads that aren't attached anywhere yet
 * can be claimed. Ids the agent named explicitly must all link, or the whole
 * write is refused (422), so an agent never silently loses its evidence.
 * Ids that only appear as /api/attachments/<id> links in the text are best
 * effort, as on the web.
 */
async function linkAgentAttachments(
  tx: Prisma.TransactionClient,
  agent: AgentContext,
  input: { requested?: string[]; text: string; bugId: string; commentId?: string | null },
): Promise<void> {
  const requested = [...new Set(input.requested ?? [])];
  if (requested.length > 0) {
    const linked = await linkAttachments(tx, { ids: requested, uploaderId: agent.ownerId, bugId: input.bugId, commentId: input.commentId ?? null });
    if (linked !== requested.length) {
      throw new IssueApiError(422, "One or more attachmentIds weren't found, belong to someone else, or are already attached.");
    }
  }
  const referenced = attachmentIdsInMarkdown(input.text).filter((id) => !requested.includes(id));
  if (referenced.length > 0) {
    await linkAttachments(tx, { ids: referenced, uploaderId: agent.ownerId, bugId: input.bugId, commentId: input.commentId ?? null });
  }
}
