import Link from "next/link";
import { requireSuperAdmin } from "@/lib/auth-helpers";
import { cancelOnCallInviteAction } from "@/app/actions/on-call";
import { OnCallInviteForm } from "@/components/on-call-invite-form";
import { OnCallStateLabel } from "@/components/on-call-state";
import { PaginationControls } from "@/components/pagination-controls";
import { calculatePagination, parsePage } from "@/lib/pagination";
import {
  ON_CALL_PEOPLE_PER_PAGE,
  countOnCallPeople,
  listOnCallPeople,
  onCallLog,
  pageCallLog,
  pendingInvites,
  type CallLogLine,
} from "@/lib/security-checks/on-call";

export const metadata = { title: "On-call people" };

const BASE = "/superadmin/on-call";

const ERRORS: Record<string, string> = {
  invalid_email: "That doesn't look like an email address.",
  not_found: "No one has that name. Pick someone from the list, or type an email.",
  ambiguous: "More than one person has that name. Pick one from the list, or type their email.",
  already_on_call: "That person is already on call.",
  already_invited: "That person already has a pending invite.",
  not_pending: "That invite isn't pending any more.",
};

/** "30s", "4m", "1h 20m": a wait in plain words. */
function waitWords(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

const card = "rounded-xl border border-zk-border bg-zk-surface";
const primary = "rounded-md bg-zk-accent px-3 py-1.5 text-sm font-medium text-white";
const button = "rounded-md border border-zk-border px-3 py-1.5 text-sm text-zk-text2 hover:bg-zk-chip";

type Params = { error?: string; q?: string; page?: string; log?: string; logPage?: string; missed?: string };

/** A link back to this page with some of its settings changed, keeping the rest (search, people page, log). */
function href(current: Params, change: Partial<Params>): string {
  const next: Params = { ...current, ...change };
  const sp = new URLSearchParams();
  for (const key of ["q", "page", "log", "logPage", "missed"] as const) {
    const value = next[key];
    if (value) sp.set(key, value);
  }
  const qs = sp.toString();
  return qs ? `${BASE}?${qs}` : BASE;
}

/**
 * Site staff only (#on-call, 14 Nov plan). Quiet by default: invite someone, then
 * the people on call as a short list (name, email, how they are doing) that
 * opens each person's own page, and the call log folded away until it's needed.
 */
export default async function OnCallPeoplePage({ searchParams }: { searchParams?: Promise<Params> }) {
  await requireSuperAdmin();
  const params = searchParams ? await searchParams : {};
  const q = (params.q ?? "").trim().slice(0, 100);
  const error = params.error ? (ERRORS[params.error] ?? "Something went wrong.") : null;

  const wanted = parsePage(params.page);
  let found = await listOnCallPeople({ q, skip: (wanted - 1) * ON_CALL_PEOPLE_PER_PAGE });
  const pagination = calculatePagination({ page: wanted, pageSize: ON_CALL_PEOPLE_PER_PAGE, totalCount: found.total });
  // A page past the end (a stale link): show the last one.
  if (found.people.length === 0 && found.total > 0) found = await listOnCallPeople({ q, skip: pagination.skip });

  const [everyone, invites, lines] = await Promise.all([countOnCallPeople(), pendingInvites(), onCallLog()]);
  const log = pageCallLog(lines, { page: parsePage(params.logPage), missedOnly: params.missed === "1" });
  // Folded away until asked for; its own links keep it open.
  const logOpen = params.log === "1" || Boolean(params.logPage) || params.missed === "1";

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold text-zk-text">On-call people</h1>
        <p className="mt-1 text-sm text-zk-text2">
          People whose agents get priority work, such as new workspaces and security-check parts. Invite by name or email; they accept on
          their side. Tick &ldquo;cleared for security checks&rdquo; only for people you trust with clients&rsquo; private results.
        </p>
        {error ? <p role="alert" className="mt-3 rounded-md border border-zk-border bg-zk-tint px-3 py-2 text-sm text-zk-text">{error}</p> : null}
      </div>

      <section className="space-y-3" aria-labelledby="invite-heading">
        <h2 id="invite-heading" className="text-base font-semibold text-zk-text">Invite a person</h2>
        <OnCallInviteForm primary={primary} />
        {/* Only when someone hasn't answered yet; folded so an empty list takes no room. */}
        {invites.length > 0 ? (
          <details className={`group ${card}`}>
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm text-zk-text [&::-webkit-details-marker]:hidden">
              <span>
                <span className="font-semibold">{invites.length}</span> {invites.length === 1 ? "invite" : "invites"} waiting for an answer
              </span>
              <span className="text-xs text-zk-accent group-open:hidden">Show</span>
              <span className="hidden text-xs text-zk-accent group-open:inline">Hide</span>
            </summary>
            <ul className="divide-y divide-zk-border border-t border-zk-border">
              {invites.map((invite) => (
                <li key={invite.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <p className="text-sm text-zk-text">
                    {invite.email}
                    <span className="block text-xs text-zk-text2">
                      invited by {invite.invitedBy.name ?? "a super admin"}
                      {invite.clearForSecurity ? " · cleared for security on accept" : ""}
                    </span>
                  </p>
                  <form action={cancelOnCallInviteAction}>
                    <input type="hidden" name="inviteId" value={invite.id} />
                    <button type="submit" className={button}>Withdraw</button>
                  </form>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>

      <section className="space-y-3" aria-labelledby="oncall-heading">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="oncall-heading" className="text-base font-semibold text-zk-text">
            On call <span className="font-normal text-zk-text2">· {everyone}</span>
          </h2>
          <form action={BASE} method="get" role="search" className="flex items-center gap-2">
            <label htmlFor="on-call-search" className="sr-only">Search people on call by name or email</label>
            <input
              id="on-call-search"
              name="q"
              type="search"
              defaultValue={q}
              placeholder="Search name or email"
              className="w-56 rounded-md border border-zk-border bg-zk-surface px-3 py-1.5 text-sm text-zk-text"
            />
            <button type="submit" className={button}>Search</button>
            {q ? <Link href={BASE} className="text-sm text-zk-accent hover:underline">Clear</Link> : null}
          </form>
        </div>

        {found.people.length === 0 ? (
          <p className="text-sm text-zk-text2">{q ? `No one on call matches “${q}”.` : "Nobody is on call yet."}</p>
        ) : (
          <ul className={`divide-y divide-zk-border ${card}`}>
            {found.people.map((person) => (
              <li key={person.id}>
                {/* The whole row opens the person's page: their agents, open work and guest stays. */}
                <Link
                  href={`${BASE}/${person.id}`}
                  className="flex items-center gap-3 px-4 py-3 transition hover:bg-zk-chip focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-zk-accent"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-zk-text">{person.name}</span>
                    <span className="block truncate text-xs text-zk-text2">{person.email}</span>
                  </span>
                  {person.cleared ? <span className="shrink-0 rounded-full bg-zk-tint px-2 py-0.5 text-xs font-semibold text-zk-accent">Cleared</span> : null}
                  <OnCallStateLabel state={person.state} />
                  <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-zk-muted">
                    <path d="M9 6l6 6-6 6" />
                  </svg>
                </Link>
              </li>
            ))}
          </ul>
        )}
        <PaginationControls
          page={pagination.page}
          totalPages={pagination.totalPages}
          totalCount={pagination.totalCount}
          from={pagination.from}
          to={pagination.to}
          queryParams={{ q: q || undefined }}
          basePath={BASE}
          itemLabel="person"
          itemLabelPlural="people"
        />
      </section>

      {/* The call log is folded away: open it when something needs a look. */}
      <details open={logOpen} className={`group ${card}`}>
        <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
          <span className="text-base font-semibold text-zk-text">
            Call log{" "}
            <span className="text-sm font-normal text-zk-text2">
              · {log.totalLines} in 48 hours{log.missed ? ` · ${log.missed} missed` : ""}
            </span>
          </span>
          <span className="text-xs text-zk-accent group-open:hidden">Show</span>
          <span className="hidden text-xs text-zk-accent group-open:inline">Hide</span>
        </summary>
        <div className="space-y-3 border-t border-zk-border p-4">
          <p className="text-sm text-zk-text2">
            Security-check parts and new-workspace requests: who picked each up, how fast, and any nobody has picked up in 15 minutes.
          </p>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Filter the call log">
            <Link
              href={href(params, { log: "1", logPage: undefined, missed: undefined })}
              aria-current={params.missed === "1" ? undefined : "true"}
              className={`rounded-full border px-3 py-1 text-xs font-semibold ${params.missed === "1" ? "border-zk-border text-zk-text2 hover:bg-zk-chip" : "border-zk-accent bg-zk-tint text-zk-accent"}`}
            >
              All
            </Link>
            <Link
              href={href(params, { log: "1", logPage: undefined, missed: "1" })}
              aria-current={params.missed === "1" ? "true" : undefined}
              className={`rounded-full border px-3 py-1 text-xs font-semibold ${params.missed === "1" ? "border-zk-accent bg-zk-tint text-zk-accent" : "border-zk-border text-zk-text2 hover:bg-zk-chip"}`}
            >
              Missed {log.missed ? `· ${log.missed}` : ""}
            </Link>
          </div>
          {log.lines.length === 0 ? (
            <p className="text-sm text-zk-text2">{params.missed === "1" ? "Nothing was missed in the last 48 hours." : "Nothing needed on-call people in the last 48 hours."}</p>
          ) : (
            <ul className={`divide-y divide-zk-border ${card}`}>
              {log.lines.map((line, i) => (
                <LogLine key={`${line.at.toISOString()}-${i}`} line={line} />
              ))}
            </ul>
          )}
          {log.pagination.totalCount > 0 ? (
            <nav aria-label="Call log pages" className="flex flex-wrap items-center justify-between gap-3 text-xs text-zk-muted">
              <span>
                Showing <span className="font-semibold text-zk-text">{log.pagination.from}</span>–<span className="font-semibold text-zk-text">{log.pagination.to}</span> of{" "}
                <span className="font-semibold text-zk-text">{log.pagination.totalCount}</span>
              </span>
              {log.pagination.totalPages > 1 ? (
                <span className="flex items-center gap-2">
                  {log.pagination.prevPage ? (
                    <Link href={href(params, { log: "1", logPage: log.pagination.prevPage > 1 ? String(log.pagination.prevPage) : undefined })} className={button}>Previous</Link>
                  ) : null}
                  <span>Page {log.pagination.page} of {log.pagination.totalPages}</span>
                  {log.pagination.nextPage ? (
                    <Link href={href(params, { log: "1", logPage: String(log.pagination.nextPage) })} className={button}>Next</Link>
                  ) : null}
                </span>
              ) : null}
            </nav>
          ) : null}
        </div>
      </details>
    </div>
  );
}

function LogLine({ line }: { line: CallLogLine }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <p className="min-w-0 text-sm text-zk-text">
        {line.what}
        <span className="block text-xs text-zk-text2">{line.at.toLocaleString("en-GB", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" })} UTC</span>
      </p>
      <p className={`text-xs ${line.missed ? "font-medium text-zk-text" : "text-zk-text2"}`}>
        {line.missed
          ? "Missed: nobody picked it up"
          : line.pickedUpBy === null
            ? "Waiting for someone"
            : `${line.pickedUpBy} · ${line.waitMs === 0 ? "at once" : waitWords(line.waitMs ?? 0)}`}
      </p>
    </li>
  );
}
