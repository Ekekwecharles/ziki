"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/toast";
import {
  acceptOfferForMyAgentAction,
  deliverForMyAgentAction,
  giveMergeReviewAction,
  giveTestVerdictAction,
  openForBidsAction,
  type StepResult,
} from "@/app/actions/human-steps";

/**
 * The one thing the viewer can do at this step, through their agent
 * (#owner-control). It sits under the next-step bar and shows at most one
 * action, only when the issue is at that step and the viewer is allowed:
 * open a confirmed issue for bids, deliver their agent's work, judge delivered
 * work, review accepted work for merge, or accept an offer made to their agent. Agents do the same
 * through the API; this is the same step, by hand.
 */
export type YourTurn =
  | { kind: "open"; agentName: string; confirmations: number; needed: number }
  | { kind: "verdict"; agentName: string }
  | { kind: "review"; agentName: string }
  | { kind: "offer"; agentName: string }
  | { kind: "deliver"; agentName: string };

const COPY: Record<YourTurn["kind"], { title: string; body: (turn: YourTurn) => string }> = {
  open: {
    title: "Ready to open for bids",
    body: (turn) =>
      turn.kind === "open"
        ? `${turn.confirmations} of ${turn.needed} confirmations are in. Open it so agents can bid on the work.`
        : "",
  },
  verdict: { title: "Is this work good to merge?", body: () => "Look at the delivered work and say whether it's ready. Your verdict counts toward accepting it." },
  review: { title: "Review this for merge", body: () => "Testers say it's good. Approve it for merging, or send it back with what to change." },
  offer: { title: "This issue was offered to your agent", body: (turn) => `Accept it and ${turn.agentName} starts working on it.` },
  deliver: {
    title: "Deliver the work",
    body: () => "When the pull request is ready, hand it in here. Other agents then test it before it can merge.",
  },
};

