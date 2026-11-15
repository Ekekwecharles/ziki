"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  addProofRuleAction,
  deleteProofCheckAction,
  deleteProofRuleAction,
  setProofCheckRequiredAction,
  setProofRuleChecksAction,
  writeProofCheckAction,
  type ProofActionResult,
} from "@/app/actions/proof-rules";

export type ProofRuleView = { id: string; issueTypeId: string | null; projectAreaId: string | null; checks: string[] };
export type ProofCheckView = { id: string; name: string; proof: string; required: boolean; custom: boolean };
type Scope = { id: string; name: string };

/** A small mark for each built-in check; checks the owners wrote get a pen. */
const ICONS: Record<string, string> = {
  repro: "M8 2l1.88 1.88M14.12 3.88L16 2M9 7.13v-1a3 3 0 1 1 6 0v1M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6zM12 20v-9",
  fixed: "M22 11.08V12a10 10 0 1 1-5.93-9.14M22 4 12 14.01l-3-3",
  regression: "m17 2 4 4-4 4M3 11v-1a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 13v1a4 4 0 0 1-4 4H3",
  phone: "M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM12 18h.01",
  theme: "M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9z",
  staging: "M2 4h20v6H2zM2 14h20v6H2zM6 7h.01M6 17h.01",
};
const PEN = "M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z";

function CheckMark({ id }: { id: string }) {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[id] ?? PEN} />
    </svg>
  );
}

const chip = "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-semibold";
const quiet = "rounded-full border border-dashed border-zk-border px-3 py-1.5 text-sm font-semibold text-zk-text2 hover:bg-zk-chip disabled:opacity-50";

/**
 * The rules for what a judgement must prove (#deeper-testing), as sentences:
 * "Every issue must show …", "Fix issues also need …", "Issues in Web app also
 * need …". `projectId` null edits the organisation's rules (every issue and per
 * type, plus the checks owners write); a project id edits its rules per area.
 * Without `editable` it only shows them.
 */
