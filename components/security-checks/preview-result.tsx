import type { ReactNode } from "react";
import type { SecuritySeverity } from "@prisma/client";
import "@/components/security-finding.css";
import { SECURITY_SEVERITIES, SEVERITY_LABEL } from "@/lib/security-severity";
import { PREVIEW_RISK_LABEL, type PreviewSummary } from "@/lib/security-checks/preview-summary";

const CHIP = "inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-bold";
const OK_CHIP = `bg-zk-ok-bg text-zk-ok-fg ${CHIP}`;
/** A clear result's tint: the green of "Report ready". */
const TINT_OK = "border-transparent bg-zk-ok-bg text-zk-ok-fg";

/**
 * A quick scan's result (#security-checks). Everything the first design showed
 * (whether HTTPS is set up, how many problems and of what kind, the risk
 * level, what a quick scan can't see, and every area it looked at with Fine or
 * its problems), drawn in the app's own look: the report's card, headings and
 * severity chips (report-results.tsx, security-finding.css). Only what any
 * browser can see, so the titles are shown; never the detail or the fix. The
 * agents' report replaces it once it's ready. `children` holds the next step.
 */
export function PreviewResult({ summary, children }: { summary: PreviewSummary; children?: ReactNode }) {
  const { counts, total, risk } = summary;
  const rank = (severity: SecuritySeverity) => SECURITY_SEVERITIES.indexOf(severity);
  const rows = [...(summary.rows ?? [])].sort((a, b) => rank(a.severity) - rank(b.severity));
  const https = summary.areas.find((area) => area.area === "https");
  const certificate = summary.areas.find((area) => area.area === "certificate");
  const secure = (https?.problems ?? 0) + (certificate?.problems ?? 0) === 0;
  const worst = SECURITY_SEVERITIES.find((severity) => counts[severity] > 0) ?? null;
  const worstIn = (area: string) => SECURITY_SEVERITIES.find((severity) => rows.some((row) => row.area === area && row.severity === severity)) ?? worst ?? "medium";
  const breakdown = SECURITY_SEVERITIES.filter((severity) => counts[severity] > 0)
    .map((severity) => `${counts[severity]} ${severity}`)
    .join(", ");

  return (
    <section aria-label="Quick scan" className="w-full overflow-hidden rounded-[20px] border border-zk-border bg-zk-surface text-left">
      <div className="px-4 pt-4 sm:px-6 sm:pt-5">
        <h3 className="m-0 text-base font-semibold text-zk-text">Quick scan</h3>
        <p className="m-0 text-xs text-zk-muted">What any browser can see. The agents check much more, and their report replaces this.</p>

        {/* The three things to know at a glance. */}
        <dl className="m-0 mt-4 grid gap-2 sm:grid-cols-3">
          <Fact
            label="Problems"
            tone={worst ? `security-severity security-severity--${worst}` : TINT_OK}
            icon={worst ? "!" : "✓"}
            value={total ? `${total} found` : "None found"}
            detail={total ? breakdown : "In what a quick scan can see."}
          />
          {https || certificate ? (
            <Fact
              label="HTTPS"
              tone={secure ? TINT_OK : "security-severity security-severity--high"}
              icon={secure ? "✓" : "!"}
              value={secure ? "Set up" : "Needs work"}
              detail={secure ? "Loads securely, valid certificate." : "Browsers may not reach it securely."}
            />
          ) : null}
          <Fact
            label="Security risk"
            tone={risk === "minimal" ? TINT_OK : `security-severity security-severity--${risk}`}
            icon={risk === "minimal" ? "✓" : "!"}
            value={PREVIEW_RISK_LABEL[risk]}
            detail={risk === "minimal" ? "Nothing worrying a browser can see." : "From what a browser can see."}
          />
        </dl>
      </div>

      {/* Every area it looked at, Fine or with its problems, worst first. */}
      <ol className="m-0 mt-4 list-none divide-y divide-zk-border border-t border-zk-border p-0">
        {summary.areas.map((area) => {
          const found = rows.filter((row) => row.area === area.area);
          return (
            <li key={area.area} className="relative px-4 py-3 sm:px-6">
              {/* A coloured stripe: green when fine, the worst problem's colour otherwise. */}
              <span
                aria-hidden="true"
                className={`absolute inset-y-2 left-0 w-1 rounded-r ${area.problems ? `security-severity security-severity--${worstIn(area.area)}` : "bg-zk-ok-fg"}`}
                style={area.problems ? { background: "currentColor" } : undefined}
              />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="m-0 text-sm font-semibold text-zk-text">{area.label}</h4>
                {area.problems ? (
                  <span className={`security-severity security-severity--${worstIn(area.area)} ${CHIP}`}>
                    {area.problems} {area.problems === 1 ? "problem" : "problems"}
                  </span>
                ) : (
                  <span className={OK_CHIP}>✓ Fine</span>
                )}
              </div>
              {found.length ? (
                <ul className="m-0 mt-2 flex list-none flex-col gap-1.5 p-0">
                  {found.map((row, index) => (
                    <li key={index} className="flex items-center gap-3 text-sm">
                      <span className={`security-severity security-severity--${row.severity} ${CHIP} w-[72px] justify-center`}>{SEVERITY_LABEL[row.severity]}</span>
                      {/* What any browser can see, so it's shown: the title only, never the detail or the fix. */}
                      <span className="min-w-0 flex-1 wrap-break-word text-zk-text">{row.title ?? "A problem in this area"}</span>
                    </li>
                  ))}
                </ul>
              ) : area.problems ? (
                <p className="m-0 mt-1 text-xs text-zk-muted">Scan again to see what was found here.</p>
              ) : null}
            </li>
          );
        })}
      </ol>

      {children ? <div className="border-t border-zk-border px-4 py-3 sm:px-6">{children}</div> : null}
    </section>
  );
}

