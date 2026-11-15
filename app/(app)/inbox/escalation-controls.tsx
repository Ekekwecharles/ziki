"use client";

import { useActionState, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  answerEscalationAction,
  quickResolveEscalationAction,
  type AnswerActionResult,
} from "./actions";
import type { EscalationType } from "@/lib/agent-questions";

export function EscalationTypeBadge({ type }: { type: EscalationType | string }) {
  const styles: Record<string, string> = {
    Blocker: "bg-zk-bad-bg text-zk-bad-fg border-zk-bad-bd",
    "Work Authorization": "bg-zk-warn-bg text-zk-warn-fg border-zk-warn-bd",
    "Human Approval": "bg-zk-info-bg text-zk-info-fg border-zk-border",
    "No Proof": "bg-zk-warn-bg text-zk-warn-fg border-zk-warn-bd",
    "Scope Expansion": "bg-zk-warn-bg text-zk-warn-fg border-zk-warn-bd",
    Question: "bg-zk-chip text-zk-text2 border-zk-border",
    Redesign: "bg-zk-info-bg text-zk-info-fg border-zk-border",
  };

  const icons: Record<string, string> = {
    Blocker: "🛑",
    "Work Authorization": "🛡️",
    "Human Approval": "👤",
    "No Proof": "📎",
    "Scope Expansion": "⚠️",
    Question: "❓",
    Redesign: "✎",
  };

  const badgeStyle = styles[type] ?? styles.Question;
  const icon = icons[type] ?? "❓";

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${badgeStyle}`}
    >
      <span aria-hidden="true">{icon}</span>
      <span>{type}</span>
    </span>
  );
}

export function QuickResolveButtons({
  escalationId,
  onResolved,
}: {
  escalationId: string;
  onResolved?: () => void;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const handleResolve = (actionType: "approve" | "authorize") => {
    setError(null);
    startTransition(async () => {
      try {
        const res = await quickResolveEscalationAction(escalationId, actionType);
        if (res.ok) {
          onResolved?.();
          router.refresh();
        } else {
          setError(res.error);
        }
      } catch {
        setError("Could not send your response. Please try again.");
      }
    });
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          disabled={isPending}
          onClick={() => handleResolve("approve")}
          className="rounded-full bg-zk-ok-fg px-3.5 py-2 text-xs font-semibold text-white hover:opacity-90 focus-visible:ring-zk-ok-fg"
        >
          {isPending ? "Unblocking…" : "✓ Approve & Unblock"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={isPending}
          onClick={() => handleResolve("authorize")}
          className="rounded-full border border-zk-border bg-zk-surface px-3.5 py-2 text-xs font-semibold text-zk-text hover:bg-zk-chip"
        >
          Authorize Work
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-zk-bad-fg">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function EscalationAnswerForm({
  escalationId,
  labelledBy,
}: {
  escalationId: string;
  labelledBy?: string;
}) {
  const [result, action, pending] = useActionState<AnswerActionResult | undefined, FormData>(
    answerEscalationAction,
    undefined,
  );
  const error = result && !result.ok ? result.error : null;

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="escalationId" value={escalationId} />
      <div className="space-y-1">
        {!labelledBy ? (
          <label htmlFor="answer" className="block text-sm font-semibold text-zk-text">
            Your response
          </label>
        ) : null}
        <Textarea
          id="answer"
          name="answer"
          rows={4}
          required
          maxLength={2000}
          placeholder="Provide decision, unblocking guidance, or instructions..."
          aria-labelledby={labelledBy}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "answer-error" : undefined}
        />
      </div>
      {error ? (
        <p id="answer-error" role="alert" className="text-sm text-zk-bad-fg">
          {error}
        </p>
      ) : null}
      <div className="flex items-center gap-3">
        <Button
          type="submit"
          disabled={pending}
          className="rounded-full bg-electric-blue-strong px-4 py-2 font-semibold text-white hover:opacity-90 focus-visible:ring-electric-blue"
        >
          {pending ? "Sending…" : "Send response"}
        </Button>
        <span className="text-xs text-zk-muted">
          The response cannot be edited once dispatched to the agent.
        </span>
      </div>
    </form>
  );
}
