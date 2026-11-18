import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { ScanActionsMenu } from "@/components/security-checks/scan-actions-menu";
import { CheckList } from "@/components/security-checks/check-list";
import { ReportLive } from "@/components/security-checks/report-live";
import { CheckHeader } from "@/components/security-checks/check-header";
import { checkListTabs } from "@/lib/security-checks/check-list";
import { SiteChatButton, SiteChatHolder, SiteChatPanel } from "@/components/security-checks/site-chat-box";
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
export default async function SecurityCheckPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ fix?: string | string[] }> }) {
  const [{ id }, query, user] = await Promise.all([params, searchParams, requireUser()]);
  // `?fix=id1,id2`: tick these and open the fix panel ("Fix the critical one", a finding's "Fix it for me").
  const initialFix = (Array.isArray(query.fix) ? query.fix.join(",") : query.fix ?? "").split(",").filter(Boolean).slice(0, 100);
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
      {/* The top row and, under it, the site's chat when it's opened from the icon by "More actions" (16 Nov): one block, so a closed chat adds no gap. */}
      <SiteChatHolder checkId={report.checkId} site={report.target.value}>
      <div className="flex flex-col">
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
      {/* Scan again, the PDF and Remove sit here, like Delete issue on an issue page, for any scan that isn't removed yet. */}
      {report.status !== "cancelled" ? (
        <div className="flex shrink-0 items-center gap-2">
          <SiteChatButton />
          <ScanActionsMenu checkId={report.checkId} site={report.target.value} posted={report.posted} nextCheckId={report.nextCheckId} />
        </div>
      ) : null}
      </div>
      {report.status !== "cancelled" ? <SiteChatPanel /> : null}
      </div>
      </SiteChatHolder>

      {/* Scanned again (#security-rescan): an older scan points to the newest, and a rescan to the scan it followed. */}
      {report.nextCheckId ? (
        <p role="status" className="m-0 rounded-2xl border border-zk-border bg-zk-tint px-4 py-3 text-sm text-zk-text">
          This site was scanned again since.{" "}
          <Link href={`/security/checks/${encodeURIComponent(report.nextCheckId)}`} className={linkClass}>Open the newest scan</Link>
        </p>
      ) : report.previousCheckId ? (
        <p className="m-0 px-0.5 text-sm text-zk-text2">
          A rescan: agents recheck what the last scan found and look for anything new.{" "}
          <Link href={`/security/checks/${encodeURIComponent(report.previousCheckId)}`} className={linkClass}>See the earlier scan</Link>
        </p>
      ) : null}

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
          {/* Where the check stands, then one list in phases (16 Nov call): quick scan, quick checks, deeper checks, code scan. */}
          <section aria-labelledby="check-headline" className="overflow-hidden rounded-[20px] border border-zk-border bg-zk-surface">
            <CheckHeader report={report} />
            {/* Keyed by `?fix`, so "Fix the critical one" on this same page ticks its findings afresh. */}
            <CheckList key={initialFix.join(",")} checkId={report.checkId} tabs={checkListTabs(report)} initialFix={initialFix} />
          </section>

        </>
      )}
    </div>
  );
}
