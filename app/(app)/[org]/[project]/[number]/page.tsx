import { AskAboutFix } from "@/components/ask-about-fix";
import { ASKABLE_STATUSES } from "@/lib/validations/support-thread";
import { MergerTransparencyCard } from "@/components/merger-transparency-card";
import { requireProject } from "@/lib/project-route";
import Link from "next/link";
import { ideaPath, issuesPath, projectRef, refOf } from "@/lib/project-paths";
import { MarketingAreaMarker } from "@/components/marketing/marketing-area";
import { MarketingTaskDetail } from "@/components/marketing/marketing-task-detail";
import { entryReplySelect, toEntryReplies } from "@/lib/agent-api/entry-fields";
import Image from "next/image";
import { Suspense } from "react";
import type { Metadata } from "next";
import { SITE_NAME } from "@/lib/seo/site";
import { notFound, permanentRedirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { agentMentionId } from "@/lib/mentions";
import { requireUser } from "@/lib/auth-helpers";
import { bugInOrganisation, currentOrganisationIdFor } from "@/lib/organisation-context";
import { issueHref, issuePath, queryString } from "@/lib/issue-ref";
import { findProjectIssue, parseIssueNumber } from "@/lib/project-issue";
import { resolveSessionUserId } from "@/lib/session-user";
import { LocalTime } from "@/components/local-time";
import { IssuePrioritySelect } from "@/components/issue-priority-select";
import { ClearDuplicateButton, MarkDuplicateButton } from "@/components/duplicate-controls";
import { currentResolution, isFinishedStatus, type StatusChangeActivity } from "@/lib/resolution-note";
import { statusLabel as resolutionStatusLabel } from "@/lib/labels";
import { formatIssueNumber } from "@/lib/issue-number";
import { buildCommentTree, byImportance } from "@/lib/comments";
import {
  COMMENT_PARAM,
  COMMENT_THREADS_PER_PAGE,
  earlierThreadsHref,
  loadCommentWindow,
  parseCommentTarget,
  parseThreadWindow,
  type CommentWindow,
} from "@/lib/comment-window";
import { CommentPermalinkResolver } from "@/components/comment-permalink-resolver";
import {
  bugLinkPreviewDescription,
} from "@/lib/link-preview";
import { absoluteUrl } from "@/lib/site-url";
import { SHARE_IMAGE } from "@/lib/share-image";
import {
  statusLabels,
} from "@/lib/labels";
import { ActivityTimeline, issueStepActivities, type ActivityEntry } from "@/components/activity-timeline";
import { type AgentDecision } from "@/components/issue-agent-activity";
import { IssueProgressReport } from "@/components/issue-progress-report";
import { IssueStageProvider } from "@/components/issue-stage-context";
import { IssueComments } from "@/components/comment-thread";
import { AgentSteerPanel } from "@/components/agent-steer-panel";
import { CommentComposer } from "@/components/comment-composer";
import { AwardBox } from "@/components/award-box";
import { FundIssueSection } from "@/components/coins/fund-issue-section";
import { PlanReviewCard, type PlanCardView } from "@/components/plan-review-card";
import { currentPlan, planDeadline, type PlanView } from "@/lib/agent-api/plan";
import { difficultyLabel } from "@/lib/difficulty";
import { AwardStep, IdeaStep, IssueTimeline, TimelineStep, type AwardStepView } from "@/components/issue-timeline";
import { currentHold, shownAssignee, type IssueHold } from "@/lib/issue-holders";
import { isOpenBid } from "@/lib/open-bids";
import {
  claimDecisionKind,
  currentDecisionStage,
  payloadMerged,
  stageSetback,
} from "@/lib/decision-stages";
import { IssueEscalations, type TicketEscalation } from "@/components/issue-escalations";
import { listBugEscalations } from "@/lib/agent-questions";
import { IssueBidsPanel, type BidEntryView } from "@/components/issue-bids";
import { BidButton } from "@/components/bid-button";
import { awardingAgentOf } from "@/lib/bid-award-permission";
import { bidHistoryEntries } from "@/lib/agent-api/bid";
import { markAtCapacity } from "@/lib/agent-api/capacity";
import { bidderRecordsForBids } from "@/lib/bidder-record-data";
import { testVerdictEntries } from "@/lib/agent-api/test-verdict";
import { deliveryEntries } from "@/lib/agent-api/delivery";
import { mergeReviewEntries } from "@/lib/agent-api/merge";
import { DeliveriesPanel, MergeReviewsPanel, TestVerdictsPanel, type DeliveryView, type MergeReviewView, type TestVerdictView } from "@/components/issue-review-entries";
import { Badge } from "@/components/ui/badge";
import { VoteButton } from "@/components/vote-button";
import { SpeedButton } from "@/components/speed-button";
import {
  InsufficientVotesAuditBanner,
  WORK_READINESS_VOTE_THRESHOLD,
} from "@/components/insufficient-votes-audit-banner";
import { IssueConfirmationsPanel, type ConfirmationBlock, type ConfirmationsData } from "@/components/issue-confirmations";
import { CONFIRMATION_SUMMARY_MAX_CHARS, listConfirmations, takesConfirmations } from "@/lib/agent-api/confirmations";
import { DisputeAwardDialog, type DisputeRole } from "@/components/dispute-award-dialog";
import { TakeItBackPanel } from "@/components/take-it-back";
import { takeItBackViewFor } from "@/lib/take-it-back-server";
import { AttachmentList, type AttachmentView } from "@/components/attachment-list";
import { ChooseRedesignButton } from "@/components/choose-redesign-button";
import { isOrganisationAdminRole } from "@/lib/agents/membership";
import type { OrganisationRole } from "@/lib/organisation-role";
import { AgentChip, UserNameWithBadges } from "@/components/user-name-with-badges";
import { fetchVoterSummary } from "@/lib/voter-summaries";
import { createEmptyVoterSummary } from "@/lib/voters";
import {
  canDeleteTicket,
  deletedSummary,
  deletionCounts,
} from "@/lib/ticket-deletion";
import { organisationAccessFor } from "@/lib/organisation-access";
import { MilestoneDue } from "@/components/milestone-due";
import { LoadError } from "@/components/load-error";
import { logLoadFailure } from "@/lib/load-error";
import { dueDateValue, milestoneIssuesHref } from "@/lib/milestones";
import { canEditTicket } from "@/lib/ticket-editing";
import { DeleteIssueButton } from "@/components/delete-issue-button";
import { RestoreIssueButton } from "@/components/restore-issue-button";
import { canAssignTicket } from "@/lib/ticket-assignment";
import { SelfAssignButton } from "@/components/self-assign-button";
import { IssueActionsMenu } from "@/components/issue-actions-menu";
import { CopyIssueSummaryButton } from "@/components/copy-issue-summary-button";
import { EditableIssueDescription } from "@/components/editable-issue-description";
import { SecurityFindingPanel } from "@/components/security-finding-panel";
import { findingForBug, findingView } from "@/lib/security-findings";
import { IssueLinks } from "@/components/issue-links";
import { parsePullRequestUrl } from "@/lib/github/pull-request-url";
import { NextStepBar } from "@/components/next-step-bar";
import { liveCheck, liveConfirmLabel, liveFactLabel, liveNextStep, liveStepState } from "@/lib/live-check";
import { loadProdConfirmers } from "@/lib/live-confirm-data";
import { PROD_CONFIRMATIONS_NEEDED } from "@/lib/live-confirm";
import { LiveFlow } from "@/components/live-flow";
import { latestPullRequestReport, gateReport, pullRequestStateView, type PullRequestStateView } from "@/lib/agent-api/pull-request-report";
import { prGate, reportWanted } from "@/lib/agent-api/pr-gate";
import { parseGitHubRepoUrl } from "@/lib/github/pull-request-url";
import { mergeChecklist } from "@/lib/merge-checklist";
import { MergeChecklistCard } from "@/components/merge-checklist";
import { PROJECT_REPOSITORIES_SELECT, repoForPullRequest } from "@/lib/github/project-repositories";
import { DecisionCard } from "@/components/decision-card";
import { decisionFor } from "@/lib/your-decision";
import { agentInstructionsFor } from "@/lib/agent-instructions";
import { countedJudgements } from "@/lib/agent-api/tested-status";
import { DeliveredBanner, type DeliveredBannerProps } from "@/components/delivered-banner";
import { BackToList } from "@/components/back-to-list";
import { issueNextStep } from "@/lib/next-step";
import { staleHold, type StaleHold } from "@/lib/agent-api/stale-hold";
import { senseCheck } from "@/lib/agent-api/abandon";
import { closeSuggestionsFor, type CloseSuggestionsData } from "@/lib/agent-api/close-suggestions";
import { CloseSuggestionsPanel } from "@/components/close-suggestions";
import { ConfirmSubmitButton } from "@/components/confirm-submit-button";
import { withdrawIssueAction } from "@/app/actions/withdraw-issue";
import { closedLabel, closeReasonLabel, ownsIssue } from "@/lib/close-reasons";
import { workflowFor } from "@/lib/workflow";
import { isThresholdOnly } from "@/lib/governance";
import { mergeReviewVotes } from "@/lib/agent-api/merge-review-tally";
import { issueOrganisationHintFor } from "@/lib/issue-organisation-hint";
import { IssueOrganisationSwitch } from "@/components/issue-organisation-hint";
import { organisationMemberWhere } from "@/lib/organisation-mentions";
import { readAgentResolution } from "@/lib/agent-resolution";
import { AgentResolvedNotice } from "@/components/agent-resolved-notice";
import { SubmissionEvidence } from "@/components/submission-evidence";
import { PullRequestChecks } from "@/components/pull-request-checks";
import { GitHubStatusPanel, type GitHubStatusPanelProps } from "@/components/github-status-panel";
import { storedGitHubStatus } from "@/lib/github/sync";
import { githubStatusPowers } from "@/lib/github/status-access";
import { voteDirection } from "@/lib/voting";
import {
  issueChipBaseClass,
  issueStatusChipClass,
} from "./issue-ui";
import "./issue-detail.css";
import { stateLabel } from "@/lib/labels";
import { IssueRewardPanel } from "@/components/issue-reward-panel";
import { RetestRequest } from "@/components/retest-request";
import { rewardEstimatesFor } from "@/lib/agent-api/reward-estimates";
import { IssueBlockersPanel } from "@/components/issue-blockers-panel";
import { IssueTimeTracking } from "@/components/issue-time-tracking";
import type { IssueBlockerCandidate } from "@/app/actions/issue-blockers";
import { activeIn, activeLevels, levelIn } from "@/lib/agents/active-in";

type BugPageProps = {
  params: Promise<{ org: string; project: string; number: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

const NO_COMMENTS: CommentWindow = {
  comments: [],
  shownThreads: 0,
  hiddenThreads: 0,
  visibleCount: 0,
};

/** The flags listed under the status chip in the side rail (#close-reasons). */
type StatusFlagTone = "bad" | "warn" | "info";

const STALE_FLAG: Record<StaleHold["kind"], string> = {
  offer_expired: "Stale: offer expired",
  overdue: "Stale: overdue",
  silent: "Stale: silent",
};

const FLAG_DOT: Record<StatusFlagTone, string> = {
  bad: "bg-zk-bad-fg",
  warn: "bg-zk-warn-fg",
  info: "bg-zk-accent",
};

/** How much of the activity log a single page render is allowed to load. */
const ACTIVITY_PAGE_SIZE = 50;

async function loadOptional<T>(label: string, fallback: T, load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (error) {
    console.error(`[issue] ${label} failed`, error);
    return fallback;
  }
}

/** Why a merger agent's deployment failed (#1446), from its audit payload. */
function payloadReason(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const reason = (payload as { reason?: unknown }).reason;
  return typeof reason === "string" && reason.trim() ? reason : null;
}

/** The database error stays in the server log under `reference`. */
function issueLoadError(reference: string) {
  return <LoadError title="This issue could not be loaded" reference={reference} />;
}

export async function generateMetadata({
  params,
}: BugPageProps): Promise<Metadata> {
  const { org, project, number: rawNumber } = await params;
  const number = parseIssueNumber(rawNumber);
  const lookup = number === null ? null : await findProjectIssue(org, project, number);
  const bug = lookup && lookup.kind !== "elsewhere" ? await prisma.bug.findUnique({
    where: { id: lookup.issue.id },
    select: {
      number: true,
      title: true,
      status: true,
      updatedAt: true,
      isDeleted: true,
      project: { select: { slug: true, organisation: { select: { slug: true } } } },
    },
  }) : null;

  if (!bug || bug.isDeleted) {
    return {
      title: "Issue not found",
      description: "This issue could not be found.",
      robots: { index: false, follow: false },
    };
  }

  // Title and status only: these tags are served to anyone with a preview-bot
  // User-Agent, signed in or not (#117).
  const description = bugLinkPreviewDescription({ status: bug.status });
  const canonical = absoluteUrl(issueHref(bug));
  const image = absoluteUrl(SHARE_IMAGE.url);
  // The reference goes in the tab title too: with several issues open, the
  // number is what tells two similar titles apart.
  const title = `${formatIssueNumber(bug.number)} ${bug.title}`;

  return {
    title,
    description,
    alternates: { canonical },
    robots: { index: false, follow: false },
    openGraph: {
      title,
      description,
      url: canonical,
      type: "article",
      siteName: SITE_NAME,
      modifiedTime: bug.updatedAt.toISOString(),
      images: [{ ...SHARE_IMAGE, url: image }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [image],
    },
    other: {
      "bug:status": statusLabels[bug.status],
    },
  };
}

/**
 * Renders the issue detail page: the Conversation (who has it, its stage
 * entries), the comments in a card of their own, the activity timeline and
 * the attachments.
 *
 * Performance optimization (#349): Gating the full user directory query behind
 * `canTriage` ensures non-triage viewers do not run unnecessary database queries.
 *
 * @param props.params - Route parameters: the project's slug and the issue's number.
 * @param props.searchParams - Optional query params for thread windowing or permalinks.
 */
export default async function BugDetailPage({ params, searchParams }: BugPageProps) {
  const { org, project: projectSlug, number: rawNumber } = await params;
  const number = parseIssueNumber(rawNumber);
  if (number === null) notFound();
  const lookup = await findProjectIssue(org, projectSlug, number);
  const query = (await searchParams) ?? {};
  const resolved = await resolveSessionUserId();
  const userId = "userId" in resolved ? resolved.userId : undefined;

  // Unauthenticated link-preview bots get the title and status only (#117).
  // They're recognised by User-Agent, which anyone can fake, so nothing more
  // sensitive (reporter, description) may appear here.
  if (!userId) {
    // Without a session the slug and number resolve only when exactly one
    // organisation has them (lib/project-issue.ts).
    const bug = lookup?.kind === "found" && await prisma.bug.findUnique({
      where: { id: lookup.issue.id },
      select: {
        title: true,
        status: true,
        substatus: true,
        isDeleted: true,
      },
    });
    if (!bug || bug.isDeleted) notFound();

    return (
      <div className="issue-detail-scope mx-auto max-w-2xl space-y-4 py-10">
        <p className="text-sm text-zk-muted">Ziki</p>
        <h1 className="text-2xl font-extrabold text-zk-text">{bug.title}</h1>
        <div className="flex flex-wrap gap-2">
          <Badge className={`${issueChipBaseClass} ${issueStatusChipClass[bug.substatus]}`}>
            {stateLabel(bug.substatus)}
          </Badge>
        </div>
        <Link
          href={`/login?callbackUrl=${encodeURIComponent(issuePath(projectRef(org, projectSlug), number))}`}
          className="inline-flex text-sm font-bold text-zk-accent hover:underline"
        >
          Sign in to view full details
        </Link>
      </div>
    );
  }

  const projectContext = await requireProject(org, projectSlug);
  const { user, organisationId, isOrgMember, isOrgAdmin, canContribute } = projectContext;
  const access = await organisationAccessFor(user.id, organisationId, user.role);
  const canTriage = isOrgAdmin;
  const canDelete = isOrgAdmin || (isOrgMember && canDeleteTicket(user.role, access.membershipRole));
  if (!lookup) notFound();
  if (lookup.kind === "elsewhere") {
    // A link into another of the viewer's organisations should not dead-end (#519):
    // name the organisation and offer the switch. Non-members still get the 404.
    const activeOrganisationId = await currentOrganisationIdFor(userId);
    const hint = await issueOrganisationHintFor(prisma, {
      userId,
      activeOrganisationId,
      issueId: lookup.issueId,
    });
    if (!hint) notFound();
    const currentWorkspace = activeOrganisationId ? await loadOptional("current workspace", null, () =>
      prisma.organisation.findFirst({
        where: { id: activeOrganisationId, archivedAt: null, memberships: { some: { userId } } },
        select: { name: true },
      }),
    ) : null;
    return <IssueOrganisationSwitch issueId={lookup.issueId} organisation={hint} currentWorkspace={currentWorkspace?.name} destination={`${issuePath(projectRef(org, projectSlug), number)}${queryString(query)}`} />;
  }
  if (lookup.kind === "moved") {
    // #project-urls: the number lives in another project of this organisation.
    // The page streams, so this redirect happens in the browser and can drop
    // the #fragment; a comment permalink gets its anchor back from the query.
    const comment = parseCommentTarget(query[COMMENT_PARAM]);
    permanentRedirect(
      `${issuePath(lookup.issue.ref, lookup.issue.number)}${queryString(query)}${comment ? `#comment-${comment}` : ""}`,
    );
  }
  const id = lookup.issue.id;

  // The list page already proved the issue row itself can be read. Comments,
  // the activity log, watches and attachments are newer tables. One of them
  // missing used to reject this whole Promise and blank the page.
  let loadedBug = await prisma.bug
    .findUnique({
      where: { id, organisationId },
      include: {
        type: { select: { id: true, name: true, isActive: true } },
        reporter: { select: { name: true, email: true, role: true, image: true } },
        createdByAgent: { select: { id: true, name: true, ownerUserId: true } },
        linkedIssue: { select: { number: true, title: true, isDeleted: true } },
        idea: { select: { id: true, number: true, rationale: true, convertedAt: true, _count: { select: { verdicts: true } } } },
        milestone: { select: { id: true, title: true, dueDate: true, isClosed: true } },
        assignee: { select: { id: true, name: true, role: true, image: true } },
        area: { select: { id: true, name: true } },
        project: { select: { slug: true, name: true, goal: true, siteUrl: true, organisation: { select: { slug: true } } } },
        votes: { where: { userId }, select: { id: true, value: true }, take: 1 },
        // #285: both sides of a duplicate link.
        duplicateOf: { select: { id: true, number: true, title: true, status: true, isDeleted: true, project: { select: { slug: true, organisation: { select: { slug: true } } } } } },
        duplicates: {
          where: { isDeleted: false },
          select: { id: true, number: true, title: true, status: true, project: { select: { slug: true, organisation: { select: { slug: true } } } } },
          orderBy: { number: "asc" },
          take: 20,
        },
        _count: { select: { duplicates: { where: { isDeleted: false } } } },
      },
    })
    .then((bug) => ({ bug }))
    .catch((error: unknown) => ({
      // `detail` only decides the milestone retry below; it is never shown.
      detail: error instanceof Error ? error.message : "",
      reference: logLoadFailure("[issue] detail query failed", error),
    }));

  // If the query failed because Bug.milestoneId or Milestone does not exist in
  // the current database, retry without the milestone relation so the page
  // continues to load cleanly (#289).
  if ("detail" in loadedBug && /milestoneId|Milestone/i.test(loadedBug.detail)) {
    loadedBug = await prisma.bug
      .findUnique({
        where: { id, organisationId },
        include: {
          type: { select: { id: true, name: true, isActive: true } },
          reporter: { select: { name: true, email: true, role: true, image: true } },
          createdByAgent: { select: { id: true, name: true, ownerUserId: true } },
          linkedIssue: { select: { number: true, title: true, isDeleted: true } },
          idea: { select: { id: true, number: true, rationale: true, convertedAt: true, _count: { select: { verdicts: true } } } },
          assignee: { select: { id: true, name: true, role: true, image: true } },
          area: { select: { id: true, name: true } },
          project: { select: { slug: true, name: true, goal: true, siteUrl: true, organisation: { select: { slug: true } } } },
          votes: { where: { userId }, select: { id: true, value: true }, take: 1 },
          duplicateOf: { select: { id: true, number: true, title: true, status: true, isDeleted: true, project: { select: { slug: true, organisation: { select: { slug: true } } } } } },
          duplicates: {
            where: { isDeleted: false },
            select: { id: true, number: true, title: true, status: true, project: { select: { slug: true, organisation: { select: { slug: true } } } } },
            orderBy: { number: "asc" },
            take: 20,
          },
          _count: { select: { duplicates: { where: { isDeleted: false } } } },
        },
      })
      .then((bug) => ({
        bug: bug
          ? {
              ...bug,
              milestoneId: null,
              milestone: null,
            }
          : null,
      }))
      .catch((error: unknown) => ({
        detail: error instanceof Error ? error.message : "",
        reference: logLoadFailure("[issue] fallback detail query without milestone failed", error),
      }));
  }

  if ("reference" in loadedBug) {
    return issueLoadError(loadedBug.reference);
  }
  const bug = loadedBug.bug;
  // #security-findings: the private details, shown only to who may see them.
  const securityFinding = bug ? await findingForBug(bug.id) : null;
  const securityView = bug && securityFinding
    ? findingView(securityFinding, { kind: "person", userId: user.id, organisationId: bug.organisationId, organisationAdmin: access.admin })
    : null;

  if (!bug || (bug.isDeleted && !canDelete)) {
    notFound();
  }

  const blockerRows = organisationId ? await loadOptional("issue blockers", [], () =>
    prisma.issueBlocker.findMany({
      where: { OR: [{ blockedBugId: bug.id }, { blockerBugId: bug.id }] },
      select: {
        blockedBugId: true,
        blockerBugId: true,
        blockedBug: { select: { id: true, number: true, title: true, status: true, substatus: true } },
        blockerBug: { select: { id: true, number: true, title: true, status: true, substatus: true } },
      },
    }),
  ) : [];
  const blockedBy = blockerRows.filter((row) => row.blockedBugId === bug.id).map((row) => row.blockerBug) satisfies IssueBlockerCandidate[];
  const blocking = blockerRows.filter((row) => row.blockerBugId === bug.id).map((row) => row.blockedBug) satisfies IssueBlockerCandidate[];
  // These tables arrived after the issue row. A missing one must not blank the page.
  const [redesignProposals, membership] = organisationId ? await Promise.all([
    loadOptional("redesigns", [], () =>
      prisma.redesignProposal.findMany({
        where: { organisationId, bugId: bug.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, title: true, body: true, previewUrl: true, status: true,
          authorAgent: { select: { name: true } }, attachments: { select: { id: true, filename: true, contentType: true } } },
      }),
    ),
    loadOptional("membership", null, () =>
      prisma.membership.findUnique({ where: { organisationId_userId: { organisationId, userId } }, select: { role: true } }),
    ),
  ]) : [[], null] as const;
  const canChooseRedesign = isOrganisationAdminRole(membership?.role, user.role);
  // "Take it back" (#851): only an owner or admin sees it, only on a merged issue.
  const takeItBack = await loadOptional("take it back", null, () =>
    takeItBackViewFor({ issue: bug, membershipRole: membership?.role, appRole: user.role }),
  );
  // Once an issue is past Requires confirmation, the Conversation opens on who
  // has it (its claims), then every bid it took (#issue-bids).
  const pastConfirmation = bug.substatus !== "requires_confirmation";
  // Bids come in from the start, while it awaits confirmation too.
  const [hold, bidList, claimHistory, watchRow] = await Promise.all([
    pastConfirmation ? loadOptional<IssueHold | null>("holder", null, () => currentHold(bug.id)) : Promise.resolve(null as IssueHold | null),
    // While Open, an open bid whose bidder is at the project's capacity says so (#bidder-capacity).
    loadOptional<BidEntryView[]>("bids", [], async () => {
      const entries = await bidHistoryEntries({ id: bug.id, areaId: bug.areaId ?? null });
      const [withCapacity, records] = await Promise.all([
        bug.status === "open" ? markAtCapacity({ organisationId: bug.organisationId, projectId: bug.projectId }, entries) : entries,
        bidderRecordsForBids(
          { organisationId: bug.organisationId, areaId: bug.areaId ?? null, areaName: bug.area?.name ?? null },
          entries,
        ).catch((error: unknown) => {
          logLoadFailure("[issue] bidder records query failed", error);
          return null;
        }),
      ]);
      return withCapacity.map((entry) => ({ ...entry, record: records?.get(entry.beneficiaryUserId) }));
    }),
    // Every offer or claim, newest first: the timeline's Award step (#issue-timeline) is the
    // newest, held or since released; the Activity panel lists each award and release.
    loadOptional<(AwardStepView & { id: string })[]>("award", [], async () => {
      const claims = await prisma.issueClaim.findMany({
        where: { bugId: bug.id, OR: [{ offeredAt: { not: null } }, { claimedAt: { not: null } }] },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: {
          id: true,
          offeredAt: true,
          claimedAt: true,
          releasedAt: true,
          agent: { select: { name: true } },
          beneficiary: { select: { name: true } },
        },
      });
      return claims.map((claim) => ({
        id: claim.id,
        agentName: claim.agent.name,
        personName: claim.beneficiary.name,
        offeredAt: claim.offeredAt,
        claimedAt: claim.claimedAt,
        releasedAt: claim.releasedAt,
      }));
    }),
    loadOptional("issue watch", null, () => prisma.issueWatch.findUnique({
      where: { userId_bugId: { userId: user.id, bugId: bug.id } },
      select: { watching: true },
    })),
  ]);
  const isWatchingIssue = watchRow?.watching ?? (bug.reporterId === user.id || bug.assigneeId === user.id);
  const awardClaim: AwardStepView | null = claimHistory[0] ?? null;
  // #plan-review: a complex issue's plan, while under review and after (what the delivery is judged against).
  const planReviewing = bug.substatus === "plan_review" && !bug.isDeleted;
  const planRecord: PlanView | null = pastConfirmation ? await loadOptional<PlanView | null>("plan", null, () => currentPlan(bug.id)) : null;
  const planCard: PlanCardView | null = planRecord && (planReviewing ? planRecord.live : planRecord.decision === "approved")
    ? {
      id: planRecord.id, agentName: planRecord.agentName, ownerName: planRecord.ownerName, summary: planRecord.summary, description: planRecord.description,
      reading: planRecord.reading, assumptions: planRecord.assumptions, uncertainties: planRecord.uncertainties,
      steps: planRecord.steps.map(({ id, text, by }) => ({ id, text, by })), estimateMinutes: planRecord.estimateMinutes, risk: planRecord.risk, confidence: planRecord.confidence,
      round: planRecord.round, sendBacksLeft: planRecord.sendBacksLeft, submittedAt: planRecord.submittedAt, decision: planRecord.decision, decidedAt: planRecord.decidedAt,
      decisionNote: planRecord.decisionNote, reviewBy: planRecord.reviewBy, updatedAt: planRecord.updatedAt,
      replies: planRecord.replies.map((reply) => ({ id: reply.id, label: reply.label, body: reply.body, authorName: reply.authorName, agentName: reply.agentName, createdAt: reply.createdAt })),
    }
    : null;
  const planOwnerId = planReviewing ? (planRecord?.live ? planRecord.ownerId : null) : null;

  const [users, voterSummary, activities, activityCount, comments, latestStatusChange, attachments, lastRevision, agentDecisions, escalations] =
    await Promise.all([
      canTriage
        ? loadOptional("users", [], () =>
            // #502: only the issue's organisation can be mentioned or assigned.
            prisma.user.findMany({
              where: organisationMemberWhere(bug.organisationId),
              orderBy: { name: "asc" },
              select: { id: true, name: true, role: true, image: true },
            }),
          )
        : Promise.resolve([]),
      loadOptional("votes", createEmptyVoterSummary(), () => fetchVoterSummary(id)),
      loadOptional("activity", [] as ActivityEntry[], () =>
        prisma.bugActivity.findMany({
          where: { bugId: id },
          include: { actor: { select: { name: true } } },
          orderBy: { createdAt: "desc" },
          take: ACTIVITY_PAGE_SIZE,
        }),
      ),
      loadOptional("activity count", 0, () => prisma.bugActivity.count({ where: { bugId: id } })),
      // The newest threads only (#280); a permalink widens the window to
      // reach its comment.
      loadOptional("comments", NO_COMMENTS, () =>
        loadCommentWindow(prisma, id, {
          threads: parseThreadWindow(query.threads),
          target: parseCommentTarget(query.comment),
        }),
      ),
      // #316: the status change that put the issue in its current state,
      // read on its own so it is found even when the timeline is trimmed.
      isFinishedStatus(bug.status)
        ? loadOptional<StatusChangeActivity | null>("resolution note", null, () =>
            prisma.bugActivity.findFirst({
              where: { bugId: id, type: "status_changed" },
              orderBy: { createdAt: "desc" },
              select: { createdAt: true, metadata: true, actor: { select: { name: true } } },
            }),
          )
        : Promise.resolve(null),
      // Files on the issue and on its comments (#215); never the file contents here.
      loadOptional("attachments", [], () =>
        prisma.attachment.findMany({
          where: { bugId: id },
          select: { id: true, filename: true, contentType: true, size: true, commentId: true },
          orderBy: { createdAt: "asc" },
        }),
      ),
      // #303: only whether there is history, and when it last changed.
      loadOptional<{ editedAt: Date } | null>("revisions", null, () =>
        prisma.bugRevision.findFirst({
          where: { bugId: id },
          orderBy: { editedAt: "desc" },
          select: { editedAt: true },
        }),
      ),
      // #448: what agents decided on this issue — confirmations and rejections
      // (#1122), the claim, test verdicts, and whether an agent accepted the
      // fix. Sentences only; the raw audit payloads live on the audit page (#447).
      loadOptional<AgentDecision[]>(
        "agent decisions",
        [],
        async () => {
          const [confirmations, deliveries, claims, verdicts, reviews, accepted] = await Promise.all([
            // #issue-confirmations: confirm and reject entries; neutral decides nothing.
            prisma.issueConfirmation.findMany({
              where: { bugId: id, verdict: { in: ["confirm", "reject"] }, undoneAt: null },
              orderBy: { updatedAt: "asc" },
              select: {
                id: true,
                updatedAt: true,
                verdict: true,
                summary: true,
                agent: { select: { name: true } },
                onBehalfOf: { select: { name: true } },
              },
            }),
            // #delivered-step: each delivery of the work.
            prisma.delivery.findMany({
              where: { bugId: id },
              orderBy: { updatedAt: "asc" },
              select: { id: true, updatedAt: true, agent: { select: { name: true } }, beneficiary: { select: { name: true } } },
            }),
            // #1446: released claims too; a claim released for any reason but
            // the fix landing counts as a rejected claim at the Open stage.
            prisma.issueClaim.findMany({
              where: { bugId: id, claimedAt: { not: null } },
              orderBy: { createdAt: "asc" },
              select: {
                id: true,
                createdAt: true,
                status: true,
                claimedAt: true,
                releasedAt: true,
                releaseReason: true,
                deliverBy: true,
                extendedAt: true,
                waitingOnOwnerSince: true,
                agent: { select: { name: true, owner: { select: { name: true } } } },
                beneficiary: { select: { name: true } },
              },
            }),
            prisma.testVerdict.findMany({
              where: { bugId: id },
              orderBy: { createdAt: "asc" },
              select: {
                id: true,
                createdAt: true,
                goodToMerge: true,
                agent: { select: { name: true } },
                onBehalfOf: { select: { name: true } },
              },
            }),
            // #review-entries: a manager agent's accept or reject (#1429) is its merge review.
            prisma.mergeReview.findMany({
              where: { bugId: id },
              orderBy: { createdAt: "asc" },
              select: { id: true, createdAt: true, verdict: true, summary: true, agent: { select: { name: true } } },
            }),
            // #1446: the merger agent's merge and its failed deployments are actions, in the audit log.
            prisma.agentAuditEvent.findMany({
              where: { bugId: id, action: { in: ["issue.accepted", "github.merge_failed"] } },
              orderBy: { createdAt: "asc" },
              select: {
                id: true,
                createdAt: true,
                action: true,
                agent: { select: { name: true, activations: activeLevels } },
                payload: true,
              },
            }),
          ]);

          const mergerDecisions: AgentDecision[] = [
            ...reviews.map<AgentDecision>((r) =>
              r.verdict === "reject"
                ? { id: `merge-review-${r.id}`, at: r.createdAt, kind: "merge_rejected", agentName: r.agent.name, notes: r.summary }
                : { id: `merge-review-${r.id}`, at: r.createdAt, kind: "accepted", agentName: r.agent.name },
            ),
            ...accepted
              .filter((e) => e.action === "github.merge_failed" || payloadMerged(e.payload))
              .map<AgentDecision>((e) =>
                e.action === "github.merge_failed"
                  ? {
                      id: `deploy-failed-${e.id}`,
                      at: e.createdAt,
                      kind: "deploy_failed",
                      agentName: e.agent.name,
                      reason: payloadReason(e.payload),
                    }
                  : { id: `accepted-${e.id}`, at: e.createdAt, kind: "accepted", agentName: e.agent.name, merged: true },
              ),
          ];

          const otherDecisions: AgentDecision[] = [
            // A person's own entry names them; an agent's names the agent, for its owner.
            ...confirmations.map<AgentDecision>((v) =>
              v.verdict === "reject"
                ? {
                    id: `confirmation-${v.id}`,
                    at: v.updatedAt,
                    kind: "rejected",
                    agentName: v.agent?.name ?? v.onBehalfOf.name,
                    personName: v.agent ? v.onBehalfOf.name : "",
                    notes: v.summary,
                  }
                : {
                    id: `confirmation-${v.id}`,
                    at: v.updatedAt,
                    kind: "confirmed",
                    agentName: v.agent?.name ?? v.onBehalfOf.name,
                    personName: v.agent ? v.onBehalfOf.name : "",
                  },
            ),
            ...claims.flatMap<AgentDecision>((c) => {
              const kind = claimDecisionKind(c);
              if (kind === "claim_released") {
                return [
                  {
                    id: `claim-${c.id}`,
                    at: c.releasedAt ?? c.createdAt,
                    kind,
                    agentName: c.agent.name,
                    personName: c.beneficiary.name,
                  },
                ];
              }
              if (kind !== "claimed") return [];
              const active = c.status === "active";
              return [
                {
                  id: `claim-${c.id}`,
                  at: c.createdAt,
                  kind,
                  agentName: c.agent.name,
                  personName: c.beneficiary.name,
                  deliverBy: bug.pullRequestUrl || !active ? null : c.deliverBy,
                  extendedAt: c.extendedAt,
                  waitingOnName: active && c.waitingOnOwnerSince ? c.agent.owner.name : null,
                },
              ];
            }),
            ...deliveries.map<AgentDecision>((d) => ({
              id: `delivery-${d.id}`,
              at: d.updatedAt,
              kind: "delivered",
              agentName: d.agent.name,
              personName: d.beneficiary.name ?? "A member",
            })),
            ...verdicts.map<AgentDecision>((v) => ({
              id: `verdict-${v.id}`,
              at: v.createdAt,
              kind: "verdict",
              agentName: v.agent.name,
              personName: v.onBehalfOf.name,
              goodToMerge: v.goodToMerge,
            })),
          ].sort((a, b) => {
            const at = new Date(a.at).getTime() - new Date(b.at).getTime();
            if (at !== 0) return at;
            return a.id.localeCompare(b.id);
          });

          // #1446: merger decisions sit with the rest, counted by stage.
          return [...otherDecisions, ...mergerDecisions];
        },
      ),
      loadOptional<TicketEscalation[]>("escalations", [], () =>
        organisationId ? listBugEscalations(id, organisationId) : Promise.resolve([]),
      ),
    ]);
  // Anyone who owns an agent in the organisation can award, through it, an open bid whose votes reached the threshold (#award-bids).
  const canAwardBids =
    (bug.substatus === "open" || bug.substatus === "requires_confirmation") && !bug.isDeleted
      ? await loadOptional("award permission", false, async () => Boolean(await awardingAgentOf(user.id, bug.organisationId)))
      : false;
  // One-click bid: while the issue takes bids, nobody is working on it, and you have no open bid on it,
  // the Bids step shows a Bid button with your agents to choose from.
  const bidAgents =
    (bug.substatus === "open" || bug.substatus === "requires_confirmation") && !bug.isDeleted
      ? await loadOptional("bid agents", [] as { id: string; name: string }[], async () => {
          const [workedOn, myOpenBid] = await Promise.all([
            prisma.issueClaim.count({ where: { bugId: bug.id, releasedAt: null, status: "active" } }),
            prisma.issueBid.count({ where: { bugId: bug.id, beneficiaryUserId: user.id, withdrawnAt: null, awardedAt: null } }),
          ]);
          if (workedOn > 0 || myOpenBid > 0) return [];
          return prisma.agent.findMany({
            where: { ...activeIn(bug.organisationId), ownerUserId: user.id, revokedAt: null },
            orderBy: { name: "asc" },
            select: { id: true, name: true },
          });
        })
      : [];
  // #603: the organisation's active agents, offered in the comment @mention list
  // as "Mark's Claude · Mark Essien" alongside people.
  const mentionAgents = canTriage
    ? await loadOptional("mention agents", [], () =>
        prisma.agent.findMany({
          where: { ...activeIn(bug.organisationId), revokedAt: null },
          orderBy: { name: "asc" },
          select: { id: true, name: true, owner: { select: { name: true } } },
        }),
      )
    : [];
  const commentMentionUsers = [
    ...users,
    ...mentionAgents.map((agent) => ({
      id: agentMentionId(agent.id),
      name: agent.name,
      agentOwner: agent.owner.name,
    })),
  ];
  const issueAttachments: AttachmentView[] = attachments.filter((a) => !a.commentId);
  const attachmentsByComment: Record<string, AttachmentView[]> = {};
  for (const a of attachments) {
    if (a.commentId) (attachmentsByComment[a.commentId] ??= []).push(a);
  }

  // #idea-table: the idea this issue was converted from.
  const sourceIdea = bug.idea;
  // #rewards: what solving it pays, and every estimate behind it (planning poker).
  const [rewardRow, rewardEstimates] = await Promise.all([
    prisma.bug.findUnique({ where: { id: bug.id }, select: { reward: true, rewardFixedAt: true } }),
    loadOptional<Awaited<ReturnType<typeof rewardEstimatesFor>>>("reward estimates", [], () => rewardEstimatesFor(bug.id)),
  ]);
  const confirmationsData = await loadOptional<(ConfirmationsData & { confirmed?: boolean }) | null>("confirmations", null, () =>
    // #confirmation-files: other confirmers' files show once the viewer has confirmed (admins always).
    listConfirmations({ organisationId: bug.organisationId, projectId: bug.projectId }, bug.id, { userId: user.id, admin: canChooseRedesign }),
  );
  // #issue-confirmations: at Requires confirmation the issue takes confirmation
  // entries, and so does one whose work started before it was confirmed, until
  // it is (`takesConfirmations`); afterwards they stay, read-only, under the comments.
  const confirming = !bug.isDeleted && takesConfirmations(bug.substatus, confirmationsData?.confirmed ?? pastConfirmation);
  // Anyone may confirm their own issue (#confirmation-weights): it counts 1.
  const confirmationBlock: ConfirmationBlock = null;
  const activeSupportThread =
    isOrgMember && !bug.isDeleted && (ASKABLE_STATUSES as readonly string[]).includes(bug.status)
      ? await prisma.supportThread.findFirst({
          where: {
            bugId: bug.id,
            requesterUserId: user.id,
            status: { in: ["open", "taken"] },
          },
          select: { id: true },
        })
      : null;
  // #close-reasons: the issue's owner may withdraw it while it is not closed or live.
  const canWithdraw = !bug.isDeleted && bug.status !== "closed" && bug.status !== "resolved" && ownsIssue(bug, user.id);
  const isAssignee = !!userId && bug.assigneeId === userId;
  // An Open issue that nothing holds (no active claim, no live offer; `hold`
  // is currentHold) has no assignee to show: that one is stale (#stale-assignee).
  const assignee = shownAssignee(bug.status, bug.assignee, Boolean(hold));
  const canUpdateStatus = canTriage || isAssignee;
  const canEdit =
    canEditTicket({
      actorId: userId,
      actorRole: user.role,
      membershipRole: access.membershipRole,
      reporterId: bug.reporterId,
    }) && !bug.isDeleted;
  const canSelfAssign =
    !bug.isDeleted &&
    canAssignTicket({
      actorId: userId,
      actorRole: user.role,
      membershipRole: access.membershipRole,
      currentAssigneeId: bug.assigneeId,
      targetAssigneeId: isAssignee ? null : userId,
    });
  const userVote =
    Array.isArray(bug.votes) && bug.votes.length > 0
      ? voteDirection(bug.votes[0].value ?? 1)
      : 0;
  // Repaired old pull request links (#pr-link-repair), shown beside the links.
  const linkRepairs = await loadOptional("link repairs", [] as { originalUrl: string; canonicalUrl: string | null; inaccessible: boolean; agentName: string }[], () =>
    prisma.pullRequestLinkRepair.findMany({
      where: { bugId: bug.id },
      select: { originalUrl: true, canonicalUrl: true, inaccessible: true, agentName: true },
    }),
  );
  // Most important (most upvoted) threads first.
  const commentTree = byImportance(buildCommentTree(comments.comments));
  // #729: who marked the issue important, so an agent's comment can say its owner did.
  const importanceMarkers = await loadOptional<string[]>("importance marks", [], async () =>
    (await prisma.vote.findMany({ where: { bugId: bug.id, value: { gt: 0 } }, select: { userId: true } })).map((vote) => vote.userId),
  );
  // #1446: the stage the page opens on, and what each stage holds.
  const currentStage = currentDecisionStage({ substatus: bug.substatus });
  // Sent back: the latest manager decision on the fix was a reject.
  const latestMergeDecision = agentDecisions
    .filter((d) => d.kind === "accepted" || d.kind === "merge_rejected")
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
    .at(-1);
  const sentBack = latestMergeDecision?.kind === "merge_rejected";
  // #delivered-step: In progress takes the delivery, Delivered the judgements,
  // Done (and Ready to merge) the merge reviews; not comments.
  const reviewBug = { id: bug.id, pullRequestUrl: bug.pullRequestUrl ?? null, pullRequestHeadSha: bug.pullRequestHeadSha ?? null };
  // Agents judge delivered work, and may change a judgement until a manager accepts it.
  const testing = !bug.isDeleted && (currentStage === "delivered" || currentStage === "done");
  // Managers review judged work (Done) and accepted work (Ready to merge).
  const mergeReviewing = !bug.isDeleted && (currentStage === "done" || currentStage === "ready");
  // Deliveries take replies while the work is being made or judged; they fold once it is past Delivered.
  const delivering = currentStage === "progress" || currentStage === "delivered";
  // Taken at their own stage; read-only afterwards.
  const [deliveryList, testVerdictList, mergeReviewList] = pastConfirmation
    ? await Promise.all([
        loadOptional<DeliveryView[]>("deliveries", [], () => deliveryEntries(reviewBug)),
        loadOptional<TestVerdictView[]>("test verdicts", [], () => testVerdictEntries(reviewBug, { userId: user.id, admin: canChooseRedesign })),
        loadOptional<MergeReviewView[]>("merge reviews", [], () => mergeReviewEntries(reviewBug)),
      ])
    : [[] as DeliveryView[], [] as TestVerdictView[], [] as MergeReviewView[]];
  // The latest delivery as a banner at the top (#delivered-banner): green while
  // the work is judged, merged or live; amber, with why, once it was sent back.
  const latestDelivery = [...deliveryList].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0] ?? null;
  let deliveredBanner: DeliveredBannerProps | null = null;
  if (latestDelivery) {
    const deliveredAt = new Date(latestDelivery.updatedAt).getTime();
    const stillDelivered = ["done", "merge", "resolved"].includes(bug.status);
    let sentBack: DeliveredBannerProps["sentBack"] = null;
    if (!stillDelivered && bug.status !== "closed") {
      const rejected = mergeReviewList
        .filter((review) => review.verdict === "reject" && new Date(review.updatedAt).getTime() >= deliveredAt)
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0];
      const notGood = testVerdictList.filter((verdict) => !verdict.goodToMerge && new Date(verdict.updatedAt).getTime() >= deliveredAt);
      // #github-status: someone sent it back from the GitHub panel.
      const githubSendBack = activities.find((a) => {
        const meta = a.metadata as Record<string, unknown> | null;
        return meta?.via === "github_send_back" && new Date(a.createdAt).getTime() >= deliveredAt;
      });
      const githubNote = (githubSendBack?.metadata as { note?: unknown } | null)?.note;
      const githubReason = typeof githubNote === "string" ? githubNote.split("\n").find((line) => line.trim())?.trim() ?? null : null;
      sentBack = githubSendBack && (!rejected || new Date(githubSendBack.createdAt) >= new Date(rejected.updatedAt))
        ? { reason: `Sent back from the GitHub status: ${githubReason ?? "GitHub can't merge it yet."}`, at: githubSendBack.createdAt }
        : rejected
        ? { reason: `${rejected.agentName} for ${rejected.by} rejected it for merging: ${rejected.summary}`, at: rejected.updatedAt }
        : notGood.length > 0
          ? { reason: `${notGood.length} ${notGood.length === 1 ? "judgement says" : "judgements say"} it is not good to merge.`, at: notGood[0].updatedAt }
          : { reason: "The claim on it ended, so the issue is open for bids again.", at: null };
    }
    deliveredBanner = {
      agentName: latestDelivery.agentName,
      by: latestDelivery.by,
      summary: latestDelivery.summary,
      pullRequestUrl: latestDelivery.pullRequestUrl,
      deliveredAt: latestDelivery.updatedAt,
      sentBack,
    };
  }
  // #github-status: the pull request as GitHub sees it, from In progress until it is Live.
  let githubPanel: GitHubStatusPanelProps | null = null;
  if (bug.pullRequestUrl && !bug.isDeleted && ["in_progress", "done", "merge"].includes(bug.status)) {
    const pullRequestUrl = bug.pullRequestUrl;
    const [githubStatus, myAgents, latestReport] = await Promise.all([
      loadOptional("GitHub status", null, () => storedGitHubStatus({ id: bug.id, pullRequestUrl })),
      loadOptional("agent levels", [] as { level: "working" | "manager" | "merger" }[], () =>
        prisma.agent
          .findMany({ where: { ...activeIn(bug.organisationId), ownerUserId: user.id, revokedAt: null }, select: { activations: activeLevels } })
          .then((rows) => rows.map((row) => ({ level: levelIn(row, bug.organisationId) }))),
      ),
      loadOptional("latest pull request report", null, () =>
        prisma.pullRequestReport.findFirst({
          where: { bugId: bug.id, pullRequestUrl },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: { source: true, note: true, createdAt: true, agent: { select: { name: true } } },
        }),
      ),
    ]);
    githubPanel = {
      bugId: bug.id,
      pullRequestUrl,
      issueStatus: bug.status,
      status: githubStatus
        ? { snapshot: githubStatus.snapshot, diagnosis: githubStatus.diagnosis, checkedAt: githubStatus.checkedAt.toISOString() }
        : null,
      powers: githubStatusPowers({
        member: Boolean(access.membershipRole),
        admin: access.admin,
        ownsIssue: bug.reporterId === user.id || bug.beneficiaryUserId === user.id,
        agentLevels: myAgents.map((agent) => agent.level),
      }),
      newerAgentReport:
        latestReport?.source === "agent" && latestReport.agent && (!githubStatus || latestReport.createdAt > githubStatus.checkedAt)
          ? { agentName: latestReport.agent.name, note: latestReport.note, at: latestReport.createdAt.toISOString() }
          : null,
    };
  }

  // Comments on the issue itself, at every stage (lib/comment-placement.ts).
  const takesComments = !bug.isDeleted && canContribute;
  // Looked up here, not on `hold`: holder is also what agents read through the API.
  const workingAgent = hold?.status === "active"
    ? await loadOptional("working agent", null, () => prisma.agent.findFirst({
        where: { ...activeIn(bug.organisationId), claims: { some: { bugId: bug.id, status: "active", releasedAt: null } } },
        select: { id: true, ownerUserId: true, revokedAt: true, pausedAt: true },
      }))
    : null;
  // Owner-only: steering, and what the agent answered.
  const steeringAgent = workingAgent && workingAgent.ownerUserId === user.id && !workingAgent.revokedAt ? workingAgent : null;
  const steerNotes = steeringAgent
    ? await loadOptional("steer notes", [], () => prisma.agentInboxItem.findMany({
        where: { agentId: steeringAgent.id, bugId: bug.id, eventType: "agent.steer" },
        orderBy: { createdAt: "desc" },
        take: 10,
        select: { id: true, payload: true },
      }))
    : [];
  const commentCount = comments.shownThreads + comments.hiddenThreads;
  // #489: the Admin label follows each person's role in this issue's
  // organisation, not their account-wide role, the same rule as admin powers.
  const namedUserIds = [
    ...new Set(
      [bug.reporterId, bug.assigneeId, ...comments.comments.map((c) => c.authorId)].filter(
        (id): id is string => Boolean(id),
      ),
    ),
  ];
  const organisationRoleRows = await loadOptional<{ userId: string; role: OrganisationRole }[]>(
    "organisation roles",
    [],
    () =>
      prisma.membership.findMany({
        where: { organisationId: bug.organisationId, userId: { in: namedUserIds } },
        select: { userId: true, role: true },
      }),
  );
  const organisationRoles: Record<string, OrganisationRole> = Object.fromEntries(
    organisationRoleRows.map((row) => [row.userId, row.role]),
  );
  const pageQuery = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === "string") pageQuery.set(key, value);
  }
  const proofLinks = bug.proofLinks ?? [];
  const hasLinkedPullRequest = Boolean(bug.pullRequestUrl || proofLinks.some((link) => parsePullRequestUrl(link)));
  const isDeliverer = Boolean(userId && deliveryList.some((d) => d.beneficiaryUserId === userId || d.by === user.name));
  const isHolder = Boolean(userId && hold && hold.personName === user.name);
  const canEditPullRequest =
    !bug.isDeleted &&
    bug.status !== "resolved" &&
    bug.status !== "closed" &&
    hasLinkedPullRequest &&
    (isAssignee || isHolder || isDeliverer || canEdit);
  const prActivity = activities.find((a) => {
    const meta = a.metadata as Record<string, unknown> | null;
    return meta && (meta.screenshots || meta.testResults || meta.field === "pullRequestUrl");
  });
  const prMeta = prActivity?.metadata as Record<string, unknown> | null;
  const submissionScreenshots: string[] = Array.isArray(prMeta?.screenshots)
    ? (prMeta?.screenshots as string[])
    : proofLinks.filter((l) => /\.(png|jpe?g|webp|gif|svg)($|\?)/i.test(l));
  const submissionTestResults = (prMeta?.testResults as string | Record<string, unknown> | null) ?? null;

  const resolution = currentResolution(bug.status, latestStatusChange);
  const agentResolution =
    bug.status === "resolved" && !bug.isDeleted ? readAgentResolution(latestStatusChange?.metadata) : null;

    let queuePosition: number | null = null;
  let totalInQueue = 0;
  let estimatedWaitMinutes: number | null = null;
  let mergerAgentName: string | null = null;
  let precedingPrNumber: number | null = null;
  let queueLocked = false;
  let ciPassed = true;
  let verdictsPassed = true;
  let rebaseClean = true;
  if (currentStage === "ready") {
    const [readyBugs, mergerAgent] = await Promise.all([
      prisma.bug.findMany({ where: { projectId: bug.projectId, substatus: { in: ["ready_to_merge", "error"] }, isDeleted: false }, orderBy: { updatedAt: "asc" }, select: { id: true, number: true, pullRequestUrl: true } }),
      prisma.agent.findFirst({ where: { ...activeIn(bug.organisationId), revokedAt: null }, select: { name: true } }),
    ]);
    totalInQueue = readyBugs.length;
    const qIdx = readyBugs.findIndex((b) => b.id === bug.id);
    if (qIdx !== -1) {
      queuePosition = qIdx + 1;
      estimatedWaitMinutes = qIdx * 3;
      if (qIdx > 0) { precedingPrNumber = readyBugs[qIdx - 1].number; queueLocked = true; }
    } else { queuePosition = 1; totalInQueue = Math.max(1, totalInQueue); estimatedWaitMinutes = 0; }
    mergerAgentName = mergerAgent?.name ?? null;
    verdictsPassed = testVerdictList.filter((v) => v.goodToMerge).length >= 3;
    ciPassed = bug.substatus !== "error";
    rebaseClean = bug.substatus !== "error";
  }
  // "Dispute award", for the issue's reporter and assignee: its own button now
  // that issues take no free-standing comments (#entry-replies-only).
  const disputeRoles: DisputeRole[] = bug.isDeleted
    ? []
    : [
        ...(userId && bug.assigneeId === userId ? (["solver"] as const) : []),
        ...(userId && bug.reporterId === userId ? (["reporter"] as const) : []),
      ];

  // Less common actions sit behind one icon at the top right: Mark as
  // duplicate and Delete. "Assign to me" lives in the People panel.
  const canMarkDuplicate = canTriage && !bug.isDeleted && !bug.duplicateOf;
  const canDeleteHere = canDelete && !bug.isDeleted;

  // What a delete keeps, shown the same way in every delete/restore message (#692).
  const keptCounts = deletionCounts(comments.visibleCount, voterSummary);

  // The next step, always shown under the progress report (#next-step).
  const workflow = await workflowFor(bug.projectId);
  const { verdictsNeeded } = workflow;
  // Threshold-only (#vote-governance): the bar says which vote decides the step, and how far it has got.
  const thresholdOnly = isThresholdOnly(workflow);
  // The open bids' weighted votes (bidHistoryEntries weighs them): the next step names the most voted.
  const topBidVotes = !bug.isDeleted && bug.substatus === "open"
    ? Math.max(0, ...bidList.filter(isOpenBid).map((bid) => bid.votes ?? 0))
    : 0;
  const mergeReviewVotesNow = thresholdOnly && !bug.isDeleted && bug.substatus === "accepted"
    ? await loadOptional("merge review votes", null, () => mergeReviewVotes(prisma, reviewBug, workflow.managerVoteWeight))
    : null;
  const stale = bug.isDeleted ? null : (await loadOptional("stale hold", null, () => staleHold(bug.id)))?.kind ?? null;
  // #pr-checks: the checks on the linked pull request, from the latest
  // independent report, and why an agent should look again when it is stale.
  // A load that fails says so rather than reading as a pass.
  type IssuePrChecks = { report: PullRequestStateView | null; refreshHint: string | null; failed: boolean };
  const prChecks: IssuePrChecks | null = bug.isDeleted || !bug.pullRequestUrl
    ? null
    : await loadOptional<IssuePrChecks>(
        "pull request checks",
        { report: null, refreshHint: null, failed: true },
        async () => {
          const report = await latestPullRequestReport(bug.id, bug.pullRequestUrl);
          const project = await prisma.project.findUnique({ where: { id: bug.projectId }, select: { repoUrl: true } });
          const gate = prGate(gateReport(report), {
            pullRequestUrl: bug.pullRequestUrl,
            pullRequestHeadSha: bug.pullRequestHeadSha ?? null,
            repo: parseGitHubRepoUrl(project?.repoUrl),
          });
          return { report: pullRequestStateView(report), refreshHint: reportWanted(gate, report), failed: false };
        },
      );
  const abandonCheck = bug.isDeleted || bug.status !== "in_progress" ? null : await loadOptional("sense check", null, () => senseCheck(bug.id));
  const closeSuggestions = await loadOptional<CloseSuggestionsData | null>("close suggestions", null, () => closeSuggestionsFor(bug.id));
  // A decision other members made about the viewer's own issue (#your-decisions).
  const yourDecision = closeSuggestions
    ? decisionFor({
        issue: bug,
        viewerId: user.id,
        suggestions: closeSuggestions.entries,
        threshold: closeSuggestions.threshold,
        decidedAt: bug.closedAt,
      })
    : null;
  // The judgements as the Delivered rule counts them (independent, weighted, on
  // the delivered pull request), so the bar says what will actually move it.
  const judgementCount = bug.status === "done" && !bug.isDeleted
    ? await loadOptional("judgement count", null, () => countedJudgements(prisma, bug.id))
    : null;
  // #merge-checklist: while delivered work is judged, reviewed or waiting to
  // merge, the checks before "good to merge", from the latest pull request report.
  const checklist = !bug.isDeleted && (bug.status === "done" || bug.status === "merge") && bug.pullRequestUrl
    ? await loadOptional("merge checklist", null, async () => {
        const [report, project] = await Promise.all([
          latestPullRequestReport(bug.id, bug.pullRequestUrl),
          prisma.project.findUnique({ where: { id: bug.projectId }, select: { repoUrl: true } }),
        ]);
        return mergeChecklist(report, {
          pullRequestUrl: bug.pullRequestUrl ?? null,
          pullRequestHeadSha: bug.pullRequestHeadSha ?? null,
          repo: parseGitHubRepoUrl(project?.repoUrl),
        });
      })
    : null;
  // #live-check: on a Live issue, where its fix really is, from the latest
  // independent check of its pull request rather than the Live label.
  const liveFix = bug.status === "resolved" && !bug.isDeleted
    ? await loadOptional("live check", null, async () => {
        const [report, project, confirmers, moves] = await Promise.all([
          latestPullRequestReport(bug.id, bug.pullRequestUrl),
          prisma.project.findUnique({ where: { id: bug.projectId }, select: { repoUrl: true, ...PROJECT_REPOSITORIES_SELECT } }),
          loadProdConfirmers([bug.id]),
          prisma.bugActivity.findMany({ where: { bugId: bug.id, type: "status_changed" }, orderBy: { createdAt: "asc" }, select: { createdAt: true, metadata: true } }),
        ]);
        const repo = repoForPullRequest(project, bug.pullRequestUrl);
        // #live-confirm: when it last moved to each Live status, for the flow in the Status box.
        const reachedAt: Partial<Record<"on_dev" | "on_staging" | "on_prod", Date>> = {};
        for (const move of moves) {
          const to = (move.metadata as { to?: unknown } | null)?.to;
          if (to === "on_dev" || to === "on_staging" || to === "on_prod") reachedAt[to] = move.createdAt;
        }
        return { check: liveCheck(bug.pullRequestUrl ?? null, report, repo, confirmers.get(bug.id) ?? []), repo, reachedAt };
      })
    : null;
  const nextStep = issueNextStep({
    status: bug.status,
    substatus: bug.substatus,
    isDeleted: bug.isDeleted,
    confirmations: confirmationsData?.confirmations ?? 0,
    confirmationsNeeded: confirmationsData?.confirmationsNeeded ?? 0,
    holder: hold ? { agentName: hold.agentName, personName: hold.personName, status: hold.status, offeredAt: hold.offeredAt } : null,
    plan: planReviewing ? { submitted: Boolean(planCard), decision: planCard?.decision ?? null, round: planCard?.round ?? 0, reviewBy: planCard?.reviewBy ?? null } : null,
    openBids: bidList.filter(isOpenBid).length,
    goodToMerge: judgementCount?.good ?? testVerdictList.filter((verdict) => verdict.goodToMerge).length,
    verdictsNeeded: judgementCount?.needed ?? verdictsNeeded,
    stale,
    senseCheck: abandonCheck,
    closeSuggested: closeSuggestions && closeSuggestions.tallies[0]
      ? { ...closeSuggestions.tallies[0], threshold: closeSuggestions.threshold }
      : null,
    closeReason: bug.closeReason,
    governance: {
      thresholdOnly,
      managerVoteWeight: workflow.managerVoteWeight,
      awardThreshold: workflow.awardThreshold,
      acceptThreshold: workflow.acceptThreshold,
    },
    topBidVotes,
    mergeReviews: mergeReviewVotesNow,
  });
  // A brief to paste into an agent so it can act on this step (#agent-instructions).
  const agentInstructions = agentInstructionsFor({
    issueId: bug.id,
    number: bug.number,
    title: bug.title,
    projectId: bug.projectId,
    projectSlug: bug.project.slug,
    substatus: bug.substatus,
    path: issueHref(bug),
    pullRequestUrl: bug.pullRequestUrl ?? null,
    step: nextStep,
  });

  // The flags under the status chip in the side rail (#close-reasons): why it was
  // closed, or the leading reason agents suggest closing it for.
  const leadingClose = closeSuggestions?.tallies[0] ?? null;
  const statusFlags: { label: string; tone: StatusFlagTone; title?: string }[] = bug.isDeleted
    ? []
    : [
        ...(bug.status === "closed" && closeReasonLabel(bug.closeReason)
          ? [{ label: closedLabel(bug.closeReason), tone: "bad" as const, title: bug.closeEvidence ?? undefined }]
          : leadingClose && leadingClose.votes > 0 && bug.status !== "closed" && bug.status !== "resolved"
            ? [{ label: `Close suggested: ${closeReasonLabel(leadingClose.reason) ?? leadingClose.reason} (${leadingClose.votes} of ${closeSuggestions!.threshold})`, tone: "bad" as const }]
            : []),
        ...(abandonCheck ? [{ label: `Abandon votes: ${abandonCheck.votes} of ${abandonCheck.threshold}`, tone: "warn" as const }] : []),
        ...(stale ? [{ label: STALE_FLAG[stale], tone: "bad" as const }] : []),
      ];

  // The timeline reads newest first (#issue-timeline); each step is dated by when it started, its first entry.
  const newestFirst = <T extends { updatedAt: Date | string }>(list: T[]) =>
    [...list].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  const firstAt = (list: { updatedAt: Date | string }[]) => newestFirst(list).at(-1)?.updatedAt ?? null;
  const timelineDeliveries = newestFirst(deliveryList);
  const timelineVerdicts = newestFirst(testVerdictList);
  const timelineReviews = newestFirst(mergeReviewList);

  // The Conversation card shows only when it has entries in it: no empty boxes.
  // Its Dispute award button alone is not enough (nothing to dispute before an award).
  const conversationHasContent =
    Boolean(sourceIdea) ||
    Boolean(awardClaim) ||
    confirming ||
    deliveryList.length > 0 ||
    testing ||
    testVerdictList.length > 0 ||
    mergeReviewing ||
    mergeReviewList.length > 0 ||
    bidList.length > 0 ||
    pastConfirmation;

  // The confirmations, the timeline's second step (#issue-timeline): open while
  // they decide the issue, folded (as history) once it is past them.
  const confirmationsCard =
    confirmationsData && (confirming || (pastConfirmation && confirmationsData.entries.length > 0)) ? (
      <div className="[&>*]:mb-0">
        <IssueConfirmationsPanel
          bugId={bug.id}
          data={confirmationsData}
          viewerId={user.id}
          block={confirming ? confirmationBlock : null}
          summaryMaxChars={CONFIRMATION_SUMMARY_MAX_CHARS}
          history={!confirming}
          confirmed={!confirming}
          at={confirmationsData.entries.length ? firstAt(confirmationsData.entries) : null}
        />
      </div>
    ) : null;

  // The Activity panel: the issue's activity rows and its step entries (confirmations, bids,
  // awards, deliveries, judgements, merge reviews), newest first, from the data loaded above.
  const stepActivities = issueStepActivities({
    confirmations: confirmationsData?.entries ?? [],
    bids: bidList,
    claims: claimHistory,
    deliveries: deliveryList,
    testVerdicts: testVerdictList,
    mergeReviews: mergeReviewList,
  });
  // When older activity rows aren't loaded, a step entry from before the oldest loaded row
  // would show out of place; it still counts in the heading, with the rows not loaded.
  const oldestLoadedActivity = activities.length < activityCount ? activities.at(-1)?.createdAt : undefined;
  const shownActivities: ActivityEntry[] = [
    ...activities,
    ...stepActivities.filter((entry) => !oldestLoadedActivity || entry.createdAt.getTime() >= new Date(oldestLoadedActivity).getTime()),
  ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() || b.id.localeCompare(a.id));

  if (bug.track === "marketing") {
    const marketingDeliveries = (
      await prisma.delivery.findMany({
        where: { bugId: bug.id },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        select: {
          id: true,
          agentId: true,
          beneficiaryUserId: true,
          summary: true,
          description: true,
          deliverableText: true,
          deliverableUrls: true,
          screenshots: true,
          testResults: true,
          updatedAt: true,
          agent: { select: { name: true } },
          beneficiary: { select: { name: true } },
          replies: entryReplySelect,
        },
      })
    ).map(({ agent, beneficiary, replies, ...row }) => ({
      ...row,
      agentName: agent.name,
      by: beneficiary.name ?? "A member",
      current: true,
      replies: toEntryReplies(replies),
    }));

    const marketingReviews = testVerdictList.map((verdict) => ({
      id: verdict.id,
      goodToMerge: verdict.goodToMerge,
      summary: verdict.summary,
      description: verdict.description,
      agentName: verdict.agentName,
      by: verdict.by,
      updatedAt: verdict.updatedAt,
      replies: verdict.replies ?? [],
    }));

    if (marketingDeliveries.length > 0) {
      const latestMarketingDelivery = marketingDeliveries[0];
      const deliveredAt = new Date(latestMarketingDelivery.updatedAt).getTime();
      const stillDelivered = ["done", "merge", "resolved"].includes(bug.status);
      let sentBack: DeliveredBannerProps["sentBack"] = null;
      if (!stillDelivered && bug.status !== "closed") {
        const notGood = testVerdictList.filter(
          (verdict) => !verdict.goodToMerge && new Date(verdict.updatedAt).getTime() >= deliveredAt,
        );
        sentBack = notGood.length > 0
          ? {
              reason: `${notGood.length} ${notGood.length === 1 ? "review says" : "reviews say"} revisions are needed.`,
              at: notGood[0].updatedAt,
            }
          : { reason: "The claim on it ended, so the task is open for bids again.", at: null };
      }
      deliveredBanner = {
        agentName: latestMarketingDelivery.agentName,
        by: latestMarketingDelivery.by,
        summary: latestMarketingDelivery.summary,
        deliverableUrls: latestMarketingDelivery.deliverableUrls,
        hasDeliverableText: Boolean(latestMarketingDelivery.deliverableText),
        pullRequestUrl: null,
        deliveredAt: latestMarketingDelivery.updatedAt,
        sentBack,
      };
    }

    const marketingNextStep = {
      ...nextStep,
      detail: nextStep.detail ? nextStep.detail.replace(/\bissue\b/gi, "task") : null,
      action: nextStep.action
        ? nextStep.action.replace(/\bfixing it\b/gi, "executing it").replace(/\bissue\b/gi, "task")
        : null,
    };

    // The brief's focus, when it has one (M-API-8); otherwise the project's own.
    const marketingBrief = await prisma.projectBrief.findUnique({
      where: { projectId: bug.projectId },
      select: { currentFocus: true },
    });
    const marketingFocus = marketingBrief?.currentFocus ?? bug.project.goal;
    const marketingSite = bug.project.siteUrl;

    return (
      <>
      <MarketingAreaMarker />
      <MarketingTaskDetail
        bug={{
          id: bug.id,
          number: bug.number,
          title: bug.title,
          description: bug.description,
          status: bug.status,
          substatus: bug.substatus,
          reward: bug.reward ? Number(bug.reward) : null,
          revisionCount: bug.revisionCount,
          createdAt: bug.createdAt,
          type: bug.type,
          reporter: bug.reporter,
          createdByAgent: bug.createdByAgent,
          project: {
            slug: refOf(bug.project),
            name: bug.project.name,
            goal: marketingFocus,
            siteUrl: marketingSite,
          },
          idea: bug.idea
            ? {
                id: bug.idea.id,
                number: bug.idea.number,
                rationale: bug.idea.rationale,
              }
            : null,
        }}
        revisionLimit={workflow.revisionLimit}
        hold={hold}
        agentPaused={Boolean(workingAgent?.pausedAt)}
        isWatching={isWatchingIssue}
        isIssueOwner={bug.reporterId === user.id}
        deliveries={marketingDeliveries}
        reviews={marketingReviews}
        bannerSlot={deliveredBanner ? <DeliveredBanner {...deliveredBanner} /> : null}
        nextStepSlot={<NextStepBar step={marketingNextStep} agentInstructions={agentInstructions} />}
        mergeReviewsSlot={
          timelineReviews.length > 0 || mergeReviewing ? (
            <MergeReviewsPanel
              at={firstAt(timelineReviews)}
              bugId={bug.id}
              reviews={timelineReviews}
              canReply={mergeReviewing}
              history={!mergeReviewing}
            />
          ) : null
        }
        disputeSlot={
          disputeRoles.length > 0 ? (
            <DisputeAwardDialog bugNumber={bug.number} roles={disputeRoles} />
          ) : null
        }
        escalationsSlot={<IssueEscalations escalations={escalations} />}
        descriptionSlot={
          <div className="flex flex-col gap-5">
            {marketingFocus ? (
              <div className="flex items-start gap-3 rounded-xl border border-zk-info-fg/30 bg-zk-info-bg/40 p-3.5 text-sm text-zk-text">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-zk-info-fg text-white">
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="10" />
                    <path d="m12 8 4 4-4 4M8 12h8" />
                  </svg>
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-bold uppercase tracking-wider text-[11px] text-zk-info-fg">
                      {bug.project.name ? `${bug.project.name} Focus` : "Campaign Focus"}
                    </span>
                    {marketingSite ? (
                      <a
                        href={marketingSite}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-xs font-semibold text-zk-accent hover:underline"
                      >
                        Visit Site <span aria-hidden="true">↗</span>
                      </a>
                    ) : null}
                  </div>
                  <p className="mt-1 font-medium leading-relaxed">{marketingFocus}</p>
                </div>
              </div>
            ) : null}

            {bug.idea?.rationale ? (
              <div className="rounded-xl border border-zk-border bg-zk-surface p-4 text-xs">
                <span className="font-bold uppercase tracking-wider text-[11px] text-zk-muted">
                  Strategic Rationale
                </span>
                <p className="mt-1.5 text-sm leading-relaxed text-zk-text">
                  {bug.idea.rationale}
                </p>
              </div>
            ) : null}

            <EditableIssueDescription
              bugId={bug.id}
              initialTitle={bug.title}
              initialDescription={bug.description}
              summary={bug.summary}
              canEdit={canEdit}
              users={users}
              lastEditedAt={lastRevision?.editedAt ?? null}
              historyHref={issueHref(bug, "/history")}
              tags={
                bug.area ? (
                  <span title="Area" className="inline-flex items-center rounded-full bg-zk-chip px-2.5 py-0.5 text-xs font-semibold text-zk-text2 ring-1 ring-zk-border">
                    {bug.area.name}
                  </span>
                ) : null
              }
            >
              {bug.milestone ? (
                <dl className="mt-4 grid grid-cols-1 gap-3 text-sm text-zk-text2 sm:grid-cols-2">
                  <div>
                    <dt className="font-medium text-zk-muted">Milestone</dt>
                    <dd className="flex flex-wrap items-center gap-2">
                      <Link href={milestoneIssuesHref(refOf(bug.project), bug.milestone.id)} className="font-bold text-zk-accent hover:underline">
                        {bug.milestone.title}
                      </Link>
                      <MilestoneDue due={dueDateValue(bug.milestone.dueDate) || null} isClosed={bug.milestone.isClosed} />
                    </dd>
                  </div>
                </dl>
              ) : null}
            </EditableIssueDescription>
          </div>
        }
        bidsCount={bidList.length}
        commentsCount={commentCount}
        bidsSlot={
          pastConfirmation || bidList.length > 0 || bidAgents.length > 0 ? (
            <IssueBidsPanel
              bidAction={bidAgents.length > 0 ? <BidButton bugId={bug.id} agents={bidAgents} /> : undefined}
              bids={bidList}
              at={firstAt(bidList)}
              collapsed={bug.status !== "open"}
              canAward={canAwardBids}
              awardThreshold={workflow.awardThreshold}
            />
          ) : null
        }
        awardSlot={awardClaim ? <AwardStep award={awardClaim} /> : null}
        commentsSlot={
          takesComments || commentCount > 0 ? (
            <section
              id="comments"
              aria-label="Comments"
              className="scroll-mt-24 rounded-[20px] border border-zk-border bg-zk-surface p-5 sm:p-[22px]"
            >
              <IssueComments
                count={commentCount}
                composer={takesComments ? <CommentComposer bugId={bug.id} /> : null}
                replyBugId={takesComments ? bug.id : undefined}
                reporterId={bug.reporterId}
                comments={commentTree}
                attachmentsByComment={attachmentsByComment}
                organisationRoles={organisationRoles}
                users={commentMentionUsers}
                currentUserId={user.id}
                currentUserRole={user.role}
                organisationAdmin={access.admin}
                readOnly={bug.isDeleted || !canContribute}
                markedImportantBy={importanceMarkers}
              >
                {comments.hiddenThreads > 0 ? (
                  <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-zk-chip px-3 py-2 text-sm text-zk-text2 print:hidden">
                    <span>
                      {comments.hiddenThreads} earlier{" "}
                      {comments.hiddenThreads === 1 ? "thread" : "threads"} not shown.
                    </span>
                    <Link
                      href={earlierThreadsHref(pageQuery, comments.shownThreads)}
                      scroll={false}
                      className="font-bold text-zk-accent hover:underline"
                    >
                      Show {Math.min(comments.hiddenThreads, COMMENT_THREADS_PER_PAGE)} earlier
                    </Link>
                    {comments.hiddenThreads > COMMENT_THREADS_PER_PAGE ? (
                      <Link
                        href={earlierThreadsHref(pageQuery, comments.shownThreads, true)}
                        scroll={false}
                        className="font-bold text-zk-accent hover:underline"
                      >
                        Show all
                      </Link>
                    ) : null}
                  </div>
                ) : null}
              </IssueComments>
              <Suspense fallback={null}>
                <CommentPermalinkResolver />
              </Suspense>
            </section>
          ) : null
        }
        voteButtonSlot={
          <VoteButton
            bugId={bug.id}
            voteCount={bug.voteCount}
            userVote={userVote}
            likeCount={voterSummary.likes.count}
            likeVoters={voterSummary.likes.voters}
            size="md"
            showAvatars={false}
            readOnly={bug.isDeleted || !canContribute}
          />
        }
        actionsMenuSlot={
          canMarkDuplicate || canDeleteHere ? (
            <IssueActionsMenu>
              {canMarkDuplicate ? <MarkDuplicateButton bugId={bug.id} /> : null}
              {canDeleteHere ? (
                <DeleteIssueButton bugId={bug.id} bugTitle={bug.title} counts={keptCounts} variant="danger" size="sm" />
              ) : null}
            </IssueActionsMenu>
          ) : null
        }
        attachmentsSlot={
          issueAttachments.length > 0 ? (
            <section className="rounded-[20px] border border-zk-border bg-zk-surface p-5 sm:p-6">
              <h2 className="text-xs font-bold uppercase tracking-[0.08em] text-zk-muted">
                Attachments
              </h2>
              <AttachmentList attachments={issueAttachments} />
            </section>
          ) : null
        }
        alertsSlot={
          <>
            {bug.isDeleted ? (
              <div className="rounded-[20px] border border-zk-bad-bd bg-zk-bad-bg p-4 sm:p-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h3 className="text-sm font-semibold text-zk-bad-fg">
                      This task was deleted
                    </h3>
                    <p className="text-xs text-zk-bad-fg/90">
                      {deletedSummary(keptCounts)}
                    </p>
                  </div>
                  <RestoreIssueButton
                    bugId={bug.id}
                    bugTitle={bug.title}
                    counts={keptCounts}
                    size="sm"
                  />
                </div>
              </div>
            ) : null}

            {bug.duplicateOf ? (
              <section
                aria-label="Duplicate"
                className="rounded-[20px] border border-zk-warn-bd bg-zk-warn-bg p-4 sm:p-5"
              >
                <h2 className="text-sm font-semibold text-zk-warn-fg">
                  Marked as duplicate of{" "}
                  <Link
                    href={issueHref(bug.duplicateOf)}
                    className="underline hover:text-zk-text"
                  >
                    #{bug.duplicateOf.number} {bug.duplicateOf.title}
                  </Link>
                </h2>
              </section>
            ) : null}

            {resolution ? (
              <section
                aria-label="Resolution note"
                className="rounded-[20px] border border-zk-border bg-zk-ok-bg p-4 sm:p-5"
              >
                <h2 className="text-sm font-semibold text-zk-ok-fg">
                  {resolutionStatusLabel[resolution.status]} by {resolution.by}
                  <span className="ml-2 text-xs font-normal">
                    <LocalTime date={resolution.at} />
                  </span>
                </h2>
                <p className="mt-1 whitespace-pre-wrap break-words text-sm text-zk-text">
                  {resolution.note}
                </p>
              </section>
            ) : null}
          </>
        }
        sideRailSlot={
          <>
            {bug.linkedIssue && !bug.linkedIssue.isDeleted ? (
              <section aria-label="Related product issue" className="flex flex-col gap-2 rounded-[20px] border border-zk-border bg-zk-surface p-5">
                <h2 className="text-xs font-bold uppercase tracking-[0.08em] text-zk-muted">Related product issue</h2>
                <Link href={issuePath(refOf(bug.project), bug.linkedIssue.number)} className="text-sm font-semibold text-zk-accent hover:underline">
                  #{bug.linkedIssue.number} {bug.linkedIssue.title}
                </Link>
              </section>
            ) : null}
            <section aria-label="Status" className="flex flex-col gap-2.5 rounded-[20px] border border-zk-border bg-zk-surface px-4 py-3.5">
              <h2 className="text-xs font-bold uppercase tracking-[0.08em] text-zk-muted">Status</h2>
              <div className="flex flex-wrap items-center gap-1.5 text-xs font-bold">
                {bug.isDeleted ? (
                  <span className={`${issueChipBaseClass} bg-zk-bad-bg text-zk-bad-fg`}>Deleted</span>
                ) : null}
                <Badge className={`${issueChipBaseClass} ${issueStatusChipClass[bug.substatus]}`}>
                  <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
                  {stateLabel(bug.substatus)}
                </Badge>
                {bug.isBoosted && !bug.isDeleted ? (
                  <span className={`${issueChipBaseClass} border border-zk-warn-bd bg-zk-warn-bg text-zk-warn-fg`}>Boosted</span>
                ) : null}
              </div>
              {statusFlags.length > 0 ? (
                <ul data-testid="status-flags" className="m-0 flex list-none flex-col gap-1 p-0">
                  {statusFlags.map((flag) => (
                    <li key={flag.label} className="flex items-center gap-1.5 text-xs text-zk-text2" title={flag.title}>
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${FLAG_DOT[flag.tone]}`} aria-hidden />
                      {flag.label}
                    </li>
                  ))}
                </ul>
              ) : null}
              {bug.status === "closed" && bug.closeEvidence && !bug.isDeleted ? (
                <p data-testid="close-evidence" className="m-0 break-words text-xs leading-[1.5] text-zk-muted">
                  {bug.closeEvidence}
                </p>
              ) : null}
              {canWithdraw ? (
                <form action={withdrawIssueAction} data-testid="issue-withdraw">
                  <input type="hidden" name="issueId" value={bug.id} />
                  <ConfirmSubmitButton
                    confirm={{
                      title: `Withdraw issue #${bug.number}?`,
                      body: "It closes as withdrawn at once, and any agent working on it is released. Its comments and entries stay.",
                      confirmLabel: "Withdraw issue",
                    }}
                  >
                    Withdraw issue
                  </ConfirmSubmitButton>
                </form>
              ) : null}
              {takeItBack ? <TakeItBackPanel view={takeItBack} /> : null}
            </section>

            {rewardRow ? (
              <IssueRewardPanel
                bugId={bug.id}
                reward={Number(rewardRow.reward)}
                fixed={Boolean(rewardRow.rewardFixedAt)}
                estimates={rewardEstimates}
                viewerId={user.id}
                canEstimate={!bug.isDeleted && bug.status !== "closed"}
                caption="paid upon accepted delivery"
              />
            ) : null}

            <section className="flex flex-col gap-2 rounded-[20px] border border-zk-border bg-zk-surface px-4 py-3.5">
              <span className="text-xs font-bold uppercase tracking-[0.08em] text-zk-muted">People</span>
              <div className="flex min-w-0 items-center gap-3">
                <span className="w-16 shrink-0 text-xs text-zk-muted">Reporter</span>
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <UserNameWithBadges
                    name={bug.reporter.name}
                    image={bug.reporter.image}
                    avatar="sm"
                    className="min-w-0 !flex-nowrap text-xs"
                    userId={bug.reporterId}
                  />
                  {bug.createdByAgent ? <AgentChip name={bug.createdByAgent.name} className="ml-auto" /> : null}
                </div>
              </div>
              <div className="flex min-w-0 items-center gap-3">
                <span className="w-16 shrink-0 text-xs text-zk-muted">Assignee</span>
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                  {assignee ? (
                    <UserNameWithBadges
                      name={assignee.name}
                      role={assignee.role}
                      organisationRole={organisationRoles[assignee.id] ?? null}
                      image={assignee.image}
                      avatar="sm"
                      className="min-w-0 !flex-nowrap text-xs"
                      userId={assignee.id}
                    />
                  ) : (
                    <span className="text-xs text-zk-muted">Unassigned</span>
                  )}
                  {assignee && hold?.agentName ? <AgentChip name={hold.agentName} className="ml-auto" /> : null}
                  {canSelfAssign && (!assignee || isAssignee) ? (
                    <SelfAssignButton
                      bugId={bug.id}
                      isAssignedToMe={isAssignee}
                      variant="ghost"
                      size="xs"
                    />
                  ) : null}
                </div>
              </div>
            </section>

            <IssueLinks
              links={proofLinks}
              linkedPullRequestUrl={bug.pullRequestUrl}
              pullRequests={false}
              idea={sourceIdea ? { number: sourceIdea.number, slug: refOf(bug.project) } : null}
              repairs={linkRepairs}
            />

            <SubmissionEvidence
              screenshots={submissionScreenshots}
              testResults={submissionTestResults}
              pullRequestUrl={bug.pullRequestUrl}
            />

            <ActivityTimeline
              activities={[...shownActivities].reverse()}
              totalCount={activityCount + stepActivities.length}
            />
          </>
        }
        canReply={!bug.isDeleted}
      />
      </>
    );
  }

  return (
    <div className="issue-detail-scope flex flex-col gap-5 pb-10">
      {bug.isDeleted ? (
        <div className="rounded-[20px] border border-zk-bad-bd bg-zk-bad-bg p-4 sm:p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="text-sm font-semibold text-zk-bad-fg">
                This issue was deleted
              </h3>
              <p className="text-xs text-zk-bad-fg/90">
                {deletedSummary(keptCounts)}
              </p>
            </div>
            <RestoreIssueButton
              bugId={bug.id}
              bugTitle={bug.title}
              counts={keptCounts}
              size="sm"
            />
          </div>
        </div>
      ) : null}

      {bug.duplicateOf ? (
        <section
          aria-label="Duplicate"
          className="flex flex-col gap-2 rounded-[20px] border border-zk-warn-bd bg-zk-warn-bg p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5"
        >
          <p className="text-sm text-zk-warn-fg">
            <span className="font-semibold">This issue is a duplicate of </span>
            {bug.duplicateOf.isDeleted && !canDelete ? (
              <span>{formatIssueNumber(bug.duplicateOf.number)} (since deleted)</span>
            ) : (
              <Link href={issueHref(bug.duplicateOf)} className="font-semibold text-zk-accent underline-offset-2 hover:underline">
                {formatIssueNumber(bug.duplicateOf.number)} {bug.duplicateOf.title}
              </Link>
            )}{" "}
            <span>({statusLabels[bug.duplicateOf.status]})</span>.{" "}
            Follow it and mark it important there instead. It&apos;s hidden from the issues list.
          </p>
          {canTriage ? (
            <div className="flex shrink-0 items-center gap-1 print:hidden">
              <MarkDuplicateButton bugId={bug.id} label="Change" />
              <ClearDuplicateButton bugId={bug.id} />
            </div>
          ) : null}
        </section>
      ) : null}

      {bug._count.duplicates > 0 ? (
        <section aria-label="Duplicates of this issue" className="rounded-[20px] border border-zk-border bg-zk-surface p-4 sm:p-5">
          <h2 className="text-sm font-semibold text-zk-text">
            {bug._count.duplicates} duplicate{bug._count.duplicates === 1 ? "" : "s"} of this issue
          </h2>
          <ul className="mt-2 space-y-1 text-sm">
            {bug.duplicates.map((d) => (
              <li key={d.id}>
                <Link href={issueHref(d)} className="text-zk-accent hover:underline">
                  <span className="tabular-nums text-zk-muted">{formatIssueNumber(d.number)}</span> {d.title}
                </Link>{" "}
                <span className="text-xs text-zk-muted">· {statusLabels[d.status]}</span>
              </li>
            ))}
          </ul>
          {bug._count.duplicates > bug.duplicates.length ? (
            <p className="mt-1 text-xs text-zk-muted">
              And {bug._count.duplicates - bug.duplicates.length} more.
            </p>
          ) : null}
        </section>
      ) : null}

      {redesignProposals.length ? (
        <section aria-label="Redesign proposals" className="rounded-[20px] border border-zk-border bg-zk-surface p-4 sm:p-5">
          <h2 className="text-lg font-semibold text-zk-text">Compare redesign proposals</h2>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            {redesignProposals.map((proposal) => (
              <article key={proposal.id} className="space-y-3 rounded-[16px] border border-zk-border bg-zk-chip/40 p-4">
                <div className="flex items-start justify-between gap-3">
                  <h3 className="font-semibold text-zk-text">{proposal.title}</h3>
                  <span className="shrink-0 text-xs capitalize text-zk-muted">{proposal.status}</span>
                </div>
                <p className="text-xs text-zk-muted">By {proposal.authorAgent.name}</p>
                <p className="whitespace-pre-wrap text-sm text-zk-text2">{proposal.body}</p>
                {proposal.previewUrl ? <a className="text-sm font-bold text-zk-accent underline" href={proposal.previewUrl} target="_blank" rel="noreferrer">Open live preview</a> : null}
                {proposal.attachments.length ? <div className="grid grid-cols-2 gap-2">
                  {proposal.attachments.map((file) => <a key={file.id} href={`/api/attachments/${file.id}`} target="_blank" rel="noreferrer" className="space-y-1 text-sm font-bold text-zk-accent underline">
                    <Image src={`/api/attachments/${file.id}`} alt={file.filename} width={480} height={320} unoptimized className="h-auto max-h-56 w-full rounded-xl border border-zk-border object-contain" />
                    <span className="block">{file.filename}</span>
                  </a>)}
                </div> : null}
                {canChooseRedesign && proposal.status === "proposed" ? <ChooseRedesignButton id={proposal.id} /> : null}
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {resolution ? (
        <section
          aria-label="Resolution note"
          className="rounded-[20px] border border-zk-border bg-zk-ok-bg p-4 sm:p-5"
        >
          <h2 className="text-sm font-semibold text-zk-ok-fg">
            {resolutionStatusLabel[resolution.status]} by {resolution.by}
            <span className="ml-2 text-xs font-normal">
              <LocalTime date={resolution.at} />
            </span>
          </h2>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm text-zk-text">
            {resolution.note}
          </p>
        </section>
      ) : null}

      {/* Header: number + title, status language, importance */}
      <div className="flex flex-col gap-3.5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-[1_1_600px] space-y-3">
            <div className="flex items-start gap-2">
              {/* Back to the list it was opened from; otherwise the list for its status. */}
              <BackToList fallback={issuesPath(refOf(bug.project), bug.status)} label="Back to issues" />
              <h1 className="min-w-0 break-words text-[28px] font-extrabold leading-tight tracking-[-0.02em] text-zk-text">
                <span className="font-bold tabular-nums text-zk-muted">
                  {formatIssueNumber(bug.number)}
                </span>{" "}
                {bug.title}
              </h1>
            </div>

            {agentResolution ? (
              <AgentResolvedNotice bugId={bug.id} resolution={agentResolution} canReopen={canUpdateStatus} />
            ) : null}

            {/* Taxonomy (#687). Status, stage and the opened date are in the Status box. */}
            {bug.type ? (
              <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-zk-muted">
                <span className={`${issueChipBaseClass} bg-zk-chip text-zk-text2`}>{bug.type.name}</span>
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <IssuePrioritySelect bugId={bug.id} priority={bug.priority} />
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2 self-start print:hidden">
            <VoteButton
              bugId={bug.id}
              voteCount={bug.voteCount}
              userVote={userVote}
              likeCount={voterSummary.likes.count}
              likeVoters={voterSummary.likes.voters}
              size="md"
              showAvatars={false}
              readOnly={bug.isDeleted || !canContribute}
            />
            {!bug.isDeleted ? (
              <SpeedButton
                bugId={bug.id}
                issueNumber={bug.number}
                issueTitle={bug.title}
                isExpedited={bug.isBoosted}
              />
            ) : null}
            {!bug.isDeleted ? (
              <IssueActionsMenu>
                <CopyIssueSummaryButton
                  issue={{
                    number: bug.number,
                    title: bug.title,
                    substatus: bug.substatus,
                    summary: bug.summary,
                    description: bug.description,
                    orgSlug: bug.project.organisation.slug,
                    projectSlug: bug.project.slug,
                    canonicalPath: issueHref(bug),
                    assigneeName: assignee?.name ?? null,
                    pullRequestUrl: bug.pullRequestUrl ?? null,
                  }}
                />
                {canMarkDuplicate ? <MarkDuplicateButton bugId={bug.id} /> : null}
                {canDeleteHere ? (
                  <DeleteIssueButton bugId={bug.id} bugTitle={bug.title} counts={keptCounts} variant="danger" size="sm" />
                ) : null}
              </IssueActionsMenu>
            ) : null}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-start gap-5">
        {/* MAIN COLUMN */}
        <div className="flex min-w-0 flex-[999_1_600px] flex-col gap-5">
          {bug.status === "open" && bug.voteCount < WORK_READINESS_VOTE_THRESHOLD ? (
            <InsufficientVotesAuditBanner
              issueId={bug.id}
              voteCount={bug.voteCount}
              threshold={WORK_READINESS_VOTE_THRESHOLD}
              canRequestAudit={canTriage || bug.reporterId === user.id}
            />
          ) : null}

          {/* #1446: the progress report's stage filters the Conversation (#186). */}
          <IssueStageProvider initialStage={currentStage}>
          {securityView ? <SecurityFindingPanel view={securityView} canDisclose={access.admin} kind="issue" /> : null}
          <EditableIssueDescription
            bugId={bug.id}
            initialTitle={bug.title}
            initialDescription={bug.description}
            summary={bug.summary}
            canEdit={canEdit && !(securityView && !securityView.disclosed)}
            users={users}
            lastEditedAt={lastRevision?.editedAt ?? null}
            historyHref={issueHref(bug, "/history")}
            tags={
              bug.area ? (
                <span title="Area" className="inline-flex items-center rounded-full bg-zk-chip px-2.5 py-0.5 text-xs font-semibold text-zk-text2 ring-1 ring-zk-border">
                  {bug.area.name}
                </span>
              ) : null
            }
          >
            {bug.milestone ? (
              <dl className="mt-4 grid grid-cols-1 gap-3 text-sm text-zk-text2 sm:grid-cols-2">
                {bug.milestone ? (
                  <div>
                    <dt className="font-medium text-zk-muted">Milestone</dt>
                    <dd className="flex flex-wrap items-center gap-2">
                      <Link href={milestoneIssuesHref(refOf(bug.project), bug.milestone.id)} className="font-bold text-zk-accent hover:underline">
                        {bug.milestone.title}
                      </Link>
                      <MilestoneDue due={dueDateValue(bug.milestone.dueDate) || null} isClosed={bug.milestone.isClosed} />
                    </dd>
                  </div>
                ) : null}
              </dl>
            ) : null}
          </EditableIssueDescription>

          {issueAttachments.length > 0 ? (
            <section className="rounded-[20px] border border-zk-border bg-zk-surface p-5 sm:p-6">
              <h2 className="text-xs font-bold uppercase tracking-[0.08em] text-zk-muted">
                Attachments
              </h2>
              <AttachmentList attachments={issueAttachments} />
            </section>
          ) : null}

          {/* Progress report (#1446), where the summary strip was; its stage drives the Conversation card. */}
          <IssueProgressReport
            decisions={agentDecisions}
            entryCounts={{
              idea: sourceIdea?._count.verdicts ?? 0,
              confirm: confirmationsData?.entries.length ?? 0,
              open: bidList.length,
              progress: deliveryList.length,
              delivered: testVerdictList.length,
              done: mergeReviewList.length,
            }}
            currentStage={currentStage}
            setback={stageSetback(currentStage, sentBack)}
            live={liveFix ? {
              // #live-confirm: once released, how many agents have found it on prod.
              caption: liveFix.check.fact === "released" ? `${liveFactLabel(liveFix.check)}, ${liveConfirmLabel(liveFix.check)}` : liveFactLabel(liveFix.check),
              state: liveStepState(liveFix.check),
            } : undefined}
          />

          <NextStepBar step={liveFix ? liveNextStep(liveFix.check, liveFix.repo) : nextStep} agentInstructions={agentInstructions} />
          {yourDecision ? <DecisionCard issueId={bug.id} decision={yourDecision} /> : null}

          <IssueBlockersPanel
            projectSlug={refOf(bug.project)}
            issueId={bug.id}
            blockedBy={blockedBy}
            blocking={blocking}
            canEdit={canTriage && !bug.isDeleted}
          />

          <IssueTimeTracking bugId={bug.id} canEdit={canUpdateStatus && !bug.isDeleted} />

          {deliveredBanner ? <DeliveredBanner {...deliveredBanner} /> : null}

          {githubPanel ? <GitHubStatusPanel {...githubPanel} /> : null}

          <FundIssueSection
            bugId={bug.id}
            userId={user.id}
            estimate={rewardRow && rewardEstimates.length > 0 ? { dollars: Number(rewardRow.reward), count: rewardEstimates.length } : null}
          />

              {/* Who has the issue, while it is the latest thing (In progress); the timeline below keeps the award after that. */}
              {(hold?.status === "active" || hold?.status === "planning") && bug.status === "in_progress" ? <AwardBox hold={hold} agentPaused={Boolean(workingAgent?.pausedAt)} bugId={bug.id} isWatching={isWatchingIssue} isIssueOwner={bug.reporterId === user.id} /> : null}


              {/* #plan-review: the plan is the latest thing while the issue is at In progress · Plan review. */}
              {planReviewing && hold?.status === "planning" ? (
                <section className="rounded-[20px] border border-zk-border bg-zk-surface p-5 sm:p-[22px]">
                  <PlanReviewCard
                    bugId={bug.id}
                    plan={planCard}
                    isOwner={planOwnerId === user.id}
                    live
                    deadline={planDeadline({ offeredAt: hold.offeredAt, createdAt: hold.offeredAt ?? new Date() }, planCard ? { reviewBy: new Date(planCard.reviewBy) } : null, workflow.planReviewSeconds)}
                    canReply={!bug.isDeleted}
                    difficultyLabel={difficultyLabel[bug.difficulty]}
                  />
                </section>
              ) : null}

              {conversationHasContent ? (
                <section
                  id="conversation"
                  className="scroll-mt-24 rounded-[20px] border border-zk-border bg-zk-surface p-5 sm:p-[22px]"
                >
                  <div className="flex justify-end empty:hidden">
                    <DisputeAwardDialog bugNumber={bug.number} roles={disputeRoles} />
                  </div>
                  <IssueTimeline>
                    {mergeReviewing || timelineReviews.length > 0 ? (
                      <>
                        {currentStage === "ready" ? (
                          <TimelineStep>
                            <MergerTransparencyCard
                              queuePosition={queuePosition}
                              totalInQueue={totalInQueue}
                              estimatedWaitMinutes={estimatedWaitMinutes}
                              mergerAgentName={mergerAgentName}
                              precedingPrNumber={precedingPrNumber}
                              ciPassed={ciPassed}
                              verdictsPassed={verdictsPassed}
                              rebaseClean={rebaseClean}
                              queueLocked={queueLocked}
                            />
                          </TimelineStep>
                        ) : null}
                        <TimelineStep>
                          <MergeReviewsPanel at={firstAt(timelineReviews)} bugId={bug.id} reviews={timelineReviews} canReply={mergeReviewing} history={!mergeReviewing} />
                        </TimelineStep>
                      </>
                    ) : null}
                    {testing || timelineVerdicts.length > 0 ? (
                      <TimelineStep>
                        <TestVerdictsPanel at={firstAt(timelineVerdicts)} bugId={bug.id} verdicts={timelineVerdicts} canReply={testing} />
                      </TimelineStep>
                    ) : null}
                    {timelineDeliveries.length > 0 ? (
                      <TimelineStep>
                        <DeliveriesPanel at={firstAt(timelineDeliveries)} bugId={bug.id} deliveries={timelineDeliveries} canReply={!bug.isDeleted && delivering} />
                      </TimelineStep>
                    ) : null}
                    {/* #plan-review: the approved plan stays on the issue, above the award, as what the delivery is judged against. */}
                    {!planReviewing && planCard?.decision === "approved" ? (
                      <TimelineStep>
                        <PlanReviewCard bugId={bug.id} plan={planCard} isOwner={false} live={false} deadline={null} canReply={!bug.isDeleted} difficultyLabel={difficultyLabel[bug.difficulty]} />
                      </TimelineStep>
                    ) : null}
                    {awardClaim ? (
                      <TimelineStep>
                        <AwardStep award={awardClaim} />
                      </TimelineStep>
                    ) : null}
                    {pastConfirmation || bidList.length > 0 || bidAgents.length > 0 ? (
                      <TimelineStep>
                        <IssueBidsPanel
                          bidAction={bidAgents.length > 0 ? <BidButton bugId={bug.id} agents={bidAgents} /> : undefined}
                          bids={bidList}
                          at={firstAt(bidList)}
                          collapsed={bug.status !== "open"}
                          canAward={canAwardBids}
                          awardThreshold={workflow.awardThreshold}
                        />
                      </TimelineStep>
                    ) : null}
                    {confirmationsCard ? (
                      <TimelineStep>{confirmationsCard}</TimelineStep>
                    ) : null}
                    {sourceIdea ? (
                      <TimelineStep>
                        <IdeaStep
                          number={sourceIdea.number}
                          href={ideaPath(refOf(bug.project), sourceIdea.number)}
                          verdicts={sourceIdea._count.verdicts}
                          convertedAt={sourceIdea.convertedAt}
                        />
                      </TimelineStep>
                    ) : null}
                  </IssueTimeline>
                </section>
              ) : null}

              {closeSuggestions ? <CloseSuggestionsPanel data={closeSuggestions} /> : null}


              {bug.status === "resolved" && !bug.isDeleted ? (
                <RetestRequest
                  bugId={bug.id}
                  issueHref={issueHref(bug)}
                  issueLabel={`${formatIssueNumber(bug.number)} · ${bug.title}`}
                />
              ) : null}

              {/* Comments, apart from the stage entries (bids, deliveries) in the Conversation. */}
              {takesComments || commentCount > 0 ? (
                <section
                  id="comments"
                  aria-label="Comments"
                  className="scroll-mt-24 rounded-[20px] border border-zk-border bg-zk-surface p-5 sm:p-[22px]"
                >
                  {steeringAgent ? (
                    <AgentSteerPanel
                      agentId={steeringAgent.id}
                      issueId={bug.id}
                      paused={steeringAgent.pausedAt !== null}
                      notes={steerNotes.map((note) => {
                        const payload = (note.payload ?? {}) as { body?: unknown; plan?: unknown };
                        return { id: note.id, body: String(payload.body ?? ""), plan: typeof payload.plan === "string" ? payload.plan : null };
                      })}
                    />
                  ) : null}
                  <IssueComments
                    count={commentCount}
                    composer={takesComments ? <CommentComposer bugId={bug.id} /> : null}
                    replyBugId={takesComments ? bug.id : undefined}
                    reporterId={bug.reporterId}
                    comments={commentTree}
                    attachmentsByComment={attachmentsByComment}
                    organisationRoles={organisationRoles}
                    users={commentMentionUsers}
                    currentUserId={user.id}
                    currentUserRole={user.role}
                    organisationAdmin={access.admin}
                    readOnly={bug.isDeleted || !canContribute}
                    markedImportantBy={importanceMarkers}
                  >
                    {comments.hiddenThreads > 0 ? (
                      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-zk-chip px-3 py-2 text-sm text-zk-text2 print:hidden">
                        <span>
                          {comments.hiddenThreads} earlier{" "}
                          {comments.hiddenThreads === 1 ? "thread" : "threads"} not shown.
                        </span>
                        <Link
                          href={earlierThreadsHref(pageQuery, comments.shownThreads)}
                          scroll={false}
                          className="font-bold text-zk-accent hover:underline"
                        >
                          Show {Math.min(comments.hiddenThreads, COMMENT_THREADS_PER_PAGE)} earlier
                        </Link>
                        {comments.hiddenThreads > COMMENT_THREADS_PER_PAGE ? (
                          <Link
                            href={earlierThreadsHref(pageQuery, comments.shownThreads, true)}
                            scroll={false}
                            className="font-bold text-zk-accent hover:underline"
                          >
                            Show all
                          </Link>
                        ) : null}
                      </div>
                    ) : null}
                  </IssueComments>
                  <Suspense fallback={null}>
                    <CommentPermalinkResolver />
                  </Suspense>
                </section>
              ) : null}


          <IssueEscalations escalations={escalations} />


          </IssueStageProvider>
        </div>

        {/* SIDE RAIL */}
        <aside className="flex min-w-0 flex-[1_1_340px] flex-col gap-4">
          {/* Status: workflow state, when it was opened, and whether it is an idea or an issue (#687). */}
          <section aria-label="Status" className="flex flex-col gap-2.5 rounded-[20px] border border-zk-border bg-zk-surface px-4 py-3.5">
            <h2 className="text-xs font-bold uppercase tracking-[0.08em] text-zk-muted">Status</h2>
            <div className="flex flex-wrap items-center gap-1.5 text-xs font-bold">
              {bug.isDeleted ? (
                <span className={`${issueChipBaseClass} bg-zk-bad-bg text-zk-bad-fg`}>Deleted</span>
              ) : null}
              <Badge className={`${issueChipBaseClass} ${issueStatusChipClass[bug.substatus]}`}>
                <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
                {stateLabel(bug.substatus)}
              </Badge>
              {/* #plan-review: the one new label, the issue's difficulty; complex issues go through plan review. */}
              <span className={`${issueChipBaseClass} ${bug.difficulty === "complex" ? "bg-zk-warn-bg text-zk-warn-fg" : "bg-zk-chip text-zk-text2"}`} data-testid="difficulty-chip" title="Set when the idea was converted; fixed once the issue has a bid.">
                {difficultyLabel[bug.difficulty]}
              </span>
              {bug.isBoosted && !bug.isDeleted ? (
                <span className={`${issueChipBaseClass} border border-zk-warn-bd bg-zk-warn-bg text-zk-warn-fg`}>Boosted</span>
              ) : null}
            </div>
            {liveFix ? (
              <LiveFlow substatus={bug.substatus} reachedAt={liveFix.reachedAt} confirmed={liveFix.check.confirmedBy.length} needed={PROD_CONFIRMATIONS_NEEDED} />
            ) : null}
            {statusFlags.length > 0 ? (
              <ul data-testid="status-flags" className="m-0 flex list-none flex-col gap-1 p-0">
                {statusFlags.map((flag) => (
                  <li key={flag.label} className="flex items-center gap-1.5 text-xs text-zk-text2" title={flag.title}>
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${FLAG_DOT[flag.tone]}`} aria-hidden />
                    {flag.label}
                  </li>
                ))}
              </ul>
            ) : null}
            {bug.status === "closed" && bug.closeEvidence && !bug.isDeleted ? (
              <p data-testid="close-evidence" className="m-0 break-words text-xs leading-[1.5] text-zk-muted">
                {bug.closeEvidence}
              </p>
            ) : null}
            {/* createSupportThreadAction accepts organisation members only, so nobody else is offered the button. */}
            {isOrgMember && !bug.isDeleted && (ASKABLE_STATUSES as readonly string[]).includes(bug.status) ? (
              activeSupportThread ? (
                <Link
                  href={`/inbox?tab=requests&thread=${activeSupportThread.id}`}
                  className="inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-lg border border-zk-border bg-zk-chip/40 px-3 text-xs font-semibold text-zk-text hover:bg-zk-chip"
                >
                  <span aria-hidden="true">💬</span>
                  <span>View your request</span>
                </Link>
              ) : (
                <AskAboutFix issueId={bug.id} issueNumber={bug.number} issueTitle={bug.title} />
              )
            ) : null}
            {/* The reporter or the person it is for cancels their own issue (#close-reasons). */}
            {canWithdraw ? (
              <form action={withdrawIssueAction} data-testid="issue-withdraw">
                <input type="hidden" name="issueId" value={bug.id} />
                <ConfirmSubmitButton
                  confirm={{
                    title: `Withdraw issue #${bug.number}?`,
                    body: "It closes as withdrawn at once, and any agent working on it is released. Its comments and entries stay.",
                    confirmLabel: "Withdraw issue",
                  }}
                >
                  Withdraw issue
                </ConfirmSubmitButton>
              </form>
            ) : null}
          </section>
          {checklist ? <MergeChecklistCard checklist={checklist} /> : null}
          {/* #rewards: the reward, your estimate, and everyone's. */}
          {rewardRow ? (
            <IssueRewardPanel
              bugId={bug.id}
              reward={Number(rewardRow.reward)}
              fixed={Boolean(rewardRow.rewardFixedAt)}
              estimates={rewardEstimates}
              viewerId={user.id}
              canEstimate={!bug.isDeleted && bug.status !== "closed"}
            />
          ) : null}

          {/* People, compact: one row each, label on the left. */}
          <section className="flex flex-col gap-2 rounded-[20px] border border-zk-border bg-zk-surface px-4 py-3.5">
            <span className="text-xs font-bold uppercase tracking-[0.08em] text-zk-muted">People</span>
            <div className="flex min-w-0 items-center gap-3">
              <span className="w-16 shrink-0 text-xs text-zk-muted">Reporter</span>
              <div className="flex min-w-0 flex-1 items-center gap-2">
                {/* One line: a long name truncates rather than dropping under the avatar. */}
                <UserNameWithBadges
                  name={bug.reporter.name}
                  image={bug.reporter.image}
                  avatar="sm"
                  className="min-w-0 !flex-nowrap text-xs"
                  userId={bug.reporterId}
                />
                {/* The agent that filed it, on the right. */}
                {bug.createdByAgent ? <AgentChip name={bug.createdByAgent.name} className="ml-auto" /> : null}
              </div>
            </div>
            <div className="flex min-w-0 items-center gap-3">
              <span className="w-16 shrink-0 text-xs text-zk-muted">Assignee</span>
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                {assignee ? (
                  <UserNameWithBadges
                    name={assignee.name}
                    role={assignee.role}
                    organisationRole={organisationRoles[assignee.id] ?? null}
                    image={assignee.image}
                    avatar="sm"
                    className="min-w-0 !flex-nowrap text-xs"
                    userId={assignee.id}
                  />
                ) : (
                  <span className="text-xs text-zk-muted">Unassigned</span>
                )}
                {/* The agent doing the work for the assignee, on the right. */}
                {assignee && hold?.agentName ? <AgentChip name={hold.agentName} className="ml-auto" /> : null}
                {/* Only an unassigned issue offers Assign to me (and your own, Unassign). */}
                {canSelfAssign && (!assignee || isAssignee) ? (
                  <SelfAssignButton
                    bugId={bug.id}
                    isAssignedToMe={isAssignee}
                    variant="ghost"
                    size="xs"
                  />
                ) : null}
              </div>
            </div>
          </section>

          {/* Links, under People: the GitHub PR (the linked one too) and the idea it came from. */}
          <IssueLinks
            links={proofLinks}
            linkedPullRequestUrl={bug.pullRequestUrl}
            idea={sourceIdea ? { number: sourceIdea.number, slug: refOf(bug.project) } : null}
            repairs={linkRepairs}
            bugId={bug.id}
            canEditPullRequest={canEditPullRequest}
          />

          {prChecks && bug.pullRequestUrl && (prChecks.failed || prChecks.report?.reportedBy) ? (
            <PullRequestChecks
              report={prChecks.report}
              pullRequestUrl={bug.pullRequestUrl}
              refreshHint={prChecks.refreshHint}
              refreshInstructions={prChecks.refreshHint ? agentInstructions : undefined}
              failed={prChecks.failed}
            />
          ) : null}

          <SubmissionEvidence
            screenshots={submissionScreenshots}
            testResults={submissionTestResults}
            pullRequestUrl={bug.pullRequestUrl}
          />

          <ActivityTimeline
            activities={[...shownActivities].reverse()}
            totalCount={activityCount + stepActivities.length}
          />
        </aside>
      </div>
    </div>
  );
}
