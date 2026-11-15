"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { SCAN_STEP_MS } from "./scan-progress";
import { runPublicScan } from "@/app/actions/security-preview";
import { addSecurityAsset } from "@/app/actions/security-assistant";
import { parseSecurityTarget, targetAddress } from "@/lib/security-checks/target";
import type { PreviewSummary } from "@/lib/security-checks/preview-summary";
import { PreviewResult } from "./preview-result";

const SITE_STEPS = ["HTTPS", "Certificate", "Headers", "Cookies", "Email"];
const REPO_STEPS = ["Secrets in files", "Security policy", "Dependency updates"];
/** How long each area shows on the Scanning bar, the same as on Security. The result waits for the bar to finish. */
const STEP_MS = SCAN_STEP_MS;

/** The empty place below the header where the scan and its result open. */
export const SCAN_RESULT_SLOT = "security-scan-result";

/** Where a signed-out visitor goes after signing up or in: their address comes along to the Security page, where its scan starts. */
export function addAssetPath(target: string): string {
  return `/security?target=${encodeURIComponent(target)}`;
}

/**
 * The box on the public Ziki Security page (#security-checks, part C2): one
 * field, no AI. Dave's quick scan looks at the site and the result shows the
 * counts only. Signed out, the next step is signing up (the address comes
 * along to the Security page); signed in, it's added to their scans straight away.
 */
