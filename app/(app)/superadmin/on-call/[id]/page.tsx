import Link from "next/link";
import { notFound } from "next/navigation";
import { removeOnCallAction, setSecurityClearanceAction } from "@/app/actions/on-call";
import { LocalTime } from "@/components/local-time";
import { OnCallStateLabel } from "@/components/on-call-state";
import { requireSuperAdmin } from "@/lib/auth-helpers";
import { getOnCallPerson } from "@/lib/security-checks/on-call";

export const metadata = { title: "On-call person" };

const card = "rounded-xl border border-zk-border bg-zk-surface";
const button = "rounded-md border border-zk-border px-3 py-1.5 text-sm text-zk-text2 hover:bg-zk-chip";

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/**
 * One on-call person (#on-call, 14 Nov plan): the detail the list leaves out. Their
 * agents with how recently each was seen, the security parts being checked now,
 * the workspaces they are a guest in, and the two things staff can do: clear
 * them for security checks, or take them off call.
 */
export default async function OnCallPersonPage({ params }: { params: Promise<{ id: string }> }) {
  await requireSuperAdmin();
  const { id } = await params;
  const person = await getOnCallPerson(id);
  if (!person) notFound();

  return (
    <div className="space-y-6">
      <Link href="/superadmin/on-call" className="inline-flex items-center gap-1.5 text-sm font-medium text-zk-accent hover:underline">
        <span aria-hidden="true">←</span> On-call people
      </Link>

      <header className="space-y-2">
        <h1 className="wrap-break-word text-xl font-semibold text-zk-text">{person.name}</h1>
        <p className="m-0 break-all text-sm text-zk-text2">{person.email}</p>
        <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zk-text2">
          <OnCallStateLabel state={person.state} />
          <span>{person.onCallSince ? <>On call since <LocalTime date={person.onCallSince} absolute /></> : "Not on call"}</span>
          <span>{person.cleared ? "Cleared for security checks" : "Not cleared for security checks"}</span>
        </p>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <form action={setSecurityClearanceAction}>
            <input type="hidden" name="userId" value={person.id} />
            <input type="hidden" name="cleared" value={person.cleared ? "false" : "true"} />
            <button type="submit" className={button}>{person.cleared ? "Remove clearance" : "Clear for security"}</button>
          </form>
          {person.onCallSince ? (
            <form action={removeOnCallAction}>
              <input type="hidden" name="userId" value={person.id} />
              <button type="submit" className={button}>Take off call</button>
            </form>
          ) : null}
        </div>
      </header>

      <dl className="grid gap-3 sm:grid-cols-3">
        {[
          ["Agents", String(person.agents.length)],
          ["Security parts being checked", String(person.openParts)],
          ["Guest in", plural(person.guestWorkspaces.length, "workspace")],
        ].map(([label, value]) => (
          <div key={label} className={`${card} p-4`}>
            <dt className="text-xs text-zk-text2">{label}</dt>
            <dd className="m-0 mt-1 text-2xl font-bold text-zk-text">{value}</dd>
          </div>
        ))}
      </dl>

      <section className="space-y-3" aria-labelledby="agents-heading">
        <h2 id="agents-heading" className="text-base font-semibold text-zk-text">Agents</h2>
        {person.agents.length === 0 ? (
          <p className="text-sm text-zk-text2">This person has no active agents, so nothing can be picked up for them.</p>
        ) : (
          <ul className={`divide-y divide-zk-border ${card}`}>
            {person.agents.map((agent) => (
              <li key={agent.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="m-0 truncate text-sm font-medium text-zk-text">
                    {agent.name} <span className="font-normal text-zk-text2">@{agent.username}</span>
                  </p>
                  <p className="m-0 text-xs text-zk-text2">
                    {agent.lastSeen ? <>Last seen <LocalTime date={agent.lastSeen} /></> : "Never seen"}
                    {agent.openParts > 0 ? ` · checking ${plural(agent.openParts, "security part")}` : ""}
                  </p>
                </div>
                <OnCallStateLabel state={agent.state} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {person.guestWorkspaces.length > 0 ? (
        <section className="space-y-3" aria-labelledby="guest-heading">
          <h2 id="guest-heading" className="text-base font-semibold text-zk-text">Guest in</h2>
          <ul className={`divide-y divide-zk-border ${card}`}>
            {person.guestWorkspaces.map((workspace) => (
              <li key={workspace.id} className="px-4 py-3 text-sm text-zk-text">{workspace.name}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
