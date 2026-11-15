"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { orgPath, type ProjectRef } from "@/lib/project-paths";
import { SETTINGS_SECTIONS } from "@/lib/settings-sections";

/** The organisation's settings, one page each under /<org>/<project>/org (#project-urls). */
const ORG_SECTIONS = [
  { section: "", label: "Overview", icon: "M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z" },
  { section: "members", label: "Members", icon: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" },
  { section: "agents", label: "Agents", icon: "M4 8h16v12H4zM12 4v4M9 14h.01M15 14h.01" },
  // #secret-protection: credentials stopped or found in this organisation's posts.
  { section: "secrets", label: "Secret alerts", icon: "M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4" },
  { section: "invites", label: "Invites", icon: "M4 4h16v16H4zM4 7l8 6 8-6" },
  { section: "projects", label: "Projects", icon: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" },
  { section: "types", label: "Issue types", icon: "M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8zM7.5 7.5h.01" },
  { section: "milestones", label: "Milestones", icon: "M4 22V4M4 4h12l-2 4 2 4H4" },
  // #deeper-testing: what every project must prove. Owners only.
  { section: "checks", label: "Checks", icon: "M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11", ownerOnly: true },
  { section: "settings", label: "General", icon: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-2.82 1.17V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-2.9-1.18l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 3.17 14H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.18-2.9l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 10 3.17V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 2.82 1.18l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 20.83 10H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" },
] as const;

/**
 * One sidebar for all settings: yours (/settings) and, below them, your
 * organisation's. /settings and the organisation pages both show it, so they
 * read as one Settings area.
 */
export function SettingsNav({ orgRef, orgName, pendingJoinCount = 0, owner = false }: { orgRef: ProjectRef | null; orgName?: string | null; pendingJoinCount?: number; owner?: boolean }) {
  const pathname = (usePathname() ?? "").replace(/\/+$/, "") || "/";
  const params = useSearchParams();
  const onSettings = pathname === "/settings";
  const section = params.get("section") ?? "account";

  return (
    <nav aria-label="Settings sections" className="settings-navigation">
      {SETTINGS_SECTIONS.map((item) => {
        const on = onSettings && section === item.id;
        return (
          <Link
            key={item.id}
            href={`/settings?section=${item.id}`}
            aria-current={on ? "page" : undefined}
            className={`flex w-full items-center gap-3 rounded-[14px] px-3 py-2.5 text-left text-zk-text transition ${
              on ? "bg-zk-tint" : "bg-transparent hover:bg-zk-chip"
            }`}
          >
            <span
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
                on ? "bg-electric-blue-strong text-white" : "bg-zk-chip text-zk-text2"
              }`}
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d={item.icon} />
              </svg>
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm font-bold">{item.label}</span>
              <span className="text-xs font-medium text-zk-muted">{item.hint}</span>
            </span>
          </Link>
        );
      })}

      {orgRef ? (
        <div className="col-span-full mt-2 border-t border-zk-divider px-1 pt-3">
          <p className="px-2 pb-1 text-[11px] font-bold uppercase tracking-[0.06em] text-zk-muted">
            Organisation{orgName ? ` · ${orgName}` : ""}
          </p>
          <ul className="m-0 list-none p-0">
            {ORG_SECTIONS.filter((item) => owner || !("ownerOnly" in item)).map((item) => {
              const href = orgPath(orgRef, item.section);
              const on = item.section === "" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
              return (
                <li key={item.label}>
                  <Link
                    href={href}
                    aria-current={on ? "page" : undefined}
                    className={`flex min-h-9 items-center gap-2.5 rounded-[10px] px-2.5 text-sm transition ${
                      on ? "bg-zk-tint font-bold text-zk-accent" : "font-medium text-zk-text2 hover:bg-zk-chip hover:text-zk-text"
                    }`}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
                      <path d={item.icon} />
                    </svg>
                    {item.label}
                    {item.section === "invites" && pendingJoinCount > 0 ? (
                      <span className="ml-auto inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-electric-blue-strong px-1 text-[10px] font-bold text-white">
                        {pendingJoinCount}
                        <span className="sr-only"> pending join requests</span>
                      </span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </nav>
  );
}
