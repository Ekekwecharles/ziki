"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { refreshLibrary } from "@/app/(app)/[org]/[project]/marketing/output-box/actions";
import { marketingPath, projectPath, type ProjectRef } from "@/lib/project-paths";
import { formatBytes } from "@/lib/attachments";
import { formatDate } from "@/lib/format";
import { CONTENT_TYPES, filterLibrary, type ContentType, type LibraryFile, type LibraryItem, type LibraryResult } from "./model";
import { DeliveredWork } from "@/components/marketing/delivered-work";
import { LibraryHeading } from "./heading";
import "./library.css";

function publishedDate(date: string | null) {
  return date ? new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Africa/Lagos" }).format(new Date(date)) : "Date unavailable";
}

function FileMark({ file }: { file?: LibraryFile }) {
  const label = !file ? "FILE" : ({ Graphics: "IMG", Videos: "PLAY", Articles: "READ", PDFs: "PDF", Docs: "DOC", Links: "LINK" })[file.kind];
  return <span className="lb-file-mark" data-kind={file?.kind} aria-hidden="true"><strong>{label}</strong><span>{file?.name ?? "Deliverable"}</span></span>;
}

function FileThumbnail({ file }: { file?: LibraryFile }) {
  const [failed, setFailed] = useState(false);
  if (file?.kind !== "Graphics" || failed) return <FileMark file={file} />;
  return <span className="lb-thumbnail" aria-hidden="true">
    {/* eslint-disable-next-line @next/next/no-img-element -- arbitrary approved image sources, with a fallback */}
    <img src={file.url} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
  </span>;
}

