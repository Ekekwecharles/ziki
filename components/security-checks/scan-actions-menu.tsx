"use client";

import { useEffect, useId, useRef, useState, useTransition, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { removeScan } from "@/app/actions/security-assistant";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { useRescan } from "./use-rescan";

/**
 * "More actions" on a scan's own page (17 Nov): Scan again (with agents, paid, after a confirm: useRescan) once the
 * report is posted and on the newest scan of the site, Download report (PDF) once the report is posted, and
 * Remove scan last in red after a line, as the Assets row menu (scan-list.tsx) and GitHub, Linear and Vercel order
 * their menus: one row per action, an icon then its name, the destructive one set apart at the bottom.
 */
export function ScanActionsMenu({ checkId, site, posted, nextCheckId }: { checkId: string; site: string; posted: boolean; nextCheckId: string | null }) {
  const router = useRouter();
  const confirm = useConfirm();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [removing, start] = useTransition();
  const { rescan, pending: rescanning } = useRescan();
  const pending = removing || rescanning;
  // Scan again (#security-rescan) follows a finished scan, and only the newest one of a site.
  const canRescan = posted && !nextCheckId;
  const menuId = useId();
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  // Opening puts focus on the first action; a click outside or Escape closes it.
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>("[role=menuitem]:not([disabled])")?.focus();
    const onPointer = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Up and down move between the actions, as in any menu.
  function moveFocus(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    const items = Array.from(menu.current?.querySelectorAll<HTMLElement>("[role=menuitem]:not([disabled])") ?? []);
    if (!items.length) return;
    event.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "Home" ? 0
      : event.key === "End" ? items.length - 1
      : event.key === "ArrowDown" ? (at + 1) % items.length
      : (at - 1 + items.length) % items.length;
    items[next]?.focus();
  }

  function scanAgain() {
    setOpen(false);
    rescan([checkId]);
  }

  async function remove() {
    setOpen(false);
    const confirmed = await confirm({
      title: `Remove ${site}?`,
      body: posted
        ? "Its report goes too, and it leaves your scans. Anything you moved to your app stays there."
        : "Agents stop checking it, and it leaves your scans.",
      confirmLabel: "Remove scan",
      tone: "danger",
    });
    if (!confirmed) return;
    start(async () => {
      const answer = await removeScan(checkId);
      if (answer.ok) {
        toast("Scan removed.");
        router.push("/security");
      } else {
        toast(answer.error, "error");
      }
    });
  }

  const row =
    "flex w-full cursor-pointer items-center gap-2.5 px-3.5 py-2 text-left text-[13px] font-medium hover:bg-zk-chip focus-visible:bg-zk-chip focus-visible:outline-none disabled:cursor-default disabled:opacity-60";

  return (
    <div ref={box} className="relative print:hidden">
      <button
        ref={button}
        type="button"
        aria-label="More actions"
        title="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((now) => !now)}
        className="inline-flex h-10 w-10 cursor-pointer items-center justify-center rounded-full border border-zk-border bg-zk-surface text-zk-text2 hover:bg-zk-chip hover:text-zk-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-electric-blue"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="2" />
          <circle cx="12" cy="12" r="2" />
          <circle cx="19" cy="12" r="2" />
        </svg>
      </button>
      {open ? (
        <div
          ref={menu}
          id={menuId}
          role="menu"
          aria-label={`Actions for ${site}`}
          tabIndex={-1}
          onKeyDown={moveFocus}
          className="absolute right-0 top-full z-30 mt-2 w-56 rounded-xl border border-zk-border bg-zk-surface py-1.5 shadow-[0_16px_40px_rgba(11,23,51,0.18)]"
        >
          {canRescan ? (
            <button role="menuitem" type="button" disabled={pending} className={`${row} text-zk-text`} onClick={scanAgain}>
              <MenuIcon>
                <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                <path d="M21 4v5h-5" />
              </MenuIcon>
              {rescanning ? "Working…" : "Scan again"}
            </button>
          ) : null}
          {/* The PDF is a secondary action (16 Nov call): people want things fixed, not a file. */}
          {posted ? (
            <a role="menuitem" href={`/security/checks/${checkId}/report.pdf`} className={`${row} text-zk-text hover:no-underline`} onClick={() => setOpen(false)}>
              <MenuIcon>
                <path d="M12 4v11" />
                <path d="M7 10l5 5 5-5" />
                <path d="M5 20h14" />
              </MenuIcon>
              Download report (PDF)
            </a>
          ) : null}
          <div role="separator" className="my-1.5 border-t border-zk-divider" />
          <button role="menuitem" type="button" disabled={pending} className={`${row} text-zk-bad-fg`} onClick={remove}>
            <MenuIcon>
              <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
            </MenuIcon>
            Remove scan
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** One menu row's icon: the same 16px stroke drawing for every action. */
function MenuIcon({ children }: { children: ReactNode }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
      {children}
    </svg>
  );
}
