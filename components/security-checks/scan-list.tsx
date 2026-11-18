"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { TARGET_KIND_LABEL } from "@/lib/security-checks";
import type { ScanStage, WorkspaceCheckRow } from "@/lib/security-checks/entry";
import { LocalTime } from "@/components/local-time";
import { ToolbarFilterMenu } from "@/components/toolbar-filter-menu";
import { PaginationControls } from "@/components/pagination-controls";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { removeScan } from "@/app/actions/security-assistant";
import { useRescan } from "./use-rescan";
import { KindIcon } from "./entry-box";
import "@/components/security-finding.css";
import { SecurityChat, chatLeftOpen, keepChatOpen, startNewChat } from "./security-chat";

/** Rows on each page. */
const PAGE = 10;

const STAGE: Record<ScanStage, { label: string; text: string; dot: string }> = {
  scanning: { label: "Scanning", text: "text-zk-accent", dot: "bg-electric-blue-strong" },
  report: { label: "Report ready", text: "text-zk-ok-fg", dot: "bg-zk-ok-fg" },
  in_app: { label: "In your app", text: "text-zk-text2", dot: "bg-zk-muted" },
  cancelled: { label: "Cancelled", text: "text-zk-muted", dot: "bg-zk-muted" },
};

const SEVERITIES = ["critical", "high", "medium", "low"] as const;
type Severity = (typeof SEVERITIES)[number];

/** Filter menu choices (?show=), in Ziki's own Filter menu, as on Issues. */
type Filter = "all" | "scanning" | "report" | "in_app" | "severe" | "clear" | "website" | "server" | "repo";
const STAGE_FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "scanning", label: "Scanning" },
  { id: "report", label: "Report ready" },
  { id: "in_app", label: "In your app" },
];
const ATTENTION_FILTERS: { id: Filter; label: string }[] = [
  { id: "severe", label: "Critical or high" },
  { id: "clear", label: "No problems" },
];
const KIND_FILTERS: { id: Filter; label: string }[] = [
  { id: "website", label: "Website" },
  { id: "server", label: "Server" },
  { id: "repo", label: "GitHub repo" },
];
const ALL_FILTERS = [...STAGE_FILTERS, ...ATTENTION_FILTERS, ...KIND_FILTERS];

type SortKey = "target" | "problems" | "added";

/** Where a scan is: the same rule as scanStage in lib/security-checks/entry.ts, kept here so this client file needs no server code. */
function stageOf(check: Pick<WorkspaceCheckRow, "status" | "posted" | "moved">): ScanStage {
  if (check.status === "cancelled") return "cancelled";
  if (check.moved > 0) return "in_app";
  return check.posted ? "report" : "scanning";
}

/** What was found, worst first: the agents' report once it's posted, the quick scan before that. */
function problemsOf(check: WorkspaceCheckRow) {
  const agent = check.agentReport;
  const found: [Severity, number][] = agent
    ? SEVERITIES.map((severity) => [severity, agent.findings.filter((finding) => finding.severity === severity).length])
    : check.preview
      ? SEVERITIES.map((severity) => [severity, check.preview!.counts[severity]])
      : [];
  const total = found.reduce((sum, [, n]) => sum + n, 0);
  // A posted report with nothing in it counts as nothing found, even with no counts to show.
  const nothing = (found.length > 0 && total === 0) || (check.posted && check.findings === 0);
  // Worst first when sorting: critical counts most, then high, medium and low.
  const weight = found.reduce((sum, [severity, n]) => sum + n * { critical: 1000000, high: 10000, medium: 100, low: 1 }[severity], 0);
  return { found, total, nothing, weight, fromAgents: Boolean(agent) };
}

function matchesFilter(check: WorkspaceCheckRow, filter: Filter): boolean {
  if (filter === "all") return true;
  if (filter === "scanning" || filter === "report" || filter === "in_app") return stageOf(check) === filter;
  if (filter === "website" || filter === "server" || filter === "repo") return check.kind === filter;
  const { found, nothing } = problemsOf(check);
  if (filter === "clear") return nothing;
  return found.some(([severity, n]) => (severity === "critical" || severity === "high") && n > 0);
}

