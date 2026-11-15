"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMarketingArea } from "@/components/marketing/marketing-area";
import { ideasPath, orgPath, type ProjectRef } from "@/lib/project-paths";
import { useProjectRef } from "@/lib/use-project-ref";
import { SignOutButton } from "@/components/sign-out-button";
import { OrganisationSwitcher, type OrganisationOption, type ExternalProjectChoice } from "@/components/organisation-switcher";
import {
  MANAGE_AGENTS_HREF,
  isNavItemActive,
  marketingTabHref,
  MY_STAKES_HREF,
  realRoleOf,
  roleViewLabels,
  SITE_ADMIN_HREF,
} from "@/lib/header-nav";
import { type AppRole } from "@/lib/roles";
import { type OrganisationRole } from "@/lib/organisation-role";
import { roleAccessFor, type RoleAccess } from "@/lib/role-access";
import { RoleAccessBadge } from "@/components/role-access-tooltip";
import { Avatar } from "@/components/avatar";
import { AccountThemeSelector } from "@/components/theme-toggle";
import { CookieSettingsLink } from "@/components/consent-banner";
import { VersionCredits } from "@/components/credits-dialog";
import { recentNotificationsAction } from "@/app/actions/notifications";
import { LocalTime } from "@/components/local-time";
import { BASE_PATH } from "@/lib/base-path";
import { PAGE_CONTAINER_CLASS } from "@/components/page-container";
import { ZikiMark } from "@/components/ziki-mark";
import { formatZ } from "@/lib/points/rules";
import { WithdrawWindow } from "@/components/withdraw-window";

const linkFocus =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-electric-blue focus-visible:ring-offset-2";


/** Closes a popover on outside click or Escape, returning focus to its trigger. */
function useDismiss(
  open: boolean,
  close: () => void,
  containerRef: React.RefObject<HTMLElement | null>,
  triggerRef: React.RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close, containerRef, triggerRef]);
}

function EnvelopeIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect width="20" height="16" x="2" y="4" rx="2" />
      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
    </svg>
  );
}

function NavIcon({ children }: { children: React.ReactNode }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
      {children}
    </svg>
  );
}

function TopNavLink({
  href,
  active,
  label,
  children,
}: {
  href: string;
  active: boolean;
  label: string;
  children: React.ReactNode;
}) {
  // Below lg this is a tab in the bottom strip: icon over a short label.
  const className = `relative inline-flex shrink-0 items-center whitespace-nowrap font-medium ${linkFocus} max-lg:min-w-16 max-lg:flex-1 max-lg:flex-col max-lg:gap-0.5 max-lg:rounded-xl max-lg:py-1.5 max-lg:text-[11px] lg:h-9 lg:gap-2 lg:rounded-full lg:px-2.5 lg:text-[13px] ${
    active ? "text-zk-accent lg:bg-zk-tint" : "text-zk-text2 hover:text-zk-text lg:hover:bg-zk-chip"
  }`;
  const inner = (
    <>
      <span className={`relative flex items-center justify-center max-lg:h-7 max-lg:w-12 max-lg:rounded-full ${active ? "max-lg:bg-zk-tint" : ""}`}>
        {children}
      </span>
      {label}
    </>
  );
  if (href.startsWith("http")) {
    return (
      <a href={href} className={className}>
        {inner}
      </a>
    );
  }
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={className}
    >
      {inner}
    </Link>
  );
}

/**
 * The organisation areas: Product (the issue tracker), Marketing and Security.
 * The logo goes to the project's Ideas.
 */
