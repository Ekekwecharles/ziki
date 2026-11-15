"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { giveRewardEstimateAction } from "@/app/actions/reward";
import { LocalTime } from "@/components/local-time";
import { formatZ, REWARD_MAX, REWARD_MAX_ESTIMATES } from "@/lib/points/rules";

export type RewardEstimateView = {
  id: string;
  userId: string;
  by: string;
  agentName: string | null;
  value: number;
  reason: string | null;
  updatedAt: Date | string;
};

/** The choices, in steps of $2 so they fit on one line: $2, $4, … $10. */
const VALUES = Array.from({ length: Math.floor(REWARD_MAX / 2) }, (_, index) => (index + 1) * 2);

/**
 * The issue page's Reward panel (#rewards): what solving the issue pays (the
 * average of the estimates, fixed at 15), a place to give or change your own
 * estimate, and every estimate so far with who gave it and why.
 */
export function IssueRewardPanel({
  bugId,
  reward,
  estimates,
  fixed,
  viewerId,
  canEstimate,
  caption,
  children,
}: {
  /** Drawn right under the amount, before the estimates: where the issue is funded (#ziki-coins). */
  children?: React.ReactNode;
  bugId: string;
  reward: number;
  estimates: RewardEstimateView[];
  fixed: boolean;
  viewerId: string | null;
  /** False on a closed or deleted issue. */
  canEstimate: boolean;
  caption?: string;
}) {
  const id = useId();
  const router = useRouter();
  const mine = viewerId ? estimates.find((estimate) => estimate.userId === viewerId) ?? null : null;
  const [value, setValue] = useState<number | null>(mine?.value ?? null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const open = canEstimate && !fixed && Boolean(viewerId);

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSaved(null);
    if (value === null) return setError("Pick what it is worth.");
    const data = new FormData();
    data.set("value", String(value));
    startTransition(async () => {
      const result = await giveRewardEstimateAction(bugId, data);
      if (result.error) {
        setError(result.error);
        return;
      }
      setSaved(result.replaced ? "Your estimate was updated." : "Your estimate was added.");
      router.refresh();
    });
  };

  return (
    <section aria-labelledby={`${id}-heading`} className="flex flex-col gap-3 rounded-[20px] border border-zk-border bg-zk-surface px-4 py-3.5" data-testid="reward-panel">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id={`${id}-heading`} className="text-xs font-bold uppercase tracking-[0.08em] text-zk-muted">Reward</h2>
        {fixed ? <span className="text-xs text-zk-muted">Fixed</span> : null}
      </div>
      <p className="m-0 flex items-center justify-center gap-5 py-2">
        <span className="font-mono text-[32px] font-extrabold leading-none tabular-nums text-zk-text" data-testid="reward-amount">{formatZ(reward)}</span>
        <span className="max-w-[40ch] text-xs leading-relaxed text-zk-muted">{caption ?? "paid to whoever solves it, once three people report it deployed"}</span>
      </p>

      {children}

      {open ? (
        <form onSubmit={submit} aria-label="Your estimate" className="flex flex-col gap-2">
          <fieldset className="m-0 border-0 p-0">
            <legend className="mb-1.5 text-[13px] font-semibold text-zk-text">{mine ? "Change your estimate" : "Your estimate"}</legend>
            {/* The choices, with the button at the right of the same row. */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-nowrap gap-1.5">
                {VALUES.map((option) => (
                  <label
                    key={option}
                    className={`inline-flex h-8 min-w-9 cursor-pointer items-center justify-center rounded-lg border px-2 text-[13px] font-bold tabular-nums transition has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-electric-blue-strong ${
                      value === option ? "border-electric-blue-strong bg-electric-blue-strong text-white" : "border-zk-border bg-zk-surface text-zk-text hover:bg-zk-chip"
                    }`}
                  >
                    <input type="radio" name="value" value={option} checked={value === option} onChange={() => setValue(option)} className="sr-only" />
                    {formatZ(option)}
                  </label>
                ))}
              </div>
              <button
                type="submit"
                disabled={pending}
                className="ml-auto inline-flex h-8 items-center rounded-full border border-zk-border bg-zk-surface px-4 text-[13px] font-bold text-zk-text transition hover:bg-zk-chip focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-electric-blue-strong disabled:opacity-50"
              >
                {pending ? "Saving…" : mine ? "Update" : "Add"}
              </button>
            </div>
          </fieldset>
          {error ? <p role="alert" className="m-0 text-xs font-medium text-zk-bad-fg">{error}</p> : null}
          {saved ? <p role="status" className="m-0 text-xs font-medium text-zk-ok-fg">{saved}</p> : null}
        </form>
      ) : fixed ? (
        <p className="m-0 text-xs text-zk-muted">The reward is fixed after {REWARD_MAX_ESTIMATES} estimates.</p>
      ) : null}

      {estimates.length === 0 ? null : (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0" aria-label="Estimates" data-testid="reward-estimates">
          {[...estimates].reverse().map((estimate) => (
            <li key={estimate.id} className="rounded-lg bg-zk-chip px-2.5 py-1.5 text-[13px]">
              <div className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 truncate">
                  <b className="font-semibold text-zk-text">{estimate.by}</b>
                  {estimate.agentName ? <span className="text-zk-muted"> via {estimate.agentName}</span> : null}
                </span>
                <span className="font-mono font-bold tabular-nums text-zk-text">{formatZ(estimate.value)}</span>
              </div>
              {estimate.reason ? <p className="m-0 mt-0.5 text-xs text-zk-text2">{estimate.reason}</p> : null}
              <p className="m-0 mt-0.5 text-[11px] text-zk-muted">
                <LocalTime date={estimate.updatedAt} />
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
