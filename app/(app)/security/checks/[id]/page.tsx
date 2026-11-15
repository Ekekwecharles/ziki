import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { IssueActionsMenu } from "@/components/issue-actions-menu";
import { RemoveScanButton } from "@/components/security-checks/remove-scan-button";
import { QuickScanList } from "@/components/security-checks/preview-result";
import { LiveCheckCard } from "@/components/security-checks/live-check-card";
import { ReportLive } from "@/components/security-checks/report-live";
import { ReportProgress } from "@/components/security-checks/report-progress";
import { ReportResults } from "@/components/security-checks/report-results";
import { ReportSummary } from "@/components/security-checks/report-summary";
import { requireUser } from "@/lib/auth-helpers";
import { substatusClass } from "@/lib/labels";
import { currentOrganisationAccess } from "@/lib/organisation-access";
import { CHECK_STATUS_LABEL, FINISHED_CHECK_STATUSES, TARGET_KIND_LABEL } from "@/lib/security-checks";
import { loadCheckReport } from "@/lib/security-checks/report";
import { orgCard } from "../../../[org]/[project]/org/org-ui";

export const metadata = { title: "Security check" };

/**
 * One security check (12 and 14 Nov plans, part S): live progress and the
 * quick scan while Ziki checks, then, once the report is posted, Ziki's
 * one-line summary and every finding worst first. The report is free; clients
 * pay only to have findings fixed (14 Nov call).
 * The report never goes away; moved findings are marked. Only the person who
 * asked for the check sees it.
 */
export default async function SecurityCheckPage({ params }: { params: Promise<{ id: string }> }) {
  const [{ id }, user] = await Promise.all([params, requireUser()]);
  const access = await currentOrganisationAccess(user.id, user.role);
  if (!access.organisationId) notFound();
  const report = await loadCheckReport(id, access.organisationId, user.id);
  if (!report) notFound();

  const linkClass = "font-semibold text-zk-accent hover:underline";
  const working = !FINISHED_CHECK_STATUSES.has(report.status);
  const kind = TARGET_KIND_LABEL[report.target.kind].toLowerCase();

  return (
    <div className="flex w-full flex-col gap-4 pb-10 sm:gap-6">
      {/* Live until the report is posted; a cancelled check has nothing more to show. */}
      {working && !report.posted ? <ReportLive /> : null}
      {/* Same look as the issue pages' breadcrumb (components/project-breadcrumb.tsx), with the same "More actions" menu on the right. */}
      <div className="flex w-full items-center justify-between gap-3">
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center px-0.5 text-[13px] text-zk-text2">
        <ol className="flex min-w-0 flex-wrap items-center gap-0.5">
          <li className="min-w-0">
            <Link
              href="/security"
              className="block truncate rounded-md px-1.5 py-0.5 font-bold text-zk-text hover:bg-zk-chip hover:text-zk-text focus-visible:outline-2 focus-visible:outline-zk-accent"
            >
              Security
            </Link>
          </li>
          <li aria-hidden="true" className="text-zk-muted">/</li>
          <li aria-current="page" className="truncate px-1.5">{report.target.value}</li>
        </ol>
      </nav>
      {/* Remove sits here, like Delete issue on an issue page, for any scan that isn't removed yet. */}
      {report.status !== "cancelled" ? (
        <IssueActionsMenu>
          <RemoveScanButton checkId={report.checkId} site={report.target.value} posted={report.posted} />
        </IssueActionsMenu>
      ) : null}
      </div>

      {/* Only while ownership proof is on: with it off, the report shows such a check as waiting to start. */}
      {report.status === "awaiting_ownership" ? (
        <section aria-labelledby="ownership-heading" className={orgCard}>
          <Badge className={substatusClass.requires_confirmation}>{CHECK_STATUS_LABEL.awaiting_ownership}</Badge>
          <h1 id="ownership-heading" className="mt-2 wrap-break-word text-xl font-bold tracking-tight text-zk-text">
            Show {report.target.value} is yours
          </h1>
          <p className="mt-1 text-sm text-zk-text2">Agents start only once you prove this {kind} is yours. You do this once.</p>
          <Link href={`/security/targets/${report.target.id}/verify`} className={`mt-3 inline-block ${linkClass}`}>
            Prove ownership
          </Link>
        </section>
      ) : (
        <>
          {/* A running check is one card (headline, something always moving, the numbers and each part); otherwise the summary on top. */}
          {working && !report.posted ? <LiveCheckCard report={report} /> : <ReportSummary report={report} />}

          {/* The quick scan from when it was added, until the agents' report replaces it (14 Nov plan). */}
          {!report.posted && report.quickScan ? <QuickScanList summary={report.quickScan} /> : null}

          {/* A check that was cancelled keeps its parts; a running one shows them inside its card. */}
          {!report.posted && !working ? (
            <section aria-labelledby="progress-heading" className={orgCard}>
              <h2 id="progress-heading" className="text-base font-semibold text-zk-text">Progress</h2>
              <div className="mt-3">
                {report.parts.length ? <ReportProgress progress={report.progress} parts={report.parts} /> : <p className="text-sm text-zk-text2">No parts were checked.</p>}
              </div>
            </section>
          ) : null}

          {report.posted ? <ReportResults report={report} /> : null}

        </>
      )}
    </div>
  );
}