function TopNav({ pathname, projectSlug }: { pathname: string | null; projectSlug: ProjectRef | null }) {
  // Product opens the project the page is in, or the first one (#project-urls).
  const productHref = projectSlug ? ideasPath(projectSlug) : "/organisations";
  const marketingHref = marketingTabHref(projectSlug);
  // The section's address starts with the project's slug, but it isn't Your App.
  const onMarketingWork = useMarketingArea();
  const inMarketing = isNavItemActive(pathname, marketingHref) || onMarketingWork;
  return (
    <nav
      aria-label="Organisation"
      // Phones and tablets: a tab strip fixed to the bottom of the screen,
      // clear of the home indicator. From lg it sits inline in the top bar.
      className="flex items-center max-lg:fixed max-lg:inset-x-0 max-lg:bottom-0 max-lg:z-40 max-lg:justify-around max-lg:border-t max-lg:border-zk-border max-lg:bg-zk-surface max-lg:px-2 max-lg:pt-1.5 max-lg:pb-[max(0.375rem,env(safe-area-inset-bottom))] max-lg:shadow-[0_-1px_3px_rgba(0,0,0,0.04)] lg:ml-6 lg:gap-1"
    >
      <TopNavLink href={productHref} active={Boolean(projectSlug && pathname?.startsWith(`/${projectSlug}`) && !inMarketing)} label="Your App">
        <NavIcon>
          <circle cx="12" cy="12" r="9" />
          <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
        </NavIcon>
      </TopNavLink>
      <TopNavLink href={marketingHref} active={inMarketing} label="Marketing">
        <NavIcon>
          <path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1Z" />
          <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />
        </NavIcon>
      </TopNavLink>
      <TopNavLink href="/security" active={isNavItemActive(pathname, "/security")} label="Security">
        <NavIcon>
          <path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6l-8-3Z" />
          <path d="m9 12 2 2 4-4" />
        </NavIcon>
      </TopNavLink>
      <TopNavLink href="/discover" active={isNavItemActive(pathname, "/discover")} label="Discover">
        <NavIcon>
          <circle cx="12" cy="12" r="9" />
          <path d="m15.5 8.5-2 5-5 2 2-5 5-2Z" />
        </NavIcon>
      </TopNavLink>
      <TopNavLink href="/forum" active={isNavItemActive(pathname, "/forum")} label="Forum">
        <NavIcon>
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </NavIcon>
      </TopNavLink>
    </nav>
  );
}