export function YourTurnCard({ bugId, turn }: { bugId: string; turn: YourTurn }) {
  const copy = COPY[turn.kind];
  const [writing, setWriting] = useState<null | "good" | "bad">(null);
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [files, setFiles] = useState("");
  const [pullRequestUrl, setPullRequestUrl] = useState("");
  const [proof, setProof] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const toast = useToast();
  const router = useRouter();
  const summaryId = useId();
  const descriptionId = useId();
  const filesId = useId();
  const prId = useId();
  const proofId = useId();

  const go = (step: () => Promise<StepResult>, done: string) => {
    setError(null);
    startTransition(async () => {
      const result = await step();
      if ("error" in result) {
        setError(result.error);
        return;
      }
      toast(done);
      setWriting(null);
      router.refresh();
    });
  };

  const submitEntry = () => {
    if (!writing) return;
    if (!summary.trim() || !description.trim()) {
      setError("Add a one-line summary and a few words on why.");
      return;
    }
    if (turn.kind === "verdict") {
      go(() => giveTestVerdictAction(bugId, { goodToMerge: writing === "good", summary, description, files }), "Verdict saved.");
    } else if (turn.kind === "review") {
      go(
        () => giveMergeReviewAction(bugId, { verdict: writing === "good" ? "accept" : "reject", summary, description }),
        writing === "good" ? "Approved for merge." : "Sent back for changes.",
      );
    }
  };

  const submitDelivery = () => {
    if (!pullRequestUrl.trim() || !summary.trim() || !description.trim() || !proof.trim()) {
      setError("Fill in all four: the pull request, a summary, what changed, and how you checked it works.");
      return;
    }
    go(() => deliverForMyAgentAction(bugId, { pullRequestUrl, summary, description, proof }), "Delivered. Other agents can test it now.");
  };

  const input = "rounded-lg border border-zk-border bg-zk-bg px-2.5 py-2 text-sm text-zk-text";
  const fieldLabel = "text-xs font-medium text-zk-text2";

  const yes = turn.kind === "review" ? "Approve for merge" : "Good to merge";
  const no = turn.kind === "review" ? "Send back" : "Not yet";

  return (
    <section
      aria-label="Your turn"
      data-testid="your-turn"
      className="flex flex-col gap-3 rounded-[20px] border border-zk-accent/40 bg-zk-surface p-4 sm:p-5"
    >
      <div className="flex flex-col gap-1">
        <p className="m-0 text-[11px] font-bold uppercase tracking-[0.08em] text-zk-accent">Your turn · as {turn.agentName}</p>
        <h2 className="m-0 text-base font-semibold text-zk-text">{copy.title}</h2>
        <p className="m-0 text-sm text-zk-text2">{copy.body(turn)}</p>
      </div>

      {turn.kind === "open" ? (
        <div>
          <button
            type="button"
            disabled={pending}
            onClick={() => go(() => openForBidsAction(bugId), "Opened for bids.")}
            className="rounded-lg bg-zk-accent px-3.5 py-2 text-sm font-semibold text-white disabled:opacity-60"
          >
            {pending ? "Opening…" : "Open for bids"}
          </button>
        </div>
      ) : null}

      {turn.kind === "offer" ? (
        <div>
          <button
            type="button"
            disabled={pending}
            onClick={() => go(() => acceptOfferForMyAgentAction(bugId), `${turn.agentName} is on it.`)}
            className="rounded-lg bg-zk-accent px-3.5 py-2 text-sm font-semibold text-white disabled:opacity-60"
          >
            {pending ? "Accepting…" : `Accept for ${turn.agentName}`}
          </button>
        </div>
      ) : null}

      {turn.kind === "deliver" ? (
        writing ? (
          <div className="flex flex-col gap-2">
            <label htmlFor={prId} className={fieldLabel}>
              Pull request link
            </label>
            <input
              id={prId}
              type="url"
              value={pullRequestUrl}
              placeholder="https://github.com/owner/repo/pull/123"
              onChange={(event) => setPullRequestUrl(event.target.value)}
              className={input}
            />
            <label htmlFor={summaryId} className={fieldLabel}>
              In a sentence or two, what did you do?
            </label>
            <input id={summaryId} value={summary} maxLength={300} onChange={(event) => setSummary(event.target.value)} className={input} />
            <label htmlFor={descriptionId} className={fieldLabel}>
              What changed, and anything left open
            </label>
            <textarea id={descriptionId} value={description} rows={3} onChange={(event) => setDescription(event.target.value)} className={`resize-y ${input}`} />
            <label htmlFor={proofId} className={fieldLabel}>
              How you checked it works (test results or steps)
            </label>
            <textarea
              id={proofId}
              value={proof}
              rows={3}
              placeholder="pnpm test: 1680 passed. Opened the issue page and moved it to Live."
              onChange={(event) => setProof(event.target.value)}
              className={`resize-y font-mono text-xs ${input}`}
            />
            {error ? (
              <p role="alert" className="m-0 text-xs font-medium text-zk-bad-fg">
                {error}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <button type="button" disabled={pending} onClick={() => setWriting(null)} className="rounded-lg px-3 py-1.5 text-xs font-semibold text-zk-text2 hover:bg-zk-chip">
                Back
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={submitDelivery}
                className="rounded-lg bg-zk-accent px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
              >
                {pending ? "Delivering…" : "Deliver"}
              </button>
            </div>
          </div>
        ) : (
          <div>
            <button type="button" onClick={() => setWriting("good")} className="rounded-lg bg-zk-accent px-3.5 py-2 text-sm font-semibold text-white">
              Deliver the work
            </button>
          </div>
        )
      ) : null}

      {turn.kind === "verdict" || turn.kind === "review" ? (
        writing ? (
          <div className="flex flex-col gap-2">
            <label htmlFor={summaryId} className="text-xs font-medium text-zk-text2">
              {writing === "good" ? "In a sentence, why is it ready?" : "In a sentence, what needs to change?"}
            </label>
            <input
              id={summaryId}
              value={summary}
              maxLength={300}
              onChange={(event) => setSummary(event.target.value)}
              className="rounded-lg border border-zk-border bg-zk-bg px-2.5 py-2 text-sm text-zk-text"
            />
            <label htmlFor={descriptionId} className="text-xs font-medium text-zk-text2">
              What did you check?
            </label>
            <textarea
              id={descriptionId}
              value={description}
              rows={3}
              onChange={(event) => setDescription(event.target.value)}
              className="resize-y rounded-lg border border-zk-border bg-zk-bg px-2.5 py-2 text-sm text-zk-text"
            />
            {turn.kind === "verdict" ? (
              <>
                <label htmlFor={filesId} className="text-xs font-medium text-zk-text2">
                  Files you checked, one per line (add :40-58 for lines)
                </label>
                <textarea
                  id={filesId}
                  value={files}
                  rows={2}
                  placeholder="app/api/v1/issues/route.ts:40-58"
                  onChange={(event) => setFiles(event.target.value)}
                  className="resize-y rounded-lg border border-zk-border bg-zk-bg px-2.5 py-2 font-mono text-xs text-zk-text"
                />
              </>
            ) : null}
            {error ? (
              <p role="alert" className="m-0 text-xs font-medium text-zk-bad-fg">
                {error}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <button type="button" disabled={pending} onClick={() => setWriting(null)} className="rounded-lg px-3 py-1.5 text-xs font-semibold text-zk-text2 hover:bg-zk-chip">
                Back
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={submitEntry}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60 ${writing === "good" ? "bg-zk-accent" : "bg-zk-text2"}`}
              >
                {pending ? "Saving…" : writing === "good" ? yes : no}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => setWriting("good")} className="rounded-lg bg-zk-accent px-3.5 py-2 text-sm font-semibold text-white">
              {yes}
            </button>
            <button type="button" onClick={() => setWriting("bad")} className="rounded-lg border border-zk-border bg-zk-surface px-3.5 py-2 text-sm font-semibold text-zk-text hover:bg-zk-chip">
              {no}
            </button>
          </div>
        )
      ) : null}

      {error && !writing ? (
        <p role="alert" className="m-0 text-xs font-medium text-zk-bad-fg">
          {error}
        </p>
      ) : null}
    </section>
  );
}
