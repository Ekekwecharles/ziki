import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardFinding } from "@/lib/security-dashboard";
import {
  filterSecurityFindingsByStage,
  parseSecurityStageFilter,
  SecurityStageFilterBar,
} from "@/components/security-stage-filter";

const loadDashboard = vi.hoisted(() => vi.fn());
vi.mock("@/lib/security-dashboard", () => ({ loadSecurityDashboard: loadDashboard }));
// The page reads the session to tell a signed-in person from a visitor (the public page); the real auth cannot load here.
vi.mock("@/auth", () => ({ auth: vi.fn(async () => ({ user: { id: "user_test" } })) }));
vi.mock("@/lib/auth-helpers", () => ({
  requireUser: vi.fn(async () => ({ id: "member-1", role: "user" })),
}));
vi.mock("@/lib/organisation-access", () => ({
  currentOrganisationAccess: vi.fn(async () => ({ organisationId: "org-1", admin: false })),
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/components/security-finding-panel", () => ({
  SeverityChip: ({ severity }: { severity: string }) => <span>{severity}</span>,
}));
vi.mock("@/components/security-finding-controls", () => ({ AgentClearanceToggle: () => null }));
vi.mock("@/components/local-time", () => ({ LocalTime: () => null }));

import SecurityPage from "@/app/(app)/security/page";

const findings = [
  { id: "reported", stage: "Waiting for verdicts", title: null, canView: false },
  { id: "open-1", stage: "Requires confirmation", title: null, canView: false },
  { id: "open-2", stage: "Open", title: "Visible finding", canView: true },
  { id: "progress", stage: "In progress", title: "Another visible finding", canView: true },
];

function makeFinding(id: string, stage: string, title: string | null): DashboardFinding {
  return {
    id,
    severity: "high",
    title,
    canView: title !== null,
    ref: `#${id}`,
    href: `/sample/project/${id}`,
    project: "Sample project",
    stage,
    reportedAt: new Date("2026-11-01T00:00:00Z"),
    days: 2,
    disclosedAt: null,
    fixedLive: false,
  };
}

function dashboard(open: DashboardFinding[]) {
  return {
    open,
    disclosed: [],
    openBySeverity: { critical: 0, high: open.length, medium: 0, low: 0 },
    medianDaysToFix: null,
    projects: [],
  };
}

beforeEach(() => {
  loadDashboard.mockResolvedValue(dashboard([]));
});