/** When it was last scanned: its quick scan's date (Scan again updates it), else when it was added. */
function lastScanned(check: WorkspaceCheckRow): Date {
  const at = check.preview?.checkedAt ? new Date(check.preview.checkedAt) : null;
  return at && !Number.isNaN(at.getTime()) ? at : new Date(check.createdAt);
}

/** Where the name takes you: the website itself, or the repo on GitHub. A server address has no page to open. */
function siteUrl(check: WorkspaceCheckRow): string | null {
  if (check.kind === "repo") return `https://github.com/${check.value.replace(/^https?:\/\/(www\.)?github\.com\//i, "")}`;
  if (check.kind !== "website") return null;
  const host = hostOf(check.value);
  return host ? (/^[a-z]+:\/\//i.test(check.value) ? check.value : `https://${check.value}`) : null;
}

/** The site's address without its scheme or path, for its icon. */
function hostOf(value: string): string | null {
  try {
    return new URL(/^[a-z]+:\/\//i.test(value) ? value : `https://${value}`).hostname || null;
  } catch {
    return null;
  }
}

/**
 * The person's targets (#security-checks), as security tools list theirs (Intruder's Targets,
 * Tenable's Applications, Detectify's Domains): a count and Filter and search above a table; a
 * box on each row to scan again or remove several at once (the actions appear next to Filter only
 * once something is ticked, as on Intruder); each site with its own icon; columns that sort;
 * a "…" menu per row; the whole row opens the target. Ziki's Filter menu and colours throughout.
 */
export function ScanList({
  checks,
  highlightId,
  show = "all",
  page = 1,
  adding,
  hideId,
}: {
  checks: WorkspaceCheckRow[];
  highlightId?: string;
  show?: string;
  page?: number;
  adding?: ReactNode;
  hideId?: string | null;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const toast = useToast();
  const [removing, start] = useTransition();
  const { rescan, pending: rescanning } = useRescan();
  const busy = removing || rescanning;
  const filter: Filter = ALL_FILTERS.some(({ id }) => id === show) ? (show as Filter) : "all";
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "added", dir: "desc" });
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const searchBox = useRef<HTMLInputElement>(null);
  // Opening the search puts the cursor in it.
  useEffect(() => {
    if (searching) searchBox.current?.focus();
  }, [searching]);

  // Removed scans leave the list, and so, for now, does the one whose result is showing in the chat.
  const live = useMemo(() => checks.filter((check) => check.status !== "cancelled" && check.id !== hideId), [checks, hideId]);
  const count = (id: Filter) => live.filter((check) => matchesFilter(check, id)).length;
  const words = query.trim().toLowerCase();
  const matching = useMemo(() => {
    const rows = live.filter((check) => matchesFilter(check, filter) && (!words || check.value.toLowerCase().includes(words)));
    const order = sort.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      if (sort.key === "target") return a.value.localeCompare(b.value) * order;
      if (sort.key === "problems") return (problemsOf(a).weight - problemsOf(b).weight) * order;
      return (lastScanned(a).getTime() - lastScanned(b).getTime()) * order;
    });
  }, [live, filter, words, sort]);
  // Numbered pages like the app's issue lists; a search looks through every page.
  const totalPages = Math.max(1, Math.ceil(matching.length / PAGE));
  const current = words ? 1 : Math.min(Math.max(1, page), totalPages);
  const visible = words ? matching : matching.slice((current - 1) * PAGE, current * PAGE);
  const ticked = visible.filter((check) => picked.has(check.id));
  const allTicked = visible.length > 0 && ticked.length === visible.length;
  const pageHref = (n: number) => {
    const params = new URLSearchParams();
    if (filter !== "all") params.set("show", filter);
    if (n > 1) params.set("page", String(n));
    const text = params.toString();
    return text ? `/security?${text}` : "/security";
  };

  function toggle(id: string) {
    setPicked((now) => {
      const next = new Set(now);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function sortBy(key: SortKey) {
    setSort((now) => (now.key === key ? { key, dir: now.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "target" ? "asc" : "desc" }));
  }

  // Scan again with agents (#security-rescan): paid, after one confirm, for scans whose report is in.
  function scanAgain(rows: WorkspaceCheckRow[]) {
    const finished = rows.filter((row) => row.posted);
    if (!finished.length) {
      toast(rows.length === 1 ? "Scan this again once its report is in." : "None of these has its report in yet.", "error");
      return;
    }
    setPicked(new Set());
    rescan(finished.map((row) => row.id));
  }

  async function remove(rows: WorkspaceCheckRow[]) {
    const one = rows.length === 1;
    const confirmed = await confirm({
      title: one ? `Remove ${rows[0].value}?` : `Remove ${rows.length} targets?`,
      body: "Agents stop checking, and any report goes too. Anything you moved to your app stays there.",
      confirmLabel: one ? "Remove scan" : `Remove ${rows.length}`,
      tone: "danger",
    });
    if (!confirmed) return;
    start(async () => {
      let failed = 0;
      for (const row of rows) {
        const answer = await removeScan(row.id);
        if (!answer.ok) failed += 1;
      }
      setPicked(new Set());
      router.refresh();
      toast(failed ? `${rows.length - failed} removed; ${failed} couldn't be.` : one ? "Scan removed." : `${rows.length} targets removed.`, failed ? "error" : undefined);
    });
  }

  const sortButton = (key: SortKey, label: string) => {
    const on = sort.key === key;
    return (
      <button
        type="button"
        onClick={() => sortBy(key)}
        aria-label={`Sort by ${label.toLowerCase()}`}
        className={`inline-flex items-center gap-1 rounded hover:text-zk-text focus-visible:outline-2 focus-visible:outline-electric-blue ${on ? "text-zk-text" : ""}`}
      >
        {label}
        <span aria-hidden="true" className={`text-[11px] ${on ? "text-zk-accent" : "text-zk-muted/70"}`}>{on ? (sort.dir === "asc" ? "↑" : "↓") : "⇅"}</span>
      </button>
    );
  };

  return (
    <div className="flex flex-col">
      {/* The list's own toolbar: how many on the left; once something is ticked, its actions sit next to Filter. */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-5">
        <p className="m-0 text-sm font-bold text-zk-text">
          {matching.length} {matching.length === 1 ? "target" : "targets"}
          {ticked.length ? <span className="font-medium text-zk-muted"> · {ticked.length} selected</span> : null}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {ticked.length ? (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => scanAgain(ticked)}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-zk-border bg-zk-surface px-3 text-[13px] font-medium text-zk-text2 hover:bg-zk-chip hover:text-zk-text disabled:opacity-60"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7L21 8" /><path d="M21 3v5h-5" /></svg>
                Scan again
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => remove(ticked)}
                className="inline-flex h-8 items-center rounded-lg border border-zk-border bg-zk-surface px-3 text-[13px] font-medium text-[#b42318] hover:bg-zk-chip disabled:opacity-60"
              >
                Remove
              </button>
              <span aria-hidden="true" className="mx-1 h-5 w-px bg-zk-border" />
            </>
          ) : null}
          {searching ? (
            <input
              ref={searchBox}
              type="search"
              aria-label="Search your targets"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onBlur={() => {
                if (!query.trim()) setSearching(false);
              }}
              placeholder="Search by site"
              className="h-8 w-44 rounded-lg border border-zk-border bg-zk-surface px-3 text-[13px] text-zk-text placeholder:text-zk-muted focus:border-electric-blue-strong/60 focus:outline-none sm:w-60"
            />
          ) : null}
          <ToolbarFilterMenu
            summary={filter === "all" ? "" : ALL_FILTERS.find(({ id }) => id === filter)?.label}
            groups={[
              { label: "Status", options: STAGE_FILTERS.map(({ id, label }) => ({ label, count: count(id), href: id === "all" ? "/security" : `/security?show=${id}`, selected: filter === id })) },
              { label: "Needs attention", options: ATTENTION_FILTERS.map(({ id, label }) => ({ label, count: count(id), href: `/security?show=${id}`, selected: filter === id })) },
              { label: "Type", options: KIND_FILTERS.map(({ id, label }) => ({ label, count: count(id), href: `/security?show=${id}`, selected: filter === id })) },
            ]}
          />
          <button
            type="button"
            aria-label="Search your targets"
            aria-pressed={searching}
            onClick={() => setSearching((open) => !open)}
            className="grid h-8 w-8 place-items-center rounded-lg border border-zk-border bg-zk-surface text-zk-text2 hover:bg-zk-chip hover:text-zk-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-electric-blue"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          </button>
        </div>
      </div>

      {/* "+ Add target" opens the box here, above the list. */}
      {adding ? <div className="px-4 pb-4 sm:px-5">{adding}</div> : null}

      {visible.length ? (
        <div role="table" aria-label="Your targets" className="border-t border-zk-border">
          <div role="row" className="grid grid-cols-[20px_minmax(0,1fr)_auto_28px] items-center gap-x-2 sm:gap-x-3 md:grid-cols-[20px_minmax(0,2.4fr)_minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1.1fr)_minmax(0,1fr)_32px] border-b border-zk-border px-3 py-3 text-xs font-semibold text-zk-muted sm:px-5">
            <span role="columnheader" className="flex justify-center">
              <input
                type="checkbox"
                aria-label={allTicked ? "Untick all targets on this page" : "Tick all targets on this page"}
                checked={allTicked}
                ref={(box) => {
                  if (box) box.indeterminate = ticked.length > 0 && !allTicked;
                }}
                onChange={() => setPicked(allTicked ? new Set() : new Set(visible.map((check) => check.id)))}
                className="h-4 w-4 accent-electric-blue-strong"
              />
            </span>
            <span role="columnheader" className="min-w-0">{sortButton("target", "Target")}</span>
            <span role="columnheader" className="hidden md:block">Type</span>
            <span role="columnheader">{sortButton("problems", "Problems")}</span>
            <span role="columnheader" className="hidden md:block">{sortButton("added", "Last scanned")}</span>
            <span role="columnheader" className="hidden md:block">Status</span>
            <span role="columnheader"><span className="sr-only">More</span></span>
          </div>
          {visible.map((check) => (
            <TargetRow
              key={check.id}
              check={check}
              highlighted={highlightId === check.id}
              ticked={picked.has(check.id)}
              onTick={() => toggle(check.id)}
              onScanAgain={() => scanAgain([check])}
              onRemove={() => remove([check])}
              busy={busy}
            />
          ))}
        </div>
      ) : (
        <p className="m-4 rounded-2xl border border-dashed border-zk-border px-4 py-8 text-center text-sm text-zk-muted sm:m-5">
          {words ? `No targets match "${query.trim()}".` : "No targets here yet."}
        </p>
      )}

      {matching.length && !words ? (
        <div className="border-t border-zk-border px-4 py-3 sm:px-5">
          {/* A computer gets Ziki's numbered pages; a phone gets "1–10 of 20 ‹ ›", as Gmail does on a phone. */}
          <div className="hidden md:block">
            <PaginationControls
              page={current}
              totalPages={totalPages}
              totalCount={matching.length}
              from={(current - 1) * PAGE + 1}
              to={Math.min(current * PAGE, matching.length)}
              basePath="/security"
              queryParams={{ show: filter === "all" ? undefined : filter }}
              itemLabel="target"
            />
          </div>
          <div className="flex items-center justify-end gap-2 md:hidden">
            <span className="mr-1 text-[13px] text-zk-text2 tabular-nums">
              {(current - 1) * PAGE + 1}–{Math.min(current * PAGE, matching.length)} of {matching.length}
            </span>
            <PageArrow href={current > 1 ? pageHref(current - 1) : null} label="Previous page" glyph="‹" />
            <PageArrow href={current < totalPages ? pageHref(current + 1) : null} label="Next page" glyph="›" />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function PageArrow({ href, label, glyph }: { href: string | null; label: string; glyph: string }) {
  const look = "grid h-8 w-8 place-items-center rounded-lg border border-zk-border bg-zk-surface text-base text-zk-text2";
  return href ? (
    <Link href={href} aria-label={label} className={`${look} hover:bg-zk-chip`}>{glyph}</Link>
  ) : (
    <span aria-label={label} aria-disabled="true" className={`${look} opacity-40`}>{glyph}</span>
  );
}

/** The site's own icon, like Netlify and Vercel list sites: Ziki's server finds the one the site declares (security/checks/[id]/icon). The globe, server or repo icon when there isn't one. */
function TargetIcon({ check }: { check: WorkspaceCheckRow }) {
  const host = check.kind === "website" ? hostOf(check.value) : null; // only websites have an icon to look for
  const [failed, setFailed] = useState(false);
  const image = useRef<HTMLImageElement>(null);
  // An icon that failed before the page came alive never fires onError: check it once on mount.
  useEffect(() => {
    const img = image.current;
    if (img && img.complete && img.naturalWidth < 2) setFailed(true);
  }, []);
  return (
    <span className="grid h-7 w-7 shrink-0 place-items-center overflow-hidden rounded-md border border-zk-border bg-zk-surface">
      {host && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element -- the site's own favicon, from the site itself
        <img
          ref={image}
          src={`/security/checks/${check.id}/icon`}
          alt=""
          width={16}
          height={16}
          onError={() => setFailed(true)}
          onLoad={(event) => {
            if (event.currentTarget.naturalWidth < 2) setFailed(true);
          }}
          className="h-4 w-4"
        />
      ) : (
        <KindIcon kind={check.kind} className="h-4 w-4 text-zk-text2" />
      )}
    </span>
  );
}

/** Nothing found: a small green label. */
function NoProblems() {
  return (
    <span className="inline-flex items-center gap-1 text-xs font-bold text-zk-ok-fg">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
      No problems
    </span>
  );
}

/** One target as a row: box, the site, its type, what was found, when it was added, its status and a "…" menu. The whole row opens it. */
function TargetRow({
  check,
  highlighted,
  ticked,
  onTick,
  onScanAgain,
  onRemove,
  busy,
}: {
  check: WorkspaceCheckRow;
  highlighted: boolean;
  ticked: boolean;
  onTick: () => void;
  onScanAgain: () => void;
  onRemove: () => void;
  busy: boolean;
}) {
  const stage = stageOf(check);
  const href = `/security/checks/${check.id}`;
  const { found, nothing, fromAgents } = problemsOf(check);
  const source = fromAgents ? "agents' report" : "quick scan";

  return (
    <div
      role="row"
      // While its "…" menu is open the row is lifted above the rows below (17 Nov): each row's cells sit at z-10,
      // so without this the next rows' boxes, links and "…" buttons showed through the open menu.
      className={`group relative has-[[aria-expanded=true]]:z-30 grid grid-cols-[20px_minmax(0,1fr)_auto_28px] items-center gap-x-2 sm:gap-x-3 md:grid-cols-[20px_minmax(0,2.4fr)_minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1.1fr)_minmax(0,1fr)_32px] border-b border-zk-divider px-3 py-3 last:border-b-0 hover:bg-zk-tint/50 sm:px-5 ${ticked || highlighted ? "bg-zk-tint/40" : ""}`}
    >
      <span role="cell" className="relative z-10 flex justify-center">
        <input type="checkbox" aria-label={`Tick ${check.value}`} checked={ticked} onChange={onTick} className="h-4 w-4 accent-electric-blue-strong" />
      </span>
      <span role="cell" className="flex min-w-0 items-center gap-2 sm:gap-2.5">
        {/* On a phone there's no Status column: a dot says it instead, where Intruder puts its status dot. */}
        <span aria-hidden="true" title={STAGE[stage].label} className={`h-2 w-2 shrink-0 rounded-full md:hidden ${STAGE[stage].dot} ${stage === "scanning" ? "animate-pulse" : ""}`} />
        <TargetIcon check={check} />
        {/* The row opens the target's page in Ziki: this link covers the row (the name is a separate link, above it). */}
        <Link href={href} aria-label={`Open ${check.value} (${STAGE[stage].label})`} className="absolute inset-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-electric-blue" />
        {/* The name opens the site itself, in a new tab, like a domain on Intruder or Detectify. */}
        {siteUrl(check) ? (
          <a
            href={siteUrl(check)!}
            target="_blank"
            rel="noopener noreferrer"
            title={`Visit ${check.value}`}
            className="relative z-10 min-w-0 truncate text-sm font-semibold text-zk-text hover:text-zk-accent hover:underline hover:underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-electric-blue"
          >
            {check.value}
            <span className="sr-only"> (opens the site in a new tab)</span>
          </a>
        ) : (
          <span className="min-w-0 truncate text-sm font-semibold text-zk-text">{check.value}</span>
        )}
      </span>
      <span role="cell" className="hidden md:block">
        <span className="inline-flex rounded-md border border-zk-border px-1.5 py-0.5 text-xs text-zk-text2">{TARGET_KIND_LABEL[check.kind]}</span>
      </span>
      <span role="cell" className="flex items-center">
        {/* Above the row's covering link, so every box's hover says what it counts (17 Nov): under it, only the faded
            zero boxes (opacity lifts them) showed theirs. Still opens the scan; out of the Tab order, the row link is the stop. */}
        <Link href={href} tabIndex={-1} className="relative z-10 flex items-center gap-0.5 md:gap-1">
        {nothing ? (
          <NoProblems />
        ) : found.length ? (
          found.map(([severity, n]) => (
            <span
              key={severity}
              title={`${n ? n : "No"} ${severity} ${n === 1 ? "problem" : "problems"}, from the ${source}.`}
              className={`inline-flex h-5 min-w-5 items-center justify-center rounded-md px-1 text-[11px] font-bold tabular-nums md:h-6 md:min-w-6 md:px-1.5 md:text-xs security-severity security-severity--${severity} ${n ? "" : "opacity-30"}`}
            >
              <span className="sr-only">{severity}: </span>
              {n}
            </span>
          ))
        ) : (
          <span className="text-xs text-zk-muted">Checking…</span>
        )}
        </Link>
      </span>
      <span role="cell" className="hidden text-xs text-zk-muted md:block">
        <LocalTime date={lastScanned(check)} />
      </span>
      <span role="cell" className={`hidden text-xs font-semibold md:block ${STAGE[stage].text}`}>{STAGE[stage].label}</span>
      <span role="cell" className="relative z-10 flex justify-end">
        <RowMenu site={check.value} href={href} onScanAgain={onScanAgain} onRemove={onRemove} busy={busy} />
      </span>
    </div>
  );
}

/** A row's "…": Open, Scan again, Copy link, and Remove scan last in red, like a Detectify or Invicti row menu. */
function RowMenu({ site, href, onScanAgain, onRemove, busy }: { site: string; href: string; onScanAgain: () => void; onRemove: () => void; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const toast = useToast();
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  const base = "block w-full px-3.5 py-1.5 text-left text-[13px] hover:bg-zk-chip disabled:opacity-60";
  const item = `${base} text-zk-text`;
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-label={`More for ${site}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((now) => !now)}
        className="grid h-7 w-7 place-items-center rounded-md text-zk-muted hover:bg-zk-chip hover:text-zk-text focus-visible:outline-2 focus-visible:outline-electric-blue"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
      </button>
      {open ? (
        <div role="menu" className="absolute right-0 top-8 z-30 min-w-44 rounded-xl border border-zk-border bg-zk-surface py-1.5 shadow-[0_16px_40px_rgba(11,23,51,0.18)]">
          <Link role="menuitem" href={href} className={item}>Open</Link>
          <button role="menuitem" type="button" disabled={busy} className={item} onClick={() => { setOpen(false); onScanAgain(); }}>Scan again</button>
          <button
            role="menuitem"
            type="button"
            className={item}
            onClick={() => {
              setOpen(false);
              navigator.clipboard.writeText(new URL(href, window.location.origin).toString()).then(() => toast("Link copied."), () => toast("Couldn't copy the link.", "error"));
            }}
          >
            Copy link
          </button>
          <div className="mt-1 border-t border-zk-divider pt-1">
            <button role="menuitem" type="button" disabled={busy} className={`${base} text-[#b42318]`} onClick={() => { setOpen(false); onRemove(); }}>Remove scan</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The page with scans (#security-checks): "Security" and "+ Add target" on top, as Intruder,
 * HostedScan and Tenable put their title and add button; the list in Ziki's panel below. "+ Add
 * target" opens the chat box above the list.
 */
export function ScansArea({
  checks,
  highlightId,
  show,
  page,
  startWith,
  top,
  bottom,
}: {
  checks: WorkspaceCheckRow[];
  highlightId?: string;
  show?: string;
  page?: number;
  startWith?: string;
  /** Shown at the top of the panel (a note after unlocking fixes). */
  top?: ReactNode;
  /** Shown at the foot of the panel (the privacy note). */
  bottom?: ReactNode;
}) {
  const router = useRouter();
  // Open when arriving with a site, or when it was left open (back from a scan's page).
  const [adding, setAdding] = useState(() => Boolean(startWith) || chatLeftOpen());
  // A site can arrive after the page is already showing (picking a workspace comes back to this same page
  // with ?picked=1): open the chat then too, so the site goes in and its result shows.
  // (React's "adjust state when a prop changes" pattern, during render rather than in an effect.)
  const [arrived, setArrived] = useState(startWith);
  if (startWith !== arrived) {
    setArrived(startWith);
    if (startWith) setAdding(true);
  }
  useEffect(() => {
    keepChatOpen(adding);
  }, [adding]);
  // The scan whose result is in the chat: its row waits until "See progress", so it isn't shown twice.
  const [inChat, setInChat] = useState<string | null>(null);

  const chat = adding ? (
    <SecurityChat
      id="security-chat"
      focusOnOpen
      startWith={startWith}
      onScanned={setInChat}
      // Straight to the scan's page; the chat stays open for when they come back.
      onSeeProgress={(checkId) => router.push(`/security/checks/${checkId}`)}
      onClose={() => {
        setAdding(false);
        setInChat(null);
      }}
    />
  ) : null;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3 px-0.5">
        <div className="min-w-0">
          <h1 id="security-scans-heading" className="m-0 text-2xl font-extrabold tracking-tight text-zk-text sm:text-[28px]">Security</h1>
          <p className="m-0 mt-1 hidden text-sm text-zk-text2 sm:block">Your websites, servers and repos, checked by Ziki&apos;s agents.</p>
        </div>
        <button
          type="button"
          aria-expanded={adding}
          aria-controls="security-chat"
          onClick={() => {
            // A second click closes the box. Opening it starts a fresh conversation.
            if (!adding) startNewChat();
            setAdding((open) => !open);
            setInChat(null);
          }}
          className={`inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full bg-electric-blue-strong px-5 text-sm font-bold text-white hover:brightness-105 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-electric-blue ${adding ? "opacity-60" : ""}`}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
          Add target
        </button>
      </header>
      <section aria-labelledby="security-scans-heading" className="rounded-[20px] border border-zk-border bg-zk-surface">
        {top}
        <ScanList checks={checks} highlightId={highlightId} show={show} page={page} adding={chat} hideId={adding ? inChat : null} />
        {bottom}
      </section>
    </div>
  );
}