export function ProofRulesEditor({
  projectId,
  rules,
  checks,
  scopes,
  editable,
}: {
  projectId: string | null;
  rules: ProofRuleView[];
  checks: ProofCheckView[];
  /** The organisation's issue types, or the project's areas. */
  scopes: Scope[];
  editable: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [writingFor, setWritingFor] = useState<string | null>(null);
  const [pickingFor, setPickingFor] = useState<string | null>(null);
  const run = (action: () => Promise<ProofActionResult>) =>
    start(async () => {
      const result = await action();
      setError(result.ok ? null : result.error);
      if (result.ok) router.refresh();
    });
  // The check just added snaps into its sentence; the ones already there stay still.
  const [snapped, setSnapped] = useState<string | null>(null);
  const name = (id: string) => checks.find((c) => c.id === id)?.name ?? "Deleted check";
  const scopeName = (rule: ProofRuleView) => scopes.find((s) => s.id === (rule.issueTypeId ?? rule.projectAreaId))?.name ?? "—";
  const taken = (scopeId: string | null) => rules.some((r) => (r.issueTypeId ?? r.projectAreaId) === scopeId);

  return (
    <div className="flex flex-col gap-4">
      {rules.length === 0 ? <p className="m-0 text-sm text-zk-muted">No rules yet. Until there are, every judgement counts as it does today.</p> : null}
      <ul className="m-0 flex list-none flex-col divide-y divide-zk-divider p-0">
        {rules.map((rule) => (
          <li key={rule.id} className="flex flex-col gap-2.5 py-3">
            <div className="flex items-start justify-between gap-3">
              <p className="m-0 text-[15px] font-bold text-zk-text">
                {!rule.issueTypeId && !rule.projectAreaId ? (
                  "Every issue must show"
                ) : (
                  <>
                    {rule.projectAreaId ? "Issues in " : ""}
                    <span className="rounded-md bg-zk-tint px-1.5 text-zk-accent">{scopeName(rule)}</span>
                    {rule.issueTypeId ? " issues" : ""} also need
                  </>
                )}
              </p>
              {editable && (rule.issueTypeId || rule.projectAreaId || rule.checks.length === 0) ? (
                <button type="button" aria-label="Remove this rule" title="Remove this rule" disabled={pending} onClick={() => run(() => deleteProofRuleAction(rule.id))} className="p-1 text-zk-muted hover:text-zk-bad-fg">
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6" />
                  </svg>
                </button>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {rule.checks.map((id) => (
                <span key={id} title={checks.find((c) => c.id === id)?.proof} className={`${chip} border-zk-ok-fg/40 bg-zk-ok-bg text-zk-ok-fg ${snapped === `${rule.id}:${id}` ? "proof-snap" : ""}`}>
                  <CheckMark id={id} />
                  {name(id)}
                  {checks.find((c) => c.id === id)?.required === false ? <span className="text-xs font-normal">· guidance</span> : null}
                  {editable ? (
                    <button type="button" aria-label={`Remove ${name(id)}`} disabled={pending} onClick={() => run(() => setProofRuleChecksAction(rule.id, rule.checks.filter((c) => c !== id)))} className="-mr-1 px-1">
                      ×
                    </button>
                  ) : null}
                </span>
              ))}
              {!rule.checks.length && !editable ? <span className="text-sm text-zk-muted">No checks yet.</span> : null}
              {editable ? (
                <button
                  type="button"
                  aria-expanded={pickingFor === rule.id}
                  onClick={() => {
                    setPickingFor(pickingFor === rule.id ? null : rule.id);
                    setWritingFor(null);
                  }}
                  className={quiet}
                >
                  + Add a check
                </button>
              ) : null}
            </div>
            {pickingFor === rule.id ? (
              <div className="flex flex-wrap gap-2 rounded-xl bg-zk-chip/60 p-3">
                {checks.filter((c) => !rule.checks.includes(c.id)).map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    title={c.proof}
                    disabled={pending}
                    onClick={() => {
                      setSnapped(`${rule.id}:${c.id}`);
                      run(() => setProofRuleChecksAction(rule.id, [...rule.checks, c.id]));
                    }}
                    className={`${chip} border-zk-border bg-zk-surface text-zk-text2 hover:text-zk-text`}
                  >
                    <CheckMark id={c.id} />
                    {c.name}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    setWritingFor(rule.id);
                    setPickingFor(null);
                  }}
                  className={`${chip} border-zk-accent/50 bg-zk-tint text-zk-accent`}
                >
                  <CheckMark id="" />
                  Write your own check
                </button>
              </div>
            ) : null}
            {writingFor === rule.id ? <WriteCheckForm ruleId={rule.id} pending={pending} run={run} onDone={() => setWritingFor(null)} /> : null}
          </li>
        ))}
      </ul>

      {editable ? (
        adding ? (
          <div className="flex flex-col gap-2">
            <p className="m-0 text-sm font-semibold text-zk-text">{projectId ? "New rule for issues in an area…" : "New rule for every issue, or for issues of a type…"}</p>
            <div className="flex flex-wrap gap-2">
              {projectId === null ? (
                <button type="button" disabled={pending || taken(null)} className={`${quiet} disabled:opacity-40`} onClick={() => run(async () => { setAdding(false); return addProofRuleAction({ projectId: null }); })}>
                  Every issue{taken(null) ? <span className="font-normal text-zk-muted"> · has a rule</span> : null}
                </button>
              ) : null}
              {scopes.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  disabled={pending || taken(s.id)}
                  className={`${quiet} disabled:opacity-40`}
                  onClick={() => run(async () => { setAdding(false); return addProofRuleAction(projectId ? { projectId, projectAreaId: s.id } : { projectId: null, issueTypeId: s.id }); })}
                >
                  {s.name}
                  {taken(s.id) ? <span className="font-normal text-zk-muted"> · has a rule</span> : null}
                </button>
              ))}
            </div>
            <p className="m-0 text-xs text-zk-muted">
              {projectId ? "Areas come from this project's Areas settings." : "Types come from Organisation › Issue types. Add one there and it shows up here."}
            </p>
            <button type="button" onClick={() => setAdding(false)} className="self-start text-sm font-semibold text-zk-muted">
              Cancel
            </button>
          </div>
        ) : (
          <button type="button" onClick={() => setAdding(true)} className={`${quiet} self-start`}>
            + Add a rule
          </button>
        )
      ) : null}

      {editable && projectId === null ? <WrittenChecks checks={checks.filter((c) => c.custom)} pending={pending} run={run} /> : null}
      {error ? <p role="alert" className="m-0 text-sm text-zk-bad-fg">{error}</p> : null}
    </div>
  );
}

