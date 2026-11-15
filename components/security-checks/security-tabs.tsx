import Link from "next/link";
import { PipelineSteps } from "@/components/pipeline-steps";
import { SecuritySettingsLink } from "@/components/security/security-settings-link";

/**
 * The top of Security once someone has something there (#security-checks):
 * the same stage bar as a project's Your Work and Ideas, with Findings and
 * settings as small icon links on the right, like the project's own icons.
 */
export function SecurityTabs({ selected, checks, jobs, canAdd = true }: { selected: "checks" | "work"; checks: number; jobs: number; canAdd?: boolean }) {
  // Only owners and admins own assets (13 Nov); everyone else sees just Your work.
  const stages = [
    ...(canAdd ? [{ label: "Assets", count: checks, href: "/security", selected: selected === "checks" }] : []),
    { label: "Your work", count: jobs, href: "/security/work", selected: selected === "work" },
  ];
  return (
    <>
    {/* Like a project's page: where you are, on a thin line above the tabs. */}
    <nav aria-label="Breadcrumb" className="mx-auto mb-3 flex w-full max-w-6xl items-center px-0.5 text-[13px] text-zk-text2 max-sm:mb-1">
      <ol className="m-0 flex min-w-0 list-none flex-wrap items-center gap-0.5 p-0">
        <li>
          <Link href="/security" className={`${CRUMB} block font-bold text-zk-text`}>Security</Link>
        </li>
        <li aria-hidden="true" className="text-zk-muted">/</li>
        <li>
          <span aria-current="page" className={`${CRUMB} block font-medium text-zk-text2`}>{selected === "checks" ? "Assets" : "Your work"}</span>
        </li>
      </ol>
    </nav>
    {/* The tabs, centred, as wide as the panel below, with the icons at its right edge. */}
    <div className="relative mx-auto mb-4 flex w-full max-w-6xl flex-wrap items-start justify-center gap-3 max-sm:mb-3">
      <PipelineSteps
        label="Security"
        stages={stages}
      />
      <div className="flex items-center gap-2 sm:absolute sm:right-0 sm:top-0">
        <Link
          href="/security?view=findings"
          aria-label="Findings"
          title="Findings"
          className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-zk-border bg-zk-surface text-zk-text transition hover:bg-zk-chip focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-electric-blue"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3z" />
            <path d="M12 8v4M12 16h.01" />
          </svg>
        </Link>
        <SecuritySettingsLink />
      </div>
    </div>
    </>
  );
}

const CRUMB = "rounded-md px-1.5 py-0.5 hover:bg-zk-chip hover:text-zk-text focus-visible:outline-2 focus-visible:outline-zk-accent";
