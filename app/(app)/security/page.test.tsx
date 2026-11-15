import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { currentOrganisationAccess } from "@/lib/organisation-access";
import SecurityPage from "./page";
import SecuritySettingsPage from "./settings/page";

vi.mock("@/app/actions/security-assistant", () => ({ talkToSecurityAssistant: vi.fn() }));
// The page reads the session to tell a signed-in person from a visitor (the public page); the real auth cannot load here.
vi.mock("@/auth", () => ({ auth: vi.fn(async () => ({ user: { id: "user_test" } })) }));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/auth-helpers", () => ({
  requireUser: vi.fn().mockResolvedValue({ id: "user_test_admin", role: "admin" }),
}));

vi.mock("@/lib/organisation-access", () => ({
  currentOrganisationAccess: vi.fn().mockResolvedValue({
    organisationId: "org_123",
    admin: true,
  }),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    securityCheck: { findMany: vi.fn().mockResolvedValue([]) },
    membership: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
    securityCheckItem: { count: vi.fn().mockResolvedValue(0) },
    agentActivation: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "act_1",
          level: "senior",
          securityCleared: true,
          agent: { id: "ag_1", name: "SecurityAgent", owner: { name: "Alice" } },
        },
      ]),
    },
  },
}));

vi.mock("@/lib/security-dashboard", () => ({
  loadSecurityDashboard: vi.fn().mockResolvedValue({
    open: [
      {
        id: "find_1",
        ref: "#2828",
        title: "Confidential RCE Vulnerability",
        severity: "critical",
        stage: "In progress",
        days: 2,
        href: "/issues/2828",
        project: "Web",
      },
      {
        id: "find_2",
        ref: "#2829",
        title: "Information Disclosure Bug",
        severity: "low",
        stage: "Open",
        days: 5,
        href: "/issues/2829",
        project: "Desktop",
      },
    ],
    openBySeverity: {
      critical: 1,
      high: 0,
      medium: 0,
      low: 1,
    },
    disclosed: [
      {
        id: "find_3",
        ref: "#2800",
        title: "SQL Injection in User Search",
        severity: "critical",
        stage: "Live",
        days: 3,
        href: "/issues/2800",
        project: "Web",
        disclosedAt: new Date("2026-11-01"),
        fixedLive: true,
      },
    ],
    medianDaysToDisclosure: 3,
    projects: [{ name: "Web", ref: "web" }],
  }),
}));

vi.mock("@/components/security-finding-panel", () => ({
  SeverityChip: ({ severity }: { severity: string }) => (
    <span>{severity.charAt(0).toUpperCase() + severity.slice(1)}</span>
  ),
}));

vi.mock("@/components/security-finding-controls", () => ({
  AgentClearanceToggle: () => <button>Clearance Toggle</button>,
}));

vi.mock("@/components/local-time", () => ({
  LocalTime: ({ date }: { date?: Date | string | null }) => <time>{String(date)}</time>,
}));