/** In-place notification preview; opening the bell never marks alerts read (#615). */
/** The envelope (#inbox): a preview of recent notifications; its count is unread notifications plus escalations waiting on you. */
function InboxEnvelope({ unreadCount, pendingEscalations, active }: { unreadCount: number; pendingEscalations: number; active: boolean }) {
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [notifications, setNotifications] = useState<Awaited<ReturnType<typeof recentNotificationsAction>> | null>(null);
  const [failed, setFailed] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), containerRef, triggerRef);

  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus({ preventScroll: true });
    let cancelled = false;
    recentNotificationsAction().then(
      (items) => { if (!cancelled) setNotifications(items); },
      () => { if (!cancelled) setFailed(true); },
    );
    return () => { cancelled = true; };
  }, [open, attempt]);

  function loadPreview() {
    setNotifications(null);
    setFailed(false);
  }
  const total = unreadCount + pendingEscalations;
  const label = total > 0 ? `Inbox, ${total} unread` : "Inbox";
  return (
    <div ref={containerRef} className="flex items-center sm:relative" onBlur={(event) => {
      if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false);
    }}>
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls="notification-preview"
        onClick={() => { loadPreview(); setOpen((value) => !value); }}
        aria-label={label}
        title={label}
        // A plain icon, no ring: the bell only needs to be findable, not prominent.
        className={`relative inline-flex h-9 w-9 items-center justify-center rounded-full hover:bg-zk-chip ${linkFocus} ${active ? "text-zk-accent" : "text-zk-text"}`}
      >
        <EnvelopeIcon />
        {total > 0 ? (
          <span
            aria-hidden="true"
            className="absolute -right-1 -top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full border-2 border-zk-surface bg-electric-blue-strong px-1 text-[11px] font-bold text-white"
          >
            {total > 99 ? "99+" : total}
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          ref={panelRef}
          id="notification-preview"
          role="region"
          aria-label="Recent notifications"
          tabIndex={-1}
          className="absolute right-4 top-full z-50 mt-2 w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-zk-border bg-zk-surface text-zk-text shadow-xl focus:outline-none sm:right-0"
        >
          <h2 className="border-b border-zk-border px-4 py-3 text-sm font-semibold">Notifications</h2>
          {pendingEscalations > 0 ? (
            <Link href="/inbox?tab=escalations" onClick={() => setOpen(false)} className={`block border-b border-zk-border bg-zk-warn-bg px-4 py-2.5 text-sm font-semibold text-zk-warn-fg hover:brightness-95 ${linkFocus}`}>
              {pendingEscalations} escalation{pendingEscalations === 1 ? "" : "s"} waiting on you
            </Link>
          ) : null}
          <div className="max-h-[min(26rem,calc(100dvh-11rem))] overflow-y-auto overscroll-contain">
            {failed ? (
              <div className="p-4 text-sm">
                <p role="alert">Could not load notifications.</p>
                <button type="button" className={`mt-2 text-zk-accent hover:underline ${linkFocus}`} onClick={() => { loadPreview(); setAttempt((value) => value + 1); }}>Try again</button>
              </div>
            ) : notifications === null ? (
              <p role="status" className="p-4 text-sm text-zk-muted">Loading notifications...</p>
            ) : notifications.length === 0 ? (
              <p role="status" className="p-4 text-sm text-zk-muted">No notifications yet.</p>
            ) : (
              <ul className="divide-y divide-zk-divider">
                {notifications.map((notification) => (
                  <li key={notification.id}>
                    {/* Plain links avoid prefetching the route that marks an alert read. */}
                    <a href={`${BASE_PATH}/inbox/notifications/${notification.id}`} className={`flex items-start gap-3 px-4 py-3 text-sm hover:bg-zk-chip ${linkFocus} ${!notification.readAt ? "bg-zk-tint" : ""}`}>
                      <span aria-hidden="true" className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${!notification.readAt ? "bg-electric-blue" : "bg-transparent"}`} />
                      <span className="min-w-0 flex-1">
                        <span className={`block break-words ${!notification.readAt ? "font-medium text-zk-text" : "text-zk-text2"}`}>
                          {!notification.readAt ? <span className="sr-only">Unread: </span> : null}
                          {notification.title}
                        </span>
                        <LocalTime date={notification.createdAt} className="mt-1 block text-xs text-zk-muted" />
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <Link href="/inbox" onClick={() => setOpen(false)} className={`block border-t border-zk-border px-4 py-3 text-sm font-medium text-zk-accent hover:bg-zk-chip ${linkFocus}`}>Open inbox</Link>
        </div>
      ) : null}
    </div>
  );
}



export function AppHeader({
  userName,
  userImage,
  role,
  isRealSuperAdmin,
  isRealAdmin,
  unreadCount = 0,
  pendingEscalationsCount = 0,
  userId,
  organisationOptions = [],
  externalProjects = [],
  activeOrganisationId = null,
  organisationRole = null,
  reportFormUrl,
  defaultProjectSlug = null,
  earned = null,
  earningsOrganisationId = null,
  version,
}: {
  /** The running version (package version), shown with Cookie settings at the foot of the account menu. */
  version?: string;
  /** Earnings (#earnings): what the person earned in the workspace they're in, shown with Withdraw on every page; null when unknown. */
  earned?: number | null;
  /** The workspace the $ and Withdraw are for (#earnings): the one the person is in. */
  earningsOrganisationId?: string | null;
  /** The first project in the current organisation, for pages whose URL names none yet. */
  defaultProjectSlug?: ProjectRef | null;
  userName?: string | null;
  userImage?: string | null;
  role?: AppRole | null;
  isRealSuperAdmin?: boolean;
  isRealAdmin?: boolean;
  unreadCount?: number;
  pendingEscalationsCount?: number;
  userId?: string | null;
  organisationOptions?: OrganisationOption[];
  externalProjects?: ExternalProjectChoice[];
  activeOrganisationId?: string | null;
  /** The person's role in the organisation they are in, for the role tooltip in the account menu. */
  organisationRole?: OrganisationRole | null;
  reportFormUrl?: string;
}) {
  const pathname = usePathname();
  const projectSlug = useProjectRef() ?? defaultProjectSlug;
  const [accountOpen, setAccountOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);
  const accountButtonRef = useRef<HTMLButtonElement>(null);
  const closeAccount = () => setAccountOpen(false);
  useDismiss(accountOpen, closeAccount, accountRef, accountButtonRef);

  const [lastPath, setLastPath] = useState(pathname);
  if (pathname !== lastPath) {
    setLastPath(pathname);
    setAccountOpen(false);
  }

  const realRole = realRoleOf({ isRealSuperAdmin, isRealAdmin });
  // The workspace the header $ is for, named so the amount is never read as the total (#862).
  const activeOrganisationName = organisationOptions.find((organisation) => organisation.id === activeOrganisationId)?.name ?? null;
  const roleAccess = roleAccessFor(organisationRole, realRole);
  // There is no request form yet: the members page names the admins who can change a role.
  const requestAccessHref = projectSlug ? orgPath(projectSlug, "members") : "/organisations";
  const earningsWorkspaceName = organisationOptions.find((organisation) => organisation.id === earningsOrganisationId)?.name ?? null;

  return (
    // Sticky only from lg: on phones and tablets the toolbar wraps onto rows,
    // and a header that tall pinned to the top covers the page under it.
    <header className="relative z-40 border-b border-zk-border bg-zk-surface shadow-[0_1px_3px_rgba(0,0,0,0.04)] lg:sticky lg:top-0">
      <div className={`${PAGE_CONTAINER_CLASS} flex flex-wrap items-center gap-x-3 gap-y-2 py-3 max-sm:flex-nowrap max-sm:gap-x-2 max-sm:py-2 sm:px-6`}>
        {/* Below lg the nav lives in the bottom strip, leaving one row here.
            The logo (the mark alone) is the way to the Dashboard. */}
        <div className="flex min-w-0 items-center gap-2">
          <Link href={projectSlug ? ideasPath(projectSlug) : "/home"} aria-label="Ziki" className={`flex shrink-0 items-center gap-2 rounded-full ${linkFocus}`}>
            {/* The mark alone; the link's name says Ziki. */}
            <ZikiMark className="h-8 w-auto text-zk-text max-sm:h-7" />
          </Link>
          <span aria-hidden="true" className="h-[18px] w-px shrink-0 bg-zk-border max-sm:hidden" />
          <OrganisationSwitcher
            organisationOptions={organisationOptions}
            externalProjects={externalProjects}
            activeOrganisationId={activeOrganisationId}
            tone="bar"
            className="min-w-0"
          />
        </div>

        <TopNav pathname={pathname} projectSlug={projectSlug} />

        {/* Phones: one row. These controls never wrap or shrink; the workspace
            name on the left narrows (down to its badge) instead. Tablets: min-w-0
            lets the group narrow and its flex-wrap break the chips onto rows (no
            sideways scroll at 768px). From lg up it keeps shrink-0. */}
        <div className={`ml-auto flex min-w-0 items-center justify-end gap-2 max-sm:shrink-0 max-sm:flex-nowrap max-sm:gap-1.5 lg:shrink-0 flex-wrap`}>
          {earned !== null ? (
            // Earnings (#earnings), on every page: the amount opens Your earnings; Withdraw opens a window over the page.
            <div className="inline-flex h-10 shrink-0 items-center gap-1 rounded-full border border-zk-border bg-zk-surface p-1">
              <Link
                href={projectSlug ? `/earnings?in=${projectSlug}` : "/earnings"}
                aria-current={isNavItemActive(pathname, "/earnings") ? "page" : undefined}
                title={earningsWorkspaceName ? `Earned in ${earningsWorkspaceName}. Your earnings adds up every workspace.` : undefined}
                className={`rounded-full px-2.5 py-1 text-sm font-bold tabular-nums text-zk-text hover:bg-zk-chip ${linkFocus}`}
              >
                {formatZ(earned)}
                <span className="sr-only"> earned{earningsWorkspaceName ? ` in ${earningsWorkspaceName}` : ""}: Your earnings</span>
              </Link>
              <WithdrawWindow earned={earned} organisationId={earningsOrganisationId} className={`inline-flex items-center justify-center rounded-full bg-electric-blue-strong px-3 py-1.5 text-xs font-bold text-white hover:bg-[#2552af] max-sm:h-8 max-sm:w-8 max-sm:p-0 ${linkFocus}`}>
                {/* Phones: a wallet icon; tablets and up: the word. Either way it is called Withdraw. */}
                <svg viewBox="0 0 24 24" className="h-[18px] w-[18px] sm:hidden" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h14a2 2 0 0 1 2 2v3" />
                  <path d="M3 5v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3" />
                  <path d="M21 12h-4a2 2 0 0 0 0 4h4z" />
                </svg>
                <span className="max-sm:sr-only">Withdraw</span>
              </WithdrawWindow>
            </div>
          ) : null}

          <div ref={accountRef} className="relative">
            <button
              ref={accountButtonRef}
              type="button"
              aria-haspopup="menu"
              aria-expanded={accountOpen}
              aria-controls="account-menu"
              onClick={() => setAccountOpen((open) => !open)}
              className={`inline-flex h-11 max-w-full items-center gap-2 rounded-full border border-zk-border bg-zk-surface py-[5px] pl-[5px] pr-3 text-zk-text hover:bg-zk-chip max-sm:h-auto max-sm:border-0 max-sm:p-0 ${linkFocus}`}
            >
              <span className="sr-only">Account menu for </span>
              <Avatar name={userName} image={userImage} size="md" variant="solid" />
              {/* Phones show just the avatar; the name is still read out. */}
              <span className="max-w-40 truncate text-[13px] font-medium max-sm:sr-only">{userName}</span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" className="shrink-0 text-zk-muted max-sm:hidden">
                <path d={accountOpen ? "m18 15-6-6-6 6" : "m6 9 6 6 6-6"} />
              </svg>
            </button>

            {accountOpen ? (
              <div
                id="account-menu"
                role="menu"
                aria-label="Account"
                className="absolute right-0 top-[54px] z-50 flex w-[300px] max-w-[calc(100vw-2rem)] origin-top-right flex-col gap-1 rounded-[20px] border border-zk-border bg-zk-surface p-2 shadow-[0_24px_56px_rgba(11,23,51,0.22)] motion-safe:animate-[header-pop_120ms_ease-out]"
              >
                <AccountSummary
                  userName={userName}
                  userImage={userImage}
                  realRole={realRole}
                  roleAccess={roleAccess}
                  organisationName={activeOrganisationName}
                  requestAccessHref={requestAccessHref}
                />
                <AccountThemeSelector />
                <div className="mx-2 h-px bg-zk-divider" />
                {/* What your agents are doing and what needs you (#849). */}
                <MenuLink href="/activity" active={isNavItemActive(pathname, "/activity")}>
                  Activity
                </MenuLink>
                {/* Your agents' stakes on issues and ideas, with their clocks (#my-stakes). */}
                <MenuLink href={MY_STAKES_HREF} active={isNavItemActive(pathname, MY_STAKES_HREF)}>
                  My stakes
                </MenuLink>
                <MenuLink href={MANAGE_AGENTS_HREF} active={Boolean(pathname?.startsWith(MANAGE_AGENTS_HREF))}>
                  Manage agents
                </MenuLink>
                {/* Ziki Coins (#ziki-coins): buy Ziks, fund issues, set up payouts and withdraw. */}
                <MenuLink href="/coins" active={pathname === "/coins" || pathname === "/coins/"}>
                  Ziks
                </MenuLink>
                <MenuLink href="/settings" active={isNavItemActive(pathname, "/settings")}>
                  Settings
                </MenuLink>
                <MenuLink href="/docs" active={isNavItemActive(pathname, "/docs")}>
                  Documentation
                </MenuLink>
                {/* The skills library is public, but signed-in people look for it here (GAP 1). */}
                <MenuLink href="/skills" active={isNavItemActive(pathname, "/skills")}>
                  Skills library
                </MenuLink>
                {/* Site staff only: users, organisations, rewards and the Ziks money page (#ziki-coins). */}
                {isRealSuperAdmin ? (
                  <MenuLink href={SITE_ADMIN_HREF} active={isNavItemActive(pathname, SITE_ADMIN_HREF)}>
                    Site admin
                  </MenuLink>
                ) : null}
                <div className="mx-2 h-px bg-zk-divider" />
                <SignOutButton
                  userId={userId}
                  className={`${linkFocus} font-bold text-zk-bad-fg hover:bg-zk-bad-soft`}
                />
                {/* On every page, with or without the agents bar: Cookie settings and the version, small and grey.
                    Cookie settings opens the consent banner, so the menu steps aside first. */}
                <div className="flex items-center justify-between gap-3 px-3 pb-1 pt-1 text-[11px] text-zk-muted">
                  <CookieSettingsLink onOpen={closeAccount} className={`rounded underline hover:text-zk-text ${linkFocus}`} />
                  {version ? (
                    <VersionCredits version={version} className={`rounded font-mono hover:text-zk-text hover:underline ${linkFocus}`} />
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>

          {/* Escalations, as an envelope, then the bell last. */}
          <InboxEnvelope key={`${userId}:${activeOrganisationId}:${pathname}`} unreadCount={unreadCount} pendingEscalations={pendingEscalationsCount} active={isNavItemActive(pathname, "/inbox")} />
        </div>
      </div>
    </header>
  );
}

function AccountSummary({
  userName,
  userImage,
  realRole,
  roleAccess,
  organisationName,
  requestAccessHref,
}: {
  userName?: string | null;
  userImage?: string | null;
  realRole: AppRole;
  /** What the role can do, when there is a summary for it; the badge then explains itself on hover. */
  roleAccess: RoleAccess | null;
  organisationName: string | null;
  requestAccessHref: string;
}) {
  const roleLabel = realRole === "user" ? "Member" : roleViewLabels[realRole];
  return (
    // Relative: the role tooltip is positioned against this row, so it is as wide as the menu.
    <div className="relative flex items-center gap-3 rounded-[14px] bg-zk-tint p-3">
      <Avatar name={userName} image={userImage} size="lg" variant="solid" />
      <div className="min-w-0">
        <p className="truncate text-base font-extrabold text-zk-text">{userName}</p>
        <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
          {roleAccess ? (
            <RoleAccessBadge label={roleLabel} access={roleAccess} organisationName={organisationName} requestHref={requestAccessHref} />
          ) : (
            <span className="rounded-full bg-zk-surface px-2 py-0.5 font-bold text-zk-text2">{roleLabel}</span>
          )}
        </p>
      </div>
    </div>
  );
}

function MenuLink({
  href,
  active = false,
  children,
}: {
  href: string;
  active?: boolean;
  children: React.ReactNode;
}) {
  const external = href.startsWith("http");
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
      className={`flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm font-semibold ${linkFocus} ${
        active ? "bg-zk-tint text-zk-accent" : "text-zk-text hover:bg-zk-chip"
      }`}
    >
      {children}
    </Link>
  );
}
