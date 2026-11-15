"use client";

import { useEffect, useRef, useState } from "react";
import { SecurityChat } from "./security-chat";

/**
 * "Add asset" (#security-checks, part 1). The box is only needed now and
 * then, so it waits behind a button and opens in a pop-up, like "Add idea".
 */
export function CheckSiteButton({ id = "security-target", variant = "primary" }: { id?: string; variant?: "primary" | "large" | "inline" }) {
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
  }, [open]);

  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className={
          variant === "inline"
            ? // Like Add Idea at the top of a project's list.
              "inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-zk-border bg-zk-surface px-2.5 text-[13px] font-semibold text-zk-text hover:bg-zk-chip focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-electric-blue"
            : `inline-flex shrink-0 items-center gap-2 rounded-full bg-electric-blue-strong font-bold text-white transition hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-electric-blue focus-visible:ring-offset-2 ${
                variant === "large" ? "h-12 px-6 text-base" : "h-10 px-5 text-sm"
              }`
        }
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        Add asset
      </button>
      {/* Esc is handled by onCancel; onClick only catches a click on the backdrop, which has no keyboard equivalent to add. */}
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions */}
      <dialog
        ref={dialog}
        aria-labelledby={`${id}-dialog-title`}
        onCancel={(event) => {
          event.preventDefault();
          setOpen(false);
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) setOpen(false);
        }}
        className="m-auto w-[calc(100%-32px)] max-w-[620px] overflow-hidden rounded-2xl border border-zk-border bg-zk-surface p-0 text-zk-text shadow-2xl backdrop:bg-slate-900/40 backdrop:backdrop-blur-xs"
      >
        {open ? (
          <div className="flex flex-col gap-5 p-6">
            <div className="flex items-center justify-between border-b border-zk-divider pb-4">
              <div className="flex items-center gap-2">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-zk-tint text-zk-accent">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true"><path d="M12 3v18M3 12h18" /></svg>
                </span>
                <h2 id={`${id}-dialog-title`} className="m-0 text-base font-bold text-zk-text">Add asset</h2>
              </div>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setOpen(false)}
                className="rounded-full p-1.5 text-zk-muted hover:bg-zk-chip hover:text-zk-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-electric-blue"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            </div>
            <SecurityChat id={id} focusOnOpen />
            <p className="m-0 border-t border-zk-divider pt-4 text-xs text-zk-muted">
              Next, you show it&apos;s yours. Agents only look: they never log in as you or change anything.
            </p>
          </div>
        ) : null}
      </dialog>
    </>
  );
}
