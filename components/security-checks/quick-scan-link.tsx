"use client";

import { useRef } from "react";
import { PREVIEW_RISK_LABEL, type PreviewSummary } from "@/lib/security-checks/preview-summary";
import { PreviewResult } from "./preview-result";

/**
 * The quick scan saved with an asset (#security-checks), behind one small
 * text link: it opens in a panel at the side, so the page stays as it is.
 */
export function QuickScanLink({ summary }: { summary: PreviewSummary }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const label = `${summary.total ? `${summary.total} ${summary.total === 1 ? "problem" : "problems"}` : "No problems"} · ${PREVIEW_RISK_LABEL[summary.risk]} risk`;
  return (
    <>
      <button
        type="button"
        onClick={() => dialog.current?.showModal()}
        className="w-fit border-0 bg-transparent p-0 text-left text-[13px] font-semibold text-zk-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-electric-blue"
      >
        See quick scan: {label}
      </button>
      <dialog
        ref={dialog}
        aria-label={`Quick scan of ${summary.target}`}
        className="fixed inset-y-0 left-auto right-0 m-0 h-dvh max-h-dvh w-[min(560px,100vw)] max-w-none overflow-y-auto border-0 bg-zk-bg p-4 shadow-[-12px_0_40px_rgba(0,0,0,0.18)] backdrop:bg-black/30 sm:p-6"
      >
        <div className="relative flex flex-col gap-3">
          <p className="m-0 pr-10 text-base font-bold text-zk-text">Quick scan of {summary.target}</p>
          <button
            type="button"
            onClick={() => dialog.current?.close()}
            aria-label="Close"
            className="absolute right-0 top-0 z-10 inline-flex h-8 w-8 items-center justify-center rounded-lg text-zk-muted hover:bg-zk-chip hover:text-zk-text"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
          <PreviewResult summary={summary}>
            <p className="m-0 text-xs text-zk-muted">Quick scan of {summary.target} from when it was added. Show it&apos;s yours to see every problem in full.</p>
          </PreviewResult>
        </div>
      </dialog>
    </>
  );
}
