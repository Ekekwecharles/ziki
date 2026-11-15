"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { WITHDRAW_THRESHOLD } from "@/lib/earnings-threshold";
import { withdrawDetailsAction, type WithdrawDetails } from "@/app/(app)/earnings/withdraw-actions";

const money = (n: number) => `$${n.toFixed(2)}`;
const PRIMARY =
  "inline-flex min-h-11 items-center justify-center rounded-full bg-electric-blue-strong px-5 text-sm font-bold whitespace-nowrap text-white max-sm:px-2 max-sm:text-[13px] shadow-[0_8px_20px_rgba(46,111,239,0.30)] transition hover:bg-[#2552af] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-electric-blue focus-visible:ring-offset-2";
const SECONDARY =
  "inline-flex min-h-11 items-center justify-center rounded-full border border-zk-border bg-zk-surface px-5 text-sm font-bold whitespace-nowrap text-zk-text max-sm:px-2 max-sm:text-[13px] transition hover:bg-zk-chip focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-electric-blue focus-visible:ring-offset-2";

/**
 * The withdraw bar, as Earn always drew it: what you've earned (green), what Ziki is still checking (yellow
 * stripes), what is still to go, the $30 marker at the end, and a glowing dot where you are.
 */
function WithdrawBar({ earned: raw, checking: rawChecking }: { earned: number; checking: number }) {
  const total = WITHDRAW_THRESHOLD;
  const earned = Math.min(Math.max(0, raw), total);
  const left = Math.max(0, total - Math.max(0, raw));
  const checking = Math.min(rawChecking, left);
  const toGo = left - checking;
  const ready = left === 0;
  const pct = (value: number) => `${(value / total) * 100}%`;
  const parts = [
    { key: "earned", value: earned, shown: Math.max(0, raw), bar: "bg-zk-ok-fg", dot: "bg-zk-ok-fg", text: "font-bold text-zk-text", label: "earned" },
    { key: "checking", value: checking, shown: rawChecking, bar: "bg-[repeating-linear-gradient(45deg,#f2c14e_0,#f2c14e_6px,#f7d98a_6px,#f7d98a_12px)]", dot: "bg-[#f2c14e]", text: "font-bold text-zk-warn-fg", label: "being checked" },
    { key: "togo", value: toGo, shown: toGo, bar: "bg-zk-accent/35", dot: "bg-zk-accent/40", text: "font-bold text-zk-accent", label: "to go" },
  ];

  return (
    <div>
      <div className="relative pt-6">
        {/* The marker at the end: where withdrawing opens. */}
        <span className={`absolute right-0 top-0 text-[11px] font-bold ${ready ? "text-zk-ok-fg" : "text-zk-muted"}`}>{ready ? "Withdraw is open" : `Withdraw opens at $${total}`}</span>
        <span aria-hidden="true" className={`absolute right-0 top-4 z-10 h-6 w-0.5 rounded-full ${ready ? "bg-zk-ok-fg" : "bg-zk-text"}`} />
        <div role="img" aria-label={ready ? `${money(raw)} earned. Withdraw is open.` : `${money(Math.max(0, raw))} earned, ${money(rawChecking)} being checked, ${money(left)} to go. Withdraw opens at $${total}.`} className="relative flex h-3.5 overflow-hidden rounded-full bg-zk-seg">
          {parts.map((part) =>
            part.value > 0 ? (
              <div key={part.key} className="h-full" style={{ width: pct(part.value) }}>
                <div className={`earn-grow h-full w-full ${part.bar}`} />
              </div>
            ) : null,
          )}
        </div>
        {/* You are here. */}
        {earned > 0 && !ready ? (
          <span aria-hidden="true" className="absolute top-[18px] z-10 flex h-[22px] w-[22px] -translate-x-1/2 items-center justify-center" style={{ left: pct(earned) }}>
            <span className="absolute h-full w-full rounded-full bg-zk-ok-fg/30 motion-safe:animate-ping" />
            <span className="relative h-3.5 w-3.5 rounded-full border-[3px] border-zk-surface bg-zk-ok-fg shadow-[0_1px_4px_rgba(11,23,51,0.35)]" />
          </span>
        ) : null}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zk-text2">
        {parts.map((part) =>
          // Earned always shows; "being checked" and "to go" only while the bar isn't full yet.
          part.key === "earned" || (!ready && part.shown > 0) ? (
            <span key={part.key} className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className={`h-2 w-2 rounded-full ${part.dot}`} />
              <span className={part.text}>{money(part.shown)}</span> {part.label}
            </span>
          ) : null,
        )}
      </div>
    </div>
  );
}

