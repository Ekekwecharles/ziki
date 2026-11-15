"use client";

import { useState } from "react";
import { Avatar } from "@/components/avatar";
import type { WeekPerson } from "@/lib/project-week";

/** The top this many show; See all opens the rest. */
const TOP = 5;

/** The top three's medals: gold, silver and bronze. */
const MEDALS = [
  { label: "1st", ribbon: "#3B82F6", disc: "#F5B301", rim: "#C98A00" },
  { label: "2nd", ribbon: "#8B5CF6", disc: "#C9D1DB", rim: "#8C97A6" },
  { label: "3rd", ribbon: "#EF4444", disc: "#D9894A", rim: "#A15A23" },
] as const;

function Medal({ place }: { place: 0 | 1 | 2 }) {
  const medal = MEDALS[place];
  return (
    <svg width="18" height="22" viewBox="0 0 18 22" role="img" aria-label={`${medal.label} this week`} className="shrink-0">
      <path d="M4 0h4l2 7H6z" fill={medal.ribbon} />
      <path d="M10 0h4l-2 7H8z" fill={medal.ribbon} opacity="0.75" />
      <circle cx="9" cy="14" r="7" fill={medal.disc} stroke={medal.rim} strokeWidth="1.5" />
      <text x="9" y="17.2" textAnchor="middle" fontSize="8.5" fontWeight="800" fill={medal.rim}>
        {place + 1}
      </text>
    </svg>
  );
}

/** Each place's bar colour, in rank order; the sixth place on starts again. */
const BAR_COLOURS = ["#2563EB", "#7C3AED", "#0D9488", "#D97706", "#DB2777", "#0891B2", "#65A30D", "#DC2626"] as const;

/**
 * One person's tickets this week as a fat bar, left to right on the panel's
 * shared scale, in their place's colour. Their name sits inside at the left
 * (white over the bar, dark over the empty track) and the count sits in a chip
 * at the end of the bar, never closer to the left than the name's room.
 */
function WeekBar({ name, you, delivered, most, colour }: { name: string; you: boolean; delivered: number; most: number; colour: string }) {
  const filled = Math.max(10, (delivered / most) * 100);
  const label = (
    <>
      {name}
      {you ? <span className="ml-1 font-normal opacity-75">(you)</span> : null}
    </>
  );
  return (
    <div
      role="img"
      aria-label={`${name}${you ? " (you)" : ""}: ${delivered} ${delivered === 1 ? "ticket" : "tickets"} this week`}
      className="relative h-10 w-full min-w-0 overflow-hidden rounded-full bg-zk-chip"
    >
      <div
        className="absolute inset-y-0 left-0 rounded-full motion-safe:transition-[width] motion-safe:duration-500"
        style={{ width: `${filled}%`, backgroundColor: colour }}
      />
      {/* The name: dark over the empty track, white over the bar. */}
      <span className="absolute inset-0 flex items-center pl-4 text-sm font-semibold text-zk-text">
        <span className="max-w-[13rem] truncate">{label}</span>
      </span>
      <span
        aria-hidden="true"
        className="absolute inset-0 flex items-center pl-4 text-sm font-semibold text-white"
        style={{ clipPath: `inset(0 ${100 - filled}% 0 0)` }}
      >
        <span className="max-w-[13rem] truncate">{label}</span>
      </span>
      {/* The count, at the end of the bar, but always right of the name's room. */}
      <span
        aria-hidden="true"
        className="absolute inset-y-0 flex items-center pr-1.5"
        style={{ right: `min(${100 - filled}%, calc(100% - 16rem))` }}
      >
        <span className="rounded-full bg-white px-2 py-0.5 font-mono text-[11px] font-bold tabular-nums shadow-sm" style={{ color: colour }}>
          {delivered}
        </span>
      </span>
    </div>
  );
}

/**
 * Project Overview's first panel (#project-overview): the people who
 * delivered tickets this week, the top five first, each with a bar filling left
 * to right in their place's colour, the top three with a medal. See all opens
 * the rest.
 */
export function ProjectWeekPanel({ people: everyone, viewerId }: { people: WeekPerson[]; viewerId: string | null }) {
  const [all, setAll] = useState(false);
  // Only this week's contributors, most first (weeklyDeliveries sorts them).
  const people = everyone.filter((person) => person.delivered > 0);
  // Bars share one scale: the most anyone delivered this week fills the track.
  const most = Math.max(1, ...people.map((person) => person.delivered));
  const total = people.reduce((sum, person) => sum + person.delivered, 0);
  const shown = all ? people : people.slice(0, TOP);
  return (
    <section aria-labelledby="week-panel-heading" className="rounded-[20px] border border-zk-border bg-zk-surface">
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 pb-2 pt-5">
        <div>
          <h2 id="week-panel-heading" className="text-base font-bold text-zk-text">Top contributors this week</h2>
          <p className="mt-0.5 text-xs text-zk-muted">
            {total === 1 ? "1 ticket" : `${total} tickets`} delivered since Monday
          </p>
        </div>
      </div>
      {people.length === 0 ? (
        // No contributions yet this week: say so, and name everyone who could.
        <div className="px-5 pb-5">
          <p className="m-0 text-sm text-zk-text2">No contributions yet this week.</p>
          {everyone.length ? (
            <ul className="m-0 mt-3 flex list-none flex-wrap gap-2 p-0">
              {everyone.map((person) => (
                <li key={person.id} className="inline-flex items-center gap-1.5 rounded-full bg-zk-chip py-1 pl-1 pr-3 text-xs font-medium text-zk-text2">
                  <Avatar name={person.name} image={person.image} size="sm" />
                  {person.id === viewerId ? `${person.name} (you)` : person.name}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : (
        <ol className="m-0 list-none divide-y divide-zk-divider px-5 py-1">
          {shown.map((person, index) => {
            const you = person.id === viewerId;
            const medal = index < 3 ? (index as 0 | 1 | 2) : null;
            return (
              <li key={person.id} className="flex items-center gap-3 py-2.5">
                <span
                  aria-label={`Rank ${index + 1}`}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zk-tint font-mono text-xs font-bold tabular-nums text-zk-accent"
                >
                  {index + 1}
                </span>
                <Avatar name={person.name} image={person.image} size="lg" />
                <WeekBar name={person.name} you={you} delivered={person.delivered} most={most} colour={BAR_COLOURS[index % BAR_COLOURS.length]} />
                {/* The medal at the end of the bar; an empty slot keeps every bar the same length. */}
                <span className="flex w-5 shrink-0 justify-center">{medal !== null ? <Medal place={medal} /> : null}</span>
              </li>
            );
          })}
        </ol>
      )}
      {people.length > TOP ? (
        <div className="border-t border-zk-divider px-5 py-2.5 text-right">
          <button
            type="button"
            onClick={() => setAll((open) => !open)}
            aria-expanded={all}
            className="rounded-md px-1.5 py-0.5 text-xs font-semibold text-zk-accent hover:bg-zk-chip focus-visible:outline-2 focus-visible:outline-electric-blue"
          >
            {all ? "Show the top 5" : `See all ${people.length}`}
          </button>
        </div>
      ) : null}
    </section>
  );
}
