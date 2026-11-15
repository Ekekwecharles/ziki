"use client";

import type { CSSProperties, ReactNode } from "react";
import { ClaimDeadline } from "@/components/claim-deadline";
import type { AgentDecision } from "@/components/issue-agent-activity";
import { useIssueStage } from "@/components/issue-stage-context";
import {
  decisionStageInfo,
  pipelineStages,
  tallyStages,
  type DecisionStage,
} from "@/lib/decision-stages";

/** The design's icon set (#1446), as inline stroke paths. */
const ICONS = {
  bulb: (
    <>
      <path d="M9 18h6M10 22h4" />
      <path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.3h6c0-1 .4-1.8 1-2.3A7 7 0 0 0 12 2Z" />
    </>
  ),
  bot: (
    <>
      <rect x="3" y="8" width="18" height="12" rx="3" />
      <path d="M12 8V4M9 13v2M15 13v2" />
    </>
  ),
  flask: <path d="M9 3h6M10 3v6L4.5 19A1.5 1.5 0 0 0 5.8 21h12.4a1.5 1.5 0 0 0 1.3-2L14 9V3M7 15h10" />,
  merge: (
    <>
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M6 21V9a9 9 0 0 0 9 9" />
    </>
  ),
  rocket: (
    <>
      <path d="M4.5 16.5c-1.5 1.3-2 5-2 5s3.7-.5 5-2c.7-.8.7-2.1-.1-2.9a2.2 2.2 0 0 0-2.9-.1Z" />
      <path d="m12 15-3-3a22 22 0 0 1 2-3.9A12.9 12.9 0 0 1 22 2c0 2.7-.8 7.5-6 11a22.4 22.4 0 0 1-4 2Z" />
      <path d="M9 12H4s.6-3 2-4c1.6-1.1 5 0 5 0M12 15v5s3-.6 4-2c1.1-1.6 0-5 0-5" />
    </>
  ),
  check: <path d="M20 6 9 17l-5-5" />,
  undo: (
    <>
      <path d="M3 7v6h6" />
      <path d="M3 13a9 9 0 1 0 3-7.7L3 8" />
    </>
  ),
  x: <path d="M18 6 6 18M6 6l12 12" />,
  alert: <path d="m10.3 3.9-8.2 14A2 2 0 0 0 3.8 21h16.4a2 2 0 0 0 1.7-3.1l-8.2-14a2 2 0 0 0-3.4 0ZM12 9v4M12 17h.01" />,
  plus: <path d="M12 5v14M5 12h14" />,
  eye: (
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  box: (
    <>
      <path d="M21 8 12 3 3 8v8l9 5 9-5V8Z" />
      <path d="m3 8 9 5 9-5M12 13v8" />
    </>
  ),
  timer: (
    <>
      <circle cx="12" cy="13" r="8" />
      <path d="M12 9v4l2 2M10 2h4" />
    </>
  ),
} as const;

export type IconName = keyof typeof ICONS;

export function StageIcon({ name, style }: { name: IconName; style?: CSSProperties }) {
  return (
    <svg className="i" viewBox="0 0 24 24" aria-hidden="true" style={style}>
      {ICONS[name]}
    </svg>
  );
}

export const stageIconName: Record<DecisionStage, IconName> = {
  idea: "bulb",
  confirm: "eye",
  open: "bot",
  progress: "timer",
  delivered: "box",
  done: "flask",
  ready: "merge",
  live: "rocket",
  closed: "x",
};

/** A chip class from the design: cg ok, cr bad, ca warn, cb info, cn neutral, cv violet. */
export type Tone = "cg" | "cr" | "ca" | "cb" | "cn" | "cv";

type DecisionCard = { label: string; tone: Tone; icon: IconName; text: ReactNode; notes: string | null };

function onBehalf(name: string) {
  return name ? ` on behalf of ${name}` : "";
}

/** How the design draws each decision: its chip, avatar icon and sentence. */
export function decisionCard(decision: AgentDecision): DecisionCard {
  switch (decision.kind) {
    case "confirmed":
      return {
        label: "Confirmed",
        tone: "cg",
        icon: "check",
        text: (
          <>
            Confirmed this issue as real
            {onBehalf(decision.personName)}.
          </>
        ),
        notes: null,
      };
    case "rejected":
      return {
        label: "Rejected",
        tone: "cr",
        icon: "x",
        text: <>Found this isn&apos;t a real issue{onBehalf(decision.personName)}.</>,
        notes: decision.notes,
      };
    case "claimed":
      return {
        label: "Claimed",
        tone: "cb",
        icon: "plus",
        text: (
          <>
            Claimed this issue for {decision.personName}.
            {decision.waitingOnName ? (
              <> Waiting for {decision.waitingOnName} to answer {decision.agentName}&apos;s question.</>
            ) : decision.deliverBy ? (
              <>
                {" "}
                <ClaimDeadline deliverBy={decision.deliverBy} />
                {decision.extendedAt ? " (extension used)" : ""}.
              </>
            ) : null}
          </>
        ),
        notes: null,
      };
    case "delivered":
      return {
        label: "Delivered",
        tone: "cg",
        icon: "box",
        text: <>Delivered the work{onBehalf(decision.personName)}.</>,
        notes: null,
      };
    case "claim_released":
      return {
        label: "Released",
        tone: "cr",
        icon: "x",
        text: <>The claim for {decision.personName} was released.</>,
        notes: null,
      };
    case "verdict":
      return decision.goodToMerge
        ? { label: "Good to merge", tone: "cg", icon: "merge", text: "Said this fix is good to merge.", notes: null }
        : { label: "Not good to merge", tone: "ca", icon: "alert", text: "Said this fix is not good to merge.", notes: null };
    case "accepted":
      return decision.merged
        ? { label: "Deployed", tone: "cg", icon: "rocket", text: "Merged and deployed the fix.", notes: null }
        : { label: "Ready to merge", tone: "cv", icon: "merge", text: "Accepted the fix: it is ready to merge.", notes: null };
    case "merge_rejected":
      return {
        label: "Not good to merge",
        tone: "ca",
        icon: "alert",
        text: "Asked for changes before it can merge.",
        notes: decision.notes,
      };
    case "deploy_failed":
      return {
        label: "Deployment failed",
        tone: "cr",
        icon: "alert",
        text: decision.reason ? `Deployment failed: ${decision.reason}` : "Deployment failed.",
        notes: null,
      };
  }
}

export type StepState = "done" | "now" | "warn" | "todo";

/** Where a stage sits against the current one: behind it, at it, or ahead. */
export function stageState(stage: DecisionStage, currentStage: DecisionStage, setback: boolean): StepState {
  const steps = pipelineStages(currentStage);
  const index = steps.indexOf(stage);
  const currentIndex = steps.indexOf(currentStage);
  return index < currentIndex ? "done" : index > currentIndex ? "todo" : setback ? "warn" : "now";
}

/** "1 bid", "3 bids", "0 confirmations": the count in the stage's own word. */
function entryCount(n: number, [one, many]: readonly [string, string]) {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The design's progress report (#1446). The stepper opens on the issue's
 * current stage; picking a stage switches the Conversation card's stage
 * summary (#186).
 */
export function IssueProgressReport({
  decisions,
  entryCounts = {},
  currentStage,
  setback = false,
  live,
  skippedStages = {},
}: {
  decisions: ReadonlyArray<AgentDecision>;
  /**
   * Each stage's own entries (#595): idea verdicts, confirmations, bids,
   * deliveries, judgements, merge reviews. A stage left out counts its
   * decisions instead (deployments, logs).
   */
  entryCounts?: Partial<Record<DecisionStage, number>>;
  /** Where the issue is now; marked "now" in the stepper. */
  currentStage: DecisionStage;
  /** Real omissions recorded at import; they never count as successful reviews. */
  skippedStages?: Partial<Record<DecisionStage, string>>;
  /** The current stage went backwards, e.g. a merger asked for changes. */
  setback?: boolean;
  /**
   * On a Live issue (#live-check): where its fix really is, in place of the
   * Live step's log count, and whether Live gets its tick (only once released).
   */
  live?: { caption: string; state: Extract<StepState, "done" | "now" | "warn"> };
}) {
  const picked = useIssueStage();
  const selected = picked?.stage ?? currentStage;
  const steps = pipelineStages(currentStage);
  const currentIndex = steps.indexOf(currentStage);
  const tallies = tallyStages(decisions);

  return (
    <section
      aria-labelledby="progress-report-title"
      className="issue-progress rounded-[20px] border border-zk-border bg-zk-surface px-5 py-[18px]"
    >
      {/* No status chip: the stepper below already marks where the issue is (one status per issue). */}
      <h2 id="progress-report-title" className="cap">
        Progress report
      </h2>
      <div className="pgw">
        <div className="pg-track" aria-hidden="true">
          <span className="pg-fill" style={{ width: `${(currentIndex * 100) / (steps.length - 1)}%` }} />
        </div>
        <ol className="pg" aria-label="Progress report: pick a stage to see its entries">
          {steps.map((stage, index) => {
            const tally = tallies[stage];
            const logs = entryCounts[stage] ?? tally.positive + tally.negative;
            const skipped = logs === 0 ? skippedStages[stage] : undefined;
            const checked = stage === "live" ? live : undefined;
            const state = skipped ? "todo" : checked?.state ?? stageState(stage, currentStage, setback);
            const on = stage === selected;
            const icon: IconName = skipped ? "undo" : state === "done" ? "check" : state === "warn" ? (checked ? "alert" : "undo") : stageIconName[stage];
            const isNow = checked ? state !== "done" : index === currentIndex;
            return (
              <li key={stage} style={{ animationDelay: `${index * 70}ms` }}>
                <button
                  type="button"
                  aria-pressed={on}
                  title={skipped ?? decisionStageInfo[stage].description}
                  onClick={() => picked?.setStage(stage)}
                  className={`pgs${isNow ? " now" : ""}${state === "warn" ? " warn" : ""}${
                    state === "todo" ? " todo" : ""
                  }${on ? " sel" : ""}`}
                >
                  <span className={`pgd ${state}`}>
                    <StageIcon name={icon} />
                  </span>
                  <span className="pgl">{decisionStageInfo[stage].label}</span>
                  <span className="pgn" style={checked?.state === "warn" ? { color: "var(--zk-warn-fg)" } : undefined}>
                    {skipped ? "Skipped: outside work" : checked ? checked.caption : index > currentIndex && !logs ? null : entryCount(logs, decisionStageInfo[stage].entry)}
                  </span>
                  <span className="sr-only">
                    {skipped ?? `${decisionStageInfo[stage].label}: ${tally.positive} positive, ${tally.negative} negative`}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}
