import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireProject } from "@/lib/project-route";
import { ideasPath, marketingPath, projectPath } from "@/lib/project-paths";
import { issueHref, parseIssueRef } from "@/lib/issue-ref";
import { IDEA_SUMMARY_MAX_CHARS, listIdeaVerdicts } from "@/lib/agent-api/idea-verdicts";
import { IdeaVerdictsPanel, type IdeaVerdictBlock } from "@/components/idea-verdicts";
import { MarketingAreaMarker } from "@/components/marketing/marketing-area";
import { AttachmentList } from "@/components/attachment-list";
import { RichText } from "@/components/rich-text";
import { SecurityFindingPanel } from "@/components/security-finding-panel";
import { findingForIdea, findingView } from "@/lib/security-findings";
import { organisationAccessFor } from "@/lib/organisation-access";
import { LocalTime } from "@/components/local-time";
import { ReportSummary } from "@/components/report-summary";
import { NextStepBar } from "@/components/next-step-bar";
import { BackToList } from "@/components/back-to-list";
import { ideaNextStep } from "@/lib/next-step";
import { UserNameWithBadges } from "@/components/user-name-with-badges";
import { isBadIdea } from "@/lib/idea-rejection";
import { archiveReasonLabel, IDEA_WITHDRAWN_REASON } from "@/lib/idea-archive";
import { workflowFor } from "@/lib/workflow";
import { isThresholdOnly } from "@/lib/governance";
import { ConfirmSubmitButton } from "@/components/confirm-submit-button";
import { RejectIdeaButton } from "@/components/reject-idea-button";
import { approveIdeaAction, rejectIdeaAction, withdrawIdeaAction } from "@/app/actions/idea-verdicts";
import { awardingAgentOf } from "@/lib/bid-award-permission";
import { OwnerIdeaControls } from "@/components/owner-idea-controls";

export const metadata: Metadata = { title: "Idea" };


type LegacyComment = { authorId: string; body: string; createdAt: string };

function legacyComments(value: unknown): LegacyComment[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (row): row is LegacyComment =>
      !!row && typeof row === "object" && typeof (row as LegacyComment).body === "string" && typeof (row as LegacyComment).authorId === "string",
  );
}

const STATUS_CHIP: Record<string, { label: string; className: string }> = {
  open: { label: "Idea", className: "bg-zk-tint text-zk-accent" },
  accepted: { label: "Idea accepted", className: "bg-zk-ok-bg text-zk-ok-fg" },
  bad: { label: "Reject advised", className: "bg-zk-bad-bg text-zk-bad-fg" },
  converted: { label: "Converted to an issue", className: "bg-zk-ok-bg text-zk-ok-fg" },
  rejected: { label: "Idea rejected", className: "bg-zk-bad-bg text-zk-bad-fg" },
  archived: { label: "Archived", className: "bg-zk-chip text-zk-text2" },
};

/**
 * One idea (#idea-table). An idea is not an issue: it takes verdicts, not
 * comments or votes, and any agent converts it once its score reaches
 * the project's threshold. A converted idea links to the issue it became.
 * Like an issue's page: the description and verdicts on the left, a side
 * panel on the right with its status, score and people.
 */
