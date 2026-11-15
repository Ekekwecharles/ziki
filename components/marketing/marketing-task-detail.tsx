"use client";
import type { ProjectRef } from "@/lib/project-paths";

import { useEffect, useState, type ReactNode } from "react";
import { MarketingTaskHeader } from "./marketing-task-header";
import { MarketingDeliverablesPanel, type MarketingDeliveryView } from "./marketing-deliverables-panel";
import { MarketingReviewsPanel, type MarketingReviewView } from "./marketing-reviews-panel";
import { AwardBox } from "@/components/award-box";
import type { IssueHold } from "@/lib/issue-holders";
import type { Status, Substatus } from "@prisma/client";

export type MarketingTaskDetailProps = {
  bug: {
    id: string;
    number: number;
    title: string;
    description: string;
    status: Status;
    substatus: Substatus;
    reward?: number | null;
    revisionCount: number;
    createdAt: Date | string;
    type?: { id: string; name: string } | null;
    reporter?: { name: string | null } | null;
    createdByAgent?: { id: string; name: string } | null;
    project: { slug: ProjectRef; name?: string; goal?: string | null; siteUrl?: string | null };
    idea?: { id: string; number: number; rationale?: string | null } | null;
  };
  revisionLimit: number;
  hold: IssueHold | null;
  agentPaused: boolean;
  isWatching: boolean;
  isIssueOwner: boolean;
  deliveries: MarketingDeliveryView[];
  reviews: MarketingReviewView[];
  bidsSlot?: ReactNode;
  awardSlot?: ReactNode;
  nextStepSlot?: ReactNode;
  bannerSlot?: ReactNode;
  commentsSlot?: ReactNode;
  voteButtonSlot?: ReactNode;
  actionsMenuSlot?: ReactNode;
  attachmentsSlot?: ReactNode;
  alertsSlot?: ReactNode;
  sideRailSlot?: ReactNode;
  descriptionSlot?: ReactNode;
  mergeReviewsSlot?: ReactNode;
  disputeSlot?: ReactNode;
  escalationsSlot?: ReactNode;
  bidsCount?: number;
  commentsCount?: number;
  canReply: boolean;
};

type PipelineTab = "deliverables" | "reviews" | "bids" | "discussion";

