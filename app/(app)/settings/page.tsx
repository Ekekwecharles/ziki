import "./settings-design.css";
import { Suspense } from "react";
import { headers } from "next/headers";
import { auth } from "@/auth";
import { SettingsNav } from "@/components/settings-nav";
import { SETTINGS_SECTIONS, type SettingsSectionId } from "@/lib/settings-sections";
import { ThemeSettings } from "@/components/theme-settings";
import { parseTheme } from "@/lib/theme";
import Link from "next/link";
import { requireUser } from "@/lib/auth-helpers";
import { firstProjectRefFor } from "@/lib/project-route";
import { orgPath } from "@/lib/project-paths";
import { currentOrganisationAccess } from "@/lib/organisation-access";
import { prisma } from "@/lib/prisma";
import { NotificationSettings } from "@/components/notification-settings";
import { WalletAddressForm } from "@/components/wallet-address-form";
import { KeyboardShortcutSettings } from "@/components/keyboard-shortcut-settings";
import { isAgentPlatformEnabled } from "@/lib/feature-flags";
import { AccountDataSettings } from "@/components/account-data-settings";
import { ActiveSessions } from "@/components/active-sessions";
import { DisplayNameForm } from "@/components/display-name-form";
import { LoginHistory } from "@/components/login-history";
import { ProfileAvatarUpload } from "@/components/profile-avatar-upload";
import { loadAccountSecurityActivity } from "@/lib/user-sessions";

/* Distinct browser-tab title; the root layout appends the site name. */
export const metadata = { title: "Settings" };

function parseSection(value: string | string[] | undefined): SettingsSectionId {
  const raw = Array.isArray(value) ? value[0] : value;
  return SETTINGS_SECTIONS.find((item) => item.id === raw)?.id ?? "account";
}

const card =
  "rounded-[20px] border border-zk-border bg-zk-surface p-6 flex flex-col gap-4";

function LinkRow({ href, label, external }: { href: string; label: string; external?: boolean }) {
  const className =
    "mt-1 flex min-h-10 items-center justify-between rounded-[10px] bg-zk-chip px-2.5 text-sm font-semibold text-zk-text transition hover:bg-zk-tint";
  if (external) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
        {label}
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="text-zk-muted">
          <path d="M7 17 17 7M8 7h9v9" />
        </svg>
      </a>
    );
  }
  return (
    <Link href={href} className={className}>
      {label}
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="text-zk-muted">
        <path d="M5 12h14M12 5l7 7-7 7" />
      </svg>
    </Link>
  );
}

