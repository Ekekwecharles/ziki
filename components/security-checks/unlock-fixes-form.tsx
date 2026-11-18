"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import type { SecuritySeverity } from "@prisma/client";
import { unlockSecurityFindings } from "@/app/actions/security-checks";
import { SEVERITY_LABEL } from "@/lib/security-severity";
import "@/components/security-finding.css";
import { ZikAmount } from "@/components/zik-symbol";

/** A finding as the unlock page may show it: never its title or details while locked. */
export type UnlockRow = { id: string; severity: SecuritySeverity; label: string; price: number; unlocked: boolean };

/**
 * Pick findings to unlock (#security-checks, plan C1): all of them, or the
 * ones ticked. The total follows the ticks, and paying takes it from the
 * person's Ziks.
 */
export function UnlockFixesForm({ checkId, rows, preselected, backHref }: { checkId: string; rows: UnlockRow[]; preselected: string[]; backHref: string }) {
  const locked = rows.filter((row) => !row.unlocked);
  const [picked, setPicked] = useState<Set<string>>(() => {
    const wanted = new Set(preselected);
    const fromReport = locked.filter((row) => wanted.has(row.id)).map((row) => row.id);
    return new Set(fromReport.length ? fromReport : locked.map((row) => row.id));
  });
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const chosen = locked.filter((row) => picked.has(row.id));
  const chosenTotal = chosen.reduce((sum, row) => sum + row.price, 0);
  const allTotal = locked.reduce((sum, row) => sum + row.price, 0);
  const allPicked = chosen.length === locked.length;

  function unlock(which: "all" | string[]) {
    setError(null);
    startTransition(async () => {
      const result = await unlockSecurityFindings(checkId, which);
      if (result?.error) setError(result.error);
    });
  }

  function toggle(id: string) {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <fieldset className="m-0 rounded-2xl border border-zk-border bg-zk-surface p-0">
        <legend className="sr-only">Findings to unlock</legend>
        <div className="flex items-center justify-between gap-3 border-b border-zk-border px-5 py-3 text-sm">
          <span className="text-zk-muted">{locked.length} locked · {rows.length - locked.length} unlocked</span>
          {locked.length > 1 ? (
            <button
              type="button"
              onClick={() => setPicked(allPicked ? new Set() : new Set(locked.map((row) => row.id)))}
              className="font-semibold text-zk-accent hover:underline"
            >
              {allPicked ? "Clear" : "Select all"}
            </button>
          ) : null}
        </div>
        <ul className="m-0 list-none divide-y divide-zk-divider p-0">
          {rows.map((row) => (
            <li key={row.id}>
              <label className={`flex items-center gap-3 px-5 py-3 ${row.unlocked ? "cursor-default" : "cursor-pointer hover:bg-zk-bg"}`}>
                <input
                  type="checkbox"
                  checked={row.unlocked || picked.has(row.id)}
                  disabled={row.unlocked || pending}
                  onChange={() => toggle(row.id)}
                  className="h-4 w-4 shrink-0 accent-[var(--color-electric-blue-strong,#2e6fef)]"
                />
                <span className={`security-severity security-severity--${row.severity} inline-flex w-[76px] shrink-0 justify-center rounded-full px-2 py-0.5 text-xs font-bold`}>
                  {SEVERITY_LABEL[row.severity]}
                </span>
                <span className="min-w-0 flex-1 text-[15px] text-zk-text">{row.label}</span>
                <span className={`shrink-0 tabular-nums ${row.unlocked ? "text-sm font-semibold text-zk-ok-fg" : "text-[15px] text-zk-text"}`}>
                  {row.unlocked ? "Unlocked" : <ZikAmount amount={row.price} />}
                </span>
              </label>
            </li>
          ))}
        </ul>
        <div className="flex items-baseline justify-between border-t border-dashed border-zk-border px-5 py-4">
          <span className="font-semibold text-zk-text">Total for {chosen.length} {chosen.length === 1 ? "finding" : "findings"}</span>
          <ZikAmount amount={chosenTotal} className="text-xl font-bold tabular-nums text-zk-text" />
        </div>
      </fieldset>

      {error ? <p role="alert" className="m-0 text-sm text-zk-bad-fg">{error}</p> : null}

      <div className="flex flex-col gap-2.5">
        <button
          type="button"
          disabled={pending || chosen.length === 0}
          onClick={() => unlock(allPicked ? "all" : chosen.map((row) => row.id))}
          className="inline-flex h-12 w-full items-center justify-center rounded-full bg-electric-blue-strong px-6 text-[15px] font-bold text-white transition hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-electric-blue focus-visible:ring-offset-2 disabled:opacity-50"
        >
          {pending ? "Unlocking…" : allPicked ? <span>Unlock all · <ZikAmount amount={allTotal} /></span> : <span>Unlock {chosen.length} selected · <ZikAmount amount={chosenTotal} /></span>}
        </button>
        <Link href={backHref} className="mx-auto text-sm text-zk-text2 underline-offset-4 hover:text-zk-text hover:underline">
          Not now
        </Link>
      </div>
    </div>
  );
}
