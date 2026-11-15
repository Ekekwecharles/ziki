"use client";

import { useId, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ownerAcceptIdeaAction, ownerArchiveIdeaAction, ownerRejectIdeaAction } from "@/app/actions/owner-moves";
import { IssueActionsMenu } from "@/components/issue-actions-menu";
import { useToast } from "@/components/ui/toast";

const ARCHIVE_CHOICES = [
  { value: "already_implemented", label: "It's already done" },
  { value: "duplicate", label: "Someone suggested it already" },
  { value: "wrong_project", label: "It belongs in another project" },
] as const;

/**
 * The organisation owner's say on an idea (#owner-control): accept it as an
 * issue now, whatever its votes; turn it down with a reason; or, from the ⋯
 * menu, archive it. No agent needed.
 */
export function OwnerIdeaControls({
  ideaId,
  ideaNumber,
  issuePathFor,
  score,
  threshold,
  more,
}: {
  ideaId: string;
  ideaNumber: number;
  /** The new issue's address, from its number. */
  issuePathFor: string;
  score: number;
  threshold: number;
  /** Other rare idea actions for the ⋯ menu (Withdraw, when it's the owner's own idea). */
  more?: ReactNode;
}) {
  const [mode, setMode] = useState<null | "accept" | "reject" | "archive">(null);
  const [reason, setReason] = useState("");
  const [archiveReason, setArchiveReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const toast = useToast();
  const router = useRouter();
  const reasonId = useId();
  const archiveId = useId();
  const early = score < threshold;

  const reset = () => {
    setMode(null);
    setReason("");
    setArchiveReason("");
    setError(null);
  };

  const submit = () => {
    setError(null);
    startTransition(async () => {
      if (mode === "accept") {
        const result = await ownerAcceptIdeaAction(ideaId);
        if ("error" in result) return setError(result.error);
        toast(`Idea #${ideaNumber} is now an issue.`);
        if (result.issueNumber) router.push(`${issuePathFor}/${result.issueNumber}`);
        else router.refresh();
        return;
      }
      const result =
        mode === "reject" ? await ownerRejectIdeaAction(ideaId, reason) : await ownerArchiveIdeaAction(ideaId, archiveReason, reason);
      if ("error" in result) return setError(result.error);
      toast(mode === "reject" ? "Idea turned down." : "Idea archived.");
      reset();
      router.refresh();
    });
  };

  if (mode) {
    return (
      <div className="flex flex-col gap-2.5 text-sm" data-testid="owner-idea-confirm">
        <p className="m-0 font-semibold text-zk-text">
          {mode === "accept"
            ? `Turn idea #${ideaNumber} into an issue?`
            : mode === "reject"
              ? `Turn down idea #${ideaNumber}?`
              : `Archive idea #${ideaNumber}?`}
        </p>
        {mode === "accept" ? (
          <p className="m-0 text-xs text-zk-text2">
            {early
              ? `It has ${score} of the ${threshold} votes it would normally need. As the owner you can accept it now. Agents will then confirm it and bid on the work.`
              : "Agents will confirm it and bid on the work."}
          </p>
        ) : null}
        {mode === "archive" ? (
          <label htmlFor={archiveId} className="flex flex-col gap-1 text-xs text-zk-text2">
            Why?
            <select
              id={archiveId}
              value={archiveReason}
              onChange={(event) => setArchiveReason(event.target.value)}
              className="rounded-lg border border-zk-border bg-zk-bg px-2 py-1.5 text-sm text-zk-text"
            >
              <option value="">Choose a reason</option>
              {ARCHIVE_CHOICES.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {mode !== "accept" ? (
          <label htmlFor={reasonId} className="flex flex-col gap-1 text-xs text-zk-text2">
            {mode === "reject" ? "Why not? Whoever suggested it will see this." : "Show where: the pull request, the other idea, or the right project."}
            <textarea
              id={reasonId}
              value={reason}
              rows={3}
              maxLength={500}
              onChange={(event) => setReason(event.target.value)}
              className="resize-y rounded-lg border border-zk-border bg-zk-bg px-2.5 py-2 text-sm text-zk-text"
            />
          </label>
        ) : null}
        {error ? (
          <p role="alert" className="m-0 text-xs font-medium text-zk-bad-fg">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <button type="button" disabled={pending} onClick={reset} className="rounded-lg px-3 py-1.5 text-xs font-semibold text-zk-text2 hover:bg-zk-chip">
            Back
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={submit}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60 ${mode === "accept" ? "bg-zk-accent" : "bg-zk-bad-fg"}`}
          >
            {pending ? "Saving…" : mode === "accept" ? "Accept idea" : mode === "reject" ? "Turn down" : "Archive"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="owner-idea-controls">
      <button type="button" onClick={() => setMode("accept")} className="rounded-lg bg-zk-accent px-3.5 py-2 text-sm font-semibold text-white">
        Accept idea
      </button>
      <button
        type="button"
        onClick={() => setMode("reject")}
        className="rounded-lg border border-zk-border bg-zk-surface px-3.5 py-2 text-sm font-semibold text-zk-text hover:bg-zk-chip"
      >
        Turn down…
      </button>
      <div className="ml-auto">
        <IssueActionsMenu>
          <button
            type="button"
            onClick={() => setMode("archive")}
            className="rounded-lg border border-zk-border px-2.5 py-1.5 text-left text-xs font-semibold text-zk-text hover:bg-zk-chip"
          >
            Archive idea…
          </button>
          {more}
        </IssueActionsMenu>
      </div>
    </div>
  );
}
