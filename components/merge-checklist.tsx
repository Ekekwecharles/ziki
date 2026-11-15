import type { ChecklistState, MergeChecklist } from "@/lib/merge-checklist";

/**
 * The ready-to-merge checklist in the issue's side rail (#merge-checklist):
 * what the latest pull request report says about each check a tester or
 * manager looks at before "good to merge", plus the checks only a person or
 * agent trying the fix can do. Read-only: judgements are still given the
 * usual way (POST /api/v1/issues/{id}/test-results).
 */

const ICON: Record<ChecklistState, { label: string; className: string; path: string }> = {
  pass: { label: "Passed", className: "text-zk-ok-fg", path: "M7.5 12.5l3 3 6-6.5" },
  fail: { label: "Failed", className: "text-zk-bad-fg", path: "M9 9l6 6M15 9l-6 6" },
  wait: { label: "Not known yet", className: "text-zk-muted", path: "M12 7v5l3 2" },
};

function StateIcon({ state }: { state: ChecklistState }) {
  const icon = ICON[state];
  return (
    <svg viewBox="0 0 24 24" className={`mt-px h-4 w-4 shrink-0 ${icon.className}`} fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" role="img" aria-label={icon.label}>
      <circle cx="12" cy="12" r="10" />
      <path d={icon.path} />
    </svg>
  );
}

const HEADLINE_TONE: Record<MergeChecklist["verdict"], string> = {
  ready: "bg-zk-ok-bg text-zk-ok-fg",
  blocked: "bg-zk-bad-bg text-zk-bad-fg",
  waiting: "bg-zk-chip text-zk-text2",
};

/** What a tester checks by trying the fix; no report can say these. */
export const MANUAL_CHECKS = [
  "The fix works when tried",
  "Looks right at phone width, in light and dark",
  "Follows the project's rules (PR template, scope)",
] as const;

export function MergeChecklistCard({ checklist, testCard = false }: { checklist: MergeChecklist; /** The issue has a test card (#deeper-testing). */ testCard?: boolean }) {
  const percent = Math.round((checklist.passed / checklist.total) * 100);
  return (
    <section aria-labelledby="merge-checklist-heading" data-testid="merge-checklist" className="flex flex-col gap-3 rounded-[20px] border border-zk-border bg-zk-surface px-4 py-3.5">
      <div className="flex items-center justify-between gap-2">
        <h2 id="merge-checklist-heading" className="text-xs font-bold uppercase tracking-[0.08em] text-zk-muted">
          Ready-to-merge checklist
        </h2>
        <span className="text-xs font-bold tabular-nums text-zk-text2">
          {checklist.passed} / {checklist.total}
        </span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-zk-chip"
        role="progressbar"
        aria-label="Checks passed"
        aria-valuemin={0}
        aria-valuemax={checklist.total}
        aria-valuenow={checklist.passed}
      >
        <div className={`h-full rounded-full ${checklist.verdict === "blocked" ? "bg-zk-bad-fg" : checklist.verdict === "ready" ? "bg-zk-ok-fg" : "bg-electric-blue"}`} style={{ width: `${percent}%` }} />
      </div>
      <p data-testid="merge-checklist-headline" className={`m-0 rounded-lg px-2.5 py-1.5 text-xs font-semibold ${HEADLINE_TONE[checklist.verdict]}`}>
        {checklist.headline}
      </p>

      <div>
        <h3 className="m-0 text-[11px] font-bold uppercase tracking-[0.06em] text-zk-muted">From the latest pull request report</h3>
        <ul className="m-0 mt-1.5 flex list-none flex-col gap-1.5 p-0">
          {checklist.items.map((item) => (
            <li key={item.key} data-state={item.state} className="flex items-start gap-2 text-xs leading-5">
              <StateIcon state={item.state} />
              <span className="min-w-0">
                <span className={item.state === "fail" ? "font-semibold text-zk-bad-fg" : "text-zk-text"}>{item.label}</span>
                {item.detail ? <span className="block text-zk-muted">{item.detail}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="border-t border-zk-divider pt-2.5">
        <h3 className="m-0 text-[11px] font-bold uppercase tracking-[0.06em] text-zk-muted">Testers also check</h3>
        {testCard ? (
          <p className="m-0 mt-1.5 text-xs leading-5 text-zk-text2">
            On the{" "}
            <a href="#test-card" className="font-semibold text-zk-accent hover:underline">
              test card
            </a>
            , with proof for each square.
          </p>
        ) : (
          <ul className="m-0 mt-1.5 flex list-none flex-col gap-1 p-0">
            {MANUAL_CHECKS.map((check) => (
              <li key={check} className="flex items-start gap-2 text-xs leading-5 text-zk-text2">
                <span aria-hidden="true" className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-zk-muted" />
                {check}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
