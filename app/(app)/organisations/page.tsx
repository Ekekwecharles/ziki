import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/lib/auth-helpers";
import { firstProjectRefFor } from "@/lib/project-route";
import { orgPath } from "@/lib/project-paths";
import { openInvitesFor, viewInvite } from "@/lib/invites";
import { prisma } from "@/lib/prisma";
import { isSuperAdmin } from "@/lib/roles";
import { currentOrganisationIdFor } from "@/lib/organisation-context";
import {
  MEMBERSHIP_ROLE_LABELS,
  ORGANISATION_NAME_MAX,
  organisationsForUser,
  zeduNeedsOwner,
} from "@/lib/organisations";
import { selectOrganisationAction, setOrganisationArchivedAction } from "./actions";
import { securityReturnPath } from "@/lib/security-return-path";
import { AcceptInviteForm } from "./accept-invite-form";
import { InviteCard } from "./invite-card";
import { OrganisationActions } from "./organisation-actions";
import { ZeduOwnerForm } from "./zedu-owner-form";
import { LocalTime } from "@/components/local-time";

/* Distinct browser-tab title; the root layout appends the site name. */
export const metadata = { title: "Organisations" };


/**
 * A person's own memberships (#444): pick the organisation to work in, accept an
 * invite or open an invite link, create a organisation, or restore an archived
 * one. Nothing here administers a organisation; that is /org, for the current one.
 */