export function MarketingTaskDetail({
  bug,
  revisionLimit,
  hold,
  agentPaused,
  isWatching,
  isIssueOwner,
  deliveries,
  reviews,
  bidsSlot,
  awardSlot,
  nextStepSlot,
  bannerSlot,
  commentsSlot,
  voteButtonSlot,
  actionsMenuSlot,
  attachmentsSlot,
  alertsSlot,
  sideRailSlot,
  descriptionSlot,
  mergeReviewsSlot,
  disputeSlot,
  escalationsSlot,
  bidsCount = 0,
  commentsCount = 0,
  canReply,
}: MarketingTaskDetailProps) {
  const isInProgress = bug.status === "in_progress";
  const workerName = hold?.agentName ? `${hold.agentName} (for ${hold.personName})` : null;

  const [activeTab, setActiveTab] = useState<PipelineTab>(() => {
    if (bug.status === "open") return "bids";
    if (bug.status === "done" || bug.substatus === "requires_review") return "reviews";
    return "deliverables";
  });

  useEffect(() => {
    const applyHash = () => {
      const hash = window.location.hash.toLowerCase();
      if (hash === "#comments" || hash.includes("comment")) setActiveTab("discussion");
      else if (hash === "#reviews" || hash === "#verdicts") setActiveTab("reviews");
      else if (hash === "#deliverables") setActiveTab("deliverables");
      else if (hash === "#bids") setActiveTab("bids");
    };

    applyHash();
    window.addEventListener("hashchange", applyHash);
    return () => window.removeEventListener("hashchange", applyHash);
  }, []);

  return (
    <div className="issue-detail-scope flex flex-col gap-5 pb-12" data-testid="marketing-task-detail">
      {/* 1. TOP PAGE HEADER: Back Link + #Number + Title + Badges + Upvote/Actions */}
      <MarketingTaskHeader
        headerOnly
        number={bug.number}
        title={bug.title}
        status={bug.status}
        substatus={bug.substatus}
        taskType={bug.type}
        revisionCount={bug.revisionCount}
        maxRevisions={revisionLimit}
        projectSlug={bug.project.slug}
        reporter={bug.reporter}
        reporterAgent={bug.createdByAgent}
        createdAt={bug.createdAt}
        voteButtonSlot={voteButtonSlot}
        actionsMenuSlot={actionsMenuSlot}
      />

      {/* 2. TOP ALERTS: Deletion notice, Duplicate notice, Resolution note */}
      {alertsSlot}

      {/* 3. TWO-COLUMN GRID: Main Content (Left, ~65%) and Side Rail (Right, ~35%) */}
      <div className="flex flex-wrap items-start gap-5">
        {/* Main Column */}
        <div className="flex min-w-0 flex-[999_1_600px] flex-col gap-5">
          {/* Campaign Focus Banner & Unified Description Card */}
          {descriptionSlot ? (
            descriptionSlot
          ) : (
            <MarketingTaskHeader
              contentOnly
              number={bug.number}
              title={bug.title}
              description={bug.description}
              status={bug.status}
              substatus={bug.substatus}
              projectName={bug.project.name}
              projectFocus={bug.project.goal}
              projectSiteUrl={bug.project.siteUrl}
              rationale={bug.idea?.rationale}
              projectSlug={bug.project.slug}
              revisionCount={bug.revisionCount}
              maxRevisions={revisionLimit}
              createdAt={bug.createdAt}
            />
          )}

          {/* Attachments Card (if any files attached) */}
          {attachmentsSlot}

          {/* Delivered Banner (if work was delivered/sent back) */}
          {bannerSlot}

          {/* Next Step Bar (Guidance for next action) */}
          {nextStepSlot}

          {/* Active Claim / Award Box (when claimed & in progress) */}
          {hold?.status === "active" && isInProgress ? (
            <AwardBox hold={hold} agentPaused={agentPaused} bugId={bug.id} isWatching={isWatching} isIssueOwner={isIssueOwner} />
          ) : null}

          {/* Tabbed Pipeline: Bids & Award, Discussion, Peer Reviews, Deliverables */}
          <div className="flex flex-col gap-3">
            <div className="flex overflow-x-auto pb-1">
              <div
                role="tablist"
                aria-label="Marketing task sections"
                className="flex items-center gap-1 rounded-full bg-zk-seg p-1 text-xs"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === "bids"}
                  aria-controls="panel-bids"
                  id="tab-bids"
                  onClick={() => setActiveTab("bids")}
                  className={`inline-flex cursor-pointer items-center gap-2 rounded-full px-3.5 py-1.5 font-semibold transition-all ${
                    activeTab === "bids"
                      ? "bg-zk-surface text-zk-text shadow-sm"
                      : "text-zk-muted hover:text-zk-text"
                  }`}
                >
                  <span>Bids & Award</span>
                  <span
                    className={`rounded-full px-1.5 py-0.5 font-mono text-[11px] ${
                      activeTab === "bids"
                        ? "bg-zk-tint font-bold text-zk-accent"
                        : "bg-zk-chip text-zk-muted"
                    }`}
                  >
                    {bidsCount}
                  </span>
                </button>

                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === "discussion"}
                  aria-controls="panel-discussion"
                  id="tab-discussion"
                  onClick={() => setActiveTab("discussion")}
                  className={`inline-flex cursor-pointer items-center gap-2 rounded-full px-3.5 py-1.5 font-semibold transition-all ${
                    activeTab === "discussion"
                      ? "bg-zk-surface text-zk-text shadow-sm"
                      : "text-zk-muted hover:text-zk-text"
                  }`}
                >
                  <span>Discussion</span>
                  <span
                    className={`rounded-full px-1.5 py-0.5 font-mono text-[11px] ${
                      activeTab === "discussion"
                        ? "bg-zk-tint font-bold text-zk-accent"
                        : "bg-zk-chip text-zk-muted"
                    }`}
                  >
                    {commentsCount}
                  </span>
                </button>

                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === "reviews"}
                  aria-controls="panel-reviews"
                  id="tab-reviews"
                  onClick={() => setActiveTab("reviews")}
                  className={`inline-flex cursor-pointer items-center gap-2 rounded-full px-3.5 py-1.5 font-semibold transition-all ${
                    activeTab === "reviews"
                      ? "bg-zk-surface text-zk-text shadow-sm"
                      : "text-zk-muted hover:text-zk-text"
                  }`}
                >
                  <span>Peer Reviews</span>
                  <span
                    className={`rounded-full px-1.5 py-0.5 font-mono text-[11px] ${
                      activeTab === "reviews"
                        ? "bg-zk-tint font-bold text-zk-accent"
                        : "bg-zk-chip text-zk-muted"
                    }`}
                  >
                    {reviews.length}
                  </span>
                </button>

                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === "deliverables"}
                  aria-controls="panel-deliverables"
                  id="tab-deliverables"
                  onClick={() => setActiveTab("deliverables")}
                  className={`inline-flex cursor-pointer items-center gap-2 rounded-full px-3.5 py-1.5 font-semibold transition-all ${
                    activeTab === "deliverables"
                      ? "bg-zk-surface text-zk-text shadow-sm"
                      : "text-zk-muted hover:text-zk-text"
                  }`}
                >
                  <span>Deliverables</span>
                  <span
                    className={`rounded-full px-1.5 py-0.5 font-mono text-[11px] ${
                      activeTab === "deliverables"
                        ? "bg-zk-tint font-bold text-zk-accent"
                        : "bg-zk-chip text-zk-muted"
                    }`}
                  >
                    {deliveries.length}
                  </span>
                </button>
              </div>
            </div>

            {/* Tab Panels Container */}
            <div className="rounded-[20px] border border-zk-border bg-zk-surface p-5 sm:p-6">
              {/* Bids & Award Panel */}
              <div
                role="tabpanel"
                id="panel-bids"
                aria-labelledby="tab-bids"
                hidden={activeTab !== "bids"}
                className="flex flex-col gap-4"
              >
                {awardSlot ? (
                  <div className="rounded-xl border border-zk-ok-fg/20 bg-zk-ok-bg/20 p-4">
                    <div className="mb-2 flex items-center justify-between">
                      <div className="text-xs font-bold uppercase tracking-wider text-zk-ok-fg">
                        Award Decision
                      </div>
                      {disputeSlot}
                    </div>
                    {awardSlot}
                  </div>
                ) : null}
                {bidsSlot ? (
                  bidsSlot
                ) : (
                  <div className="rounded-xl border border-dashed border-zk-divider bg-zk-surface/50 p-6 text-center text-sm text-zk-muted">
                    No bids submitted yet for this task.
                  </div>
                )}
              </div>

              {/* Discussion Panel */}
              <div
                role="tabpanel"
                id="panel-discussion"
                aria-labelledby="tab-discussion"
                hidden={activeTab !== "discussion"}
              >
                {commentsSlot ? (
                  commentsSlot
                ) : (
                  <div className="rounded-xl border border-dashed border-zk-divider bg-zk-surface/50 p-6 text-center text-sm text-zk-muted">
                    No comments yet.
                  </div>
                )}
              </div>

              {/* Peer Reviews Panel */}
              <div
                role="tabpanel"
                id="panel-reviews"
                aria-labelledby="tab-reviews"
                hidden={activeTab !== "reviews"}
                className="flex flex-col gap-5"
              >
                {mergeReviewsSlot}
                <MarketingReviewsPanel
                  bugId={bug.id}
                  reviews={reviews}
                  revisionCount={bug.revisionCount}
                  maxRevisions={revisionLimit}
                  canReply={canReply}
                />
              </div>

              {/* Deliverables Panel */}
              <div
                role="tabpanel"
                id="panel-deliverables"
                aria-labelledby="tab-deliverables"
                hidden={activeTab !== "deliverables"}
              >
                <MarketingDeliverablesPanel
                  bugId={bug.id}
                  deliveries={deliveries}
                  isInProgress={isInProgress}
                  workerName={workerName}
                  canReply={canReply}
                />
              </div>
            </div>
          </div>

          {/* Escalations Slot */}
          {escalationsSlot}
        </div>

        {/* Side Rail (Status, Reward, People, Links, ActivityTimeline) */}
        {sideRailSlot ? (
          <aside className="flex min-w-0 flex-[1_1_340px] flex-col gap-4">
            {sideRailSlot}
          </aside>
        ) : null}
      </div>
    </div>
  );
}
