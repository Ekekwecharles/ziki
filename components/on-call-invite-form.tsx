"use client";

import { useEffect, useId, useRef, useState } from "react";
import { inviteOnCallAction, searchOnCallPeopleAction } from "@/app/actions/on-call";
import type { PersonMatch } from "@/lib/security-checks/on-call";

/** Wait this long after the last keystroke before searching, so typing isn't a search per letter. */
const SEARCH_DELAY_MS = 250;
const MIN_CHARS = 2;

const STATE_LABEL: Record<NonNullable<PersonMatch["state"]>, string> = {
  on_call: "Already on call",
  invited: "Invite waiting",
};

/**
 * The invite box on the on-call page (#on-call, 14 Nov plan): type a person's
 * display name or email and matching people appear as you type. Pick one to fill
 * in their email, or type any email to invite someone who has no account yet.
 * The form posts the text in the box; the server turns a name into an email.
 */
export function OnCallInviteForm({ primary }: { primary: string }) {
  const listId = useId();
  const [text, setText] = useState("");
  const [matches, setMatches] = useState<PersonMatch[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [searching, setSearching] = useState(false);
  // The latest request wins: an older, slower answer must not replace a newer one.
  const latest = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  /** Called as the box changes: waits a moment after the last keystroke, then searches. */
  function onType(value: string) {
    setText(value);
    setOpen(true);
    if (timer.current) clearTimeout(timer.current);
    const q = value.trim();
    const mine = ++latest.current;
    if (q.length < MIN_CHARS) {
      setMatches([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    timer.current = setTimeout(async () => {
      try {
        const found = await searchOnCallPeopleAction(q);
        if (latest.current !== mine) return;
        setMatches(found);
        setActive(-1);
      } catch {
        if (latest.current === mine) setMatches([]);
      } finally {
        if (latest.current === mine) setSearching(false);
      }
    }, SEARCH_DELAY_MS);
  }

  function choose(person: PersonMatch) {
    if (person.state) return;
    if (timer.current) clearTimeout(timer.current);
    latest.current++;
    setText(person.email);
    setMatches([]);
    setOpen(false);
    setSearching(false);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || matches.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => (i + 1) % matches.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => (i <= 0 ? matches.length - 1 : i - 1));
    } else if (event.key === "Enter" && active >= 0) {
      event.preventDefault();
      choose(matches[active]!);
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  }

  const showList = open && text.trim().length >= MIN_CHARS;

  return (
    <form action={inviteOnCallAction} className="flex flex-wrap items-end gap-3">
      <div className="relative flex flex-col gap-1 text-sm text-zk-text2">
        <label htmlFor={`${listId}-input`}>Name or email</label>
        <input
          id={`${listId}-input`}
          name="email"
          required
          autoComplete="off"
          value={text}
          onChange={(event) => onType(event.target.value)}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKeyDown}
          placeholder="Start typing a name or email"
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
          className="w-72 rounded-md border border-zk-border bg-zk-surface px-3 py-2 text-sm text-zk-text"
        />
        {showList ? (
          <ul
            id={listId}
            role="listbox"
            className="absolute left-0 top-full z-10 mt-1 max-h-72 w-full overflow-auto rounded-md border border-zk-border bg-zk-surface shadow-lg"
          >
            {matches.length === 0 ? (
              <li role="presentation" className="px-3 py-2 text-xs text-zk-text2">
                {searching ? "Searching…" : text.includes("@") ? "No account with that email yet: you can still invite it." : "No one found."}
              </li>
            ) : (
              matches.map((person, index) => (
                <li
                  key={person.id}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === active}
                  aria-disabled={person.state !== null}
                  // mousedown, not click: the input's blur would close the list first.
                  onMouseDown={(event) => {
                    event.preventDefault();
                    choose(person);
                  }}
                  className={`flex items-center justify-between gap-3 px-3 py-2 text-sm ${
                    index === active ? "bg-zk-chip" : ""
                  } ${person.state ? "cursor-not-allowed text-zk-text2" : "cursor-pointer text-zk-text hover:bg-zk-chip"}`}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{person.name}</span>
                    <span className="block truncate text-xs text-zk-text2">{person.email}</span>
                  </span>
                  {person.state ? <span className="shrink-0 text-xs text-zk-text2">{STATE_LABEL[person.state]}</span> : null}
                </li>
              ))
            )}
          </ul>
        ) : null}
      </div>
      <label className="flex items-center gap-2 pb-2 text-sm text-zk-text2">
        <input type="checkbox" name="clearForSecurity" /> Cleared for security checks
      </label>
      <button type="submit" className={primary}>
        Invite
      </button>
    </form>
  );
}