/** The settings index: themed appearance, sign-in security, and links into the nested settings surfaces. */
export default async function SettingsPage(props: {
  searchParams?: Promise<{ section?: string | string[] | undefined }>;
}) {
  const user = await requireUser();
  const projectSlug = await firstProjectRefFor(user.id);
  const params = props.searchParams ? await props.searchParams : {};
  const section = parseSection(params.section);
  const agentsEnabled = isAgentPlatformEnabled();

  let settings: {
    name?: string | null;
    email?: string | null;
    theme?: string | null;
    walletAddress?: string | null;
    emailNotifications?: boolean;
    notifyMentions?: boolean;
    notifyAssignments?: boolean;
    notifyStatusChanges?: boolean;
    keyboardShortcuts?: boolean;
    sessionVersion?: number;
  } | null = null;

  try {
    settings = await prisma.user.findUnique({
      where: { id: user.id },
      select: {
        name: true,
        email: true,
        theme: true,
        walletAddress: true,
        emailNotifications: true,
        notifyMentions: true,
        notifyAssignments: true,
        notifyStatusChanges: true,
        keyboardShortcuts: true,
        sessionVersion: true,
      },
    });
  } catch (error) {
    console.error("[settings] full settings query failed, falling back to minimal fields:", error);
    try {
      settings = await prisma.user.findUnique({
        where: { id: user.id },
        select: {
          name: true,
          email: true,
          sessionVersion: true,
        },
      });
    } catch (fallbackError) {
      console.error("[settings] fallback user query failed:", fallbackError);
      settings = {
        name: user.name ?? null,
        email: user.email ?? null,
      };
    }
  }

  const displayName = settings?.name ?? user.name ?? "";
  const orgName = projectSlug
    ? (await prisma.organisation.findUnique({ where: { slug: projectSlug.split("/")[0] }, select: { name: true } }))?.name ?? null
    : null;

  const securityActivity =
    section === "account"
      ? await loadAccountSecurityActivity({
          userId: user.id,
          sessionId: (await auth().catch(() => null))?.user?.sessionId,
          sessionVersion: settings?.sessionVersion ?? 0,
          headers: await headers().catch(() => null),
        })
      : null;

  return (
    <div className="settings-page settings-design mx-auto flex w-full max-w-5xl flex-col gap-6 pb-10">
      <div className="flex flex-col gap-2.5">
        <Link
          href="/home"
          className="inline-flex min-h-8 items-center gap-1.5 self-start text-sm font-semibold text-zk-accent hover:underline"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
          Back to issues
        </Link>
        <h1 className="m-0 text-[28px] font-extrabold tracking-[-0.02em] text-zk-text">Settings</h1>
        <p className="m-0 text-sm text-zk-muted">Your account, finance, preferences and agents, and your organisation&apos;s settings.</p>
      </div>

      <div className="settings-layout">
        {/* Yours, then your organisation's: one sidebar for all settings. */}
        <Suspense fallback={<nav aria-label="Settings sections" className="settings-navigation" />}>
          <SettingsNav orgRef={projectSlug} orgName={orgName} owner={(await currentOrganisationAccess(user.id, user.role)).membershipRole === "owner"} />
        </Suspense>

        <div className="settings-content flex min-w-0 flex-col gap-5">
          {section === "account" ? (
            <div className="flex flex-col gap-4">
              <section className={card}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-col gap-1">
                    <h2 className="m-0 text-lg font-bold text-zk-text">Profile</h2>
                    <span className="text-[13px] text-zk-muted">How you appear to everyone in the organisation.</span>
                  </div>
                  <Link
                    href={`/users/${user.id}`}
                    className="inline-flex h-[38px] items-center gap-1.5 rounded-full border border-zk-border px-3.5 text-[13px] font-bold text-zk-text hover:bg-zk-chip"
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                    See how others see you
                  </Link>
                </div>
                {/* The one place to manage your profile: picture, display name, and the email you sign in with. */}
                <ProfileAvatarUpload initialImage={user.image} name={displayName} />
                <div className="border-t border-zk-divider pt-4">
                  <DisplayNameForm initialName={displayName} initialImage={user.image} showAvatar={false} />
                </div>
                <div className="space-y-1 border-t border-zk-divider pt-4">
                  <p className="text-sm font-bold text-zk-text">Email</p>
                  <p className="break-words text-sm text-zk-text2">{settings?.email ?? user.email}</p>
                  <p className="text-xs text-zk-muted">Your sign-in email cannot be changed here.</p>
                </div>
              </section>

              <section className={`${card} flex-row flex-wrap items-center justify-between gap-4`}>
                <div className="flex items-center gap-3.5">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[14px] bg-zk-tint text-zk-accent">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                    </svg>
                  </span>
                  <div className="flex flex-col gap-1">
                    <h2 className="m-0 text-lg font-bold text-zk-text">Two-factor sign-in</h2>
                    <span className="text-[13px] text-zk-muted">
                      Protect your account with a second step at sign-in.
                    </span>
                  </div>
                </div>
                <Link
                  href="/settings/security"
                  className="inline-flex h-[42px] items-center rounded-full bg-electric-blue-strong px-[18px] text-sm font-bold text-white hover:brightness-105"
                >
                  Set up
                </Link>
              </section>

              {securityActivity ? (
                <>
                  <ActiveSessions initialSessions={securityActivity.sessions} />
                  <LoginHistory
                    items={securityActivity.history}
                    totalCount={securityActivity.historyTotal}
                  />
                </>
              ) : null}
            </div>
          ) : null}

          {section === "finance" ? (
            <div className="flex flex-col gap-4">
              <section className={card}>
                <WalletAddressForm initialAddress={settings?.walletAddress ?? ""} />
              </section>
            </div>
          ) : null}

          {section === "prefs" ? (
            <div className="flex flex-col gap-4">
              <section className={card}>
                <div className="flex flex-col gap-1">
                  <h2 className="m-0 text-lg font-bold text-zk-text">Appearance</h2>
                  <span className="text-[13px] text-zk-muted">
                    Saved to your account, so it follows you to every device.
                  </span>
                </div>
                <ThemeSettings initialTheme={parseTheme(settings?.theme)} />
              </section>

              <section className={card}>
                <div className="flex flex-col gap-1">
                  <h2 className="m-0 text-lg font-bold text-zk-text">Email notifications</h2>
                  <span className="text-[13px] text-zk-muted">
                    Sent to <strong className="font-bold text-zk-text">{settings?.email ?? user.email}</strong>.
                    You&apos;re never emailed about your own changes.
                  </span>
                </div>
                <NotificationSettings
                  initialEnabled={settings?.emailNotifications ?? true}
                  initialPrefs={{
                    notifyMentions: settings?.notifyMentions ?? true,
                    notifyAssignments: settings?.notifyAssignments ?? true,
                    notifyStatusChanges: settings?.notifyStatusChanges ?? true,
                  }}
                />
              </section>

              <section className={card}>
                <KeyboardShortcutSettings initialEnabled={settings?.keyboardShortcuts ?? true} />
              </section>
            </div>
          ) : null}

          {section === "agents" ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-[repeat(auto-fit,minmax(280px,1fr))]">
              {agentsEnabled ? (
                <section className={`${card} gap-3.5`}>
                  <div className="flex items-center gap-3">
                    <span className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-[14px] bg-zk-tint text-zk-accent">
                      <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M4 8h16v12H4zM12 4v4M9 14h.01M15 14h.01" />
                      </svg>
                    </span>
                    <h2 className="m-0 text-[17px] font-bold text-zk-text">Agents</h2>
                  </div>
                  <p className="m-0 text-[13px] leading-relaxed text-zk-muted">
                    Register the AI agents that work issues for you, and see your team&apos;s.
                  </p>
                  <div className="flex flex-col gap-0.5">
                    <LinkRow href="/settings/agents/connect" label="Connect your agent" />
                    <LinkRow href="/settings/agents/pair" label="Approve a pairing code" />
                    <LinkRow href="/agents/mine" label="Manage agents" />
                    <LinkRow href="/settings/connect" label="Create agent" />
                    <LinkRow href="/settings/webhooks" label="Webhooks" />
                    <LinkRow href="/settings/audit" label="Agent audit log" />
                  </div>
                </section>
              ) : null}

              <section className={`${card} gap-3.5`}>
                <div className="flex items-center gap-3">
                  <span className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-[14px] bg-zk-tint text-zk-accent">
                    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" />
                    </svg>
                  </span>
                  <h2 className="m-0 text-[17px] font-bold text-zk-text">Team</h2>
                </div>
                <p className="m-0 text-[13px] leading-relaxed text-zk-muted">
                  Organisation members and their active agents.
                </p>
                <div className="flex flex-col gap-0.5">
                  {projectSlug ? <LinkRow href={orgPath(projectSlug, "members")} label="Organisation members" /> : null}
                  <LinkRow href="/workers" label="View ranking" />
                </div>
              </section>

              <section className={`${card} gap-3.5`}>
                <div className="flex items-center gap-3">
                  <span className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-[14px] bg-zk-tint text-zk-accent">
                    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="m16 18 6-6-6-6M8 6l-6 6 6 6" />
                    </svg>
                  </span>
                  <h2 className="m-0 text-[17px] font-bold text-zk-text">API &amp; integrations</h2>
                </div>
                <p className="m-0 text-[13px] leading-relaxed text-zk-muted">
                  Developer documentation, cURL references and machine-readable specs for AI agents and automated tools.
                </p>
                <div className="flex flex-col gap-0.5">
                  {projectSlug ? <LinkRow href={orgPath(projectSlug, "projects")} label="Project settings & workflows" /> : null}
                  <LinkRow href="/docs" label="API documentation" />
                  <LinkRow href="/llms.txt" label="AI specs (/llms.txt)" external />
                </div>
              </section>
            </div>
          ) : null}

          {section === "data" ? <AccountDataSettings /> : null}
        </div>
      </div>
    </div>
  );
}
