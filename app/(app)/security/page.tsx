import Link from "next/link";
import { auth } from "@/auth";
import { SecurityPublicPage, securityPublicMetadata } from "@/components/security-checks/security-public-page";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { requireUser } from "@/lib/auth-helpers";
import { currentOrganisationAccess } from "@/lib/organisation-access";
import { prisma } from "@/lib/prisma";
import { loadSecurityDashboard, type DashboardFinding } from "@/lib/security-dashboard";
import { isSecuritySeverity, SECURITY_SEVERITIES, SEVERITY_GUIDE, SEVERITY_LABEL } from "@/lib/security-severity";
import { newIssuePath, type ProjectRef } from "@/lib/project-paths";
import { SeverityChip } from "@/components/security-finding-panel";
import { AgentClearanceToggle } from "@/components/security-finding-controls";
import { PipelineSteps } from "@/components/pipeline-steps";
import { SecuritySettingsLink } from "@/components/security/security-settings-link";
import {
  filterSecurityFindingsByStage,
  parseSecurityStageFilter,
  SecurityStageFilterBar,
  type SecurityStageFilter,
} from "@/components/security-stage-filter";
import { LocalTime } from "@/components/local-time";
import { SecurityChecksPanel } from "@/components/security-checks/entry-panel";
import { SecurityTabs } from "@/components/security-checks/security-tabs";
import { WorkspacePickerModal } from "@/components/security-checks/workspace-picker";
import { listWorkspaceChecks } from "@/lib/security-checks/entry";
import { parseSecurityTarget, targetAddress } from "@/lib/security-checks/target";
import { countAgentJobs } from "@/lib/security-checks/your-work";
import { OrgPageHeader, ReadOnlyNote, orgCard, orgListCard } from "../[org]/[project]/org/org-ui";

/** Signed out, /security is the public Ziki Security page, so it carries that page's search title and description. */
export async function generateMetadata() {
  const session = await auth();
  return session?.user ? { title: "Security" } : securityPublicMetadata;
}

/**
 * The Security area (#security-findings): report a vulnerability privately,
 * see how exposed the workspace is, follow each finding to its fix, and read
 * the ones already disclosed. Owners and admins also choose which agents may
 * read private findings.
 */
type SearchParams = Promise<{
  severity?: string | string[];
  stage?: string | string[];
  q?: string | string[];
  project?: string | string[];
  assignee?: string | string[];
  reporter?: string | string[];
  check?: string | string[];
  unlocked?: string | string[];
  added?: string | string[];
  view?: string | string[];
  show?: string | string[];
  target?: string | string[];
  picked?: string | string[];
  page?: string | string[];
}>;

const FINDINGS_PATH = "/security?view=findings";
const FINDINGS_FILTERS = ["severity", "stage", "q", "project", "assignee", "reporter"] as const;

