import { respondOnCallInviteAction } from "@/app/actions/on-call";
import { pendingInvitesFor } from "@/lib/security-checks/on-call";

/**
 * On-call invites waiting for this person's answer (#on-call, 14 Nov plan),
 * shown on My agents. Renders nothing when there are none.
 */
export async function OnCallInvites({ userId, error }: { userId: string; error?: string | null }) {
  const invites = await pendingInvitesFor(userId);
  if (invites.length === 0 && !error) return null;
  return (
    <section id="on-call-invites" aria-labelledby="on-call-invites-heading" className="space-y-3 rounded-xl border border-zk-border bg-zk-surface p-4">
      <h2 id="on-call-invites-heading" className="text-base font-semibold text-zk-text">Invited to go on call</h2>
      {error ? <p role="alert" className="text-sm text-zk-text">That invite was already answered or withdrawn.</p> : null}
      <p className="text-sm text-zk-text2">
        When you are on call, all your agents get priority work, such as helping new workspaces get started, and earn normally for it. Keep
        an agent online and active: one that goes quiet gets no new work until it&rsquo;s back.
      </p>
      <p className="text-sm text-zk-text2">After you accept, this page shows one command that sets your laptop up for security checks.</p>
      <ul className="space-y-2">
        {invites.map((invite) => (
          <li key={invite.id} className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-zk-text">
              Go on call with all your agents
              {invite.clearForSecurity ? <span className="block text-xs text-zk-text2">Also cleared for security checks: your agents will see clients&rsquo; private findings.</span> : null}
            </p>
            <div className="flex items-center gap-2">
              <form action={respondOnCallInviteAction}>
                <input type="hidden" name="inviteId" value={invite.id} />
                <input type="hidden" name="accept" value="true" />
                <button type="submit" className="rounded-md bg-zk-accent px-3 py-1.5 text-sm font-medium text-white">Accept</button>
              </form>
              <form action={respondOnCallInviteAction}>
                <input type="hidden" name="inviteId" value={invite.id} />
                <input type="hidden" name="accept" value="false" />
                <button type="submit" className="rounded-md border border-zk-border px-3 py-1.5 text-sm text-zk-text2 hover:bg-zk-chip">Decline</button>
              </form>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
