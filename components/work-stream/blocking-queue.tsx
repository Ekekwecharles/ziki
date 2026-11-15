"use client";

import Link from "next/link";

export interface BlockingQueueItem {
  id: string;
  issueNumber: number;
  projectSlug?: string;
  title: string;
  actionRequired: "triage_vote" | "implementation_bid" | "pr_review" | "discussion";
  expeditedBy: {
    name: string;
    /** Optional public handle. Never derived from an email address. */
    handle?: string;
    avatarUrl?: string;
  };
  urgencyNote?: string;
  progress: {
    current: number;
    required: number;
    unit: string; // e.g. "votes", "bids", "reviews"
  };
  expeditedAt: string;
  status: "active_blocking" | "cleared";
}

export interface BlockingQueueProps {
  items: BlockingQueueItem[];
  currentHaltedAgentsCount?: number;
  className?: string;
}

const ACTION_LABELS: Record<
  BlockingQueueItem["actionRequired"],
  { label: string; icon: string; role: string; color: string }
> = {
  triage_vote: {
    label: "Triage & Readiness Vote",
    icon: "🗳️",
    role: "Reviewers / Triagers",
    color: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  },
  implementation_bid: {
    label: "Implementation & Claim",
    icon: "🔨",
    role: "Builders / Coders",
    color: "border-blue-500/40 bg-blue-500/10 text-blue-300",
  },
  pr_review: {
    label: "PR Review Consensus",
    icon: "🔍",
    role: "Lead Reviewers",
    color: "border-purple-500/40 bg-purple-500/10 text-purple-300",
  },
  discussion: {
    label: "Reporter Clarification",
    icon: "💬",
    role: "Assigned Agents",
    color: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  },
};

export function WorkStreamBlockingQueue({
  items,
  currentHaltedAgentsCount = 4,
  className = "",
}: BlockingQueueProps) {
  const activeItems = items.filter((i) => i.status === "active_blocking");

  if (activeItems.length === 0) {
    return (
      <div
        className={`rounded-2xl border border-[#1f2d52] bg-[#0c1630] p-5 text-slate-300 shadow-md ${className}`}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 text-sm">
              ✓
            </span>
            <div>
              <h3 className="text-sm font-semibold text-white">
                Work Stream Priority Queue: Clear
              </h3>
              <p className="text-xs text-slate-400">
                No active blocking items. Agent workers are processing routine backlog tasks freely.
              </p>
            </div>
          </div>
          <span className="text-xs text-slate-400 font-mono">Quota: 3/3 Daily Available</span>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`rounded-2xl border-2 border-red-500/40 bg-[#0c1630] p-5 shadow-xl relative overflow-hidden ${className}`}
      style={{
        boxShadow: "0 0 35px -5px rgba(239, 68, 68, 0.2)",
      }}
    >
      {/* Top Banner Alert Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-[#1f2d52] pb-4 mb-4">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-red-500/20 text-red-400 border border-red-500/40 font-bold text-base animate-pulse">
            🚨
          </span>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-bold tracking-tight text-white uppercase">
                Mandatory Priority Blocking Queue
              </h3>
              <span className="rounded-full bg-red-500/20 border border-red-500/50 px-2 py-0.5 text-[10px] font-bold text-red-300">
                {activeItems.length} BLOCKING {activeItems.length === 1 ? "ITEM" : "ITEMS"}
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              Agents are strictly prohibited from routine tasks until all blocking items below are resolved.
            </p>
          </div>
        </div>

        {/* Halted Agents Pill */}
        <div className="flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-200">
          <span className="h-2 w-2 rounded-full bg-amber-400 animate-ping" />
          <span>
            <strong>{currentHaltedAgentsCount} agents</strong> currently waiting on this queue
          </span>
        </div>
      </div>

      {/* List of Blocking Items */}
      <div className="space-y-3">
        {activeItems.map((item) => {
          const actionMeta = ACTION_LABELS[item.actionRequired];
          const pct = Math.min(
            100,
            Math.round((item.progress.current / item.progress.required) * 100)
          );
          const needed = item.progress.required - item.progress.current;

          return (
            <div
              key={item.id}
              className="rounded-xl border border-[#1f2d52] bg-[#070d1f]/80 p-4 transition hover:border-[#2a3a66]"
            >
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                <div className="space-y-2 flex-1">
                  {/* Action and Priority badges */}
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex items-center gap-1 rounded-full border border-red-500/40 bg-red-500/15 px-2.5 py-0.5 text-[11px] font-bold text-red-300">
                      ⚡ EXPEDITED P0
                    </span>
                    <span
                      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${actionMeta.color}`}
                    >
                      <span>{actionMeta.icon}</span> {actionMeta.label}
                    </span>
                    <span className="text-[11px] text-slate-400">
                      Target: <strong className="text-slate-300">{actionMeta.role}</strong>
                    </span>
                  </div>

                  {/* Title */}
                  <div className="text-sm font-semibold text-white">
                    <Link
                      href={item.projectSlug ? `/${item.projectSlug}/issues/${item.issueNumber}` : `/issues/${item.issueNumber}`}
                      className="hover:text-amber-400 transition"
                    >
                      #{item.issueNumber} {item.title}
                    </Link>
                  </div>

                  {/* Urgency note */}
                  {item.urgencyNote ? (
                    <div className="rounded-lg bg-[#0c1630] border border-[#1f2d52] px-3 py-1.5 text-xs text-amber-200/90 italic">
                      &ldquo;{item.urgencyNote}&rdquo;
                    </div>
                  ) : null}

                  {/* Expedited by & timestamp */}
                  <div className="flex items-center gap-3 text-xs text-slate-400">
                    <span>
                      Expedited by{" "}
                      <strong className="text-slate-200">
                        {item.expeditedBy.name}
                        {item.expeditedBy.handle ? ` (${item.expeditedBy.handle})` : null}
                      </strong>
                    </span>
                    <span>·</span>
                    <span>{item.expeditedAt}</span>
                  </div>
                </div>

                {/* Progress Box & Action Button */}
                <div className="sm:w-56 shrink-0 flex flex-col justify-between items-end gap-3 bg-[#0c1630] border border-[#1f2d52] p-3 rounded-xl">
                  <div className="w-full">
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="text-slate-400 font-medium">Consensus:</span>
                      <span className="font-mono font-bold text-white">
                        {item.progress.current} / {item.progress.required} {item.progress.unit}
                      </span>
                    </div>
                    {/* Progress Bar */}
                    <div className="h-2 w-full rounded-full bg-[#070d1f] overflow-hidden border border-[#1f2d52]">
                      <div
                        className="h-full bg-linear-to-r from-amber-500 to-amber-400 transition-all duration-300"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <p className="mt-1 text-[11px] text-amber-300 font-medium text-right">
                      {needed > 0
                        ? `Need ${needed} more ${needed === 1 ? item.progress.unit.slice(0, -1) : item.progress.unit} to unblock`
                        : "Threshold met · clearing block"}
                    </p>
                  </div>

                  <Link
                    href={item.projectSlug ? `/${item.projectSlug}/issues/${item.issueNumber}` : `/issues/${item.issueNumber}`}
                    className="w-full text-center rounded-lg bg-amber-500 hover:bg-amber-400 px-3 py-1.5 text-xs font-semibold text-slate-950 transition shadow-xs"
                  >
                    Act Now to Unblock →
                  </Link>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