export default async function OrganisationsPage({
  searchParams,
}: {
  searchParams: Promise<{
    invite?: string | string[];
    error?: string | string[];
    notice?: string | string[];
    next?: string | string[];
  }>;
}) {
  const user = await requireUser();
  const projectSlug = await firstProjectRefFor(user.id);
  // In-app invite notifications (#443) link here with the invite's id.
  const {
    invite: inviteParam,
    error: errorParam,
    notice: noticeParam,
    next: nextParam,
  } = await searchParams;
  // From Security with a scanned site: after creating the organisation, go back there.
  const next = (securityReturnPath(typeof nextParam === "string" ? nextParam : null)) ?? undefined;
  const inviteId = typeof inviteParam === "string" ? inviteParam : "";
  const error = typeof errorParam === "string" ? errorParam : "";
  const notice = typeof noticeParam === "string" ? noticeParam : "";

  const [organisations, currentOrganisationId, invite, zeduOwnerNeeded, openInvites] = await Promise.all([
    organisationsForUser(prisma, user.id, user.role),
    currentOrganisationIdFor(user.id),
    inviteId ? viewInvite(prisma, { inviteId }, user) : null,
    isSuperAdmin(user.role) ? zeduNeedsOwner(prisma) : false,
    openInvitesFor(prisma, user),
  ]);
  const listedInvites = openInvites.filter((row) => row.id !== inviteId);
  const activeOrganisations = organisations.filter((organisation) => !organisation.archivedAt);
  const archivedOrganisations = organisations.filter(
    (organisation) => organisation.archivedAt && (organisation.role === "owner" || isSuperAdmin(user.role)),
  );
  const hasOrganisations = activeOrganisations.length > 0;
  // #537: names shared by two of your organisations, so their buttons say which is which.
  const nameCounts = new Map<string, number>();
  for (const organisation of activeOrganisations) {
    const key = organisation.name.toLocaleLowerCase();
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }
  const sharesName = (name: string) => (nameCounts.get(name.toLocaleLowerCase()) ?? 0) > 1;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-extrabold tracking-tight text-zk-text">
          {hasOrganisations ? "Choose an organisation" : "Join or create an organisation"}
        </h1>
        <p className="text-sm text-zk-text2">
          {hasOrganisations
            ? "An organisation is your team. A project is one product inside it."
            : "You're not in an organisation yet. Accept an invite, or create an organisation of your own."}
        </p>
      </div>
      <OrganisationActions nameMax={ORGANISATION_NAME_MAX} next={next} />
      </div>

      <div className="flex items-center justify-between rounded-[18px] border border-zk-border bg-gradient-to-r from-zk-surface to-zk-tint/20 p-4 sm:p-5">
        <div className="space-y-0.5">
          <h2 className="text-sm font-bold text-zk-text">Looking for projects to contribute to?</h2>
          <p className="text-xs text-zk-text2">Browse public projects and open products accepting contributors.</p>
        </div>
        <Link
          href="/discover"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-electric-blue-strong px-4 py-2 text-xs font-bold text-white shadow-sm transition hover:brightness-110"
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
          Discover Projects
        </Link>
      </div>

      {error ? (
        <p className="rounded-[14px] border border-zk-bad-bd bg-zk-bad-bg px-3 py-2 text-sm text-zk-bad-fg">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="rounded-[14px] border border-zk-border bg-zk-ok-bg px-3 py-2 text-sm text-zk-ok-fg">
          {notice}
        </p>
      ) : null}

      {inviteId ? (
        <InviteCard invite={invite} accept={{ inviteId }} accountEmail={user.email} />
      ) : null}

      {listedInvites.length > 0 ? (
        <section aria-labelledby="your-invites" className="overflow-hidden rounded-[20px] border border-zk-border bg-zk-surface">
          <h2
            id="your-invites"
            className="border-b border-zk-border bg-zk-tint px-4 py-3 text-base font-semibold text-zk-text sm:px-6"
          >
            Invitations
          </h2>
          <ul className="divide-y divide-zk-border">
            {listedInvites.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-zk-text">{row.organisation.name}</p>
                  <p className="mt-0.5 text-xs text-zk-muted">
                    {row.invitedByName} invited you · expires <LocalTime date={row.expiresAt} />
                  </p>
                </div>
                <AcceptInviteForm inviteId={row.id} organisationName={row.organisation.name} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {!hasOrganisations && !inviteId ? (
        <>
          {/* #641: a newcomer's first step is their own organisation, explained. */}
          <section aria-labelledby="how-ziki-works" className="rounded-xl border border-zk-border bg-zk-tint p-4 sm:p-6">
            <h2 id="how-ziki-works" className="text-base font-semibold text-zk-text">
              How Ziki is organised
            </h2>
            <ul className="mt-2 space-y-1.5 text-sm text-zk-text2">
              <li>
                <span className="font-medium">An organisation</span> is your team or company. Its people, projects,
                and issues stay inside it.
              </li>
              <li>
                <span className="font-medium">A project</span> is one product in that organisation, such as a web
                app or a desktop app. The switcher chooses which project&apos;s issues you see.
              </li>
            </ul>
          </section>
        </>
      ) : null}

      {hasOrganisations ? (
        <section aria-labelledby="your-organisations" className="overflow-hidden rounded-[20px] border border-zk-border bg-zk-surface">
          <h2
            id="your-organisations"
            className="border-b border-zk-border bg-zk-tint px-4 py-3 text-base font-semibold text-zk-text sm:px-6"
          >
            Your organisations
          </h2>
          <ul className="divide-y divide-zk-border">
            {activeOrganisations.map((organisation) => {
              const current = organisation.id === currentOrganisationId;
              return (
                <li key={organisation.id} className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-zk-text">
                      <span className="truncate">{organisation.name}</span>
                      {current ? (
                        <Badge className="rounded-full bg-zk-tint text-zk-accent ring-1 ring-zk-border">Current</Badge>
                      ) : null}
                    </p>
                    <p className="mt-0.5 text-xs text-zk-muted">
                      {/* #537: the slug tells organisations with the same name apart. */}
                      <span className="font-mono">{organisation.slug}</span> · {MEMBERSHIP_ROLE_LABELS[organisation.role]}
                      {current && projectSlug ? (
                        <>
                          {" · "}
                          <Link href={orgPath(projectSlug)} className="text-zk-accent hover:underline">
                            {organisation.role === "member" ? "Members and projects" : "Manage organisation"}
                          </Link>
                        </>
                      ) : null}
                    </p>
                  </div>
                  <form action={selectOrganisationAction}>
                    <input type="hidden" name="organisationId" value={organisation.id} />
                    <Button type="submit" variant={current ? "secondary" : "primary"}>
                      Open {organisation.name}
                      {sharesName(organisation.name) ? <span className="sr-only"> ({organisation.slug})</span> : null}
                    </Button>
                  </form>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {archivedOrganisations.length > 0 ? (
        <section
          aria-labelledby="archived-organisations"
          className="overflow-hidden rounded-[20px] border border-zk-border bg-zk-surface"
        >
          <h2
            id="archived-organisations"
            className="border-b border-zk-border bg-zk-tint px-4 py-3 text-base font-semibold text-zk-text sm:px-6"
          >
            Archived organisations
          </h2>
          <p className="border-b border-zk-border px-4 py-3 text-sm text-zk-text2 sm:px-6">
            Archived organisations are hidden from the switcher and can&apos;t be opened. Restore one
            to work in it again.
          </p>
          <ul className="divide-y divide-zk-border">
            {archivedOrganisations.map((organisation) => (
              <li
                key={organisation.id}
                className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-6"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-zk-text">{organisation.name}</p>
                  <p className="mt-0.5 text-xs text-zk-muted">
                    <span className="font-mono">{organisation.slug}</span> · Archived · {MEMBERSHIP_ROLE_LABELS[organisation.role]}
                  </p>
                </div>
                <form action={setOrganisationArchivedAction}>
                  <input type="hidden" name="organisationId" value={organisation.id} />
                  <input type="hidden" name="archived" value="false" />
                  <Button type="submit" variant="secondary">
                    Restore {organisation.name}
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {zeduOwnerNeeded ? (
        <section aria-labelledby="zedu-owner" className="rounded-xl border border-zk-warn-bd bg-zk-warn-bg p-4 sm:p-6">
          <h2 id="zedu-owner" className="text-base font-semibold text-zk-warn-fg">
            Ziki has no owner yet
          </h2>
          <p className="mt-1 text-sm text-zk-warn-fg">
            Everyone moved into Ziki is a member, so nobody can invite people. As the site&apos;s
            super admin, choose its first owner from its existing members.
          </p>
          <ZeduOwnerForm />
        </section>
      ) : null}
    </div>
  );
}
