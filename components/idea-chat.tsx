"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { unstable_rethrow } from "next/navigation";
import { createBugAction } from "@/app/actions/issues";
import { ClaudeWorking } from "@/components/claude-working";
import { BASE_PATH } from "@/lib/base-path";
import { AreaCropper } from "@/components/area-cropper";
import { CaptureError, MAX_RECORDING_SECONDS, captureScreenFrame, startScreenRecording, type ScreenRecording } from "@/components/idea-capture";

type Upload = { key: string; name: string; id?: string; error?: string };

/** The first line, as the idea's title: up to 120 characters, without Markdown marks. */
function titleFrom(text: string): string {
  const line = text.split("\n").map((l) => l.replace(/^[#>*\-\s]+/, "").trim()).find(Boolean) ?? "";
  const title = line.length > 120 ? `${line.slice(0, 117).trimEnd()}…` : line;
  return title.length >= 3 ? title : "New idea";
}

/**
 * Add Idea as a chat box (#idea-chat): the button opens a composer on its
 * right, in the list's header bar above the table, which grows to hold it,
 * like a chat with an assistant. Type the idea, attach files with +, record
 * the screen or capture an area of it (under the box, kept as images), and
 * send with Enter (Shift+Enter for a new line). It files an idea in this
 * project with the first line as its title; agents structure it afterwards,
 * as any unstructured draft.
 */
export function IdeaChat({
  projectId,
  className = "",
  alwaysOpen = false,
  placeholder,
}: {
  projectId: string;
  className?: string;
  /** Just the box, open from the start and never closed (the Ideas empty state). */
  alwaysOpen?: boolean;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(alwaysOpen);
  // Capture area: the frame being cropped; Record screen: the recording under way.
  const [crop, setCrop] = useState<{ url: string; blob: Blob } | null>(null);
  const [recording, setRecording] = useState<{ seconds: number } | null>(null);
  const recorderRef = useRef<ScreenRecording | null>(null);
  // The empty state and the header may both hold a box on one page.
  const boxId = useId();
  const [text, setText] = useState("");
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const uploading = uploads.some((u) => !u.id && !u.error);

  // Grow with the text, up to a few lines.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    box.style.height = "auto";
    box.style.height = `${Math.min(box.scrollHeight, 220)}px`;
  }, [text, open]);

  // Escape closes; a click outside closes it while nothing is typed.
  useEffect(() => {
    if (!open || alwaysOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !buttonRef.current?.contains(target) && !text.trim() && uploads.length === 0) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open, alwaysOpen, text, uploads.length]);

  async function attach(files: FileList | File[] | null) {
    for (const file of Array.from(files ?? []).slice(0, 5)) {
      const key = `${file.name}-${Math.random().toString(36).slice(2)}`;
      setUploads((list) => [...list, { key, name: file.name }]);
      const body = new FormData();
      body.set("file", file);
      try {
        const res = await fetch(`${BASE_PATH}/api/uploads`, { method: "POST", body });
        const data = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
        setUploads((list) => list.map((u) => (u.key !== key ? u : res.ok && data.id ? { ...u, id: data.id } : { ...u, error: data.error ?? "Upload failed" })));
      } catch {
        setUploads((list) => list.map((u) => (u.key === key ? { ...u, error: "Upload failed" } : u)));
      }
    }
  }

  function captureFailed(thrown: unknown) {
    setError(thrown instanceof CaptureError ? thrown.message : "Couldn't use the screen. Try again.");
  }

  async function captureArea() {
    setError(null);
    try {
      const blob = await captureScreenFrame();
      setCrop({ url: URL.createObjectURL(blob), blob });
    } catch (thrown) {
      captureFailed(thrown);
    }
  }

  function closeCrop() {
    if (crop) URL.revokeObjectURL(crop.url);
    setCrop(null);
  }

  function keepCapture(blob: Blob) {
    closeCrop();
    void attach([new File([blob], `screen-capture-${Date.now()}.png`, { type: "image/png" })]);
  }

  function keepRecording(frames: Blob[]) {
    recorderRef.current = null;
    setRecording(null);
    const stamp = Date.now();
    void attach(frames.map((frame, index) => new File([frame], `screen-recording-${stamp}-${index + 1}.jpg`, { type: "image/jpeg" })));
  }

  async function toggleRecording() {
    if (recorderRef.current) {
      keepRecording(await recorderRef.current.stop());
      return;
    }
    setError(null);
    try {
      recorderRef.current = await startScreenRecording({
        onTick: (seconds) => setRecording({ seconds }),
        onEnd: keepRecording,
      });
      setRecording({ seconds: 0 });
    } catch (thrown) {
      captureFailed(thrown);
    }
  }

  function send() {
    const body = text.trim();
    if (body.length < 10) {
      setError("Say a little more: at least 10 characters.");
      return;
    }
    if (uploading) return;
    setError(null);
    const data = new FormData();
    data.set("title", titleFrom(body));
    data.set("description", body);
    data.set("proofLinks", "");
    data.set("projectId", projectId);
    data.set("isReport", "true");
    const ids = uploads.filter((u) => u.id).map((u) => u.id!);
    if (ids.length) data.set("attachmentIds", ids.join(","));
    startTransition(async () => {
      try {
        // On success the action takes you to the new idea.
        const result = await createBugAction(data);
        if (result?.error) setError(result.error);
      } catch (thrown) {
        unstable_rethrow(thrown);
        setError("Could not send the idea. Try again.");
      }
    });
  }

  const button = (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => {
          setOpen(true);
          requestAnimationFrame(() => boxRef.current?.focus());
        }}
        aria-expanded={open}
        title="Add Idea"
        className={`issues-new inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-zk-border bg-zk-surface px-2.5 text-[13px] font-semibold text-zk-text hover:bg-zk-chip ${className}`}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        Add Idea
      </button>
    </>
  );
  const composer = (
        <div
          ref={panelRef}
          role="group"
          data-idea-chat-open=""
          aria-label="Add an idea"
          // In the header bar, to the right of the Add Idea button, above the table: it takes
          // the rest of the bar (its own row when there's no room) and the bar grows to hold it.
          className={`min-w-0 flex-1 basis-72 ${className}`}
        >
          <div className="rounded-[22px] border border-zk-border bg-zk-surface px-4 pb-2.5 pt-3 shadow-[0_2px_10px_rgba(0,0,0,0.06)] focus-within:border-electric-blue-strong/50">
            <label htmlFor={boxId} className="sr-only">Your idea</label>
            <textarea
              id={boxId}
              ref={boxRef}
              rows={1}
              value={text}
              disabled={pending}
              maxLength={5000}
              placeholder={placeholder ?? "Describe your idea: what's wrong or missing, and what should happen…"}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  send();
                }
              }}
              className="block max-h-[220px] min-h-[28px] w-full resize-none border-0 bg-transparent p-1 text-[15px] leading-6 text-zk-text placeholder:text-zk-muted focus:outline-none"
            />
            {uploads.length ? (
              <ul className="m-0 mt-1 flex list-none flex-wrap gap-1.5 p-0">
                {uploads.map((u) => (
                  <li key={u.key} className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs ${u.error ? "bg-zk-bad-bg text-zk-bad-fg" : "bg-zk-chip text-zk-text2"}`}>
                    <span className="max-w-48 truncate">{u.name}</span>
                    {u.error ? <span>· {u.error}</span> : !u.id ? <span>· uploading…</span> : null}
                    <button type="button" aria-label={`Remove ${u.name}`} onClick={() => setUploads((list) => list.filter((x) => x.key !== u.key))} className="ml-0.5 rounded-full px-1 hover:bg-zk-border">×</button>
                  </li>
                ))}
              </ul>
            ) : null}
            {/* While the idea goes to Claude to be written up, show the work happening. */}
            {pending ? <ClaudeWorking className="mt-2" /> : null}
            {error ? <p role="alert" className="m-0 mt-1 px-1 text-xs text-zk-bad-fg">{error}</p> : null}
            <div className="mt-2 flex items-center justify-between">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                aria-label="Attach files"
                title="Attach files"
                className="inline-flex h-9 w-9 items-center justify-center rounded-full text-zk-text2 hover:bg-zk-chip hover:text-zk-text"
              >
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
              </button>
              <input ref={fileRef} type="file" multiple hidden onChange={(event) => { void attach(event.target.files); event.target.value = ""; }} />
              <button
                type="button"
                onClick={send}
                disabled={pending || uploading || !text.trim()}
                aria-label="Send idea"
                title="Send"
                className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-zk-text text-zk-surface transition disabled:opacity-30"
              >
                {pending ? (
                  <span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                ) : (
                  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
                )}
              </button>
            </div>
          </div>
          {/* Under the box: record the screen, or capture an area of it. Both attach images to the idea. */}
          <div className="mt-2 flex flex-wrap items-center gap-2 px-1">
            <button
              type="button"
              onClick={() => void toggleRecording()}
              disabled={pending}
              aria-pressed={Boolean(recording)}
              className={`inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold transition disabled:opacity-40 ${
                recording ? "border-zk-bad-bd bg-zk-bad-soft text-zk-bad-fg" : "border-zk-border bg-zk-surface text-zk-text2 hover:bg-zk-chip hover:text-zk-text"
              }`}
            >
              <span aria-hidden="true" className={`h-2.5 w-2.5 rounded-full bg-red-500 ${recording ? "motion-safe:animate-pulse" : ""}`} />
              {recording
                ? `Stop recording · ${Math.floor(recording.seconds / 60)}:${String(recording.seconds % 60).padStart(2, "0")} of ${MAX_RECORDING_SECONDS / 60}:00`
                : "Record screen"}
            </button>
            <button
              type="button"
              onClick={() => void captureArea()}
              disabled={pending || Boolean(recording)}
              className="inline-flex h-8 items-center gap-1.5 rounded-full border border-zk-border bg-zk-surface px-3 text-xs font-semibold text-zk-text2 transition hover:bg-zk-chip hover:text-zk-text disabled:opacity-40"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" />
              </svg>
              Capture area
            </button>
          </div>
          {crop ? (
            <div role="dialog" aria-modal="true" aria-label="Crop the capture" className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
              <div className="max-h-[calc(100dvh-2rem)] w-[min(60rem,100%)] overflow-y-auto rounded-2xl border border-zk-border bg-zk-surface p-4 shadow-2xl">
                <AreaCropper
                  imageSrc={crop.url}
                  onCropComplete={(blob, url) => {
                    URL.revokeObjectURL(url);
                    keepCapture(blob);
                  }}
                  onUseFull={() => keepCapture(crop.blob)}
                  onRetake={() => {
                    closeCrop();
                    void captureArea();
                  }}
                  onCancel={closeCrop}
                />
              </div>
            </div>
          ) : null}
        </div>
  );
  if (!open) return button;
  if (alwaysOpen) return composer;

  return (
    <>
      {button}
      {composer}
    </>
  );
}
