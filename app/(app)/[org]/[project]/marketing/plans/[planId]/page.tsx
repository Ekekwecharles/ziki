import { notFound } from "next/navigation";
import { requireProject } from "@/lib/project-route";
import { projectRef } from "@/lib/project-paths";
import { getMarketingPlan, MarketingPlanStoreError } from "@/lib/structured-marketing-plans";
import { PlanEditor } from "@/components/marketing/plans/plan-editor";
import { isAdminOfOrganisation } from "@/lib/agents/membership";

export const metadata = { title: "Review marketing plan" };

export default async function MarketingPlanPage({ params }: { params: Promise<{ org: string; project: string; planId: string }> }) {
  const { org, project, planId } = await params;
  const context = await requireProject(org, project);
  let plan;
  try { plan = await getMarketingPlan(context.user, context.project.id, planId); }
  catch (error) { if (error instanceof MarketingPlanStoreError && error.status === 404) notFound(); throw error; }
  const revision = plan.revisions.find((item) => item.revision === plan.currentRevision);
  if (!revision) notFound();
  const canApprove = await isAdminOfOrganisation(context.user, context.organisationId);
  return <main className="mx-auto w-full max-w-6xl px-4 pb-12"><PlanEditor slug={projectRef(org, project)} plan={plan} revision={revision} canApprove={canApprove} /></main>;
}
