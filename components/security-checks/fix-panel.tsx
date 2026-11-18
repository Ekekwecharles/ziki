"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { fixSecurityCheck, loadSecurityCheckFixOptions } from "@/app/actions/security-check-fix";
import { BorrowZiks } from "@/components/coins/borrow-ziks";
import { ZikAmount } from "@/components/zik-symbol";
import type { FixOptions, FixOutcome } from "@/lib/security-checks/fix";

/**
 * "Fix N selected" opens this under the Deeper scan's list (17 Nov, Hamzat), in place of the old Move to your app
 * page: choose the project, see what it costs in Ziks, then Pay and move. The ticked findings become issues in that
 * project for agents to fix. A check sends all its findings to one project, so once it has one, that is the only
 * choice. Someone who has never bought Ziks and is short is offered the one-time loan.
 */
export function FixPanel({ checkId, findings, onDone }: { checkId: string; findings: { id: string; price: number }[]; onDone: () => void }) {
  const router = useRouter();
  const [options, setOptions] = useState<FixOptions | null | undefined>();
  const [projectId, setProjectId] = useState("");
  const [outcome, setOutcome] = useState<FixOutcome>();
  const [attempt, setAttempt] = useState(0);
  const [pending, startTransition] = useTransition();
  const total = findings.reduce((sum, finding) => sum + finding.price, 0);

  useEffect(() => {
    let current = true;
    loadSecurityCheckFixOptions(checkId).then(
      (data) => {
        if (!current) return;
        setOptions(data);
        setProjectId(data?.projectId ?? (data?.projects.length === 1 ? data.projects[0]!.id : ""));
      },
      () => {
        if (current) setOptions(null);
      },
    );
    return () => {
      current = false;
    };
  }, [checkId, attempt]);

  function send() {
    if (!projectId || !findings.length) return;
    startTransition(async () => {
      try {
        const reply = await fixSecurityCheck({ checkId, projectId, resultIds: findings.map((finding) => finding.id) });
        setOutcome(reply);
        if (reply.ok) {
          onDone();
          router.refresh();
        }
      } catch {
        setOutcome({ ok: false, error: "Could not send the findings. Try again." });
      }
    });
  }

  if (options === undefined) return <p role="status" className="m-0 px-4 py-4 text-sm text-zk-text2 sm:px-6">Loading your projects…</p>;
  if (options === null) {
    return (
      <p role="status" className="m-0 px-4 py-4 text-sm text-zk-text2 sm:px-6">
        Couldn&apos;t load your projects.{" "}
        <button type="button" className="font-semibold text-zk-accent underline" onClick={() => { setOptions(undefined); setAttempt((n) => n + 1); }}>
          Try again
        </button>
      </p>
    );
  }
  const projects = options.projects.filter((project) => !options.projectId || project.id === options.projectId);

  return (
    <div id="fix-panel" className="space-y-4 border-t border-zk-border bg-zk-surface px-4 py-4 sm:px-6">
      {projects.length === 0 ? (
        <p className="m-0 text-sm text-zk-text2">No project in this workspace can take these yet. Create a project for your app first.</p>
      ) : (
        <>
          <label className="block space-y-2">
            <span className="block text-sm font-semibold text-zk-text">Destination project</span>
            <select
              className="w-full rounded-xl border border-zk-border bg-zk-bg px-3 py-2.5 text-sm text-zk-text focus-visible:outline-2 focus-visible:outline-zk-accent disabled:opacity-70"
              value={projectId}
              disabled={pending || Boolean(options.projectId)}
              onChange={(event) => setProjectId(event.currentTarget.value)}
            >
              <option value="">Choose a project</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </select>
          </label>
          <div role="status" className="flex items-center justify-between gap-3 border-t border-zk-divider pt-4">
            <div className="text-sm text-zk-text2">
              <p className="m-0">{findings.length} selected</p>
              <p className="m-0 text-xs text-zk-muted">Paid from your Ziks wallet</p>
            </div>
            <ZikAmount amount={total} className="font-semibold tabular-nums text-zk-text" />
          </div>
          <button
            type="button"
            onClick={send}
            disabled={pending || !projectId || !findings.length}
            className="inline-flex min-h-11 w-full items-center justify-center rounded-full bg-electric-blue-strong px-5 py-2 text-sm font-semibold text-white transition hover:brightness-105 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zk-accent disabled:opacity-50"
          >
            {pending ? "Moving…" : "Pay and move"}
          </button>
        </>
      )}
      {outcome && !outcome.ok ? <p role="alert" className="m-0 text-sm font-medium text-zk-bad-fg">{outcome.error}</p> : null}
      {/* Never bought Ziks: offer the one-time loan, then send again (16 Nov call). */}
      {outcome && !outcome.ok && outcome.canBorrow ? <BorrowZiks onBorrowed={send} /> : null}
      {outcome?.ok ? (
        <p role="status" className="m-0 text-sm text-zk-ok-fg">
          Sent to your app.{" "}
          {outcome.issues.map((issue, i) => (
            <span key={issue.number}>
              {i ? ", " : ""}
              <Link className="font-semibold underline" href={issue.href}>Issue #{issue.number}</Link>
            </span>
          ))}
        </p>
      ) : null}
    </div>
  );
}
