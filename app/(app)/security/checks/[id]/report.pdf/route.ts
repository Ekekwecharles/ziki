import { redirect } from "next/navigation";
import { renderReportPdf } from "@/components/security-checks/report-pdf";
import { requireUser } from "@/lib/auth-helpers";
import { currentOrganisationAccess } from "@/lib/organisation-access";
import { loadCheckReport } from "@/lib/security-checks/report";

/**
 * The security report as a PDF (12 Nov plan, S2). Same access rule as the
 * check page (only the person who asked for it), and free once the report is
 * posted: it follows the page's rules exactly, so a locked finding is as
 * vague here as on the page. Before posting it goes back to the check's page.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const [{ id }, user] = await Promise.all([params, requireUser()]);
  const access = await currentOrganisationAccess(user.id, user.role);
  const report = access.organisationId ? await loadCheckReport(id, access.organisationId, user.id) : null;
  if (!report || report.status === "awaiting_ownership") {
    return new Response("Not found", { status: 404 });
  }
  // No PDF before the report is posted: the page shows progress until then.
  if (!report.posted) redirect(`/security/checks/${report.checkId}`);

  let pdf: Buffer;
  try {
    pdf = await renderReportPdf(report);
  } catch (error) {
    // Say what failed in the server log (a bare 500 says nothing) and in plain words to the person.
    console.error(`[report.pdf] check ${report.checkId}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    return new Response("We couldn't make the PDF just now. Please try again in a minute.", {
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "private, no-store" },
    });
  }
  const name = report.target.input.replace(/^https?:\/\//, "").replace(/[^a-zA-Z0-9.-]+/g, "-").slice(0, 60);
  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="security-report-${name || "check"}.pdf"`,
      // Private results: never kept by a shared cache.
      "Cache-Control": "private, no-store",
    },
  });
}
