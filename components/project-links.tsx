"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { saveProjectLinksAction, type ProjectActionResult } from "@/app/(app)/projects/actions";

/** Where the panel renders: a placeholder above the list (issues-list renders it). */
export const PROJECT_LINKS_SLOT_ID = "project-links-slot";

/** How long a dismissed panel stays away while the site URL is still unset. */
const SNOOZE_MS = 60 * 60 * 1000;
const snoozeKey = (slug: string) => `ziki-project-links-snoozed:${slug}`;

function snoozedRecently(slug: string): boolean {
  try {
    const at = Number(window.localStorage.getItem(snoozeKey(slug)));
    return Number.isFinite(at) && at > 0 && Date.now() - at < SNOOZE_MS;
  } catch {
    return false;
  }
}

function snooze(slug: string): void {
  try {
    window.localStorage.setItem(snoozeKey(slug), String(Date.now()));
  } catch {
    /* Storage can be blocked; the panel then just comes back on the next load. */
  }
}

const input =
  "h-9 w-full rounded-md border border-zk-border bg-zk-surface px-3 text-[13px] text-zk-text placeholder:text-zk-muted focus:border-electric-blue-strong focus:outline-none";

/** A gear: the project's settings (ProjectIconLinks). */
function SettingsIcon({ size }: { size: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </svg>
  );
}