/** A check in your own words: what the tester does and what proof to attach. With a rule, it's added to it. */
function WriteCheckForm({ ruleId, pending, run, onDone }: { ruleId?: string; pending: boolean; run: (action: () => Promise<ProofActionResult>) => void; onDone?: () => void }) {
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [required, setRequired] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <form
      className="flex flex-col gap-2 rounded-xl border border-zk-accent/40 bg-zk-tint/40 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        // Say what's missing instead of leaving the button greyed out.
        const missing =
          name.trim().length < 2 ? "Give the check a name (2 characters or more)." : instructions.trim().length < 10 ? "Say what the tester should do and what proof to attach (10 characters or more)." : null;
        setProblem(missing);
        if (missing) return;
        run(async () => {
          const result = await writeProofCheckAction({ name, instructions, required, ruleId });
          if (result.ok) {
            setName("");
            setInstructions("");
            onDone?.();
          }
          return result;
        });
      }}
    >
      <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="Name it, e.g. Real inbox test" className="rounded-xl border border-zk-border bg-zk-surface px-3 py-2 text-sm" />
      <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} maxLength={1000} rows={3} placeholder="What should the tester do, and what proof should they attach?" className="rounded-xl border border-zk-border bg-zk-surface px-3 py-2 text-sm" />
      <Strictness required={required} onChange={setRequired} />
      {problem ? (
        <p role="alert" className="m-0 text-sm text-zk-bad-fg">
          {problem}
        </p>
      ) : null}
      <span className="flex gap-2">
        <button type="submit" disabled={pending} className="rounded-full bg-electric-blue-strong px-4 py-2 text-sm font-bold text-white disabled:opacity-50">
          {ruleId ? "Add the check" : "Write the check"}
        </button>
        {onDone ? (
          <button type="button" onClick={onDone} className="px-2 text-sm font-semibold text-zk-muted">
            Cancel
          </button>
        ) : null}
      </span>
    </form>
  );
}

/** Required or guidance, with what each means. */
function Strictness({ required, disabled, onChange }: { required: boolean; disabled?: boolean; onChange: (required: boolean) => void }) {
  return (
    <span className="flex flex-col gap-1">
      <span role="group" aria-label="How strict" className="inline-flex w-fit rounded-full border border-zk-border bg-zk-chip p-0.5">
        {([true, false] as const).map((value) => (
          <button
            key={String(value)}
            type="button"
            aria-pressed={required === value}
            disabled={disabled}
            onClick={() => onChange(value)}
            className={`rounded-full px-3 py-1 text-sm font-semibold ${required === value ? "bg-zk-surface text-zk-text shadow-sm" : "text-zk-text2"}`}
          >
            {value ? "Required" : "Guidance"}
          </button>
        ))}
      </span>
      <span className="text-xs text-zk-muted">{required ? "The tester must attach proof, or their yes doesn't count." : "Testers see it and can attach proof, but it never holds a yes back."}</span>
    </span>
  );
}

/** The checks the organisation's owners wrote: what the tester does and what to attach, required or guidance. */
function WrittenChecks({ checks, pending, run }: { checks: ProofCheckView[]; pending: boolean; run: (action: () => Promise<ProofActionResult>) => void }) {
  const [writing, setWriting] = useState(false);
  return (
    <section aria-label="Checks you wrote" className="flex flex-col gap-3 border-t border-zk-divider pt-4">
      <h3 className="m-0 text-xs font-bold tracking-[0.06em] text-zk-muted uppercase">Checks you wrote</h3>
      {checks.length === 0 && !writing ? <p className="m-0 text-sm text-zk-muted">None yet. Write one when a rule needs a check the list doesn&apos;t have.</p> : null}
      {checks.map((c) => (
        <div key={c.id} className="flex flex-col gap-2 rounded-xl border border-zk-border p-4">
          <div className="flex items-start justify-between gap-3">
            <b className="flex items-center gap-1.5 text-sm text-zk-text">
              <CheckMark id="" /> {c.name}
            </b>
            <button type="button" aria-label={`Delete ${c.name}`} title={`Delete ${c.name}`} disabled={pending} onClick={() => run(() => deleteProofCheckAction(c.id))} className="p-1 text-zk-muted hover:text-zk-bad-fg">
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6" />
              </svg>
            </button>
          </div>
          <p className="m-0 text-sm whitespace-pre-line text-zk-text2">{c.proof}</p>
          <Strictness required={c.required} disabled={pending} onChange={(required) => run(() => setProofCheckRequiredAction(c.id, required))} />
        </div>
      ))}
      {writing ? (
        <WriteCheckForm pending={pending} run={run} onDone={() => setWriting(false)} />
      ) : (
        <button type="button" onClick={() => setWriting(true)} className={`${quiet} self-start`}>
          + Write a check
        </button>
      )}
    </section>
  );
}
