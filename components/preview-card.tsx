"use client";

import { useEffect, useRef, useState } from "react";
import { previewStatusAction } from "@/app/actions/previews";
import type { PreviewBuildView } from "@/lib/previews/builds";

export type PreviewCardProps = {
  bugId: string;
  /** The pull request number, for labels. */
  pullNumber: number | null;
  /** Ziki's latest build of the pull request, or null before the first one. */
  build: PreviewBuildView | null;
  /** The last ready preview of this pull request, shown while a newer commit builds or after it failed. */
  lastReadyUrl: string | null;
  /** Members can ask for updates while it builds. */
  canFollow: boolean;
};

/** Ask again this often while the build runs, or while waiting for the first one. */
const POLL_MS = 15_000;
/** Stop waiting for a first build after this long on the page. */
const FIRST_BUILD_WAIT_MS = 5 * 60_000;
/** The size the site is laid out at before it is scaled down to the card. */
const SITE_WIDTH = 1280;
const SITE_HEIGHT = 800;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function since(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** The browser frame every state is drawn in: an address bar, then the screen. */
function BrowserFrame({ address, dim, children }: { address: string | null; dim?: boolean; children: React.ReactNode }) {
  return (
    <div className={`overflow-hidden rounded-2xl border border-zk-border bg-zk-surface shadow-[0_1px_2px_rgba(0,0,0,0.04)] ${dim ? "opacity-90" : ""}`}>
      <div className="flex items-center gap-2 border-b border-zk-border bg-zk-chip px-3 py-2">
        <span className="flex gap-1.5" aria-hidden="true">
          <span className="h-2.5 w-2.5 rounded-full bg-zk-border" />
          <span className="h-2.5 w-2.5 rounded-full bg-zk-border" />
          <span className="h-2.5 w-2.5 rounded-full bg-zk-border" />
        </span>
        <span className="min-w-0 flex-1 truncate rounded-md bg-zk-surface px-2.5 py-1 font-mono text-[11px] text-zk-muted">
          {address ?? "Waiting for a preview"}
        </span>
      </div>
      <div className="relative aspect-[16/10] w-full overflow-hidden bg-zk-surface">{children}</div>
    </div>
  );
}

/**
 * The system's light or dark mode: what the site gets when opened in its own
 * tab. An embedded page reads `prefers-color-scheme` from its frame's
 * `color-scheme` instead, which would otherwise follow Ziki's theme.
 */
function useSystemScheme(): "light" | "dark" {
  const [scheme, setScheme] = useState<"light" | "dark">("light");
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setScheme(media.matches ? "dark" : "light");
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return scheme;
}

/**
 * The site itself, laid out at desktop width and scaled down to the card. It
 * is a picture of the page, not something to use here: it takes no clicks or
 * focus, and runs sandboxed (no popups, forms or navigating Ziki's page).
 * It is shown in the system's light or dark mode, as opening it would, on
 * that mode's page colour (`Canvas`), so a site that leaves its background to
 * the browser looks as it does on its own.
 */
function SiteView({ url, title }: { url: string; title: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const scheme = useSystemScheme();

  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const measure = () => setScale(element.clientWidth / SITE_WIDTH);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={box} className="absolute inset-0">
      {!loaded ? <ScreenSkeleton label="Loading the preview…" /> : null}
      {scale > 0 ? (
        <iframe
          src={url}
          title={title}
          loading="lazy"
          sandbox="allow-scripts allow-same-origin"
          referrerPolicy="no-referrer"
          tabIndex={-1}
          aria-hidden="true"
          onLoad={() => setLoaded(true)}
          className="pointer-events-none absolute left-0 top-0 origin-top-left border-0"
          style={{ width: SITE_WIDTH, height: SITE_HEIGHT, transform: `scale(${scale})`, colorScheme: scheme, background: "Canvas" }}
        />
      ) : null}
    </div>
  );
}

/** A page-shaped placeholder: a header bar, a heading and a few blocks. */
function ScreenSkeleton({ label, animate = true }: { label?: string; animate?: boolean }) {
  const pulse = animate ? "motion-safe:animate-pulse" : "";
  return (
    <div className="absolute inset-0 flex flex-col gap-3 bg-zk-surface p-[5%]" aria-hidden={label ? undefined : true}>
      <div className={`h-[7%] w-full rounded-md bg-zk-chip ${pulse}`} />
      <div className={`h-[9%] w-1/2 rounded-md bg-zk-chip ${pulse}`} />
      <div className={`h-[5%] w-3/4 rounded-md bg-zk-chip ${pulse}`} />
      <div className="grid flex-1 grid-cols-3 gap-3">
        <div className={`rounded-lg bg-zk-chip ${pulse}`} />
        <div className={`rounded-lg bg-zk-chip ${pulse}`} />
        <div className={`rounded-lg bg-zk-chip ${pulse}`} />
      </div>
      {label ? <span className="sr-only">{label}</span> : null}
    </div>
  );
}

/** A message laid over the screen, centred. */
function ScreenMessage({ tone, title, children }: { tone: "info" | "warn" | "bad"; title: string; children?: React.ReactNode }) {
  const dot = tone === "bad" ? "bg-zk-bad-fg" : tone === "warn" ? "bg-zk-warn-fg motion-safe:animate-pulse" : "bg-zk-muted";
  return (
    <div className="absolute inset-0 flex items-center justify-center p-4">
      <div className="flex max-w-[22rem] flex-col items-center gap-1.5 rounded-xl border border-zk-border bg-zk-surface/95 px-4 py-3 text-center shadow-[0_4px_16px_rgba(0,0,0,0.08)] backdrop-blur-sm">
        <span className="flex items-center gap-2 text-sm font-bold text-zk-text">
          <span className={`h-2 w-2 rounded-full ${dot}`} aria-hidden="true" />
          {title}
        </span>
        {children ? <span className="text-xs text-zk-text2">{children}</span> : null}
      </div>
    </div>
  );
}

/** The issue's pull request preview (#previews): the site itself once built, kept current while it builds. */
export function PreviewCard({ bugId, pullNumber, build: initialBuild, lastReadyUrl: initialLastReady, canFollow }: PreviewCardProps) {
  const [build, setBuild] = useState(initialBuild);
  const [lastReadyUrl, setLastReadyUrl] = useState(initialLastReady);
  const [now, setNow] = useState(() => Date.now());
  const [openedAt] = useState(() => Date.now());
  const running = build?.status === "queued" || build?.status === "building";
  const waitingForFirst = !build && now - openedAt < FIRST_BUILD_WAIT_MS;

  // A fresh server render (router refresh) replaces what polling found.
  const [shownProps, setShownProps] = useState({ initialBuild, initialLastReady });
  if (shownProps.initialBuild !== initialBuild || shownProps.initialLastReady !== initialLastReady) {
    setShownProps({ initialBuild, initialLastReady });
    setBuild(initialBuild);
    setLastReadyUrl(initialLastReady);
  }

  // Keep asking while it builds, or briefly while the first build may be starting.
  useEffect(() => {
    if (!canFollow || !(running || waitingForFirst)) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      const result = await previewStatusAction(bugId).catch(() => null);
      if (cancelled || !result?.ok) return;
      setBuild(result.build);
      setLastReadyUrl(result.lastReadyUrl);
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [bugId, running, waitingForFirst, canFollow]);

  // The elapsed time while it builds.
  useEffect(() => {
    if (!running && !waitingForFirst) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running, waitingForFirst]);

  const label = pullNumber ? `pull request #${pullNumber}` : "the pull request";
  const readyUrl = build?.status === "ready" && build.url ? build.url : null;
  // While a newer commit builds, or after it failed, the last good preview still shows.
  const shownUrl = readyUrl ?? lastReadyUrl;
  const commit = build?.headSha.slice(0, 7) ?? null;

  let status: { text: string; tone: string };
  if (!build) status = { text: "No preview yet", tone: "bg-zk-chip text-zk-text2" };
  else if (build.status === "ready") status = { text: "Ready", tone: "bg-zk-ok-bg text-zk-ok-fg" };
  else if (build.status === "failed") status = { text: "Build failed", tone: "bg-zk-bad-bg text-zk-bad-fg" };
  else status = { text: build.status === "queued" ? "Waiting to build" : "Building", tone: "bg-zk-warn-bg text-zk-warn-fg" };

  let screen: React.ReactNode;
  if (readyUrl) {
    screen = <SiteView url={readyUrl} title={`Preview of ${label}`} />;
  } else if (running) {
    screen = shownUrl ? (
      <>
        <SiteView url={shownUrl} title={`Last preview of ${label}`} />
        <div className="absolute inset-0 bg-zk-surface/40" aria-hidden="true" />
        <ScreenMessage tone="warn" title="Updating to the new commit">
          Building {commit} for {since(build!.createdAt, now)}. This shows the last preview until it&apos;s ready.
        </ScreenMessage>
      </>
    ) : (
      <>
        <ScreenSkeleton />
        <ScreenMessage tone="warn" title={build!.status === "queued" ? "Starting the build" : "Building the preview"}>
          Commit {commit}, {since(build!.createdAt, now)} so far. It usually takes a minute or two.
        </ScreenMessage>
      </>
    );
  } else if (build?.status === "failed") {
    screen = shownUrl ? (
      <>
        <SiteView url={shownUrl} title={`Last preview of ${label}`} />
        <div className="absolute inset-0 bg-zk-surface/40" aria-hidden="true" />
        <ScreenMessage tone="bad" title={`Commit ${commit} didn't build`}>
          This is the last preview that built.
        </ScreenMessage>
      </>
    ) : (
      <>
        <ScreenSkeleton animate={false} />
        <ScreenMessage tone="bad" title="The preview didn't build">
          {build.error ?? "The build failed."}
        </ScreenMessage>
      </>
    );
  } else {
    screen = (
      <>
        <ScreenSkeleton animate={false} />
        <ScreenMessage tone="info" title="No preview yet">
          {waitingForFirst
            ? "Ziki builds one when it reads the pull request's latest commit. This updates on its own."
            : `Ziki builds one for each new commit of ${label} while the issue is in progress or being reviewed.`}
        </ScreenMessage>
      </>
    );
  }

  const frame = <BrowserFrame address={shownUrl ? hostOf(shownUrl) : null}>{screen}</BrowserFrame>;

  return (
    <section aria-label="Preview" data-testid="preview" data-status={build?.status ?? "none"} className="flex flex-col gap-3 rounded-[20px] border border-zk-border bg-zk-surface p-5 sm:p-[22px]">
      <header className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-bold text-zk-text">Preview</span>
        <span role="status" className={`rounded-full px-2 py-0.5 text-xs font-bold ${status.tone}`}>{status.text}</span>
        {commit ? <span className="font-mono text-xs text-zk-muted">@ {commit}</span> : null}
      </header>

      {shownUrl ? (
        <a
          href={shownUrl}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open the preview of ${label} in a new tab`}
          className="group relative block rounded-2xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zk-accent"
        >
          {frame}
          <span className="pointer-events-none absolute bottom-3 right-3 inline-flex items-center gap-1.5 rounded-full bg-electric-blue-strong px-3 py-1.5 text-xs font-bold text-white opacity-90 shadow-[0_2px_8px_rgba(0,0,0,0.2)] transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
            Open preview
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M7 17 17 7M8 7h9v9" />
            </svg>
          </span>
        </a>
      ) : (
        frame
      )}

      {build?.status === "failed" && build.error && shownUrl ? <p className="m-0 text-sm text-zk-bad-fg">{build.error}</p> : null}
      <p className="m-0 text-xs text-zk-muted">Anyone with the link can open a preview.</p>
    </section>
  );
}
