"use client";

import { useId, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { assignBugAction } from "@/app/actions/issues";
import { extendMyAgentAction, releaseMyAgentAction } from "@/app/actions/human-steps";

/**
 * The rarer issue actions that live in the ⋯ menu (#owner-control). Each is a
 * plain menu button that opens a short form in place, inside the menu, so
 * nothing new sits on the page until someone asks for it.
 */
function MenuForm({
  label,
  tone,
  children,
}: {
  label: string;
  tone?: "danger";
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <div className="flex flex-col gap-2">
      <Button
        type="button"
        variant="secondary"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className={`cursor-pointer justify-start px-2.5 py-1.5 text-left text-xs ${tone === "danger" ? "text-zk-bad-fg" : ""}`}
      >
        {label}
      </Button>
      {open ? (
        <div id={panelId} className="flex flex-col gap-2 rounded-xl border border-zk-border bg-zk-bg p-2.5 text-xs">
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}

function useStep() {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const toast = useToast();
  const router = useRouter();
  const go = (step: () => Promise<{ error?: string } | { ok: true }>, done: string, after?: () => void) => {
    setError(null);
    startTransition(async () => {
      const result = await step();
      const failed = "error" in result ? result.error : undefined;
      if (failed) {
        setError(failed);
        return;
      }
      toast(done);
      after?.();
      router.refresh();
    });
  };
  return { error, pending, go };
}

function Actions({ pending, label, onCancel, onGo, tone }: { pending: boolean; label: string; onCancel: () => void; onGo: () => void; tone?: "danger" }) {
  return (
    <div className="flex justify-end gap-2">
      <button type="button" disabled={pending} onClick={onCancel} className="rounded-lg px-2.5 py-1 font-semibold text-zk-text2 hover:bg-zk-chip">
        Cancel
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={onGo}
        className={`rounded-lg px-2.5 py-1 font-semibold text-white disabled:opacity-60 ${tone === "danger" ? "bg-zk-bad-fg" : "bg-zk-accent"}`}
      >
        {pending ? "Saving…" : label}
      </button>
    </div>
  );
}

function ErrorLine({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="m-0 font-medium text-zk-bad-fg">
      {error}
    </p>
  ) : null;
}

/** Owner: hand the issue to a member's agent directly, without bidding. */
export function AssignToItem({ bugId, members, currentAssigneeId }: { bugId: string; members: { id: string; name: string; agentName: string }[]; currentAssigneeId: string | null }) {
  const [choice, setChoice] = useState("");
  const { error, pending, go } = useStep();
  const selectId = useId();
  const options = members.filter((member) => member.id !== currentAssigneeId);
  return (
    <MenuForm label="Assign to someone…">
      {(close) => (
        <>
          <label htmlFor={selectId} className="font-medium text-zk-text2">
            Who should work on it? Their agent gets the offer.
          </label>
          {options.length === 0 ? (
            <p className="m-0 text-zk-muted">Nobody else here has an agent yet.</p>
          ) : (
            <select
              id={selectId}
              value={choice}
              onChange={(event) => setChoice(event.target.value)}
              className="rounded-lg border border-zk-border bg-zk-surface px-2 py-1.5 text-xs text-zk-text"
            >
              <option value="">Choose a person</option>
              {options.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name} (agent: {member.agentName})
                </option>
              ))}
            </select>
          )}
          <ErrorLine error={error} />
          <Actions
            pending={pending}
            label="Assign"
            onCancel={close}
            onGo={() => (choice ? go(() => assignBugAction(bugId, choice), "Assigned. Their agent has the offer.", close) : undefined)}
          />
        </>
      )}
    </MenuForm>
  );
}

/** The person whose agent holds the issue: let it go, back to Open. */
export function StopMyAgentItem({ bugId, agentName }: { bugId: string; agentName: string }) {
  const [reason, setReason] = useState("");
  const { error, pending, go } = useStep();
  const fieldId = useId();
  return (
    <MenuForm label={`Stop ${agentName} working on this`} tone="danger">
      {(close) => (
        <>
          <p className="m-0 text-zk-text">{agentName} lets go of the issue. If nothing was delivered yet, it goes back to Open so others can bid.</p>
          <label htmlFor={fieldId} className="font-medium text-zk-text2">
            Why? (optional)
          </label>
          <input
            id={fieldId}
            value={reason}
            maxLength={140}
            onChange={(event) => setReason(event.target.value)}
            className="rounded-lg border border-zk-border bg-zk-surface px-2 py-1.5 text-xs text-zk-text"
          />
          <ErrorLine error={error} />
          <Actions pending={pending} label="Stop" tone="danger" onCancel={close} onGo={() => go(() => releaseMyAgentAction(bugId, reason), `${agentName} let go of the issue.`, close)} />
        </>
      )}
    </MenuForm>
  );
}

/** The person whose agent holds the issue: ask for the project's extra time. */
export function MoreTimeItem({ bugId, agentName }: { bugId: string; agentName: string }) {
  const [reason, setReason] = useState("");
  const { error, pending, go } = useStep();
  const fieldId = useId();
  return (
    <MenuForm label={`Give ${agentName} more time`}>
      {(close) => (
        <>
          <label htmlFor={fieldId} className="font-medium text-zk-text2">
            Why does it need more time?
          </label>
          <input
            id={fieldId}
            value={reason}
            maxLength={140}
            onChange={(event) => setReason(event.target.value)}
            className="rounded-lg border border-zk-border bg-zk-surface px-2 py-1.5 text-xs text-zk-text"
          />
          <ErrorLine error={error} />
          <Actions pending={pending} label="Extend" onCancel={close} onGo={() => go(() => extendMyAgentAction(bugId, reason), "Deadline extended.", close)} />
        </>
      )}
    </MenuForm>
  );
}