export function PublicScan({ signedIn }: { signedIn: boolean }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [site, setSite] = useState<string | null>(null);
  const [summary, setSummary] = useState<PreviewSummary | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /** A repo the scan couldn't see (a private one) can still be added; a site the scan couldn't reach can't. */
  const [repo, setRepo] = useState(false);
  const [step, setStep] = useState(0);
  const STEPS = repo ? REPO_STEPS : SITE_STEPS;
  const [pending, startTransition] = useTransition();
  const [adding, startAdding] = useTransition();
  // The result opens below the header, like the prototype: in the page's own slot, not over the photo.
  // Only after a scan starts, so the first render matches the server's.
  const open = pending || summary !== null || (note !== null && site !== null);
  const slot = open && typeof document !== "undefined" ? document.getElementById(SCAN_RESULT_SLOT) : null;
  useEffect(() => {
    if (pending || summary || note) document.getElementById(SCAN_RESULT_SLOT)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [pending, summary, note]);

  // Tick through the areas while the scan runs, so the wait shows what's happening.
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => setStep((current) => Math.min(current + 1, STEPS.length - 1)), STEP_MS);
    return () => clearInterval(timer);
  }, [pending]);

  function scan(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;
    const parsed = parseSecurityTarget(text);
    if (!parsed.ok) {
      setError(text.trim() ? "Enter a valid URL, like yourshop.com" : "Enter your URL first.");
      return;
    }
    setError(null);
    setSummary(null);
    setNote(null);
    // A repo goes by its GitHub address: it is what the scan reads back.
    const address = targetAddress(parsed.target);
    setSite(address);
    setStep(0);
    setRepo(parsed.target.kind === "repo");
    // The bar runs through every area before the result drops, even when the scan answers sooner.
    const steps = parsed.target.kind === "repo" ? REPO_STEPS.length : SITE_STEPS.length;
    const minimum = new Promise((done) => setTimeout(done, steps * STEP_MS));
    startTransition(async () => {
      try {
        const [answer] = await Promise.all([runPublicScan(address), minimum]);
        if (answer.ok) setSummary(answer.summary);
        else setNote(answer.reason);
      } catch {
        setNote("The scan couldn't run just now. Try again in a moment.");
      }
    });
  }

  function addToScans() {
    if (!site) return;
    startAdding(async () => {
      const answer = await addSecurityAsset(site);
      if (answer.kind === "go") router.push(answer.href);
      else setNote(answer.kind === "error" ? answer.error : answer.reply);
    });
  }

  const next = site ? (
    signedIn ? (
      <div className="flex flex-wrap items-center gap-3 border-t border-zk-divider pt-3">
        <p className="m-0 min-w-[12rem] flex-1 text-[13px] leading-snug text-zk-muted">
          Add {site} to your scans and agents check it properly.
        </p>
        <button type="button" onClick={addToScans} disabled={adding} className="inline-flex h-10 shrink-0 items-center rounded-full bg-electric-blue-strong px-5 text-sm font-bold text-white hover:brightness-105 disabled:opacity-60">
          {adding ? "Adding…" : "Add to your scans"}
        </button>
      </div>
    ) : (
      <div className="flex flex-col items-center gap-2 rounded-xl bg-zk-tint px-4 py-4 text-center">
        <p className="m-0 text-base font-bold text-zk-text">Sign up to see your report</p>
        <p className="m-0 max-w-sm text-[13px] text-zk-text2">{site} comes with you to your Security page, where agents check it properly and you can unlock each fix.</p>
        <div className="mt-1 flex flex-wrap items-center justify-center gap-3">
          <Link href={`/signup?callbackUrl=${encodeURIComponent(addAssetPath(site))}`} className="inline-flex h-10 items-center rounded-full bg-electric-blue-strong px-6 text-sm font-bold text-white hover:brightness-105">
            Sign up
          </Link>
          <Link href={`/login?callbackUrl=${encodeURIComponent(addAssetPath(site))}`} className="text-sm font-semibold text-zk-accent hover:underline">
            I have an account
          </Link>
        </div>
      </div>
    )
  ) : null;

  return (
    <div className="w-full max-w-[620px]">
      <form onSubmit={scan} noValidate className="flex items-center gap-2 rounded-[18px] bg-white p-2 shadow-[0_12px_40px_rgba(0,20,50,0.28)]">
        <label htmlFor="security-check-url" className="sr-only">Your URL</label>
        <input
          id="security-check-url"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Enter your URL, e.g. yourshop.com"
          autoComplete="off"
          inputMode="url"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "security-check-error" : undefined}
          className="h-12 min-w-0 flex-1 border-0 bg-transparent px-3 text-[17px] text-[#0b1733] outline-none placeholder:text-[#8a94a6]"
        />
        <button type="submit" disabled={pending} className="h-12 shrink-0 rounded-[12px] bg-[#2e6fef] px-7 text-[16px] font-bold text-white disabled:opacity-70">
          {pending ? "Scanning…" : "Scan"}
        </button>
      </form>
      {error ? <p id="security-check-error" role="alert" className="m-0 mt-3 text-sm font-semibold text-[#ffd7d7]">{error}</p> : null}
      <p className="m-0 mt-3 text-[13px] text-white/85">
        A quick check only sees what a browser sees, so it can&apos;t promise your site is safe. For a full check, sign up and Ziki&apos;s agents look properly.
      </p>

      {slot
        ? createPortal(
      <div aria-live="polite" className="mx-auto w-full max-w-[880px] px-4 pb-4 pt-10 sm:px-6">
        {pending ? (
          <div className="rounded-2xl border border-zk-border bg-zk-surface p-5 text-left">
            <p className="m-0 text-[15px] font-bold text-zk-text">Scanning {site}…</p>
            <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-zk-chip">
              <div className="h-full rounded-full bg-electric-blue-strong transition-[width] duration-700" style={{ width: `${((step + 1) / STEPS.length) * 100}%` }} />
            </div>
            <ul className="m-0 mt-3 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-[13px]">
              {STEPS.map((label, index) => (
                <li key={label} className={index < step ? "text-zk-ok-fg" : index === step ? "font-semibold text-zk-text" : "text-zk-muted"}>
                  {index < step ? "✓ " : ""}{label}
                </li>
              ))}
            </ul>
          </div>
        ) : summary ? (
          <PreviewResult summary={summary}>{next}</PreviewResult>
        ) : note && site ? (
          <div className="flex flex-col gap-3 rounded-2xl bg-zk-surface p-4 text-left">
            <p className="m-0 text-sm text-zk-text2">{note}</p>
            {/* Only a repo goes on from here: a site the scan couldn't reach has nothing to secure yet. */}
            {repo ? next : null}
          </div>
        ) : null}
      </div>,
            slot,
          )
        : null}
    </div>
  );
}