export function Library({ slug, initial }: { slug: ProjectRef; initial: LibraryResult }) {
  const params = useSearchParams();
  const [result, setResult] = useState(initial);
  const [refreshError, setRefreshError] = useState(false);
  const [pending, setPending] = useState(false);
  const request = useRef(false);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const heading = useRef<HTMLHeadingElement>(null);
  const errorHeading = useRef<HTMLHeadingElement>(null);
  const scrollBeforeDetail = useRef(0);
  const search = params.get("q") ?? "";
  // The field keeps its own text: URL state arrives in a transition, and reading it back here dropped typed characters.
  const [query, setQuery] = useState(search);
  const rawType = params.get("type");
  const type: ContentType = CONTENT_TYPES.find((value) => value === rawType) ?? "All";
  const oldest = params.get("sort") === "oldest";
  const items = result.ok ? result.items : [];
  const filtered = filterLibrary(items, query, type, oldest);
  const selected = filtered.find((item) => item.id === params.get("item")) ?? filtered[0];
  const selectedFile = selected?.files.find((file) => file.id === params.get("file"))
    ?? selected?.files.find((file) => type === "All" || file.kind === type) ?? selected?.files[0];
  const detail = params.get("view") === "detail" && Boolean(selected);
  const previousDetail = useRef(detail);

  function update(values: Record<string, string | null>, push = false) {
    const next = new URLSearchParams(window.location.search);
    for (const [key, value] of Object.entries(values)) {
      if (value) next.set(key, value); else next.delete(key);
    }
    const url = `${window.location.pathname}${next.size ? `?${next}` : ""}`;
    if (push) window.history.pushState(null, "", url); else window.history.replaceState(null, "", url);
  }

  function select(item: LibraryItem) {
    const mobile = window.matchMedia("(max-width: 767px)").matches;
    if (mobile) scrollBeforeDetail.current = window.scrollY;
    update({ item: item.id, file: null, view: mobile ? "detail" : null }, mobile);
    if (mobile) window.scrollTo({ top: 0 });
  }

  function back() {
    update({ view: null });
  }

  useEffect(() => {
    if (detail && window.matchMedia("(max-width: 767px)").matches) heading.current?.focus();
    if (previousDetail.current && !detail) {
      rowRefs.current.get(selected?.id ?? "")?.focus({ preventScroll: true });
      window.scrollTo({ top: scrollBeforeDetail.current });
    }
    previousDetail.current = detail;
  }, [detail, selected?.id]);

  useEffect(() => {
    const syncQuery = () => setQuery(new URLSearchParams(window.location.search).get("q") ?? "");
    window.addEventListener("popstate", syncQuery);
    return () => window.removeEventListener("popstate", syncQuery);
  }, []);

  useEffect(() => {
    if (!result.ok) errorHeading.current?.focus();
  }, [result.ok]);

  async function refresh() {
    if (request.current) return;
    request.current = true;
    setPending(true);
    try {
      const next = await refreshLibrary(slug);
      if (next.ok) { setResult(next); setRefreshError(false); }
      else if (result.ok) setRefreshError(true);
      else setResult(next);
    } catch {
      if (result.ok) setRefreshError(true); else setResult({ ok: false });
    } finally { request.current = false; setPending(false); }
  }

  const tasksPath = marketingPath(slug, "tasks");
  return <div className="lb-page" data-detail={detail}>
    <LibraryHeading />
    {!result.ok ? <section className="lb-state" aria-busy={pending}>
      <span className="lb-state-icon lb-warning" aria-hidden="true">!</span>
      <h2 ref={errorHeading} tabIndex={-1} role="alert">We couldn’t load the Output box</h2><p>Check your connection and try again in a moment.</p>
      <button className="lb-button lb-primary" onClick={refresh} disabled={pending}>{pending ? "Trying again…" : "Try again"}</button>
    </section> : items.length === 0 ? <section className="lb-state">
      <span className="lb-state-icon" aria-hidden="true">◇</span><h2>No approved work yet</h2>
      <p>Deliverables will appear here when a marketing task reaches Live · Published.</p>
      <Link className="lb-button lb-primary" href={tasksPath}>View Marketing</Link>
    </section> : <>
      {refreshError && <div className="lb-refresh-error" role="alert">We couldn’t refresh the Library. Your previous results are still shown. <button className="lb-button" onClick={refresh} disabled={pending}>Try again</button></div>}
      <div className="lb-toolbar" aria-label="Find approved work">
        <label className="lb-search"><span className="sr-only">Search approved work</span><span aria-hidden="true">⌕</span><input type="search" placeholder="Search approved work…" value={query} onChange={(event) => { setQuery(event.target.value); update({ q: event.target.value || null, view: null }); }} /></label>
        <div className="lb-filters" role="group" aria-label="Deliverable type">{CONTENT_TYPES.map((value) => <button key={value} className="lb-filter" aria-pressed={type === value} onClick={() => update({ type: value === "All" ? null : value, file: null, view: null })}>{value}</button>)}</div>
        <label className="lb-sort"><span className="sr-only">Sort by publication date</span><select value={oldest ? "oldest" : "newest"} onChange={(event) => update({ sort: event.target.value === "oldest" ? "oldest" : null })}><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select></label>
        <button className="lb-button lb-refresh" onClick={refresh} disabled={pending}>{pending ? "Refreshing…" : "Refresh"}</button>
      </div>
      <p className="lb-count" role="status">{pending ? "Refreshing approved work…" : `${filtered.length} ${filtered.length === 1 ? "deliverable" : "deliverables"} · ${filtered.reduce((count, item) => count + item.files.length, 0)} files & links`}</p>
      {filtered.length === 0 ? <section className="lb-state lb-no-matches"><h2>No matching work</h2><p>Try another search or clear the content filter.</p><button className="lb-button" onClick={() => { setQuery(""); update({ q: null, type: null, view: null }); }}>Clear filters</button></section> : <div className="lb-split">
        <section className="lb-collection" aria-label="Approved deliverables"><ul>{filtered.map((item) => {
          const file = item.files.find((file) => type === "All" || file.kind === type) ?? item.files[0];
          return <li key={item.id}><button ref={(node) => { if (node) rowRefs.current.set(item.id, node); else rowRefs.current.delete(item.id); }} className="lb-row" onClick={() => select(item)} aria-pressed={selected?.id === item.id}>
            <FileThumbnail key={file?.id} file={file} /><span className="lb-row-content"><strong>{item.title}</strong><span>Task #{item.number}</span><span>{item.agent} · {publishedDate(item.publishedAt)}</span><span>{item.files.length} {item.files.length === 1 ? "file or link" : "files & links"}</span></span>
            <span className="sr-only">{file ? `${file.kind}: ${file.name}` : "Source unavailable"}</span>
            {selected?.id === item.id && <span className="lb-selected" aria-hidden="true">✓</span>}
          </button></li>;
        })}</ul></section>
        {selected && <section className="lb-detail" aria-label="Selected deliverable">
          <button className="lb-button lb-back" onClick={back}>← Back to Library</button>
          <div className="lb-detail-top"><span>Deliverable preview</span><span className="lb-published">✓ Live · Published</span></div>
          <h2 ref={heading} tabIndex={-1} className="lb-detail-title">{selected.title}</h2>
          <dl className="lb-metadata"><div><dt>Produced by</dt><dd>{selected.agent}</dd></div><div><dt>Published</dt><dd>{selected.publishedAt ? <time dateTime={selected.publishedAt} title={formatDate(selected.publishedAt)}>{publishedDate(selected.publishedAt)}</time> : "Date unavailable"}</dd></div><div><dt>Associated task</dt><dd><Link href={projectPath(slug, `/${selected.number}`)}>Task #{selected.number}</Link></dd></div></dl>
          {selected.files.length > 1 && <div className="lb-attachments" role="group" aria-label="Task deliverables">{selected.files.map((file) => <button key={file.id} className="lb-file-choice" aria-pressed={selectedFile?.id === file.id} onClick={() => update({ file: file.id })}>{file.name}</button>)}</div>}
          {selectedFile?.text ? <>
            <DeliveredWork text={selectedFile.text} title={selected.title} from={selected.agent} />
            <div className="lb-actions mt-3"><Link className="lb-button" href={projectPath(slug, `/${selected.number}`)}>View task #{selected.number} <span aria-hidden="true">↗</span></Link></div>
          </> : selectedFile ? <DeliverablePreview key={`${selected.id}:${selectedFile.id}`} file={selectedFile} item={selected} slug={slug} /> : <div className="lb-fallback"><h3>Original unavailable</h3><p>No deliverable source is available. You can still view the task.</p></div>}
        </section>}
      </div>}
    </>}
  </div>;
}

