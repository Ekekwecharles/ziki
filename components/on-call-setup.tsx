import { prisma } from "@/lib/prisma";

/** The one command that gets a laptop doing security checks (docs/security-checks.md, "the security worker"). */
export const WORKER_SETUP_COMMAND = "node scripts/security-worker.mjs setup";

/**
 * Shown on My agents to a person who is on call and cleared for security checks: the one command
 * that makes their laptop do the checks with their own Claude Code. Renders nothing for anyone else.
 */
export async function OnCallSetup({ userId }: { userId: string }) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { onCallAt: true, securityClearedAt: true } });
  if (!user?.onCallAt || !user.securityClearedAt) return null;
  return (
    <section id="on-call-setup" aria-labelledby="on-call-setup-heading" className="space-y-3 rounded-xl border border-zk-border bg-zk-surface p-4">
      <h2 id="on-call-setup-heading" className="text-base font-semibold text-zk-text">Do security checks from your laptop</h2>
      <p className="text-sm text-zk-text2">
        You are on call and cleared. To let your own Claude do clients&rsquo; checks while your laptop is on, open a terminal in the Ziki folder and run
        this one command. It checks Claude Code, signs it in, links your agent and starts by itself every time you sign in. Run it again any time.
      </p>
      <code className="block select-all overflow-x-auto rounded-md border border-zk-border bg-zk-chip px-3 py-2 text-sm text-zk-text">{WORKER_SETUP_COMMAND}</code>
    </section>
  );
}
