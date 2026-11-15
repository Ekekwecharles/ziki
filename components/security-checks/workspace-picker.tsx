"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

export type PickerWorkspace = { name: string; current: boolean; href: string };

/**
 * Which workspace a scanned site goes in (#security-checks, 14 Nov call), as a
 * pop-up over the Security page for someone who owns or runs more than one.
 * Picking one opens it and starts the scan there; closing it just stays on
 * Security, with nothing scanned.
 */
export function WorkspacePickerModal({ site, workspaces, createHref }: { site: string; workspaces: PickerWorkspace[]; createHref: string }) {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (!dialog.current?.open) dialog.current?.showModal();
  }, []);

  const close = () => {
    dialog.current?.close();
    router.replace("/security");
  };

  return (
    <dialog
      ref={dialog}
      aria-labelledby="workspace-picker-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      className="m-auto w-[min(30rem,calc(100vw-2rem))] rounded-[20px] border border-zk-border bg-zk-surface p-6 text-zk-text shadow-xl backdrop:bg-black/50"
    >
      <div className="flex items-start justify-between gap-3">
        <h2 id="workspace-picker-title" className="m-0 text-lg font-extrabold">
          Which workspace should {site} go in?
        </h2>
        <button
          type="button"
          onClick={close}
          aria-label="Close"
          className="rounded-md p-1 text-zk-muted hover:bg-zk-chip hover:text-zk-text focus-visible:outline-2 focus-visible:outline-electric-blue"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="m6 6 12 12M18 6 6 18" />
          </svg>
        </button>
      </div>
      <p className="m-0 mt-1 text-sm text-zk-text2">Its scan starts there, in that workspace&apos;s Security.</p>
      <ul className="m-0 mt-4 flex list-none flex-col gap-2 p-0">
        {workspaces.map((workspace) => (
          <li key={workspace.href}>
            <Link
              href={workspace.href}
              className="flex items-center justify-between gap-3 rounded-xl border border-zk-border bg-zk-surface px-4 py-3 text-[15px] font-semibold text-zk-text transition hover:border-zk-accent hover:text-zk-accent"
            >
              <span className="min-w-0 truncate">{workspace.name}</span>
              {workspace.current ? <span className="shrink-0 rounded-full bg-zk-chip px-2.5 py-0.5 text-xs font-semibold text-zk-muted">Open now</span> : null}
            </Link>
          </li>
        ))}
      </ul>
      <Link href={createHref} className="mt-4 inline-flex w-fit items-center gap-1.5 text-sm font-semibold text-zk-accent hover:underline">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
          <path d="M12 5v14M5 12h14" />
        </svg>
        Create a new workspace
      </Link>
    </dialog>
  );
}
