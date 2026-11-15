"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { requestToJoinProjectAction } from "@/app/actions/project-join-requests";

export type JoinRequestState = "none" | "pending" | "rejected";

/**
 * Ask to join a public project that isn't open for contributors (#join-requests). The maintainers (the
 * organisation's owners and admins) accept or decline it from Organisation → Invites.
 */
export function ProjectJoinRequestButton({
  project,
  state,
  size = "sm",
}: {
  project: { id: string; name: string; contributorGuidelines?: string | null };
  state: JoinRequestState;
  size?: "sm" | "md";
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [pending, startTransition] = useTransition();
  const text = size === "sm" ? "text-xs" : "text-sm";

  // Escape closes the form, unless it is still sending.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, pending]);

  if (state === "pending" || sent) {
    return (
      <Button variant="secondary" disabled className={`${text} font-medium opacity-60`}>
        Request sent
      </Button>
    );
  }

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await requestToJoinProjectAction(project.id, message);
      if (result.ok) {
        setSent(true);
        setOpen(false);
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  };

  return (
    <>
      <div className="flex flex-col items-end gap-1">
        {state === "rejected" ? <span className="text-[11px] text-zk-muted">Your last request was declined</span> : null}
        <Button variant="primary" onClick={() => setOpen(true)} className={`${text} font-bold`}>
          {state === "rejected" ? "Ask again" : "Request to join"}
        </Button>
      </div>

      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby={`join-request-title-${project.id}`}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
        >
          <div className="w-full max-w-lg rounded-[20px] border border-zk-border bg-zk-surface p-6 text-left shadow-2xl">
            <div className="flex items-center justify-between border-b border-zk-divider pb-3">
              <h2 id={`join-request-title-${project.id}`} className="text-lg font-bold text-zk-text">
                Ask to join {project.name}
              </h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={pending}
                className="cursor-pointer rounded-full p-1 text-zk-muted hover:bg-zk-chip hover:text-zk-text"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            <form onSubmit={submit} className="mt-4 space-y-4">
              {project.contributorGuidelines ? (
                <div className="rounded-[12px] border border-zk-border bg-zk-tint/30 p-3 text-xs text-zk-text2">
                  <span className="font-semibold text-zk-text">Maintainer guidelines</span>
                  <p className="mt-1 whitespace-pre-wrap">{project.contributorGuidelines}</p>
                </div>
              ) : null}

              <div>
                <label htmlFor={`join-request-message-${project.id}`} className="block text-xs font-semibold uppercase tracking-wider text-zk-text2">
                  Note to the maintainers (optional)
                </label>
                <p className="mt-0.5 text-xs text-zk-muted">What you&apos;d like to work on, and what you bring.</p>
                <textarea
                  id={`join-request-message-${project.id}`}
                  rows={4}
                  maxLength={1000}
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  className="mt-2 w-full rounded-xl border border-zk-border bg-zk-card px-3 py-2 text-sm text-zk-text placeholder:text-zk-muted focus:border-zk-accent focus:outline-none focus:ring-1 focus:ring-zk-accent"
                />
                <div className="mt-1 text-right text-[11px] text-zk-muted">{message.length} / 1000</div>
              </div>

              {error ? (
                <p role="alert" className="rounded-lg border border-zk-bad-bd bg-zk-bad-bg px-3 py-2 text-xs text-zk-bad-fg">
                  {error}
                </p>
              ) : null}

              <div className="flex items-center justify-end gap-2 pt-2">
                <Button type="button" variant="secondary" onClick={() => setOpen(false)} disabled={pending}>
                  Cancel
                </Button>
                <Button type="submit" variant="primary" disabled={pending}>
                  {pending ? "Sending…" : "Send request"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}
