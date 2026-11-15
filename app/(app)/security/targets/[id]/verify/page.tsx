import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth-helpers";
import { currentOrganisationAccess } from "@/lib/organisation-access";
import { prisma } from "@/lib/prisma";
import { FINISHED_CHECK_STATUSES, ownershipProofRequired, TARGET_KIND_LABEL } from "@/lib/security-checks";
import { OrgPageHeader, orgListCard } from "../../../../[org]/[project]/org/org-ui";
import { OwnershipSteps } from "./ownership-steps";
import { QuickScanLink } from "@/components/security-checks/quick-scan-link";
import { readQuickScan } from "@/lib/security-checks/entry";

export const metadata = { title: "Show it's yours" };

const KIND_NOUN = { website: "site", server: "server", repo: "repo" } as const;

/**
 * Step 2, show it's yours (#security-checks, part 2). Before any agent looks
 * at a target, the client proves it is theirs with its secret code, once. Then
 * its checks are let go to the agents and the client goes back to Assets, where the free scan runs.
 *
 * Hidden for now (14 Nov plan, D1): while SECURITY_OWNERSHIP_PROOF_REQUIRED isn't
 * "true" there is nothing to prove, so an old link lands back on Security, on
 * this person's open check when there is one. The page stays for when proof returns.
 */
export default async function VerifySecurityTargetPage({ params }: { params: Promise<{ id: string }> }) {
  const [{ id }, user] = await Promise.all([params, requireUser()]);
  const access = await currentOrganisationAccess(user.id, user.role);
  if (!access.organisationId) notFound();

  const target = await prisma.securityTarget.findFirst({
    where: { id, organisationId: access.organisationId },
    select: {
      id: true,
      kind: true,
      value: true,
      ownershipToken: true,
      verifiedAt: true,
      previewSummary: true,
      checks: {
        // Checks are per person: only this person's own check carries on from here.
        where: { requestedById: user.id, status: { notIn: [...FINISHED_CHECK_STATUSES] } },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { id: true },
      },
    },
  });
  if (!target) notFound();

  const openCheck = target.checks[0] ?? null;
  const next = openCheck ? `/security?check=${encodeURIComponent(openCheck.id)}` : "/security";
  if (!ownershipProofRequired()) redirect(next);
  const noun = KIND_NOUN[target.kind];
  const quickScan = readQuickScan(target.previewSummary);

  // For a repo: whether the workspace's GitHub App is connected yet, and where to connect it.
  const projects =
    target.kind === "repo" && !target.verifiedAt
      ? await prisma.project.findMany({
          where: { organisationId: access.organisationId, archivedAt: null },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: { slug: true, githubInstallationId: true },
        })
      : [];
  const appConnected = projects.some((project) => project.githubInstallationId);
  const settingsProject = projects.find((project) => project.githubInstallationId) ?? projects[0] ?? null;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 pb-10 sm:gap-6">
      <nav aria-label="Breadcrumb" className="text-sm text-zk-muted">
        <Link href="/security" className="font-semibold text-zk-accent hover:underline">Security</Link>
        <span aria-hidden="true"> / </span>
        <span className="break-all font-mono">{target.value}</span>
      </nav>

      <div className="space-y-4">
        <OrgPageHeader heading="h1" title="Show it's yours">
          Agents only check what their owners ask for. {target.kind === "server" ? "Follow the step below." : "Pick one way below."} You only do this once per {noun}.
        </OrgPageHeader>
        <ol aria-label="Steps" className="m-0 flex list-none flex-wrap items-center gap-x-1.5 gap-y-1 p-0 text-[13px]">
          <Step state={target.verifiedAt ? "done" : "now"}>Show it&apos;s yours</Step>
          <StepLine />
          <Step state={target.verifiedAt ? "now" : "later"}>Checking</Step>
          <StepLine />
          <Step state="later">Fix</Step>
        </ol>
        {/* The quick scan from when it was added (#security-checks): why it's worth proving. */}
        {quickScan && !target.verifiedAt ? <QuickScanLink summary={quickScan} /> : null}
      </div>

      <section className={orgListCard} aria-label={`Show ${target.value} is yours`}>
        <div className="border-b border-zk-border bg-zk-tint px-4 py-3 sm:px-6">
          <p className="m-0 text-xs font-semibold text-zk-muted">{TARGET_KIND_LABEL[target.kind]}</p>
          <p className="m-0 break-all font-mono text-base font-semibold text-zk-text">{target.value}</p>
        </div>

        {target.verifiedAt ? (
          <div role="status" className="flex flex-wrap items-center justify-between gap-3 px-4 py-5 sm:px-6">
            <p className="m-0 text-sm text-zk-ok-fg">You&apos;ve already shown {target.value} is yours.</p>
            <Link href={next} className="text-sm font-semibold text-zk-accent hover:underline">
              {openCheck ? "Continue" : "Back to Security"}
            </Link>
          </div>
        ) : (
          <OwnershipSteps
            targetId={target.id}
            kind={target.kind}
            value={target.value}
            token={target.ownershipToken}
            github={{ connected: appConnected, settingsHref: settingsProject ? `/projects/${encodeURIComponent(settingsProject.slug)}/settings` : null }}
          />
        )}
      </section>
    </div>
  );
}

/** One step, drawn like the step line on each check on Security. */
function Step({ state, children }: { state: "done" | "now" | "later"; children: React.ReactNode }) {
  const tone = state === "done" ? "text-zk-ok-fg" : state === "now" ? "font-semibold text-zk-text" : "text-zk-muted";
  return (
    <li aria-current={state === "now" ? "step" : undefined} className={`inline-flex items-center gap-1.5 whitespace-nowrap ${tone}`}>
      {state === "done" ? (
        <span aria-hidden="true" className="grid h-4 w-4 place-items-center rounded-full bg-zk-ok-bg">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L19 7" /></svg>
        </span>
      ) : (
        <span aria-hidden="true" className={`h-2 w-2 rounded-full ${state === "now" ? "bg-electric-blue-strong ring-4 ring-electric-blue-strong/15" : "border border-zk-border bg-zk-surface"}`} />
      )}
      {state === "done" ? <span className="sr-only">Done: </span> : null}
      {children}
    </li>
  );
}

function StepLine() {
  return <li aria-hidden="true" className="h-px w-3 bg-zk-border sm:w-6" />;
}