export default async function SecurityPage(props: {
  searchParams?: SearchParams;
}) {
  // Signed out: the public Ziki Security page (#security-checks, C2).
  const session = await auth();
  if (!session?.user) return <SecurityPublicPage signedIn={false} />;
  const params = (await props.searchParams) ?? {};
  const severity = typeof params.severity === "string" ? params.severity.toLowerCase() : "";
  const selectedSeverity = isSecuritySeverity(severity) ? severity : "all";
  const selectedStage = parseSecurityStageFilter(params.stage);
  const search = {
    q: typeof params.q === "string" ? params.q.trim().slice(0, 200) : "",
    project: typeof params.project === "string" ? params.project : "",
    assignee: typeof params.assignee === "string" ? params.assignee.trim().slice(0, 200) : "",
    reporter: params.reporter === "person" || params.reporter === "agent" ? params.reporter : "",
  };
  const searchQuery = new URLSearchParams(Object.entries(search).filter(([, value]) => value));
  const user = await requireUser();
  const access = await currentOrganisationAccess(user.id, user.role);
  // The page opens on the one box (#security-checks). The findings dashboard is
  // one link away, and any old link that carries a findings filter still lands on it.
  const showFindings = params.view === "findings" || FINDINGS_FILTERS.some((key) => params[key] !== undefined);
  const parsed = typeof params.target === "string" ? parseSecurityTarget(params.target) : null;
  // The scanned site as an address the parser reads back: a repo goes as github.com/owner/name.
  const brought = parsed?.ok ? targetAddress(parsed.target) : null;
  const back = brought ? `/security?target=${encodeURIComponent(brought)}` : "/security";
  // Arriving with a scanned site (from the public page) and more than one workspace you own or run:
  // ask which one it goes in, or to create a new one (14 Nov call). Once picked, `picked=1` comes back.
  let picker: React.ReactNode = null;
  if (brought && params.picked !== "1" && !showFindings) {
    const owned = await prisma.membership.findMany({
      where: { userId: user.id, role: { in: ["owner", "admin"] }, organisation: { archivedAt: null } },
      orderBy: { createdAt: "asc" },
      select: { organisation: { select: { id: true, name: true } } },
    });
    if (owned.length > 1) {
      const pickedBack = `/security?target=${encodeURIComponent(brought)}&picked=1`;
      picker = (
        <WorkspacePickerModal
          site={brought}
          workspaces={owned.map(({ organisation }) => ({
            name: organisation.name,
            current: organisation.id === access.organisationId,
            href: `/organisations/open?organisation=${encodeURIComponent(organisation.id)}&next=${encodeURIComponent(pickedBack)}`,
          }))}
          createHref={`/organisations?next=${encodeURIComponent(pickedBack)}`}
        />
      );
    }
  }
  // The pop-up shows over the Security page; when this workspace isn't one you run, over an empty one.
  if (picker && !(access.admin && access.organisationId)) {
    return (
      <div className="flex w-full flex-col pb-10">
        <h1 className="sr-only">Security</h1>
        {picker}
      </div>
    );
  }
  if (!showFindings && !access.admin) {
    // Scans live in a workspace the person owns or runs. If the current one isn't theirs,
    // open one that is, keeping the scanned site.
    const own = await prisma.membership.findFirst({
      where: { userId: user.id, role: { in: ["owner", "admin"] }, organisation: { archivedAt: null } },
      orderBy: { createdAt: "asc" },
      select: { organisationId: true },
    });
    if (own && own.organisationId !== access.organisationId) {
      redirect(`/organisations/open?organisation=${encodeURIComponent(own.organisationId)}&next=${encodeURIComponent(back)}`);
    }
    // Owns none and arrived with a scanned site (from the public page): straight to creating one;
    // they come back here afterwards and the scan starts.
    if (!own && brought) redirect(`/organisations?next=${encodeURIComponent(back)}`);
    // A plain member of this workspace just sees their own work, as before.
    if (access.organisationId) redirect("/security/work");
  }
  if (!access.organisationId) {
    return (
      <div className="space-y-4">
        <OrgPageHeader heading="h1" title="Security" actions={
          <div className="flex items-center gap-2">
            <Link href="/security/activity" className="text-sm font-semibold text-zk-accent hover:underline">Activity</Link>
            <SecuritySettingsLink />
          </div>
        }>Report and track security findings.</OrgPageHeader>
        {/* No workspace of their own: scans live in one, so make it first, then come straight back with the site. */}
        <ReadOnlyNote>
          {brought ? `To scan ${brought}, first ` : "To secure a website, server or repo, first "}
          <Link
            href={`/organisations?next=${encodeURIComponent(back)}`}
            className="font-semibold text-zk-accent hover:underline"
          >
            create your workspace
          </Link>
          . You&apos;ll come straight back here{brought ? " and the scan starts" : ""}.
        </ReadOnlyNote>
      </div>
    );
  }
  const organisationId = access.organisationId;
  if (!showFindings) {
    const [checks, jobs] = await Promise.all([listWorkspaceChecks(organisationId, user.id), countAgentJobs(user.id)]);
    const highlight = typeof params.check === "string" ? { checkId: params.check, unlocked: Number(params.unlocked) > 0 ? Number(params.unlocked) : 0 } : undefined;
    // One page (14 Nov plan): the box, the scan under it, then the person's scans.
    return (
      <div className="flex w-full flex-col pb-10">
        <h1 className="sr-only">Security</h1>
        {/* Removed (cancelled) scans don't count. */}
        <SecurityTabs selected="checks" checks={checks.filter((check) => check.status !== "cancelled").length} jobs={jobs} />
        {picker}
        {/* While the pop-up asks where it goes, nothing is scanned yet. */}
        <SecurityChecksPanel checks={checks} highlight={highlight} startWith={picker ? undefined : (brought ?? undefined)} show={typeof params.show === "string" ? params.show : undefined} page={Number(params.page) > 0 ? Math.floor(Number(params.page)) : 1} />
      </div>
    );
  }
  const dashboard = await loadSecurityDashboard(organisationId, { kind: "person", userId: user.id, organisationId, organisationAdmin: access.admin }, undefined, search);
  const agents = access.admin
    ? (
        await prisma.agentActivation.findMany({
          where: { organisationId, deactivatedAt: null, agent: { revokedAt: null } },
          orderBy: [{ securityCleared: "desc" }, { agent: { name: "asc" } }],
          take: 200,
          select: { level: true, securityCleared: true, agent: { select: { id: true, name: true, owner: { select: { name: true } } } } },
        })
      ).map(({ agent, level, securityCleared }) => ({ ...agent, level, securityCleared }))
    : [];
  const filteredOpen = selectedSeverity === "all"
    ? dashboard.open
    : dashboard.open.filter((f) => f.severity === selectedSeverity);

  const filteredDisclosed = selectedSeverity === "all"
    ? dashboard.disclosed
    : dashboard.disclosed.filter((f) => f.severity === selectedSeverity);

  const visibleOpen = filterSecurityFindingsByStage(filteredOpen, selectedStage);
  const findings = [...dashboard.open, ...dashboard.disclosed];
  const severitySteps = (["all", ...SECURITY_SEVERITIES] as const).map((level) => ({
    label: level === "all" ? "All" : SEVERITY_LABEL[level],
    count: level === "all" ? findings.length : findings.filter((finding) => finding.severity === level).length,
    href: securityFilterHref(level, selectedStage, searchQuery),
    selected: selectedSeverity === level,
  }));
  const openCount = dashboard.open.length;
  const severe = dashboard.openBySeverity.critical + dashboard.openBySeverity.high;

  return (
    <div className="flex w-full flex-col gap-4 pb-10 sm:gap-6">
      <nav aria-label="Breadcrumb" className="text-sm text-zk-muted">
        <Link href="/security" className="font-semibold text-zk-accent hover:underline">Security</Link>
        <span aria-hidden="true"> / </span>Findings
      </nav>
      <OrgPageHeader heading="h1" title="Findings" actions={
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/security/activity" className="text-sm font-semibold text-zk-accent hover:underline">Activity</Link>
          <SecuritySettingsLink />
          <ReportButton projects={dashboard.projects} />
        </div>
      }>
        Report vulnerabilities privately. A workspace owner or admin decides when to publish them.
      </OrgPageHeader>

      <form action="/security" className="grid gap-3 rounded-[20px] border border-zk-border bg-zk-surface p-4 sm:grid-cols-2 lg:grid-cols-4">
        <input type="hidden" name="view" value="findings" />
        {selectedSeverity !== "all" ? <input type="hidden" name="severity" value={selectedSeverity} /> : null}
        {selectedStage !== "all" ? <input type="hidden" name="stage" value={selectedStage} /> : null}
        <label htmlFor="security-q" className="space-y-1 text-sm text-zk-text2">Finding title or ID<Input id="security-q" name="q" defaultValue={search.q} maxLength={200} /></label>
        <label htmlFor="security-project" className="space-y-1 text-sm text-zk-text2">Project
          <Select id="security-project" name="project" defaultValue={search.project}>
            <option value="">All projects</option>
            {dashboard.projects.map((project) => <option key={project.ref} value={project.ref.split("/").at(-1)}>{project.name}</option>)}
          </Select>
        </label>
        <label htmlFor="security-assignee" className="space-y-1 text-sm text-zk-text2">Assignee<Input id="security-assignee" name="assignee" defaultValue={search.assignee} placeholder="Name or unassigned" maxLength={200} /></label>
        <label htmlFor="security-reporter" className="space-y-1 text-sm text-zk-text2">Reporter
          <Select id="security-reporter" name="reporter" defaultValue={search.reporter}>
            <option value="">Everyone</option>
            <option value="person">Person</option>
            <option value="agent">Agent</option>
          </Select>
        </label>
        <div className="flex items-center gap-3 sm:col-span-2">
          <Button type="submit">Apply filters</Button>
          {searchQuery.size ? <Link href={securityFilterHref(selectedSeverity, selectedStage)} className="text-sm font-semibold text-zk-accent hover:underline">Clear search filters</Link> : null}
        </div>
      </form>
      <section aria-label="Summary" className={`${orgListCard} grid grid-cols-2 sm:grid-cols-4`}>
        <Stat label="Open findings" value={String(openCount)} hint={openCount ? "Private until published" : "Nothing open"} />
        <Stat
          label="Critical and high"
          value={String(severe)}
          hint={`${dashboard.openBySeverity.critical} critical, ${dashboard.openBySeverity.high} high`}
          alert={severe > 0}
        />
        <Stat label="Disclosed" value={String(dashboard.disclosed.length)} hint="Details now public" />
        <Stat
          label="Median time to disclose"
          value={dashboard.medianDaysToDisclosure === null ? "–" : `${dashboard.medianDaysToDisclosure} d`}
          hint="From report to publication"
        />
      </section>

      <div className="flex justify-center">
        <PipelineSteps stages={severitySteps} label="Filter findings by severity" />
      </div>

      <section aria-labelledby="open-heading" className={orgCard}>
        <h2 id="open-heading" className="text-base font-semibold text-zk-text">Open findings</h2>
        <p className="text-xs text-zk-muted">Worst first, then oldest.</p>
        <div className="mt-3">
          <SecurityStageFilterBar findings={dashboard.open} selected={selectedStage} severity={selectedSeverity} search={searchQuery} />
        </div>
        {selectedStage !== "all" || selectedSeverity !== "all" ? (
          <p className="mt-3 text-sm text-zk-text2">
            Showing {visibleOpen.length} of {openCount} open {openCount === 1 ? "finding" : "findings"}
          </p>
        ) : null}
        {visibleOpen.length ? (
          <FindingTable findings={visibleOpen} kind="open" filterHref={securityFilterHref(selectedSeverity, selectedStage, searchQuery)} />
        ) : selectedStage === "all" && selectedSeverity === "all" && !searchQuery.size ? (
          <p className="mt-3 text-sm text-zk-text2">No open security findings. Found something? Report it privately.</p>
        ) : selectedSeverity === "all" && !searchQuery.size ? (
          <p className="mt-3 text-sm text-zk-text2">
            No open findings in this stage yet.{" "}
            <Link href={FINDINGS_PATH} className="font-semibold text-zk-accent hover:underline">
              Show all
            </Link>
          </p>
        ) : (
          <p className="mt-3 text-sm text-zk-text2">
            No open findings match these filters.{" "}
            <Link href={FINDINGS_PATH} className="font-semibold text-zk-accent hover:underline">
              Show all
            </Link>
          </p>
        )}
      </section>

      <section aria-labelledby="disclosed-heading" className={orgCard}>
        <h2 id="disclosed-heading" className="text-base font-semibold text-zk-text">Disclosed</h2>
        {filteredDisclosed.length ? (
          <FindingTable findings={filteredDisclosed} kind="disclosed" filterHref={securityFilterHref(selectedSeverity, selectedStage, searchQuery)} />
        ) : (
          <p className="mt-3 text-sm text-zk-text2">Findings appear here after a workspace owner or admin publishes them.</p>
        )}
      </section>

      <section aria-labelledby="severity-heading" className={orgCard}>
        <h2 id="severity-heading" className="text-base font-semibold text-zk-text">How to rate severity</h2>
        <dl className="mt-3 grid gap-3 sm:grid-cols-2">
          {SECURITY_SEVERITIES.map((level) => (
            <div key={level} className="space-y-1">
              <dt><SeverityChip severity={level} /></dt>
              <dd className="text-sm text-zk-text2">{SEVERITY_GUIDE[level]}</dd>
            </div>
          ))}
        </dl>
      </section>

      {access.admin ? (
        <section aria-labelledby="agents-heading" className={orgCard}>
          <h2 id="agents-heading" className="text-base font-semibold text-zk-text">Agents cleared for security work</h2>
          <p className="mt-1 text-sm text-zk-text2">
            A cleared agent can read every private finding in this workspace, through the API and its files, so it can
            confirm, fix and test them. Only owners and admins see this list. An agent can always read findings its own
            owner reported.
          </p>
          {agents.length ? (
            <ul className="mt-3 divide-y divide-zk-border">
              {agents.map((agent) => (
                <li key={agent.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="min-w-0 text-sm">
                    <span className="font-semibold text-zk-text">{agent.name}</span>{" "}
                    <span className="text-zk-muted">
                      {agent.level} agent of {agent.owner?.name ?? "someone"}
                    </span>
                  </span>
                  <AgentClearanceToggle agentId={agent.id} agentName={agent.name} cleared={agent.securityCleared} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-zk-text2">No agents in this workspace yet.</p>
          )}
        </section>
      ) : null}
      <section aria-labelledby="policy-heading" className={orgCard}>
        <h2 id="policy-heading" className="text-base font-semibold text-zk-text">Responsible disclosure</h2>
        <div className="mt-3">
          <ReadOnlyNote>
            Share sensitive evidence through the private report. A workspace owner or admin decides when to publish the finding.
          </ReadOnlyNote>
        </div>
      </section>
    </div>
  );
}

function securityFilterHref(severity: "all" | (typeof SECURITY_SEVERITIES)[number], stage: SecurityStageFilter, search?: URLSearchParams) {
  const params = new URLSearchParams(search);
  params.set("view", "findings");
  if (severity !== "all") params.set("severity", severity);
  if (stage !== "all") params.set("stage", stage);
  return `/security?${params.toString()}`;
}

function Stat({ label, value, hint, alert = false }: { label: string; value: string; hint: string; alert?: boolean }) {
  return (
    <div className="min-w-0 p-4">
      <p className="text-sm font-medium text-zk-text2">{label}</p>
      <p className={`mt-1 text-2xl font-bold tabular-nums ${alert ? "text-zk-bad-fg" : "text-zk-text"}`}>{value}</p>
      <p className="mt-1 text-xs text-zk-text2">{hint}</p>
    </div>
  );
}

function FindingTable({ findings, kind, filterHref }: { findings: DashboardFinding[]; kind: "open" | "disclosed"; filterHref: string }) {
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="text-xs text-zk-muted">
            <th scope="col" className="py-2 pr-3 font-semibold">Severity</th>
            <th scope="col" className="py-2 pr-3 font-semibold">Finding</th>
            <th scope="col" className="hidden py-2 pr-3 font-semibold sm:table-cell">Status</th>
            <th scope="col" className="hidden py-2 pr-3 text-right font-semibold sm:table-cell">{kind === "open" ? "Open for" : "Took"}</th>
            {kind === "disclosed" ? <th scope="col" className="hidden py-2 font-semibold sm:table-cell">Disclosed</th> : null}
          </tr>
        </thead>
        <tbody className="divide-y divide-zk-border">
          {findings.map((finding) => (
            <tr key={finding.id}>
              <td className="py-2 pr-3 align-top"><SeverityChip severity={finding.severity} /></td>
              <td className="py-2 pr-3 align-top">
                <Link href={finding.canView ? "/security/findings/" + finding.id + filterHref.slice("/security".length) : finding.href} className="font-semibold text-zk-accent hover:underline">{finding.ref}</Link>{" "}
                {finding.title ? (
                  <span className="break-words text-zk-text">{finding.title}</span>
                ) : (
                  <span className="italic text-zk-muted">Details restricted</span>
                )}
                <span className="block text-xs text-zk-muted">{finding.project}</span>
                <span className="block text-xs text-zk-text2 sm:hidden">{finding.stage} · {finding.days} d</span>
                {finding.disclosedAt ? <span className="block text-xs text-zk-text2 sm:hidden"><LocalTime date={finding.disclosedAt} /></span> : null}
              </td>
              <td className="hidden py-2 pr-3 align-top text-zk-text2 sm:table-cell">{finding.stage}</td>
              <td className="hidden py-2 pr-3 text-right align-top tabular-nums text-zk-text2 sm:table-cell">{finding.days} d</td>
              {kind === "disclosed" ? (
                <td className="hidden py-2 align-top text-xs text-zk-text2 sm:table-cell">
                  {finding.disclosedAt ? <LocalTime date={finding.disclosedAt} /> : null}
                  <span className="block">{finding.fixedLive ? "Fix live" : "Published by an owner or admin"}</span>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const REPORT_BUTTON =
  "inline-flex h-10 items-center rounded-full bg-electric-blue-strong px-5 text-sm font-bold text-white hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-electric-blue focus-visible:ring-offset-2";

/** "Report a vulnerability": straight to the form in a one-project workspace, else pick the project. */
function ReportButton({ projects }: { projects: { name: string; ref: ProjectRef }[] }) {
  if (projects.length === 0) return null;
  if (projects.length === 1) {
    // A full page load, so the quick-report modal doesn't intercept it.
    return <a href={newIssuePath(projects[0].ref, "security=1")} className={REPORT_BUTTON}>Report a vulnerability</a>;
  }
  return (
    <details className="security-report relative">
      <summary className={`${REPORT_BUTTON} cursor-pointer list-none`}>Report a vulnerability</summary>
      <div className="absolute left-0 z-10 mt-2 w-64 sm:left-auto sm:right-0 rounded-2xl border border-zk-border bg-zk-surface p-2 shadow-lg">
        <p className="px-2 py-1 text-xs text-zk-muted">Which product is it in?</p>
        <ul>
          {projects.map((project) => (
            <li key={project.ref}>
              <a href={newIssuePath(project.ref, "security=1")} className="block rounded-xl px-2 py-1.5 text-sm text-zk-text hover:bg-zk-bg">
                {project.name}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}
