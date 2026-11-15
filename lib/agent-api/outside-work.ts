import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { AgentContext } from "@/lib/agents/require-agent";
import { assertExpressImportGrant } from "@/lib/agents/express-import";
import { audit } from "@/lib/agents/audit";
import { IssueApiError } from "@/lib/agent-api/errors";
import { deliveryBodySchema } from "@/lib/agent-api/delivery";
import { hashCreateRequest, parseIdempotencyKey } from "@/lib/agent-api/create-policy";
import { publish } from "@/lib/agent-api/events";
import { finalizeResolved } from "@/lib/agent-api/merge";
import { createReviewOffers } from "@/lib/agent-api/review-offer";
import { GitHubError, githubClientFor } from "@/lib/github/client";
import { readPullRequest } from "@/lib/github/pull-request-snapshot";
import { installationIdForPullRequest, PROJECT_REPOSITORIES_SELECT, projectRepoRefs } from "@/lib/github/project-repositories";
import { parsePullRequestUrl, sameRepo } from "@/lib/github/pull-request-url";
import { outsideWorkPullRequest } from "@/lib/outside-work";
import { moveTo } from "@/lib/issue-substatus";

export const outsideWorkSchema = deliveryBodySchema.pick({
  summary: true, description: true, screenshots: true, testResults: true, receipt: true,
}).extend({
  projectId: z.string().trim().min(1).max(191).optional(),
  title: z.string().trim().min(1).max(200),
  pullRequestUrl: z.string().trim().min(1).max(2048),
}).strict().refine((body) => (body.screenshots?.length ?? 0) > 0 || body.testResults !== undefined, {
  message: "Include screenshots or test results that show what was delivered.", path: ["testResults"],
});

const importedIssueSelect = { id: true, number: true, status: true, substatus: true, pullRequestUrl: true } as const;

