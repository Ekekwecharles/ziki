"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { replaceScan, talkToSecurityAssistant } from "@/app/actions/security-assistant";
import { TARGET_KIND_LABEL } from "@/lib/security-checks";
import { ClaudeWorking } from "@/components/claude-working";
import { parseSecurityTarget, PRIVATE_TARGET_ERROR } from "@/lib/security-checks/target";
import type { AssistantTurn } from "@/lib/security-checks/assistant";
import type { PreviewSummary } from "@/lib/security-checks/preview-summary";
import { PreviewResult } from "./preview-result";
import { SCAN_BAR_MS, ScanProgress } from "./scan-progress";

const MESSAGE_MAX = 600;
/** How long the Ideas-style thinking lines show before the Scanning bar. */
const THINK_MS = 1500;

/** What Ziki is doing while it answers, typed out like the Ideas chat. */
const WORKING_STEPS = [
  "Reading what you wrote…",
  "Working out what you want to secure…",
  "Checking it's a website, server or repo…",
  "Writing back…",
];

/**
 * The conversation, kept while the client moves around Security and back, so
 * nothing typed or said is lost. It lives only in this browser tab's memory:
 * a refresh starts afresh.
 */
const kept: { turns: ChatItem[]; text: string; started?: string; open?: boolean } = { turns: [], text: "" };

/**
 * Whether the chat was left open: "See progress" opens the scan's page, and
 * coming back finds the chat as it was, until the person closes it.
 */
export function chatLeftOpen(): boolean {
  return Boolean(kept.open);
}

/** Open or close the kept chat; closing it ends the conversation. */
export function keepChatOpen(open: boolean) {
  kept.open = open;
  if (!open) {
    kept.turns = [];
    kept.text = "";
  }
}

/** A message in the chat; a reply can carry a quick scan of the site. */
type ChatItem = AssistantTurn & { scan?: { target: string; summary: PreviewSummary | null; note: string | null; checkId: string | null; already?: boolean } };

/**
 * The box on Security, with Ziki's AI behind it (#security-checks, 14 Nov plan
 * C1 and C3). It looks like the Ideas box. Paste a link and its quick scan runs
 * here, then it's added to the person's scans; type anything else ("I want to
 * secure my shop's website") and the reply asks for what's missing. There is no
 * proof step, and the chat stays on the page after each answer.
 */
