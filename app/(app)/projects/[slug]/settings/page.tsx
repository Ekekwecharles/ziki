import "@/app/(app)/settings/settings-design.css";
import { checkOptions, loadProofRules } from "@/lib/proof";
import { ProofRulesEditor } from "@/components/proof-rules-editor";
import { organisationAccessFor } from "@/lib/organisation-access";
import { PRODUCT_TRACK } from "@/lib/marketing/track";
import type { AppRole } from "@/lib/roles";
import Link from "next/link";
import { issuesPath, orgPath, refOf } from "@/lib/project-paths";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth-helpers";
import { currentOrganisationIdFor } from "@/lib/organisation-context";
import { isAdminOfOrganisation } from "@/lib/agents/membership";
import { prisma } from "@/lib/prisma";
import { ProjectSettingsForm } from "./settings-form";
import { ProjectAreasManager } from "./areas-manager";
import { WorkflowSettingsForm } from "./workflow-settings-form";
import { ProjectRepositoriesManager } from "./repositories-manager";
import { RepositoryAccessPanel } from "./repository-access";
import { repositoryAccessForSettings } from "@/lib/github/settings-access";
import { PreviewSettingsForm } from "./preview-settings-form";
import { ProjectGoals } from "@/app/(app)/[org]/[project]/goals/project-goals";
import { CopyProjectIdButton } from "@/app/(app)/projects/copy-project-id";
import { ConfirmSubmitButton } from "@/components/confirm-submit-button";
import { Button } from "@/components/ui/button";
import { deleteProjectAction, setProjectArchivedAction } from "@/app/(app)/projects/actions";
import { workflowValues } from "@/lib/workflow-config";
import { previewSettingsValues } from "@/lib/validations/preview-settings";
import {
  getPlatformRewardConfig,
  projectDefaultsFromPlatform,
} from "@/lib/points/platform-rewards";

export const metadata = { title: "Project settings" };