describe("SecurityPage (/security)", () => {
  it("renders the security dashboard with posture metrics and stats", async () => {
    const page = await SecurityPage({});
    expect(page).toBeDefined();
    expect(React.isValidElement(page)).toBe(true);
  });

  it("filters findings when severity query parameter is provided", async () => {
    const pageWithFilter = await SecurityPage({
      searchParams: Promise.resolve({ severity: "critical" }),
    });
    expect(pageWithFilter).toBeDefined();
    expect(React.isValidElement(pageWithFilter)).toBe(true);
  });

  it("shows matching open and disclosed findings while filtering out other severities", async () => {
    const page = await SecurityPage({
      searchParams: Promise.resolve({ severity: "critical" }),
    });
    const html = renderToStaticMarkup(page);

    expect(html).toContain('href="/issues/2828"');
    expect(html).toContain('href="/issues/2800"');
    expect(html).not.toContain('href="/issues/2829"');
  });

  it("opens on Your sites with the box, beside Your work, and Findings one icon away (#security-checks)", async () => {
    const markup = renderToStaticMarkup(await SecurityPage({}));

    expect(markup).toContain("What do you want to secure?");
    expect(markup).toContain('name="target"');
    expect(markup).toContain('href="/security?view=findings"');
    expect(markup).toContain('href="/security/work"');
    expect(markup).not.toContain('href="/security/activity"');
    expect(markup).toContain(">Assets<");
    expect(markup).not.toContain("Open findings");
    expect(markup).not.toContain("Apply filters");
  });

  it("shows the findings dashboard on the Findings view, without the box", async () => {
    const markup = renderToStaticMarkup(await SecurityPage({ searchParams: Promise.resolve({ view: "findings" }) }));

    expect(markup).toContain("Open findings");
    expect(markup).toContain("Apply filters");
    expect(markup).toContain('name="view" value="findings"');
    expect(markup).not.toContain("Add asset");
  });

  it("sends a member who owns no workspace straight to creating one, instead of to Your work", async () => {
    vi.mocked(currentOrganisationAccess).mockResolvedValueOnce({
      organisationId: "org_123",
      organisationName: "Workspace",
      organisationSlug: "workspace",
      membershipRole: "member",
      admin: false,
    });

    // With a scanned site, straight to creating a workspace; it comes back here with the site.
    await expect(SecurityPage({ searchParams: Promise.resolve({ target: "yourshop.com" }) })).rejects.toMatchObject({
      digest: expect.stringContaining(`/organisations?next=${encodeURIComponent("/security?target=yourshop.com")}`),
    });
  });

  it("asks which workspace a scanned site goes in when you own or run more than one", async () => {
    const { prisma } = await import("@/lib/prisma");
    vi.mocked(prisma.membership.findMany).mockResolvedValueOnce([
      { organisation: { id: "org_a", name: "Shop A" } },
      { organisation: { id: "org_b", name: "Shop B" } },
    ] as never);
    const markup = renderToStaticMarkup(await SecurityPage({ searchParams: Promise.resolve({ target: "yourshop.com" }) }));
    expect(markup).toContain("Which workspace should yourshop.com go in?");
    expect(markup).toContain("Shop A");
    expect(markup).toContain("Shop B");
    expect(markup).toContain(encodeURIComponent("/security?target=yourshop.com&picked=1"));
    expect(markup).toContain("Create a new workspace");
  });

  it("sends a plain member with no scanned site to Your work, as before", async () => {
    vi.mocked(currentOrganisationAccess).mockResolvedValueOnce({
      organisationId: "org_123",
      organisationName: "Workspace",
      organisationSlug: "workspace",
      membershipRole: "member",
      admin: false,
    });

    await expect(SecurityPage({})).rejects.toMatchObject({ digest: expect.stringContaining("/security/work") });
  });

  it("keeps a scanned repo's full GitHub address through the redirect, so its scan starts after", async () => {
    vi.mocked(currentOrganisationAccess).mockResolvedValueOnce({
      organisationId: "org_123",
      organisationName: "Workspace",
      organisationSlug: "workspace",
      membershipRole: "member",
      admin: false,
    });

    await expect(SecurityPage({ searchParams: Promise.resolve({ target: "github.com/settle/app" }) })).rejects.toMatchObject({
      digest: expect.stringContaining(`/organisations?next=${encodeURIComponent(`/security?target=${encodeURIComponent("github.com/settle/app")}`)}`),
    });
  });

  it("opens the workspace a member owns elsewhere, keeping the scanned site", async () => {
    vi.mocked(currentOrganisationAccess).mockResolvedValueOnce({
      organisationId: "org_123",
      organisationName: "Workspace",
      organisationSlug: "workspace",
      membershipRole: "member",
      admin: false,
    });
    const { prisma } = await import("@/lib/prisma");
    vi.mocked(prisma.membership.findFirst).mockResolvedValueOnce({ organisationId: "org_own" } as never);

    await expect(SecurityPage({ searchParams: Promise.resolve({ target: "yourshop.com" }) })).rejects.toMatchObject({
      digest: expect.stringContaining(`/organisations/open?organisation=org_own&next=${encodeURIComponent("/security?target=yourshop.com")}`),
    });
  });

  it("renders the Security settings gear link with its accessible name", async () => {
    const markup = renderToStaticMarkup(await SecurityPage({}));

    expect(markup).toContain('href="/security/settings"');
    expect(markup).toContain('aria-label="Security settings"');
    expect(markup).toContain('title="Security settings"');
  });

  it("renders the read-only settings cards and existing severity and stage guidance", async () => {
    const markup = renderToStaticMarkup(await SecuritySettingsPage());

    for (const text of [
      "Breadcrumb",
      "Security",
      "Settings",
      "Security settings",
      "Back to findings",
      "Only workspace owners and admins can change security settings.",
      "Who can see a finding",
      "Severity guide",
      "Critical",
      "Anyone can take over accounts",
      "Agents cleared for security work",
      "View agent clearance on Security",
      "How findings move",
      "Reported",
      "Open",
      "In progress",
      "Done",
      "Merge",
      "Live",
      "Closed",
      "Rejected",
      "Archived",
    ]) {
      expect(markup).toContain(text);
    }
    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain('href="/security?view=findings#agents-heading"');
  });

  it("shows only the no-workspace message when the user has no workspace", async () => {
    vi.mocked(currentOrganisationAccess).mockResolvedValueOnce({
      organisationId: null,
      organisationName: null,
      organisationSlug: null,
      membershipRole: null,
      admin: false,
    });

    const markup = renderToStaticMarkup(await SecuritySettingsPage());

    expect(markup).toContain("Join or create a workspace to report and track security findings.");
    expect(markup).not.toContain("Who can see a finding");
    expect(markup).not.toContain("Severity guide");
    expect(markup).not.toContain("Agents cleared for security work");
  });

  it("does not load or reveal the agent list to a non-admin", async () => {
    vi.mocked(currentOrganisationAccess).mockResolvedValueOnce({
      organisationId: "org_123",
      organisationName: "Workspace",
      organisationSlug: "workspace",
      membershipRole: "member",
      admin: false,
    });

    const markup = renderToStaticMarkup(await SecuritySettingsPage());

    expect(markup).toContain("Only workspace owners and admins can see or change agent clearance.");
    expect(markup).toContain('href="/security"');
    expect(markup).not.toContain("SecurityAgent");
    expect(markup).not.toContain("Clearance Toggle");
  });

  it("shows a clear load error without exposing access lookup details", async () => {
    vi.mocked(currentOrganisationAccess).mockRejectedValueOnce(
      new Error("private database connection detail"),
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const markup = renderToStaticMarkup(await SecuritySettingsPage());

      expect(markup).toContain("Security settings could not be loaded");
      expect(markup).toContain("Something went wrong on our side.");
      expect(markup).toContain("report it with this reference");
      expect(markup).not.toContain("private database connection detail");
    } finally {
      errorSpy.mockRestore();
    }
  });
});