export function SecurityChat({
  id = "security-chat",
  focusOnOpen = false,
  startWith,
  onSeeProgress,
  onScanned,
  onClose,
}: {
  id?: string;
  focusOnOpen?: boolean;
  /** An address brought from the public page after sign-up: sent once, so its quick scan starts on arrival. */
  startWith?: string;
  /**
   * Once a scan is in, the send button becomes "See progress" (while nothing new is typed), which opens the scan's page:
   * the chat stays open for when they come back. Without it, the chat just carries on.
   */
  onSeeProgress?: (checkId: string) => void;
  /** A scan just came in and is in the person's scans; its card can wait until "See progress". */
  onScanned?: (checkId: string) => void;
  /** The X at the box's top right: closes the chat and ends the conversation. */
  onClose?: () => void;
}) {
  const router = useRouter();
  const [turns, setTurns] = useState<ChatItem[]>(() => kept.turns);
  const [text, setText] = useState(() => kept.text);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  /** A site was sent: think first, like the Ideas chat, then show the scan's progress. */
  const [thinking, setThinking] = useState(false);
  const thinkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (thinkTimer.current) clearTimeout(thinkTimer.current);
  }, []);
  const box = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLOListElement>(null);
  const value = text.trim();
  const parsed = value ? parseSecurityTarget(value) : null;
  const target = parsed?.ok ? parsed.target : null;
  const isPrivate = parsed !== null && !parsed.ok && parsed.error === PRIVATE_TARGET_ERROR;
  const errorId = `${id}-error`;

  useEffect(() => {
    if (focusOnOpen) box.current?.focus();
  }, [focusOnOpen]);
  // Keep the conversation for when the client comes back to it.
  useEffect(() => {
    kept.turns = turns;
    kept.text = text;
  }, [turns, text]);
  // Keep the newest message in view.
  useEffect(() => {
    log.current?.lastElementChild?.scrollIntoView({ block: "nearest" });
  }, [turns, pending]);
  // Grow with the text, up to a few lines.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  function send() {
    sendText(value);
  }

  function sendText(raw: string) {
    const words = raw.trim();
    if (!words || pending) return;
    const next: ChatItem[] = [...turns, { role: "user", text: words.slice(0, MESSAGE_MAX) }];
    setTurns(next);
    setText("");
    setError(null);
    setThinking(true);
    if (thinkTimer.current) clearTimeout(thinkTimer.current);
    thinkTimer.current = setTimeout(() => setThinking(false), THINK_MS);
    const started = Date.now();
    startTransition(async () => {
      try {
        // Only the words go to the server, never a scan card.
        const answer = await talkToSecurityAssistant(next.map(({ role, text }) => ({ role, text })));
        // A fresh scan waits for the thinking lines and the Scanning bar to finish, like the public page.
        if (answer.kind === "scan" && !answer.already && answer.summary) {
          const left = THINK_MS + SCAN_BAR_MS - (Date.now() - started);
          if (left > 0) await new Promise((done) => setTimeout(done, left));
        }
        if (answer.kind === "error") {
          setError(answer.error);
          return;
        }
        if (answer.kind === "scan") {
          setTurns([...next, { role: "assistant", text: answer.reply, scan: { target: answer.target, summary: answer.summary, note: answer.note, checkId: answer.checkId, already: answer.already } }]);
          // Added to the person's scans: the list below picks it up.
          if (answer.checkId) onScanned?.(answer.checkId);
          if (answer.checkId && !answer.already) router.refresh();
          return;
        }
        if (answer.kind === "go") {
          kept.turns = [];
          kept.text = "";
          router.push(answer.href);
          return;
        }
        setTurns([...next, { role: "assistant", text: answer.reply }]);
      } catch {
        setError("Ziki couldn't answer just now. Try again.");
      }
    });
  }

  // Brought an address from the public page: send it once, as if typed. Kept in
  // memory, so it isn't sent again when the page swaps the empty box for the list.
  useEffect(() => {
    if (!startWith || kept.started === startWith) return;
    kept.started = startWith;
    sendText(startWith);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startWith]);
  const lastUser = [...turns].reverse().find((turn) => turn.role === "user")?.text ?? "";
  const lastTarget = lastUser ? parseSecurityTarget(lastUser) : null;
  // The scan the latest answer is about, once it's in the person's scans: "See progress" shows it in the list.
  const finishedCheckId = turns.at(-1)?.role === "assistant" ? (turns.at(-1)?.scan?.checkId ?? null) : null;
  // Only while the answer is still coming: not while the list below refreshes after it.
  const waiting = pending && turns.at(-1)?.role === "user";
  const scanning = waiting && !thinking && lastTarget?.ok === true;

  return (
    <div className="flex flex-col gap-3">
      {turns.length ? (
        <ol ref={log} aria-label="Conversation with Ziki" aria-live="polite" className="m-0 flex list-none flex-col gap-2.5 p-0">
          {turns.map((turn, index) => (
            <li key={index} className={turn.role === "user" ? "ml-auto max-w-[85%]" : `mr-auto flex flex-col gap-2 ${turn.scan ? "w-full" : "max-w-[90%]"}`}>
              {turn.role === "user" ? (
                <p className="m-0 whitespace-pre-wrap break-words rounded-[18px] rounded-br-md bg-electric-blue-strong px-4 py-2 text-[15px] text-white">
                  <span className="sr-only">You: </span>
                  {turn.text}
                </p>
              ) : (
                <>
                  {turn.text ? (
                    <p className="m-0 w-fit whitespace-pre-wrap break-words rounded-[18px] rounded-tl-md border border-zk-border bg-zk-surface px-4 py-2 text-[15px] text-zk-text2">
                      <span className="sr-only">Reply: </span>
                      {turn.text}
                    </p>
                  ) : null}
                  {turn.scan ? <ScanCard scan={turn.scan} /> : null}
                </>
              )}
            </li>
          ))}
          {waiting ? (
            // The same "Claude is working" lines as the Ideas chat, for this job.
            <li className="mr-auto w-full max-w-[90%]">
              {scanning && lastTarget?.ok ? (
                <ScanProgress site={lastTarget.target.value} />
              ) : (
                <ClaudeWorking steps={WORKING_STEPS} statusText="Ziki is reading your message." />
              )}
            </li>
          ) : null}
        </ol>
      ) : null}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
        noValidate
      >
        <div className="relative rounded-[22px] border border-zk-border bg-zk-surface px-4 pb-2.5 pt-3 shadow-[0_2px_10px_rgba(0,0,0,0.06)] focus-within:border-electric-blue-strong/50">
          {/* Close, like the X on Ziki's dialogs (add-confirmation-dialog.tsx). */}
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close chat"
              title="Close chat"
              className="absolute right-2.5 top-2.5 inline-flex h-8 w-8 items-center justify-center rounded-lg text-zk-muted hover:bg-zk-chip hover:text-zk-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-electric-blue-strong"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="m6 6 12 12M18 6 6 18" />
              </svg>
            </button>
          ) : null}
          <label htmlFor={id} className="sr-only">What do you want to secure?</label>
          <textarea
            id={id}
            ref={box}
            name="target"
            rows={1}
            value={text}
            disabled={pending}
            maxLength={MESSAGE_MAX}
            placeholder={turns.length ? "Reply to Ziki" : "Tell Ziki what you want to secure"}
            autoComplete="off"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : `${id}-reading`}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send();
              }
            }}
            className="block min-h-[28px] w-full resize-none border-0 bg-transparent p-1 pr-9 text-[15px] leading-6 text-zk-text placeholder:text-zk-muted focus:outline-none"
          />
          <div className="mt-2 flex items-center justify-between gap-3">
            <p id={`${id}-reading`} aria-live="polite" className="m-0 min-w-0 truncate px-1 text-[13px] text-zk-muted">
              {target ? (
                <span className="inline-flex items-center gap-1.5 text-zk-ok-fg">
                  <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
                  {TARGET_KIND_LABEL[target.kind]}: <span className="font-semibold">{target.value}</span>
                </span>
              ) : isPrivate ? (
                <span className="text-zk-bad-fg">That&apos;s a private address</span>
              ) : null}
            </p>
            {onSeeProgress && finishedCheckId && !value && !pending ? (
              <button
                type="button"
                // The conversation stays: coming back from the scan's page finds it open.
                onClick={() => onSeeProgress(finishedCheckId)}
                className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-electric-blue-strong px-4 text-sm font-bold text-white transition hover:brightness-105"
              >
                See progress
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
              </button>
            ) : (
            <button
              type="submit"
              disabled={pending || !value}
              aria-label="Send"
              title="Send"
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zk-text text-zk-surface transition disabled:opacity-30"
            >
              {pending ? (
                <span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
              ) : (
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
              )}
            </button>
            )}
          </div>
        </div>
        {error ? <p id={errorId} role="alert" className="m-0 mt-2 px-2 text-sm text-zk-bad-fg">{error}</p> : null}
      </form>
    </div>
  );
}