/** The project's settings, one section at a time, laid out like Settings (a sidebar of sections). */
const SECTIONS = [
  {
    id: "details",
    label: "Details & rewards",
    hint: "Name, goal, links, rewards",
    icon: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  },
  {
    id: "github",
    label: "GitHub",
    hint: "The GitHub App installation",
    icon: "M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22",
  },
  {
    id: "previews",
    label: "Previews",
    hint: "Pull request preview builds",
    icon: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  },
  {
    id: "workflow",
    label: "Workflow",
    hint: "The gates agents work under",
    icon: "M4 6h16M4 12h10M4 18h6",
  },
  {
    id: "areas",
    label: "Areas",
    hint: "Parts of the product",
    icon: "M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z",
  },
  {
    // #616: the project's goals and their budget pools.
    id: "goals",
    label: "Goals",
    hint: "Budget pools for the work",
    icon: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM12 11a1 1 0 1 0 0 2 1 1 0 0 0 0-2z",
  },
  {
    // Owners only: archive, restore or delete the project.
    id: "archive",
    label: "Archive or delete",
    hint: "Owners only",
    icon: "M3 7h18M5 7v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7M9 7V4h6v3M10 11v6M14 11v6",
  },
  {
    // #deeper-testing: what a judgement on this project's issues must prove.
    id: "checks",
    label: "Checks",
    hint: "What testers must prove",
    icon: "M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11",
  },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

function parseSection(value: string | undefined, github: string | undefined): SectionId {
  // Coming back from connecting GitHub opens its section.
  if (!value && github) return "github";
  return SECTIONS.find((item) => item.id === value)?.id ?? "details";
}

const card = "rounded-[20px] border border-zk-border bg-zk-surface p-6 flex flex-col gap-4";

/** The Checks section's data: the organisation's rules (read-only here) and this project's per area. */
async function projectChecks(organisationId: string, projectId: string, user: { id: string; role?: AppRole | null }) {
  const [rules, types, areas, access] = await Promise.all([
    loadProofRules(prisma, organisationId),
    prisma.issueType.findMany({ where: { organisationId, ...PRODUCT_TRACK }, select: { id: true, name: true } }),
    prisma.projectArea.findMany({ where: { projectId }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    organisationAccessFor(user.id, organisationId, user.role),
  ]);
  return {
    owner: access.membershipRole === "owner",
    organisationName: access.organisationName ?? "the organisation",
    orgRules: rules.rules.filter((r) => !r.projectId),
    projectRules: rules.rules.filter((r) => r.projectId === projectId),
    options: checkOptions(rules),
    types,
    areas,
  };
}

export default async function ProjectSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ github?: string; section?: string }>;
}) {
  const user = await requireUser();
  const organisationId = await currentOrganisationIdFor(user.id);
  if (!organisationId) redirect("/organisations");
  if (!(await isAdminOfOrganisation(user, organisationId))) notFound();
  const { slug } = await params;
  const project = await prisma.project.findFirst({
    where: { organisationId, slug },
    select: {
      id: true, slug: true, name: true, goal: true, repoUrl: true, stagingUrl: true, siteUrl: true,
      visibility: true, isOpenForContributors: true, acceptsGuestIdeas: true, contributorGuidelines: true,
      githubInstallationId: true, rewardConfig: true, workflow: true, archivedAt: true, organisation: { select: { slug: true } },
      _count: { select: { bugs: true } },
      repositories: {
        select: { id: true, url: true, label: true, branch: true, githubInstallationId: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      },
    },
  });
  if (!project) notFound();
  const owner = (await organisationAccessFor(user.id, organisationId, user.role)).membershipRole === "owner";
  const { github, section: rawSection } = await searchParams;
  const section = parseSection(rawSection, github);
  const workflow = workflowValues(project.workflow);
  const areas = section === "areas"
    ? await prisma.projectArea.findMany({
        where: { projectId: project.id },
        orderBy: [{ name: "asc" }, { id: "asc" }],
        select: { id: true, name: true, slug: true, description: true, paths: true },
      })
    : [];
  const checks = section === "checks" ? await projectChecks(organisationId, project.id, user) : null;
  const repositoryAccess = section === "github" ? await repositoryAccessForSettings(project) : null;
  const previewSettings = section === "previews"
    ? previewSettingsValues(await prisma.projectPreviewSettings.findUnique({ where: { projectId: project.id } }))
    : null;
  const platformDefaults = section === "details" ? projectDefaultsFromPlatform(await getPlatformRewardConfig(prisma)) : null;
  const base = `/projects/${encodeURIComponent(project.slug)}/settings`;

  return (
    <div className="settings-page settings-design mx-auto flex w-full max-w-5xl flex-col gap-6 pb-10">
      <div className="flex flex-col gap-2.5">
        {/* Back to the project itself: its Project Overview. */}
        <Link
          href={issuesPath(refOf(project), "your_work")}
          className="inline-flex min-h-8 items-center gap-1.5 self-start text-sm font-semibold text-zk-accent hover:underline"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
          {project.name}
        </Link>
        <h1 className="m-0 text-[28px] font-extrabold tracking-[-0.02em] text-zk-text">{project.name} settings</h1>
        <div className="flex flex-wrap items-center gap-2 text-sm text-zk-muted">
          <span>Project ID</span>
          <code className="rounded bg-zk-chip px-1.5 py-0.5 font-mono text-[12px] text-zk-text2">{project.id}</code>
          <CopyProjectIdButton projectId={project.id} />
          {project.archivedAt ? <span className="rounded-full bg-zk-warn-bg px-2 py-0.5 text-[11px] font-bold text-zk-warn-fg">Archived</span> : null}
        </div>
      </div>

      <div className="settings-layout">
        <nav aria-label="Project settings sections" className="settings-navigation">
          {SECTIONS.filter((item) => owner || item.id !== "archive").map((item) => {
            const on = section === item.id;
            return (
              <Link
                key={item.id}
                href={`${base}?section=${item.id}`}
                aria-current={on ? "page" : undefined}
                className={`flex w-full items-center gap-3 rounded-[14px] px-3 py-2.5 text-left text-zk-text transition ${
                  on ? "bg-zk-tint" : "bg-transparent hover:bg-zk-chip"
                }`}
              >
                <span
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
                    on ? "bg-electric-blue-strong text-white" : "bg-zk-chip text-zk-text2"
                  }`}
                >
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d={item.icon} />
                  </svg>
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm font-bold">{item.label}</span>
                  <span className="text-xs font-medium text-zk-muted">{item.hint}</span>
                </span>
              </Link>
            );
          })}
        </nav>

        <div className="settings-content flex min-w-0 flex-col gap-5">
          {section === "details" && platformDefaults ? (
            <section className={card}>
              <div className="flex flex-col gap-1">
                <h2 className="m-0 text-lg font-bold text-zk-text">Details &amp; rewards</h2>
                <span className="text-[13px] text-zk-muted">What the project is, where it lives, and what its work pays.</span>
              </div>
              <ProjectSettingsForm project={project} defaults={platformDefaults} />
            </section>
          ) : null}

          {section === "github" ? (
            <div className="flex flex-col gap-4">
              <Link href="/projects/readiness" className="self-start text-sm font-semibold text-zk-accent underline">Check repository readiness for this organisation</Link>
              {github === "error" ? <p role="alert" className="rounded-[14px] bg-zk-warn-bg p-3 text-sm text-zk-warn-fg">GitHub setup could not be completed. Start the connection again from this page.</p> : null}
              {github === "connected" ? <p role="status" className="rounded-[14px] bg-zk-ok-bg p-3 text-sm text-zk-ok-fg">GitHub App installation connected.</p> : null}
              {github === "unavailable" ? <p role="alert" className="rounded-[14px] bg-zk-warn-bg p-3 text-sm text-zk-warn-fg">The GitHub App is not configured. Set GITHUB_APP_SLUG before connecting it.</p> : null}
              {github === "requested" ? <p role="status" className="rounded-[14px] bg-zk-warn-bg p-3 text-sm text-zk-warn-fg">GitHub App installation was requested and is waiting for organisation admin approval.</p> : null}
              {github === "cancelled" ? <p role="status" className="rounded-[14px] bg-zk-surface p-3 text-sm text-zk-text2">GitHub App connection was cancelled.</p> : null}
              <section className={card}>
                <div className="flex flex-col gap-1">
                  <h2 className="m-0 text-lg font-bold text-zk-text">GitHub App</h2>
                  <span className="text-[13px] text-zk-muted">
                    For the main repository, and the others in the same organisation. Installation ID: {project.githubInstallationId ?? "Not connected"}. No access token is stored.
                  </span>
                </div>
                <a
                  href={`${base}/github`}
                  className="inline-flex h-[42px] items-center self-start rounded-full bg-electric-blue-strong px-[18px] text-sm font-bold text-white hover:brightness-105"
                >
                  {project.githubInstallationId ? "Change installation" : "Connect GitHub App"}
                </a>
                {repositoryAccess ? <RepositoryAccessPanel access={repositoryAccess} /> : null}
                <ProjectRepositoriesManager
                  projectSlug={project.slug}
                  repositories={project.repositories}
                  projectConnected={Boolean(project.githubInstallationId)}
                />
              </section>
            </div>
          ) : null}

          {section === "previews" && previewSettings ? (
            <section className={card} aria-labelledby="previews-heading">
              <div className="flex flex-col gap-1">
                <h2 id="previews-heading" className="m-0 text-lg font-bold text-zk-text">Previews</h2>
                <span className="text-[13px] text-zk-muted">
                  Ziki builds each pull request of the main repository and links a working preview from its issue. For frontends
                  that build to static files. Changes are audited.
                </span>
              </div>
              {!project.githubInstallationId ? (
                <p role="status" className="rounded-[14px] bg-zk-warn-bg p-3 text-sm text-zk-warn-fg">
                  Private repositories need the GitHub App, so Ziki can fetch their code.{" "}
                  <Link href={`${base}?section=github`} className="font-semibold underline">
                    Connect it in GitHub
                  </Link>
                  .
                </p>
              ) : null}
              <PreviewSettingsForm slug={project.slug} settings={previewSettings} repoUrl={project.repoUrl} />
            </section>
          ) : null}

          {section === "workflow" ? (
            <section className={card} aria-labelledby="workflow-heading">
              <div className="flex flex-col gap-1">
                <h2 id="workflow-heading" className="m-0 text-lg font-bold text-zk-text">Workflow</h2>
                <span className="text-[13px] text-zk-muted">The gates agents work under in this project. Changes are audited.</span>
              </div>
              <WorkflowSettingsForm slug={project.slug} workflow={workflow} />
            </section>
          ) : null}

          {section === "areas" ? <ProjectAreasManager projectSlug={project.slug} areas={areas} /> : null}

          {section === "archive" && owner ? (
            <section className={card} aria-labelledby="archive-heading">
              <div className="flex flex-col gap-1">
                <h2 id="archive-heading" className="m-0 text-lg font-bold text-zk-text">Archive or delete</h2>
                <span className="text-[13px] text-zk-muted">Only the organisation&apos;s owners can archive, restore or delete a project.</span>
              </div>
              <div className="flex flex-col gap-2 rounded-xl border border-zk-border p-4">
                <h3 className="m-0 text-sm font-bold text-zk-text">{project.archivedAt ? "Restore the project" : "Archive the project"}</h3>
                <p className="m-0 text-[13px] text-zk-muted">
                  {project.archivedAt
                    ? "It comes back to the project switcher, with its issues."
                    : "It leaves the project switcher and can\u2019t be selected. Its issues stay, and you can restore it later."}
                </p>
                <form action={setProjectArchivedAction} className="self-start">
                  <input type="hidden" name="projectId" value={project.id} />
                  <input type="hidden" name="archived" value={project.archivedAt ? "false" : "true"} />
                  {project.archivedAt ? (
                    <Button type="submit" variant="secondary">Restore project</Button>
                  ) : (
                    <ConfirmSubmitButton
                      variant="secondary"
                      confirm={{
                        title: `Archive ${project.name}?`,
                        body: "It leaves the project switcher and can\u2019t be selected. Its issues stay, and you can restore it later.",
                        confirmLabel: "Archive project",
                      }}
                    >
                      Archive project
                    </ConfirmSubmitButton>
                  )}
                </form>
              </div>
              <form action={deleteProjectAction} className="flex flex-col gap-2 rounded-xl border border-zk-bad-bd bg-zk-bad-soft/40 p-4">
                <input type="hidden" name="projectId" value={project.id} />
                <h3 className="m-0 text-sm font-bold text-zk-bad-fg">Delete the project</h3>
                <p className="m-0 text-[13px] text-zk-text2">
                  {project._count.bugs > 0
                    ? `It has ${project._count.bugs === 1 ? "1 issue" : `${project._count.bugs} issues`}, so it can\u2019t be deleted. Archive it instead.`
                    : "It has no issues, so it can be deleted for good. This can\u2019t be undone."}
                </p>
                {project._count.bugs === 0 ? (
                  <>
                    <label htmlFor="confirm-delete" className="text-xs font-medium text-zk-text2">Type {project.name} to confirm</label>
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        id="confirm-delete"
                        name="confirmName"
                        placeholder={project.name}
                        autoComplete="off"
                        required
                        className="min-w-0 flex-1 rounded-xl border border-zk-border bg-zk-surface px-3 py-2 text-sm text-zk-text"
                      />
                      <Button type="submit" variant="danger-secondary">Delete project</Button>
                    </div>
                  </>
                ) : null}
              </form>
            </section>
          ) : null}

          {section === "goals" ? (
            <section className={card} aria-labelledby="goals-heading">
              <div className="flex flex-col gap-1">
                <h2 id="goals-heading" className="m-0 text-lg font-bold text-zk-text">Goals</h2>
                <span className="text-[13px] text-zk-muted">A goal holds a pool of credits and splits it across issues, nested goals and agent deliverables. Allocations only ever take from what is left, so a pool can never be spent twice.</span>
              </div>
              <ProjectGoals org={project.organisation.slug} organisationId={organisationId} project={{ id: project.id, slug: project.slug, ref: refOf(project) }} />
            </section>
          ) : null}

          {checks ? (
            <section className={card} aria-labelledby="checks-heading">
              <div className="flex flex-col gap-1">
                <h2 id="checks-heading" className="m-0 text-lg font-bold text-zk-text">Checks</h2>
                <span className="text-[13px] text-zk-muted">
                  What a judgement must prove before it counts. Testers attach proof for each check; builds and tests are already read from the pull request.
                </span>
              </div>
              <div className="rounded-xl border border-zk-border bg-zk-tint/50 p-4">
                <p className="m-0 mb-2 flex flex-wrap items-center gap-2 text-xs font-bold tracking-[0.06em] text-zk-muted uppercase">
                  From {checks.organisationName}
                  {checks.owner ? (
                    <Link href={orgPath(refOf(project), "checks")} className="text-xs font-semibold tracking-normal text-zk-accent normal-case hover:underline">
                      Edit in Org › Checks
                    </Link>
                  ) : null}
                </p>
                <ProofRulesEditor projectId={null} rules={checks.orgRules} checks={checks.options} scopes={checks.types} editable={false} />
                {checks.owner ? null : <p className="m-0 mt-2 text-xs text-zk-muted">Set by the organisation&apos;s owners for every project. Add checks for this project&apos;s areas below.</p>}
              </div>
              <h3 className="m-0 text-sm font-bold text-zk-text">This project&apos;s own checks</h3>
              <ProofRulesEditor projectId={project.id} rules={checks.projectRules} checks={checks.options} scopes={checks.areas} editable />
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