/** A chain link: the project's site and code addresses. */
function LinksIcon({ size }: { size: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

const ICON_BUTTON =
  "relative inline-flex h-8 w-8 items-center justify-center rounded-lg border border-zk-border bg-zk-surface text-zk-text2 hover:bg-zk-chip hover:text-zk-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-electric-blue";

/** Beside the stage tabs, at the top right: Project notes and the project's settings, as icons only. Goals are on Project Overview. */
export function ProjectIconLinks({
  notesHref,
  settingsHref,
}: {
  notesHref?: string;
  settingsHref?: string;
}) {
  return (
    <>
      {notesHref ? (
        <Link href={notesHref} aria-label="Project notes" title="Project notes" className={ICON_BUTTON}>
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="3" width="15" height="18" rx="2" /><path d="M9 3v18M3 7h4M3 12h4M3 17h4M12 8h5M12 12h5" /></svg>
        </Link>
      ) : null}
      {settingsHref ? (
        <Link href={settingsHref} aria-label="Project settings" title="Project settings" className={ICON_BUTTON}>
          <SettingsIcon size={17} />
        </Link>
      ) : null}
    </>
  );
}

/** An address shown as a link, without the https:// in front. */
function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

/**
 * The project's site and code addresses (#project-links).
 *
 * Until the site URL is set, a grey panel above the list asks for it. Add (or
 * ×) sends it flying into the settings icon at the far right of the top row:
 * - with a site URL, it is saved and the icon opens the addresses as links (with Edit),
 *   Project notes and the full settings page;
 * - with nothing (or only a code URL, which is saved), it is snoozed in this
 *   browser for an hour and then opens on its own again, until a site is set.
 *   The icon reopens it at any time.
 * The icon is this component's anchor; the panel is portalled into the slot
 * above the list, so the page refreshing after a save doesn't cut the flight short.
 */
export function ProjectLinks({
  slug,
  siteUrl,
  repoUrl,
  canEdit,
  askOnLoad,
}: {
  slug: string;
  siteUrl: string | null;
  repoUrl: string | null;
  canEdit: boolean;
  /** Whether the panel asks for a missing site by itself here: only on the Ideas tab. Elsewhere only the icon opens it. */
  askOnLoad: boolean;
}) {
  const [result, action, pending] = useActionState<ProjectActionResult | undefined, FormData>(saveProjectLinksAction, undefined);
  // Closed until mounted: whether to open depends on the snooze kept in this browser.
  const [open, setOpen] = useState(false);
  const [hasSite, setHasSite] = useState(Boolean(siteUrl));
  const [snoozed, setSnoozed] = useState(false);
  // Opened from the icon once set, it shows the links; Edit (or a missing site) shows the form.
  const [editing, setEditing] = useState(!siteUrl);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [arrived, setArrived] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const handled = useRef<ProjectActionResult | undefined>(undefined);
  // What the last Add sent for the site: only a real site ends the asking.
  const submittedSite = useRef("");
  // Read by the flight's finish, which runs after the save's render.
  const hasSiteRef = useRef(hasSite);
  useEffect(() => {
    hasSiteRef.current = hasSite;
  }, [hasSite]);

  // On load: on the Ideas tab, open by itself while the site is unset and it wasn't dismissed in the last hour.
  // Moving to another tab (In progress, Delivered, …) puts it away; the icon still opens it.
  useEffect(() => {
    if (siteUrl) return;
    // The snooze lives in this browser, so it is read after mounting, in a frame callback.
    const frame = requestAnimationFrame(() => {
      // On a phone it would cover the list: the icon (with its dot) asks instead.
      if (window.matchMedia("(max-width: 639px)").matches) setSnoozed(true);
      else if (!askOnLoad) setOpen(false);
      else if (snoozedRecently(slug)) setSnoozed(true);
      else setOpen(true);
    });
    return () => cancelAnimationFrame(frame);
    // Only on first load for this project, and when the tab changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, askOnLoad]);

  // Find the slot above the list on every render: switching tabs replaces it.
  // Setting the same element again changes nothing, so this settles at once.
  useEffect(() => {
    const frame = requestAnimationFrame(() => setSlot(document.getElementById(PROJECT_LINKS_SLOT_ID)));
    return () => cancelAnimationFrame(frame);
  });

  /** Fly the panel into the settings icon, then close it. */
  function flyToIcon() {
    const finish = () => {
      setOpen(false);
      setEditing(!hasSiteRef.current);
      setArrived(true);
      setTimeout(() => setArrived(false), 900);
    };
    const panel = panelRef.current;
    const anchor = anchorRef.current;
    if (!panel || !anchor || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      finish();
      return;
    }
    const from = panel.getBoundingClientRect();
    const to = anchor.getBoundingClientRect();
    const dx = to.left + to.width / 2 - from.left;
    const dy = to.top + to.height / 2 - from.top;
    const animation = panel.animate(
      [
        { transform: "translate(0, 0) scale(1)", opacity: 1 },
        { transform: `translate(${dx}px, ${dy}px) scale(0.04)`, opacity: 0.15 },
      ],
      { duration: 650, easing: "cubic-bezier(0.4, 0, 0.2, 1)", fill: "forwards" },
    );
    animation.onfinish = finish;
  }

  /** Put it away for an hour (no site yet): the icon stays to reopen it. */
  function snoozeAndFly() {
    snooze(slug);
    setSnoozed(true);
    flyToIcon();
  }

  // After a successful save.
  useEffect(() => {
    if (!result || result.error || handled.current === result) return;
    handled.current = result;
    if (submittedSite.current) {
      setHasSite(true);
      hasSiteRef.current = true;
      flyToIcon();
    } else {
      snoozeAndFly();
    }
    // flyToIcon and snoozeAndFly read refs and setters only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  // Off the Ideas tab the icon is the way in, so it shows while the site is unset too.
  const showIcon = hasSite || snoozed || !askOnLoad;

  const panel = open ? (
    <section
      ref={panelRef}
      aria-labelledby="project-links-heading"
      style={{ transformOrigin: "top left" }}
      // The same corners and border as the list below it (.issues-table: 10px, 8px on phones).
      className="rounded-[10px] border border-zk-border bg-zk-chip px-4 py-4 max-md:rounded-lg sm:px-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="project-links-heading" className="text-[15px] font-bold text-zk-text">
            {editing ? "What is your site URL?" : "Project settings"}
          </h2>
          {editing ? <p className="mt-1 text-[13px] text-zk-text2">Also add your code URL if you know where it is.</p> : null}
        </div>
        <button
          type="button"
          onClick={() => (hasSite ? flyToIcon() : snoozeAndFly())}
          aria-label="Close"
          className="px-1 text-lg leading-none text-zk-muted hover:text-zk-text"
        >
          ×
        </button>
      </div>

      {!editing ? (
        // Set: the addresses as links, and Edit for those who may change them.
        <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
          <dl className="m-0 grid gap-x-6 gap-y-1.5 text-[13px] sm:grid-cols-[auto_1fr]">
            <dt className="font-semibold text-zk-text2">Site</dt>
            <dd className="m-0">
              {siteUrl ? (
                <a href={siteUrl} target="_blank" rel="noreferrer noopener" className="font-medium text-zk-accent hover:underline">{shortUrl(siteUrl)} ↗</a>
              ) : (
                <span className="text-zk-muted">Not set</span>
              )}
            </dd>
            <dt className="font-semibold text-zk-text2">Code</dt>
            <dd className="m-0">
              {repoUrl ? (
                <a href={repoUrl} target="_blank" rel="noreferrer noopener" className="font-medium text-zk-accent hover:underline">{shortUrl(repoUrl)} ↗</a>
              ) : (
                <span className="text-zk-muted">Not set</span>
              )}
            </dd>
          </dl>
          {canEdit ? (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="inline-flex h-9 items-center justify-center rounded-md border border-zk-border bg-zk-surface px-4 text-[13px] font-semibold text-zk-text hover:bg-zk-chip"
            >
              Edit
            </button>
          ) : null}
        </div>
      ) : canEdit ? (
        <form
          action={action}
          onSubmit={(event) => {
            const data = new FormData(event.currentTarget);
            const site = String(data.get("siteUrl") ?? "").trim();
            const code = String(data.get("repoUrl") ?? "").trim();
            // Nothing entered and no site yet: save nothing; put it away for an hour.
            if (!site && !code && !hasSite) {
              event.preventDefault();
              snoozeAndFly();
              return;
            }
            submittedSite.current = site;
          }}
          className="mt-3 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
        >
          <input type="hidden" name="slug" value={slug} />
          <label className="flex flex-col gap-1 text-[12px] font-semibold text-zk-text2">
            Site URL
            <input name="siteUrl" type="url" inputMode="url" placeholder="https://example.com" defaultValue={siteUrl ?? ""} className={input} />
          </label>
          <label className="flex flex-col gap-1 text-[12px] font-semibold text-zk-text2">
            Code URL
            <input name="repoUrl" type="url" inputMode="url" placeholder="https://github.com/owner/repository" defaultValue={repoUrl ?? ""} className={input} />
          </label>
          <button
            type="submit"
            disabled={pending}
            className="inline-flex h-9 items-center justify-center rounded-md bg-zk-text px-5 text-[13px] font-semibold text-zk-surface hover:opacity-90 disabled:opacity-60"
          >
            {pending ? (hasSite ? "Saving…" : "Adding…") : hasSite ? "Save" : "Add"}
          </button>
          {result?.error ? (
            <p role="alert" className="text-[12.5px] text-zk-bad-fg sm:col-span-3">
              {result.fieldErrors?.siteUrl ?? result.fieldErrors?.repoUrl ?? result.error}
            </p>
          ) : null}
        </form>
      ) : (
        <p className="mt-2 text-[12.5px] text-zk-muted">An organisation owner or admin can add these.</p>
      )}

    </section>
  ) : null;

  return (
    <>
      {/* The addresses icon at the top right; the panel flies here. */}
      <span ref={anchorRef} className="inline-flex">
        {showIcon ? (
          <button
            type="button"
            onClick={() => {
              setOpen((value) => !value);
              setEditing(!hasSite);
            }}
            aria-expanded={open}
            aria-label={hasSite ? "Site and code addresses" : "Add your site URL"}
            title={hasSite ? "Site and code addresses" : "Add your site URL"}
            className={`relative inline-flex h-8 w-8 items-center justify-center rounded-lg border border-zk-border bg-zk-surface text-zk-text2 hover:bg-zk-chip hover:text-zk-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-electric-blue ${
              arrived ? "motion-safe:animate-[zk-links-arrive_0.9s_ease-out]" : ""
            }`}
          >
            <LinksIcon size={16} />
            {/* Still unset: a small dot says something is missing. */}
            {!hasSite ? <span aria-hidden="true" className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-amber-500" /> : null}
          </button>
        ) : (
          <span className="block h-8 w-0" aria-hidden="true" />
        )}
      </span>
      {slot && panel ? createPortal(panel, slot) : null}
    </>
  );
}