/** `/<slug>/ideas/<number>` (#project-urls): the slug picks the project and checks access; the idea must be in it. */
export default async function IdeaPage({ params, searchParams }: {
  params: Promise<{ org: string; project: string; number: string }>;
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const { org, project: slugParam, number: id } = await params;
  const query = await searchParams;
  const { user, organisationId, project } = await requireProject(org, slugParam);
  const slug = project.ref;
  const ref = parseIssueRef(id);
  const idea = await prisma.idea.findFirst({
    where: { organisationId, projectId: project.id, isDeleted: false, ...(ref.kind === "number" ? { number: ref.number } : { id: ref.id }) },
    select: {
      id: true,
      number: true,
      title: true,
      // #stakes: who has claimed it, to take the issue it becomes.
      stakes: { where: { status: "waiting" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, beneficiaryUserId: true, expiresAt: true, agent: { select: { name: true } } } },
      summary: true,
      description: true,
      rationale: true,
      status: true,
      track: true,
      projectId: true,
      createdAt: true,
      convertedAt: true,
      rejectedAt: true,
      rejectReason: true,
      archivedAt: true,
      archiveReason: true,
      archiveEvidence: true,
      archiveDuplicateOf: true,
      reporterId: true,
      beneficiaryUserId: true,
      legacyComments: true,
      reporter: { select: { name: true, role: true, image: true } },
      beneficiary: { select: { name: true, role: true, image: true } },
      createdByAgent: { select: { name: true, ownerUserId: true } },
      type: { select: { name: true } },
      area: { select: { name: true } },
      issue: { select: { number: true, title: true, project: { select: { slug: true, organisation: { select: { slug: true } } } } } },
      attachments: {
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, filename: true, contentType: true, size: true },
      },
    },
  });
  const claimants = idea?.stakes.length
    ? new Map((await prisma.user.findMany({ where: { id: { in: idea.stakes.map((stake) => stake.beneficiaryUserId) } }, select: { id: true, name: true, image: true } })).map((person) => [person.id, person]))
    : new Map<string, { id: string; name: string | null; image: string | null }>();
  if (!idea) notFound();

  const [verdicts, workflow, securityFinding] = await Promise.all([
    listIdeaVerdicts({ organisationId, projectId: idea.projectId }, idea.id),
    workflowFor(idea.projectId),
    findingForIdea(idea.id),
  ]);
  // #security-findings: the private details, shown only to who may see them.
  const securityAdmin = securityFinding ? (await organisationAccessFor(user.id, organisationId, user.role)).admin : false;
  const securityView = securityFinding
    ? findingView(securityFinding, { kind: "person", userId: user.id, organisationId, organisationAdmin: securityAdmin })
    : null;
  const own = idea.reporterId === user.id || idea.beneficiaryUserId === user.id || idea.createdByAgent?.ownerUserId === user.id;
  // Anyone may give a verdict on their own idea.
  const block: IdeaVerdictBlock = idea.status !== "open" ? "closed" : null;
  const votes = { total: verdicts.votes.good + verdicts.votes.bad + verdicts.votes.neutral, good: verdicts.votes.good };
  // A bad open idea is red and manager agents are advised to reject it; one at the threshold is accepted.
  const rejectable = idea.status === "open" && isBadIdea(votes, verdicts.ideaThreshold);
  const chip =
    STATUS_CHIP[idea.status !== "open" ? idea.status : rejectable ? "bad" : verdicts.convertible ? "accepted" : "open"] ?? STATUS_CHIP.open;
  // The next step, always shown at the top (#next-step).
  const nextStep = ideaNextStep({
    status: idea.status,
    score: verdicts.ideaScore,
    threshold: verdicts.ideaThreshold,
    totalVotes: votes.total,
    bad: rejectable,
    convertible: idea.status === "open" && verdicts.convertible,
    issueNumber: idea.issue?.number ?? null,
    archiveLabel: idea.status === "archived" ? archiveReasonLabel(idea.archiveReason, idea.archiveDuplicateOf) : null,
    withdrawn: idea.status === "archived" && idea.archiveReason === IDEA_WITHDRAWN_REASON,
    governance: { thresholdOnly: isThresholdOnly(workflow), managerVoteWeight: workflow.managerVoteWeight },
    rejectReason: idea.rejectReason,
  });
  // What this person can do from the Actions box, through their highest-level agent.
  // #owner-control: the organisation's owner decides an open idea themselves, whatever its votes, without an agent.
  const ideaOwner = idea.status === "open" && (await organisationAccessFor(user.id, organisationId, user.role)).admin;
  const actingAgent = !ideaOwner && idea.status === "open" && (rejectable || verdicts.convertible) ? await awardingAgentOf(user.id, organisationId) : null;
  const canApprove = idea.status === "open" && verdicts.convertible && Boolean(actingAgent);
  const canReject = rejectable && (actingAgent?.level === "manager" || actingAgent?.level === "merger");
  const canWithdraw = own && idea.status === "open";
  const actionError = typeof query.error === "string" ? query.error : null;
  const earlier = legacyComments(idea.legacyComments);
  const authors = earlier.length
    ? new Map(
        (await prisma.user.findMany({ where: { id: { in: [...new Set(earlier.map((c) => c.authorId))] } }, select: { id: true, name: true } }))
          .map((u) => [u.id, u.name]),
      )
    : new Map<string, string | null>();

  const marketingIdea = idea.track === "marketing";
  const closedIdea = idea.status === "rejected" || idea.status === "archived";
  const backFallback = marketingIdea
    ? marketingPath(slug, closedIdea ? "ideas/rejected" : "tasks")
    : closedIdea ? ideasPath(slug, "rejected") : ideasPath(slug);

  return (
    <div className="flex flex-col gap-5 pb-10">
      {marketingIdea ? <MarketingAreaMarker /> : null}
      {/* Header like an issue's: back to the Ideas tab, number + title. */}
      <div className="flex flex-col gap-3">
        <div className="flex items-start gap-2">
          {/* Back to the list it was opened from; otherwise New ideas or Rejected ideas. */}
          <BackToList fallback={backFallback} label={marketingIdea ? "Back to proposals" : "Back to ideas"} />
          <h1 className="min-w-0 break-words text-[28px] font-extrabold leading-tight tracking-[-0.02em] text-zk-text">
            <span className="font-bold tabular-nums text-zk-muted">Idea #{idea.number}</span> {idea.title}
          </h1>
        </div>
      </div>

      <div className="flex flex-wrap items-start gap-5">
        {/* MAIN COLUMN */}
        <div className="flex min-w-0 flex-[999_1_600px] flex-col gap-5">
          <NextStepBar step={nextStep} />
          {securityView ? <SecurityFindingPanel view={securityView} canDisclose={securityAdmin} kind="idea" /> : null}
          <ReportSummary summary={idea.summary} />
          {marketingIdea && idea.rationale ? (
            <section className="rounded-[20px] border border-zk-border bg-zk-surface p-5 sm:p-6">
              <h2 className="text-xs font-bold uppercase tracking-[0.08em] text-zk-muted">Why it serves the focus</h2>
              <p className="mt-3 text-sm text-zk-text">{idea.rationale}</p>
            </section>
          ) : null}
          {idea.status === "archived" && idea.archiveEvidence ? (
            <section className="rounded-[20px] border border-zk-border bg-zk-surface p-5 sm:p-6" data-testid="idea-archive-evidence">
              <h2 className="text-xs font-bold uppercase tracking-[0.08em] text-zk-muted">
                Archived: {archiveReasonLabel(idea.archiveReason, idea.archiveDuplicateOf)}
              </h2>
              <RichText content={idea.archiveEvidence} className="mt-3 text-sm text-zk-text" />
            </section>
          ) : null}
          <section className="rounded-[20px] border border-zk-border bg-zk-surface p-5 sm:p-6">
            <h2 className="text-xs font-bold uppercase tracking-[0.08em] text-zk-muted">Description</h2>
            <RichText content={idea.description} className="mt-3 text-sm text-zk-text" />
          </section>

          {idea.attachments.length > 0 ? (
            <section className="rounded-[20px] border border-zk-border bg-zk-surface p-5 sm:p-6">
              <h2 className="text-xs font-bold uppercase tracking-[0.08em] text-zk-muted">Attachments</h2>
              <AttachmentList attachments={idea.attachments} />
            </section>
          ) : null}

          <IdeaVerdictsPanel ideaId={idea.id} track={idea.track} data={verdicts} viewerId={user.id} block={block} summaryMaxChars={IDEA_SUMMARY_MAX_CHARS} />

          {earlier.length > 0 ? (
            <section className="rounded-[20px] border border-zk-border bg-zk-surface p-5 sm:p-6" aria-labelledby="earlier-comments">
              <h2 id="earlier-comments" className="text-xs font-bold uppercase tracking-[0.08em] text-zk-muted">
                Earlier comments
              </h2>
              <p className="mt-1 text-[13px] text-zk-muted">Left before ideas took verdicts instead of comments.</p>
              <ul className="mt-3 flex flex-col gap-2.5">
                {earlier.map((comment, index) => (
                  <li key={index} className="rounded-xl border border-zk-divider px-3 py-2.5 text-[13px]">
                    <p className="m-0 text-xs text-zk-muted">
                      <b className="font-semibold text-zk-text">{authors.get(comment.authorId) ?? "Someone"}</b> · <LocalTime date={comment.createdAt} />
                    </p>
                    <RichText content={comment.body} className="mt-1 text-zk-text" />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
            </div>

        {/* SIDE RAIL, like an issue's: status, score, people, details. */}
        <aside className="flex min-w-0 flex-[1_1_340px] flex-col gap-4">
          <section aria-label="Status" className="flex flex-col gap-2.5 rounded-[20px] border border-zk-border bg-zk-surface px-4 py-3.5">
            <h2 className="text-xs font-bold uppercase tracking-[0.08em] text-zk-muted">Status</h2>
            <div className="flex flex-wrap items-center gap-1.5 text-xs font-bold">
              <span data-testid="idea-status" className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 ${chip.className}`}>
                <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
                {chip.label}
              </span>
              {idea.issue ? (
                <Link
                  href={issueHref(idea.issue)}
                  data-testid="idea-issue-link"
                  className="inline-flex items-center rounded-full bg-zk-chip px-2.5 py-1 text-zk-text2 hover:underline"
                >
                  Became issue #{idea.issue.number}
                </Link>
              ) : null}
            </div>
            <p className="text-xs text-zk-muted">
              Opened <LocalTime date={idea.createdAt} /> by {idea.reporter.name ?? "Someone"}
              {idea.convertedAt ? (
                <>
                  {" "}· converted <LocalTime date={idea.convertedAt} />
                </>
              ) : null}
              {idea.rejectedAt ? (
                <>
                  {" "}· rejected <LocalTime date={idea.rejectedAt} />
                </>
              ) : null}
              {idea.archivedAt ? (
                <>
                  {" "}· archived <LocalTime date={idea.archivedAt} />
                </>
              ) : null}
            </p>
          </section>

          {/* Actions (#idea-actions): approve once the score reached the threshold,
              reject a bad idea (a manager agent's), withdraw your own. */}
          {ideaOwner || canApprove || canReject || canWithdraw ? (
            <section aria-label="Actions" data-testid="idea-actions" className="flex flex-col gap-2.5 rounded-[20px] border border-zk-border bg-zk-surface px-4 py-3.5">
              <h2 className="text-xs font-bold uppercase tracking-[0.08em] text-zk-muted">Actions</h2>
              {actionError ? <p role="alert" className="m-0 text-xs text-zk-bad-fg">{actionError}</p> : null}
              {ideaOwner ? (
                <OwnerIdeaControls
                  ideaId={idea.id}
                  ideaNumber={idea.number}
                  issuePathFor={projectPath(slug, "")}
                  score={verdicts.ideaScore}
                  threshold={verdicts.ideaThreshold}
                  more={canWithdraw ? (
                  <form action={withdrawIdeaAction} data-testid="idea-withdraw">
                    <input type="hidden" name="ideaId" value={idea.id} />
                    <ConfirmSubmitButton
                      confirm={{
                        title: `Withdraw idea #${idea.number}?`,
                        body: "It is archived as withdrawn by its owner, moves to Rejected ideas and takes no more verdicts. $ already given for verdicts on it stay.",
                        confirmLabel: "Withdraw idea",
                      }}
                    >
                      Withdraw idea
                    </ConfirmSubmitButton>
                  </form>
                  ) : null}
                />
              ) : null}
              <div className="flex flex-wrap gap-2 empty:hidden">
                {canApprove ? (
                  <form action={approveIdeaAction}>
                    <input type="hidden" name="ideaId" value={idea.id} />
                    <ConfirmSubmitButton
                      variant="primary"
                      confirm={{
                        title: `Approve idea #${idea.number}?`,
                        body: "It becomes an issue at Open · Awaiting confirmation, through your agent.",
                        confirmLabel: "Approve idea",
                      }}
                    >
                      Approve idea
                    </ConfirmSubmitButton>
                  </form>
                ) : null}
                {canReject ? (
                  <RejectIdeaButton ideaId={idea.id} ideaNumber={idea.number} />
                ) : null}
                {canWithdraw && !ideaOwner ? (
                  <form action={withdrawIdeaAction} data-testid="idea-withdraw">
                    <input type="hidden" name="ideaId" value={idea.id} />
                    <ConfirmSubmitButton
                      confirm={{
                        title: `Withdraw idea #${idea.number}?`,
                        body: "It is archived as withdrawn by its owner, moves to Rejected ideas and takes no more verdicts. $ already given for verdicts on it stay.",
                        confirmLabel: "Withdraw idea",
                      }}
                    >
                      Withdraw idea
                    </ConfirmSubmitButton>
                  </form>
                ) : null}
              </div>
            </section>
          ) : null}

          <section aria-label="Score" className="flex flex-col gap-2 rounded-[20px] border border-zk-border bg-zk-surface px-4 py-3.5">
            <h2 className="text-xs font-bold uppercase tracking-[0.08em] text-zk-muted">Score</h2>
            <p className="m-0 text-sm text-zk-text">
              <b className="text-lg font-extrabold tabular-nums">{verdicts.ideaScore}</b>
              <span className="text-zk-muted"> of {verdicts.ideaThreshold} needed to accept it</span>
            </p>
            <p className="m-0 flex flex-wrap gap-x-3 gap-y-1 text-xs text-zk-text2">
              <span><b className="text-zk-ok-fg">{verdicts.votes.good}</b> good</span>
              <span><b className="text-zk-bad-fg">{verdicts.votes.bad}</b> bad</span>
              <span><b>{verdicts.votes.neutral}</b> neutral</span>
              <span className="text-zk-muted">· {votes.total} vote{votes.total === 1 ? "" : "s"} in all</span>
            </p>
            {rejectable ? (
              <p className="m-0 text-xs text-zk-bad-fg" data-testid="idea-rejectable">
                More bad and neutral votes than good ones: manager agents are advised to reject it.
              </p>
            ) : null}
          </section>

          <section aria-label="People" className="flex flex-col gap-2 rounded-[20px] border border-zk-border bg-zk-surface px-4 py-3.5">
            <span className="text-xs font-bold uppercase tracking-[0.08em] text-zk-muted">People</span>
            <div className="flex min-w-0 items-center gap-3">
              <span className="w-16 shrink-0 text-xs text-zk-muted">Reporter</span>
              <UserNameWithBadges
                name={idea.reporter.name ?? "Someone"}
                image={idea.reporter.image}
                avatar="sm"
                className="text-xs"
                userId={idea.reporterId}
                agentName={idea.createdByAgent?.name}
              />
            </div>
            {/* #stakes: a claim on the idea takes the issue it becomes. */}
            {idea.stakes.map((stake) => {
              const person = claimants.get(stake.beneficiaryUserId);
              return (
                <div key={stake.id} className="flex min-w-0 items-center gap-3" data-testid="idea-claimant">
                  <span className="w-16 shrink-0 text-xs text-zk-muted">Claimed by</span>
                  <UserNameWithBadges
                    name={person?.name ?? "Someone"}
                    image={person?.image ?? null}
                    avatar="sm"
                    className="text-xs"
                    userId={stake.beneficiaryUserId}
                    agentName={stake.agent.name}
                  />
                </div>
              );
            })}
            {idea.beneficiaryUserId !== idea.reporterId ? (
              <div className="flex min-w-0 items-center gap-3">
                <span className="w-16 shrink-0 text-xs text-zk-muted">For</span>
                <UserNameWithBadges
                  name={idea.beneficiary.name ?? "Someone"}
                  role={idea.beneficiary.role}
                  image={idea.beneficiary.image}
                  avatar="sm"
                  className="text-xs"
                  userId={idea.beneficiaryUserId}
                />
              </div>
            ) : null}
          </section>

          {idea.type || idea.area ? (
            <section aria-label="Details" className="flex flex-col gap-2 rounded-[20px] border border-zk-border bg-zk-surface px-4 py-3.5">
              <span className="text-xs font-bold uppercase tracking-[0.08em] text-zk-muted">Details</span>
              {idea.type ? (
                <div className="flex items-center gap-3 text-sm">
                  <span className="w-16 shrink-0 text-xs text-zk-muted">Type</span>
                  {idea.type.name}
                </div>
              ) : null}
              {idea.area ? (
                <div className="flex items-center gap-3 text-sm">
                  <span className="w-16 shrink-0 text-xs text-zk-muted">Area</span>
                  {idea.area.name}
                </div>
              ) : null}
            </section>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
