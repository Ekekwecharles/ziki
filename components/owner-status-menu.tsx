"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import type { Substatus } from "@prisma/client";
import { ownerMoveIssueAction } from "@/app/actions/owner-moves";
import { OWNER_MOVES, OWNER_NOTE_MAX, type OwnerMove } from "@/lib/owner-moves";
import { useToast } from "@/components/ui/toast";

type OwnerStatusMenuProps = {
  bugId: string;
  substatus: Substatus;
  /** "Open · Requires confirmation": the chip's own text. */
  label: string;
  /** The chip's colours, as the read-only chip has them. */
  chipClassName: string;
};

/**
 * The Status chip, for the organisation's owner (#owner-control): the same
 * chip everyone sees, with a small arrow. It opens the moves that make sense
 * from this step; picking one asks once, with room for a note, then moves it.
 * Nobody else gets the arrow, so the page looks the same for them.
 */
export function OwnerStatusMenu({ bugId, substatus, label, chipClassName }: OwnerStatusMenuProps) {
  const moves = OWNER_MOVES[substatus];
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<OwnerMove | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const toast = useToast();
  const panelId = useId();
  const noteId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const close = () => {
    setOpen(false);
    setChosen(null);
    setNote("");
    setError(null);
  };

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!pending && !rootRef.current?.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending) {
        close();
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, pending]);

  const regular = moves.filter((move) => move.tone !== "danger");
  const danger = moves.filter((move) => move.tone === "danger");

  const submit = () => {
    if (!chosen) return;
    if (chosen.needsReason && !note.trim()) {
      setError("Say why you're closing it. Agents and reporters will see this.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await ownerMoveIssueAction(bugId, chosen.to, note);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      toast(`Done: ${chosen.label.toLowerCase()}.`);
      close();
    });
  };

  return (
    <div ref={rootRef} className="relative" data-testid="owner-status-menu">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={panelId}
        title="Change status"
        onClick={() => (open ? close() : setOpen(true))}
        className={`${chipClassName} cursor-pointer gap-1.5 ring-zk-accent/40 hover:ring-2 focus-visible:outline-none focus-visible:ring-2`}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
        {label}
        <svg width="10" height="10" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className={`transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.17l3.71-3.94a.75.75 0 1 1 1.08 1.04l-4.25 4.5a.75.75 0 0 1-1.08 0l-4.25-4.5a.75.75 0 0 1 .02-1.06Z" />
        </svg>
      </button>

      {open ? (
        <div
          id={panelId}
          className="absolute left-0 top-full z-30 mt-2 w-[min(300px,calc(100vw-48px))] rounded-2xl border border-zk-border bg-zk-surface p-1.5 text-sm font-normal shadow-lg"
        >
          {chosen ? (
            <div className="flex flex-col gap-2.5 p-2.5">
              <p className="m-0 font-semibold text-zk-text">{chosen.confirm}</p>
              <label htmlFor={noteId} className="flex flex-col gap-1 text-xs text-zk-muted">
                {chosen.needsReason ? "Why? (shown on the issue)" : "Note (optional, shown in the history)"}
                <textarea
                  id={noteId}
                  value={note}
                  maxLength={OWNER_NOTE_MAX}
                  rows={3}
                  // The note is the one thing to fill in once a move is picked, as the confirm dialog focuses its button.
                  // eslint-disable-next-line jsx-a11y/no-autofocus
                  autoFocus
                  onChange={(event) => setNote(event.target.value)}
                  className="w-full resize-y rounded-lg border border-zk-border bg-zk-bg px-2.5 py-2 text-sm text-zk-text focus:border-zk-accent focus:outline-none"
                />
              </label>
              {error ? (
                <p role="alert" className="m-0 text-xs font-medium text-zk-bad-fg">
                  {error}
                </p>
              ) : null}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    setChosen(null);
                    setError(null);
                  }}
                  className="rounded-lg px-3 py-1.5 text-xs font-semibold text-zk-text2 hover:bg-zk-chip"
                >
                  Back
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={submit}
                  className={`rounded-lg px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60 ${chosen.tone === "danger" ? "bg-zk-bad-fg" : "bg-zk-accent"}`}
                >
                  {pending ? "Saving…" : chosen.label}
                </button>
              </div>
            </div>
          ) : (
            <ul role="menu" className="m-0 flex list-none flex-col p-0">
              <li className="px-2.5 pb-1 pt-1.5 text-[11px] font-bold uppercase tracking-[0.08em] text-zk-muted" role="presentation">
                As the owner, you can
              </li>
              {[...regular, ...danger].map((move, index) => (
                <li key={`${move.to}-${move.label}`} role="none">
                  {move.tone === "danger" && index === regular.length && regular.length > 0 ? (
                    <div className="mx-1.5 my-1 h-px bg-zk-border" aria-hidden />
                  ) : null}
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => setChosen(move)}
                    className="flex w-full flex-col items-start gap-0.5 rounded-xl px-2.5 py-2 text-left hover:bg-zk-chip focus-visible:bg-zk-chip focus-visible:outline-none"
                  >
                    <span className={`font-semibold ${move.tone === "danger" ? "text-zk-bad-fg" : "text-zk-text"}`}>{move.label}</span>
                    <span className="text-xs text-zk-muted">{move.hint}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
