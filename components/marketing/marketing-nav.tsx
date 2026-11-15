"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { marketingPath, type ProjectRef } from "@/lib/project-paths";

const focus = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-electric-blue";
const action = `inline-flex min-h-10 shrink-0 items-center gap-2 rounded-full text-sm font-bold transition ${focus}`;
const quiet = "border border-zk-border bg-zk-surface text-zk-text hover:bg-zk-chip aria-[current=page]:border-transparent aria-[current=page]:bg-zk-tint aria-[current=page]:text-zk-accent";

const iconProps = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, className: "h-4 w-4" } as const;

/** The Marketing section's header: the tasks board, finished work, settings and proposing a task. The breadcrumb names the section. */
export function MarketingNav({ slug }: { slug: ProjectRef }) {
  const pathname = usePathname()?.replace(/\/+$/, "") ?? "";
  const tasks = marketingPath(slug, "tasks");
  const output = marketingPath(slug, "output-box");
  const settings = marketingPath(slug, "settings");
  const plans = marketingPath(slug, "plans");
  const newTask = marketingPath(slug, "tasks/new");
  const current = (href: string) => (pathname === href || pathname.startsWith(`${href}/`) ? "page" : undefined);

  return (
    <nav aria-label="Marketing" className="mx-auto mb-5 flex w-full max-w-6xl flex-wrap items-center justify-end gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Link href={tasks} aria-current={pathname === tasks ? "page" : undefined} className={`${action} ${quiet} px-4`}>
          <svg {...iconProps}>
            <path d="M9 6h11M9 12h11M9 18h11" />
            <path d="m3 6 1 1 2-2M3 12l1 1 2-2M3 18l1 1 2-2" />
          </svg>
          Tasks
        </Link>
        <Link href={output} aria-current={current(output)} className={`${action} ${quiet} px-4`}>
          <svg {...iconProps}>
            <path d="M22 12h-6l-2 3h-4l-2-3H2" />
            <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
          </svg>
          Output box
        </Link>
        <Link href={plans} aria-current={current(plans)} className={`${action} ${quiet} px-4`}>Plans</Link>
        <Link href={settings} aria-current={current(settings)} aria-label="Marketing settings" title="Marketing settings" className={`${action} ${quiet} w-10 justify-center`}>
          <svg {...iconProps}>
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </Link>
        {pathname === newTask ? null : (
          <Link href={newTask} className={`${action} bg-electric-blue-strong px-4 text-white hover:opacity-90`}>
            Propose a task
          </Link>
        )}
      </div>
    </nav>
  );
}