function DeliverablePreview({ file, item, slug }: { file: LibraryFile; item: LibraryItem; slug: ProjectRef }) {
  const supported = ["Graphics", "Videos"].includes(file.kind);
  const [state, setState] = useState<"loading" | "ready" | "error">(supported ? "loading" : "ready");
  const [attempt, setAttempt] = useState(0);
  const [unavailable, setUnavailable] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState(false);
  const downloadingRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const source = file.local ? "Ziki attachment" : new URL(file.url).hostname;
  async function failed() {
    setState("error");
    // Authenticated local files have meaningful status codes; do not probe external hosts.
    if (file.local) {
      try {
        const response = await fetch(file.url, { method: "HEAD" });
        if (mounted.current && [403, 404, 410].includes(response.status)) setUnavailable(true);
      } catch { /* A network error doesn't prove the original was removed. */ }
    }
  }
  // A file can finish loading before hydration, when its load event has already passed.
  function settleImage(image: HTMLImageElement | null) {
    if (!image?.complete || state !== "loading") return;
    if (image.naturalWidth > 0) setState("ready");
    else if (image.currentSrc) void failed();
  }
  function settleVideo(video: HTMLVideoElement | null) {
    if (!video || state !== "loading") return;
    if (video.error) void failed();
    else if (video.readyState >= 1) setState("ready");
  }
  async function download() {
    if (downloadingRef.current) return;
    downloadingRef.current = true; setDownloading(true); setDownloadError(false);
    try {
      // Blob download also works for cross-origin file URLs when their host permits CORS.
      const response = await fetch(file.url, { credentials: file.local ? "same-origin" : "omit" });
      if (!response.ok) {
        if ([404, 410].includes(response.status) && mounted.current) setUnavailable(true);
        throw new Error("Download failed");
      }
      if (response.headers.get("content-type")?.includes("text/html")) throw new Error("The source returned a web page instead of the file");
      const blob = await response.blob();
      if (!mounted.current) return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = file.name;
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { if (mounted.current) setDownloadError(true); }
    finally { downloadingRef.current = false; if (mounted.current) setDownloading(false); }
  }
  return <>
    <div className="lb-media" aria-busy={state === "loading"}>
      {unavailable ? <div className="lb-fallback"><FileMark file={file} /><h3>Original unavailable</h3><p>This source was removed or is no longer accessible.</p></div> : state === "error" ? <div className="lb-fallback" role="status"><FileMark file={file} /><h3>Preview couldn’t load</h3><p>You can try again or open the original.</p><button className="lb-button" onClick={() => { setState("loading"); setAttempt(attempt + 1); }}>Retry preview</button></div> : <>
        {state === "loading" && <div className="lb-preview-loading" aria-hidden="true"><div className="lb-skeleton" /></div>}
        {file.kind === "Graphics" ? (
          // eslint-disable-next-line @next/next/no-img-element -- approved arbitrary deliverable URLs and authenticated local attachments
          <img key={attempt} ref={settleImage} src={file.url} alt={`${item.title} — ${file.name}`} className={state === "loading" ? "lb-loading-media" : ""} onLoad={() => setState("ready")} onError={failed} referrerPolicy="no-referrer" />
        ) : file.kind === "Videos" ? (
          // eslint-disable-next-line jsx-a11y/media-has-caption -- the delivery contract has no caption track; the delivery summary and original remain available
          <video key={attempt} ref={settleVideo} src={file.url} controls preload="metadata" aria-label={`${item.title} — ${file.name}`} onLoadedMetadata={() => setState("ready")} onError={failed}>
          Your browser cannot preview this video. Open the original to watch it.
        </video>) : <div className="lb-fallback"><FileMark file={file} />
          <h3>{file.kind === "Links" || file.kind === "Articles" ? file.name : "Preview isn’t available for this file"}</h3>
          <p>{file.kind === "Links" || file.kind === "Articles" ? source : "You can still open or download the original document."}</p>
          {(file.kind === "Links" || file.kind === "Articles") && <p className="lb-delivery-note">{item.summary}</p>}
        </div>}
      </>}
    </div>
    <p className="sr-only" role="status">{state === "loading" ? `Loading preview for ${file.name}` : unavailable ? "Original unavailable" : state === "error" ? "Preview couldn’t load" : `${file.name} preview ready`}</p>
    <div className="lb-file-description"><strong>{file.name}</strong><span>{file.kind}{file.size !== null ? ` · ${formatBytes(file.size)}` : ""} · {source}</span></div>
    <div className="lb-actions">
      {unavailable ? <span className="lb-button" aria-disabled="true">Original unavailable</span> : <a className="lb-button lb-primary" href={file.url} target="_blank" rel="noopener noreferrer">Open original <span aria-hidden="true">↗</span><span className="sr-only"> (opens in a new tab)</span></a>}
      <Link className="lb-button" href={projectPath(slug, `/${item.number}`)}>View task #{item.number} <span aria-hidden="true">↗</span></Link>
      {file.downloadable && <button className="lb-button" disabled={unavailable || downloading} onClick={download}>{downloading ? "Downloading…" : "Download"} <span aria-hidden="true">↓</span></button>}
    </div>
    {downloadError && <p className="lb-download-error" role="alert">The download failed. Try again, or open the original to save it from its source.</p>}
  </>;
}