function Fact({ label, tone, icon, value, detail }: { label: string; tone: string; icon: string; value: string; detail: string }) {
  return (
    <div className={`rounded-xl border px-3 py-2.5 ${tone}`}>
      <dt className="text-xs font-semibold opacity-80">{label}</dt>
      <dd className="m-0 mt-0.5">
        <span className="flex items-center gap-1.5 text-base font-bold">
          <span aria-hidden="true" className="grid h-5 w-5 place-items-center rounded-full bg-current text-[11px] leading-none"><span className="text-white">{icon}</span></span>
          {value}
        </span>
        <span className="block text-xs opacity-80">{detail}</span>
      </dd>
    </div>
  );
}

/**
 * The quick scan on the scan's own page, before the agents' report: just its
 * problems, worst first, laid out like the report's "What we found"
 * (report-results.tsx) so the page reads the same before and after. The
 * agents' report replaces it once it's ready.
 */
export function QuickScanList({ summary }: { summary: PreviewSummary }) {
  const { counts, total } = summary;
  const rank = (severity: SecuritySeverity) => SECURITY_SEVERITIES.indexOf(severity);
  const rows = [...(summary.rows ?? [])].sort((a, b) => rank(a.severity) - rank(b.severity));
  const areaLabel = new Map(summary.areas.map((area) => [area.area, area.label]));

  return (
    <section aria-labelledby="quick-scan-heading" className="overflow-hidden rounded-[20px] border border-zk-border bg-zk-surface">
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 pt-4 sm:px-6 sm:pt-5">
        <div className="min-w-0">
          <h2 id="quick-scan-heading" className="text-base font-semibold text-zk-text">Quick scan</h2>
          <p className="text-xs text-zk-muted">What any browser can see, worst first. The agents&apos; report replaces this.</p>
        </div>
        <ul aria-label="Results by severity" className="m-0 flex list-none flex-wrap gap-1.5 p-0">
          {total ? (
            SECURITY_SEVERITIES.filter((severity) => counts[severity] > 0).map((severity) => (
              <li key={severity}>
                <span className={`security-severity security-severity--${severity} ${CHIP}`}>
                  {counts[severity]} {SEVERITY_LABEL[severity].toLowerCase()}
                </span>
              </li>
            ))
          ) : (
            <li>
              <span className={OK_CHIP}>No problems found</span>
            </li>
          )}
        </ul>
      </div>
      {rows.length ? (
        <ol className="m-0 mt-3 list-none divide-y divide-zk-border border-t border-zk-border p-0">
          {rows.map((row, index) => (
            <li key={index} className="grid gap-1.5 px-4 py-3 sm:grid-cols-[6rem_minmax(0,1fr)] sm:gap-4 sm:px-6">
              <div>
                <span className={`security-severity security-severity--${row.severity} ${CHIP}`}>{SEVERITY_LABEL[row.severity]}</span>
              </div>
              <div className="min-w-0">
                <p className="m-0 wrap-break-word text-sm font-semibold text-zk-text">{row.title ?? "A problem in this area"}</p>
                {areaLabel.get(row.area) ? <p className="m-0 text-xs text-zk-muted">{areaLabel.get(row.area)}</p> : null}
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="m-0 mt-3 border-t border-zk-border px-4 py-4 text-sm text-zk-text2 sm:px-6">
          {total ? "Scan again to see what was found." : "Nothing a browser can see needs fixing."}
        </p>
      )}
    </section>
  );
}