/** The quick scan in the chat: its locked rows, and that it's now in the person's scans with agents checking it. */
function ScanCard({ scan }: { scan: NonNullable<ChatItem["scan"]> }) {
  // Already in their scans: show the saved result and ask, like "this file already exists, replace it?".
  if (scan.already && scan.checkId) return <AlreadyScanned scan={scan} checkId={scan.checkId} />;
  const added = scan.checkId && !scan.already ? (
    <p className="m-0 text-[13px] leading-snug text-zk-muted">
      Saved to your scans. Agents are checking it now.
    </p>
  ) : null;
  if (scan.summary) return <PreviewResult summary={scan.summary}>{added}</PreviewResult>;
  return (
    <div className="flex w-full flex-col gap-3 rounded-2xl border border-zk-border bg-zk-surface p-4 text-left">
      <p className="m-0 text-sm leading-relaxed text-zk-text2">{scan.note ?? "The quick scan couldn't run just now."}</p>
      {added}
    </div>
  );
}

/**
 * A site already in the person's scans (#security-checks): its saved result,
 * and "Replace it with a new scan?" with Replace and Keep. Replace runs the
 * Scanning bar, saves the new result over the old one on the same card, and
 * shows it here; Keep leaves the saved result as it is.
 */
function AlreadyScanned({ scan, checkId }: { scan: NonNullable<ChatItem["scan"]>; checkId: string }) {
  const router = useRouter();
  const [state, setState] = useState<"ask" | "scanning" | "replaced" | "kept">("ask");
  const [summary, setSummary] = useState<PreviewSummary | null>(scan.summary);
  const [error, setError] = useState<string | null>(null);

  async function replace() {
    setState("scanning");
    setError(null);
    try {
      const [answer] = await Promise.all([replaceScan(checkId), new Promise((done) => setTimeout(done, SCAN_BAR_MS))]);
      if (!answer.ok) {
        setError(answer.error);
        setState("ask");
        return;
      }
      setSummary(answer.summary);
      setState("replaced");
      router.refresh();
    } catch {
      setError("The scan couldn't run just now. Try again in a moment.");
      setState("ask");
    }
  }

  if (state === "scanning") return <ScanProgress site={scan.target} />;

  const footer = (
    <div className="flex flex-col gap-2 border-t border-zk-divider pt-3">
      {state === "replaced" ? (
        <p className="m-0 text-[13px] leading-snug text-zk-muted">Replaced with a new scan. Its card in your scans shows this result now.</p>
      ) : state === "kept" ? (
        <p className="m-0 text-[13px] leading-snug text-zk-muted">Kept the saved result. It&apos;s on its card in your scans.</p>
      ) : (
        <>
          <p className="m-0 text-[13px] leading-snug text-zk-text2">{error ?? scan.note}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={replace} className="inline-flex h-8 items-center rounded-full bg-electric-blue-strong px-4 text-[13px] font-bold text-white hover:brightness-105">
              Replace
            </button>
            <button type="button" onClick={() => setState("kept")} className="inline-flex h-8 items-center rounded-full border border-zk-border bg-zk-surface px-4 text-[13px] font-semibold text-zk-text hover:border-zk-accent hover:text-zk-accent">
              Keep
            </button>
          </div>
        </>
      )}
    </div>
  );
  if (summary) return <PreviewResult summary={summary}>{footer}</PreviewResult>;
  return <div className="flex w-full flex-col gap-3 rounded-2xl border border-zk-border bg-zk-surface p-4 text-left">{footer}</div>;
}
