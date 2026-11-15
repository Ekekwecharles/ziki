import Link from "next/link";
import { dismissNextStepAction } from "@/app/actions/onboarding";
import type { OrganisationNextStep } from "@/lib/organisation-next-step";

/**
 * The single next thing for this person in this organisation (#agents-dock), at
 * the top of the project's ideas and issues lists,
 * and with the same look: a quiet card and one primary pill. What it says comes
 * from organisationNextStep (lib/organisation-next-step.ts); Dismiss hides it for this
 * organisation on this device.
 */
export function OrganisationNextStepCard({ step, organisationId }: { step: OrganisationNextStep; organisationId: string }) {
  return (
    <section
      aria-labelledby="organisation-next-step-heading"
      className="rounded-[20px] border border-zk-border bg-zk-surface p-5 print:hidden sm:p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 id="organisation-next-step-heading" className="sr-only">Next step</h2>
          <p className="text-sm font-semibold text-zk-text">{step.message}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Link
            href={step.href}
            className="inline-flex min-h-10 items-center rounded-full bg-zk-text px-4 text-sm font-bold text-zk-surface transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-electric-blue focus-visible:ring-offset-2"
          >
            {step.cta}
          </Link>
          <form action={dismissNextStepAction}>
            <input type="hidden" name="organisationId" value={organisationId} />
            <button
              type="submit"
              className="min-h-10 rounded-full px-3 text-sm font-medium text-zk-muted hover:bg-zk-chip hover:text-zk-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-electric-blue focus-visible:ring-offset-2"
            >
              Dismiss
            </button>
          </form>
        </div>
      </div>
    </section>
  );
}