/**
 * Withdraw (#earnings, Mark's review): always a window in the middle of the page you are on, never a trip to another
 * page, the way Earn showed it. It shows the threshold and what you earned in the workspace you're in against it on
 * the withdraw bar (not your total across workspaces), with a link to Your earnings for that workspace. At $30 or more it says the money is ready and sends you to the Ziks
 * page (/coins), where payouts are set up and the withdrawal is made.
 */
export function WithdrawWindow({ earned, organisationId, className, children }: { earned: number; organisationId: string | null; className: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [details, setDetails] = useState<WithdrawDetails | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (open && dialog && !dialog.open) dialog.showModal();
  }, [open]);

  function show() {
    setOpen(true);
    withdrawDetailsAction(organisationId).then(setDetails, () => undefined);
  }
  function close() {
    setOpen(false);
    buttonRef.current?.focus();
  }

  const available = details?.available ?? Math.max(0, earned);
  const checking = details?.checking ?? 0;
  const ready = available >= WITHDRAW_THRESHOLD;
  const left = Math.max(0, WITHDRAW_THRESHOLD - available);

  return (
    <>
      <button ref={buttonRef} type="button" onClick={show} className={className} aria-haspopup="dialog">
        {children}
      </button>
      {open ? (
        // Clicking the backdrop closes it; Escape is handled by onCancel, so the click needs no key listener.
        // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions
        <dialog
          ref={dialogRef}
          aria-labelledby="withdraw-title"
          onCancel={(event) => {
            event.preventDefault();
            close();
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) close();
          }}
          className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-[20px] border border-zk-border bg-zk-surface p-6 text-zk-text shadow-xl backdrop:bg-black/40"
        >
          <div className="flex items-start justify-between gap-3">
            <h2 id="withdraw-title" className="text-xl font-extrabold tracking-tight text-zk-text">
              {ready ? `You’ve reached $${WITHDRAW_THRESHOLD}` : `Withdrawals open at $${WITHDRAW_THRESHOLD}`}
            </h2>
            {/* × closes it, like the app's other panels (the site URL panel). */}
            <button
              type="button"
              onClick={close}
              aria-label="Close"
              className="-mr-1 -mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xl leading-none text-zk-muted transition hover:bg-zk-chip hover:text-zk-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-electric-blue"
            >
              ×
            </button>
          </div>
          <p className="mt-1 text-sm text-zk-text2">
            {ready ? "Your money is ready. Set up payouts on your Ziks page, then withdraw it to your bank account." : `You have ${money(available)}. ${money(left)} to go.`}
          </p>

          <p className="mt-5 flex flex-wrap items-baseline gap-x-2">
            <span className="text-[34px] font-extrabold leading-none tracking-tight tabular-nums text-zk-text">{money(available)}</span>
            <span className="text-sm text-zk-muted">{ready ? "ready" : `of $${WITHDRAW_THRESHOLD} to withdraw`}</span>
          </p>
          <div className="mt-4">
            <WithdrawBar earned={available} checking={checking} />
          </div>

          {/* Side by side on every screen: two equal columns on phones, right-aligned from sm up. */}
          <div className="mt-6 grid grid-cols-2 gap-2 sm:flex sm:justify-end">
            <Link href={details?.workspaceSlug ? `/earnings?in=${encodeURIComponent(details.workspaceSlug)}` : "/earnings"} onClick={() => setOpen(false)} className={SECONDARY}>See my earnings</Link>
            {ready ? (
              <Link href="/coins" onClick={() => setOpen(false)} className={PRIMARY}>Withdraw</Link>
            ) : (
              <Link href="/discover?open=true" onClick={() => setOpen(false)} className={PRIMARY}>Find more tasks</Link>
            )}
          </div>
        </dialog>
      ) : null}
    </>
  );
}
