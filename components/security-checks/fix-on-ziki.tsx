"use client";

import { useEffect, useState, useTransition, type FormEvent } from "react";
import Link from "next/link";
import type { SecuritySeverity } from "@prisma/client";
import { fixSecurityCheck, loadSecurityCheckFixOptions } from "@/app/actions/security-check-fix";
import { SEVERITY_LABEL } from "@/lib/security-severity";
import "@/components/security-finding.css";
import type { FixOptions, FixOutcome } from "@/lib/security-checks/fix";

type Props = {
  standalone?: boolean;
  checkId: string;
  results: readonly { id: string; severity: SecuritySeverity; title: string; price?: number; moved?: boolean; issue?: { number: number; href: string } | null }[];
};

export function FixOnZiki(props: Props) {
  if (!props.results.length) return null;
  return <FixPicker key={props.checkId} {...props} />;
}

function FixPicker({ checkId, results, standalone }: Props) {
  const [options, setOptions] = useState<FixOptions | null | undefined>();
  const [projectId, setProjectId] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [outcome, setOutcome] = useState<FixOutcome>();
  const [loadingAttempt, setLoadingAttempt] = useState(0);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let current = true;
    loadSecurityCheckFixOptions(checkId).then((data) => {
      if (!current) return;
      setOptions(data);
      setProjectId(data?.projectId ?? "");
    }, () => { if (current) setOptions(null); });
    return () => { current = false; };
  }, [checkId, loadingAttempt]);

  const [movedIssues, setMovedIssues] = useState<Record<string, { number: number; href: string }>>({});
  const total = results.reduce((sum, result) => selected.includes(result.id) ? sum + (result.price ?? 0) : sum, 0);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!projectId || !selected.length || pending) return;
    startTransition(async () => {
      try {
        const reply = await fixSecurityCheck({ checkId, projectId, resultIds: selected });
        setOutcome(reply);
        if (reply.ok) {
          setOptions((old) => old && { ...old, projectId });
          setMovedIssues((previous) => ({
            ...previous,
            ...Object.fromEntries(reply.issues.map((issue) => [issue.resultId, issue])),
          }));
          setSelected([]);
        }
      } catch {
        setOutcome({ ok: false, error: "Could not send the findings. Try again." });
      }
    });
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      {standalone ? null : <h2 className="font-semibold text-zk-text">Move to your app</h2>}
      {options === undefined ? <p role="status">Loading projects…</p> : options === null ? (
        <p role="status">
          You can move findings to your app once the report is posted.{" "}
          <button type="button" className="underline" onClick={() => {
            setOptions(undefined);
            setLoadingAttempt((attempt) => attempt + 1);
          }}>Retry</button>
        </p>
      ) : options.projects.length === 0 ? <p>No eligible projects are available in this workspace.</p> : (
        <>
          <fieldset disabled={pending} className="min-w-0 rounded-2xl border border-zk-border bg-zk-surface">
            <legend className="sr-only">Choose findings</legend>
            <h2 className="border-b border-zk-divider px-4 py-4 text-base font-semibold text-zk-text sm:px-5">Choose findings</h2>
            <ul className="divide-y divide-zk-divider">
              {results.map((result) => {
                const issue = movedIssues[result.id] ?? result.issue;
                const moved = result.moved || Boolean(issue);
                const price = result.price ?? 0;
                return (
                  <li key={result.id} className="relative flex items-center gap-3 px-4 py-3.5 hover:bg-zk-bg sm:px-5">
                    <label className="flex min-w-0 flex-1 items-center gap-3">
                      <input type="checkbox" disabled={moved}
                        className="h-4 w-4 shrink-0 accent-electric-blue-strong"
                        checked={selected.includes(result.id)}
                        onChange={(event) => {
                          const checked = event.currentTarget.checked;
                          setSelected((ids) => checked ? [...ids, result.id] : ids.filter((id) => id !== result.id));
                        }} />
                      <span className="flex min-w-0 flex-col items-start gap-1.5 sm:flex-row sm:items-center sm:gap-3">
                        <span className={`security-severity security-severity--${result.severity} shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold`}>
                          {SEVERITY_LABEL[result.severity]}
                        </span>
                        <span className="min-w-0 break-words text-sm font-medium text-zk-text">{result.title}</span>
                      </span>
                    </label>
                    {issue ? <Link className="shrink-0 text-sm font-semibold text-zk-accent hover:underline" href={issue.href}>Issue #{issue.number}</Link>
                      : moved ? <span className="text-xs font-semibold text-zk-ok-fg">Moved</span>
                      : standalone ? <span className="shrink-0 text-sm tabular-nums text-zk-text2">{price} {price === 1 ? "coin" : "coins"}</span> : null}
                  </li>
                );
              })}
            </ul>
          </fieldset>
          <div className="space-y-4 rounded-2xl border border-zk-border bg-zk-surface p-4 sm:p-5">
            <label className="block space-y-2">
              <span className="block text-sm font-semibold text-zk-text">Destination project</span>
              <select className="w-full rounded-xl border border-zk-border bg-zk-bg px-3 py-2.5 text-sm text-zk-text focus-visible:outline-2 focus-visible:outline-zk-accent disabled:opacity-70"
                required value={projectId} disabled={pending || Boolean(options.projectId)}
                onChange={(event) => setProjectId(event.currentTarget.value)}>
                <option value="">Choose a project</option>
                {options.projects.filter((project) => !options.projectId || project.id === options.projectId)
                  .map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
            </label>
            {standalone ? (
              <div role="status" className="flex items-center justify-between gap-3 border-t border-zk-divider pt-4">
                <div className="text-sm text-zk-text2">
                  <p>{selected.length} selected</p>
                  <p className="text-xs text-zk-muted">Simulated payment</p>
                </div>
                <span className="font-semibold tabular-nums text-zk-text">{total} {total === 1 ? "coin" : "coins"}</span>
              </div>
            ) : null}
            <button type="submit" disabled={pending || !projectId || !selected.length}
              className="inline-flex min-h-11 w-full items-center justify-center rounded-full bg-electric-blue-strong px-5 py-2 text-sm font-semibold text-white transition hover:brightness-105 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zk-accent disabled:opacity-50">
              {pending ? "Moving…" : standalone ? "Pay and move" : "Move to your app"}
            </button>
          </div>
        </>
      )}
      {outcome && !outcome.ok ? <p role="alert">{outcome.error}</p> : null}
      {outcome?.ok ? (
        <div role="status" className="space-y-2 rounded-2xl border border-zk-border bg-zk-surface p-4 text-sm text-zk-ok-fg">
          <p>{outcome.created} moved. {outcome.reused} already moved. {standalone ? `${outcome.coins} coins simulated.` : null}</p>
          {outcome.issues.length ? <ul>
            {outcome.issues.map((issue) => <li key={issue.number}>
              <Link className="underline" href={issue.href}>Issue #{issue.number}</Link>
            </li>)}
          </ul> : null}
        </div>
      ) : null}
    </form>
  );
}