describe("security workflow-stage filters", () => {
  it("counts findings in each workflow group and keeps every zero-count stage visible", () => {
    const markup = renderToStaticMarkup(<SecurityStageFilterBar findings={[]} selected="all" />);

    expect(markup).toContain('aria-current="page"');
    for (const label of ["All", "Reported", "Open", "In progress", "Done", "Merge", "Live", "Closed", "Rejected", "Archived"]) {
      expect(markup).toContain(`>${label}<`);
    }
    expect((markup.match(/>0<\/span>/g) ?? []).length).toBe(10);
  });

  it("filters only the selected workflow group and leaves redacted details unchanged", () => {
    const filtered = filterSecurityFindingsByStage(findings, "open");

    expect(filtered.map((finding) => finding.id)).toEqual(["open-1", "open-2"]);
    expect(filtered[0].title).toBeNull();
    expect(filtered[0].canView).toBe(false);
  });

  it("counts each main workflow stage from its detailed finding stage", () => {
    const stagedFindings = [
      makeFinding("reported", "Reported", null),
      makeFinding("waiting", "Waiting for verdicts", null),
      makeFinding("confirm", "Requires confirmation", null),
      makeFinding("open", "Open", null),
      makeFinding("plan", "Plan review", null),
      makeFinding("progress", "In progress", null),
      makeFinding("review", "Requires review", null),
      makeFinding("accepted", "Accepted", null),
      makeFinding("merge-ready", "Ready to merge", null),
      makeFinding("merge-error", "Error", null),
      makeFinding("dev", "On dev", null),
      makeFinding("staging", "On staging", null),
      makeFinding("prod", "On prod", null),
      makeFinding("published", "Published", null),
      makeFinding("closed", "Closed", null),
      makeFinding("rejected", "Rejected", null),
      makeFinding("archived", "Archived", null),
    ];

    expect(filterSecurityFindingsByStage(stagedFindings, "reported")).toHaveLength(2);
    expect(filterSecurityFindingsByStage(stagedFindings, "open")).toHaveLength(2);
    expect(filterSecurityFindingsByStage(stagedFindings, "in-progress")).toHaveLength(2);
    expect(filterSecurityFindingsByStage(stagedFindings, "done")).toHaveLength(2);
    expect(filterSecurityFindingsByStage(stagedFindings, "merge")).toHaveLength(2);
    expect(filterSecurityFindingsByStage(stagedFindings, "live")).toHaveLength(4);
    expect(filterSecurityFindingsByStage(stagedFindings, "closed")).toHaveLength(1);
    expect(filterSecurityFindingsByStage(stagedFindings, "rejected")).toHaveLength(1);
    expect(filterSecurityFindingsByStage(stagedFindings, "archived")).toHaveLength(1);
  });

  it("uses the all view for unknown or repeated stage query values", () => {
    expect(parseSecurityStageFilter("unknown")).toBe("all");
    expect(parseSecurityStageFilter(["open", "done"])).toBe("all");
    expect(filterSecurityFindingsByStage(findings, parseSecurityStageFilter("unknown"))).toHaveLength(4);
  });

  it("renders reload-safe stage links, preserves severity, and marks the active stage", () => {
    const markup = renderToStaticMarkup(
      <SecurityStageFilterBar findings={findings} selected="open" severity="critical" />,
    );

    expect(markup).toContain('href="/security?view=findings&amp;stage=open&amp;severity=critical"');
    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain('aria-label="All: 4 open findings"');
    expect(markup).toContain('aria-label="Reported: 1 open finding"');
    expect(markup).toContain('aria-label="Open: 2 open findings"');
    expect(markup).toContain('aria-label="In progress: 1 open finding"');
    expect(markup).toContain('href="/security?view=findings&amp;stage=in-progress&amp;severity=critical"');
  });

  it("filters the loaded open table without revealing redacted finding details", async () => {
    loadDashboard.mockResolvedValueOnce(
      dashboard([
        makeFinding("12", "Requires confirmation", null),
        makeFinding("13", "Open", "Visible finding title"),
        makeFinding("14", "In progress", "Other workflow stage"),
      ]),
    );
    const markup = renderToStaticMarkup(
      await SecurityPage({ searchParams: Promise.resolve({ stage: "open" }) }),
    );

    expect(markup).toContain("Showing 2 of 3 open findings");
    expect(markup).toContain("#12");
    expect(markup).toContain("Visible finding title");
    expect(markup).not.toContain("Other workflow stage");
    expect(markup).not.toContain("REDACTED");
  });

  it("combines severity and stage filters and preserves the other filter in links", async () => {
    loadDashboard.mockResolvedValueOnce(
      dashboard([
        { ...makeFinding("critical-open", "Open", "Critical open finding"), severity: "critical" },
        { ...makeFinding("high-open", "Open", "High open finding"), severity: "high" },
        { ...makeFinding("critical-progress", "In progress", "Critical in progress"), severity: "critical" },
      ]),
    );
    const markup = renderToStaticMarkup(
      await SecurityPage({
        searchParams: Promise.resolve({ stage: "open", severity: "critical" }),
      }),
    );

    expect(markup).toContain("Showing 1 of 3 open findings");
    expect(markup).toContain("Critical open finding");
    expect(markup).not.toContain("High open finding");
    expect(markup).not.toContain("Critical in progress");
    expect(markup).toContain('href="/security?view=findings&amp;severity=high&amp;stage=open"');
    expect(markup).toContain('href="/security?view=findings&amp;stage=in-progress&amp;severity=critical"');
  });

  it("shows all findings for an invalid stage and keeps the bar visible with no findings", async () => {
    loadDashboard.mockResolvedValueOnce(
      dashboard([
        makeFinding("12", "Requires confirmation", null),
        makeFinding("14", "In progress", "Other workflow stage"),
      ]),
    );
    const filteredPage = renderToStaticMarkup(
      await SecurityPage({ searchParams: Promise.resolve({ stage: "unknown" }) }),
    );
    expect(filteredPage).toContain("#12");
    expect(filteredPage).toContain("Other workflow stage");
    expect(filteredPage).toContain('aria-label="All: 2 open findings"');

    loadDashboard.mockResolvedValueOnce(dashboard([]));
    const emptyPage = renderToStaticMarkup(
      await SecurityPage({ searchParams: Promise.resolve({ view: "findings" }) }),
    );
    expect(emptyPage).toContain('aria-label="All: 0 open findings"');
    expect(emptyPage).toContain('aria-label="Open: 0 open findings"');
    expect(emptyPage).toContain("No open security findings.");
  });

  it("offers a Show all link when a stage filter has no matches", async () => {
    loadDashboard.mockResolvedValueOnce(dashboard([makeFinding("12", "Open", null)]));
    const markup = renderToStaticMarkup(
      await SecurityPage({ searchParams: Promise.resolve({ stage: "done" }) }),
    );

    expect(markup).toContain("Showing 0 of 1 open finding");
    expect(markup).toContain("No open findings in this stage yet.");
    expect(markup).toContain('href="/security?view=findings"');
    expect(markup).toContain(">Show all</a>");
  });
});
