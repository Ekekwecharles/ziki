"use client";

import { useEffect, useState } from "react";

/** Where a running check is, for what to say: Ziki is planning the parts, agents are checking them, Ziki is writing the report. */
export type CheckPhase = "planning" | "checking" | "writing";

/** Playful lines, each swapped for the next every few seconds, so a page that is only waiting never looks frozen. */
const LINES: Record<CheckPhase, string[]> = {
  planning: [
    "Ziki is reading the site and drawing up the checklist…",
    "Sharpening the magnifying glasses…",
    "Deciding which doors to rattle first…",
    "Teaching the checklist some manners…",
    "Almost ready to hand out the work…",
  ],
  checking: [
    "Agents are poking around, politely…",
    "Peeking under the doormat for stray keys…",
    "Counting cookies (the browser kind)…",
    "Squinting at the headers…",
    "Following loose threads to see where they go…",
    "Asking the certificate for its papers…",
  ],
  writing: [
    "Every part is checked. Ziki is writing it all up…",
    "Sorting the findings, worst first…",
    "Putting a bow on your report…",
  ],
};

const TITLE: Record<CheckPhase, string> = {
  planning: "Planning the checks",
  checking: "Agents are on it",
  writing: "Writing your report",
};

const ROTATE_MS = 3200;

/**
 * A lively "we are working on it" strip for a check that isn't done (a
 * wandering magnifier, waving dots, a line that changes every few seconds). It
 * says only what phase the check is in: never what any part found. Movement
 * only with motion-safe:, so reduced motion shows it still.
 */
export function CheckActivity({ site, phase, done, total }: { site: string; phase: CheckPhase; done: number; total: number }) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setIndex((current) => current + 1), ROTATE_MS);
    return () => clearInterval(timer);
  }, []);
  const lines = LINES[phase];
  const line = lines[index % lines.length]!;

  return (
    <div className="flex items-center gap-4">
      <span aria-hidden="true" className="relative grid h-14 w-14 shrink-0 place-items-center rounded-2xl border border-zk-border bg-zk-tint text-zk-accent sm:h-16 sm:w-16">
        <span className="absolute inset-0 rounded-2xl bg-zk-accent/10 motion-safe:animate-pulse" />
        <svg
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="relative motion-safe:[animation:zk-check-peek_3.4s_ease-in-out_infinite]"
        >
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="M15.5 15.5L21 21" />
        </svg>
      </span>
      <div className="min-w-0 flex-1">
        {/* Ziki's big headline style (as on Coming soon): bigger and heavier than a page title. */}
        <h1 id="check-headline" className="m-0 wrap-break-word text-2xl font-extrabold tracking-[-0.02em] text-zk-text sm:text-[28px]">
          Ziki is checking {site}
        </h1>
        <p className="m-0 mt-1 flex items-center gap-2 text-[15px] font-bold text-zk-accent">
          {TITLE[phase]}
          <span aria-hidden="true" className="inline-flex items-end gap-1">
            {[0, 1, 2].map((dot) => (
              <span
                key={dot}
                className="h-1.5 w-1.5 rounded-full bg-zk-accent motion-safe:[animation:zk-check-wave_1.2s_ease-in-out_infinite]"
                style={{ animationDelay: `${dot * 0.16}s` }}
              />
            ))}
          </span>
        </p>
        {/* Not announced each time it changes: the title and the numbers say where the check is. */}
        <p key={line} aria-hidden="true" className="m-0 mt-0.5 min-h-5 text-[13px] text-zk-text2 motion-safe:[animation:zk-check-fade_0.4s_ease-out]">
          {line}
        </p>
        <p className="sr-only" role="status">
          {TITLE[phase]}.{total > 0 ? ` ${done} of ${total} parts done.` : ""}
        </p>
      </div>
    </div>
  );
}