/** One call creates the issue, its delivery, verified PR report and provenance atomically. */
export async function importOutsideWork(agent: AgentContext, projectId: string, raw: unknown, idempotencyKey: string | null) {
  const body = outsideWorkSchema.parse(raw);
  const key = parseIdempotencyKey(idempotencyKey);
  if (!key) throw new IssueApiError(400, "Send a valid Idempotency-Key (visible ASCII, at most 255 characters).");
  const pr = outsideWorkPullRequest(body.pullRequestUrl);
  if (!pr) throw new IssueApiError(422, "Send an HTTPS GitHub pull request URL.");
  await assertExpressImportGrant(prisma, agent, projectId);
  const project = await prisma.project.findFirst({
    where: { id: projectId, organisationId: agent.organisationId, archivedAt: null },
    select: { repoUrl: true, githubInstallationId: true, ...PROJECT_REPOSITORIES_SELECT },
  });
  const ref = parsePullRequestUrl(pr.url)!;
  if (!project || !projectRepoRefs(project).some((repo) => sameRepo(repo, ref))) {
    throw new IssueApiError(422, "That pull request is not in a repository configured for this project.");
  }
  const requestHash = hashCreateRequest({ ...body, projectId, pullRequestUrl: pr.url, screenshots: body.screenshots ?? [] });
  const identity = { agentId: agent.agentId, projectId, requestKey: key };
  const replay = async (db: Prisma.TransactionClient | typeof prisma) => {
    const existing = await db.outsideWorkImport.findUnique({
      where: { agentId_projectId_requestKey: identity }, include: { bug: { select: importedIssueSelect } },
    });
    if (!existing) return null;
    if (existing.requestHash !== requestHash) throw new IssueApiError(409, "This Idempotency-Key was used with a different import.");
    return { issue: existing.bug, replayed: true as const };
  };
  const previous = await replay(prisma);
  if (previous) return previous;

  // All network work is outside the database transaction. The submitting agent
  // cannot choose a status or assert that its own PR has merged.
  let snapshot;
  try {
    const client = await githubClientFor({ githubInstallationId: installationIdForPullRequest(project, pr.url) });
    snapshot = await readPullRequest(client, ref);
  } catch (error) {
    if (error instanceof GitHubError) throw new IssueApiError(503, "GitHub could not verify this pull request. Retry the same import later.");
    throw error;
  }
  if (snapshot.state !== "open" && snapshot.state !== "merged") {
    throw new IssueApiError(422, "Only open or merged pull requests can be imported; this pull request is missing or closed without merging.");
  }
  // Revalidate GitHub's canonical address too: a renamed/transferred repository
  // must not turn a configured repository into permission to import another one.
  const actual = outsideWorkPullRequest(snapshot.url);
  if (!actual || actual.key !== pr.key) throw new IssueApiError(422, "The pull request moved. Configure its current repository and import its canonical URL.");
  const verified = snapshot;
  const live = verified.state === "merged" && verified.inDefaultBranch === true;
  const start = verified.state === "open" ? "requires_review" : "ready_to_merge";
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${projectId} FOR UPDATE`;
    await assertExpressImportGrant(tx, agent, projectId);
    const existing = await replay(tx);
    if (existing) return existing;
    const currentAgent = await tx.agent.findUnique({ where: { id: agent.agentId }, select: { revokedAt: true, pausedAt: true, ownerUserId: true } });
    const currentKey = await tx.agentApiKey.findUnique({ where: { id: agent.keyId }, select: { revokedAt: true } });
    const activation = await tx.agentActivation.findUnique({
      where: { agentId_organisationId: { agentId: agent.agentId, organisationId: agent.organisationId } }, select: { deactivatedAt: true },
    });
    const member = await tx.membership.findUnique({ where: { organisationId_userId: { organisationId: agent.organisationId, userId: agent.ownerId } }, select: { id: true } });
    if (!currentAgent || currentAgent.revokedAt || currentAgent.pausedAt || currentAgent.ownerUserId !== agent.ownerId || !currentKey || currentKey.revokedAt || !activation || activation.deactivatedAt || !member) {
      throw new IssueApiError(403, "This agent is no longer allowed to import work.");
    }
    // Recheck repository settings after the network call, while the project is locked.
    const currentProject = await tx.project.findUnique({ where: { id: projectId }, select: { repoUrl: true, ...PROJECT_REPOSITORIES_SELECT } });
    if (!projectRepoRefs(currentProject).some((repo) => sameRepo(repo, ref))) throw new IssueApiError(409, "Project repositories changed. Check the configuration and retry.");
    const duplicate = await tx.outsideWorkImport.findUnique({ where: { projectId_pullRequestKey: { projectId, pullRequestKey: pr.key } }, select: { bugId: true } });
    if (duplicate) throw new IssueApiError(409, "This pull request was already imported.", { issueId: duplicate.bugId });
    // A PR already credited through the board must not earn a second solver
    // reward through this endpoint. Existing legitimate multi-issue PRs remain untouched.
    const linked = await tx.bug.findMany({ where: { projectId, pullRequestUrl: { not: null } }, select: { id: true, pullRequestUrl: true } });
    const recorded = linked.find((bug) => outsideWorkPullRequest(bug.pullRequestUrl!)?.key === pr.key);
    if (recorded) throw new IssueApiError(409, "This pull request is already recorded on an issue.", { issueId: recorded.id });
    const bug = await tx.bug.create({
      data: {
        organisationId: agent.organisationId, projectId, title: body.title, summary: body.summary, description: body.description,
        reporterId: agent.ownerId, beneficiaryUserId: agent.ownerId, assigneeId: agent.ownerId, createdByAgentId: agent.agentId,
        pullRequestUrl: pr.url, pullRequestHeadSha: verified.headSha, proofLinks: body.screenshots ?? [], ...moveTo(start),
      }, select: importedIssueSelect,
    });
    await tx.delivery.create({ data: {
      bugId: bug.id, agentId: agent.agentId, beneficiaryUserId: agent.ownerId, summary: body.summary, description: body.description,
      pullRequestUrl: pr.url, headSha: verified.headSha, screenshots: body.screenshots ?? [],
      testResults: body.testResults === undefined ? null : typeof body.testResults === "string" ? body.testResults : JSON.stringify(body.testResults),
      ...(body.receipt ? { receipt: body.receipt } : {}),
    } });
    await tx.outsideWorkImport.create({ data: {
      bugId: bug.id, projectId, agentId: agent.agentId, pullRequestKey: pr.key, requestKey: key, requestHash, initialState: verified.state,
    } });
    await tx.pullRequestReport.create({ data: {
      bugId: bug.id, pullRequestUrl: pr.url, state: verified.state, source: "ziki", headSha: verified.headSha,
      mergedInto: verified.state === "merged" ? verified.baseRef : null, inDefaultBranch: verified.inDefaultBranch,
      mergeCommitSha: verified.mergeCommitSha, checks: verified.checksSummary, mergeable: verified.mergeable,
      note: "Read on GitHub when importing work delivered outside the board.",
      checkedAt: new Date(verified.fetchedAt), details: verified as unknown as Prisma.InputJsonValue,
    } });
    await tx.bugActivity.create({ data: {
      bugId: bug.id, actorId: agent.ownerId, type: "status_changed", summary: "Delivered outside the board; earlier intake and allocation steps were skipped",
      metadata: { via: "outside_work", agentId: agent.agentId, initialState: verified.state, to: start, pullRequestUrl: pr.url },
    } });
    await audit(agent, "issue.imported", `bug:${bug.id}`, { projectId, initialState: verified.state, pullRequestUrl: pr.url, beneficiaryUserId: agent.ownerId }, { bugId: bug.id, db: tx });
    await publish(tx, { organisationId: agent.organisationId, type: "issue.delivered", bugId: bug.id, actorAgentId: agent.agentId,
      payload: { issueId: bug.id, projectId, pullRequestUrl: pr.url, outsideBoard: true, ...moveTo(start) } });
    if (live) {
      await finalizeResolved(tx, {
        agent, bug: { ...bug, organisationId: agent.organisationId, projectId }, claim: null,
        solverUserId: agent.ownerId, solverAgentId: agent.agentId, rewardedReviewerUserIds: [], acceptedHeadSha: null,
        mergeCommitSha: verified.mergeCommitSha,
        record: { via: "outside_work", preMergeReviewSkipped: true }, eventRecord: { via: "outside_work" },
      });
    }
    return { issue: { ...bug, ...(live ? moveTo("on_dev") : {}) }, replayed: false as const };
  });
  if (!result.replayed && verified.state === "open") {
    // The work feed also exposes the new delivery, so a notification failure
    // cannot turn a committed import into a failed request or lose the work.
    await createReviewOffers(prisma, agent, result.issue.id, { pullRequestUrl: pr.url, headSha: verified.headSha }).catch(() => null);
  }
  return result;
}
