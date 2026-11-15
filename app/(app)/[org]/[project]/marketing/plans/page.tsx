import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { projectRef, marketingPath } from "@/lib/project-paths";
import { requireProject } from "@/lib/project-route";

export const metadata = { title: "Marketing plans" };

export default async function MarketingPlansPage({ params }: { params: Promise<{ org: string; project: string }> }) {
  const { org, project: projectSlug } = await params;
  const context = await requireProject(org, projectSlug);
  const plans = await prisma.marketingPlan.findMany({
    where: { projectId: context.project.id }, orderBy: { updatedAt: "desc" }, take: 50,
    select: { id: true, title: true, updatedAt: true, currentRevision: true },
  });
  const slug = projectRef(org, projectSlug);
  return <main className="mx-auto w-full max-w-6xl px-4 pb-12">
    <header className="mb-6"><p className="text-sm font-semibold text-zk-accent">Marketing</p><h1 className="mt-1 text-2xl font-extrabold text-zk-text">Structured plans</h1><p className="mt-2 max-w-2xl text-sm text-zk-text2">Review and edit saved strategy drafts. Changes here are saved as drafts and never launch campaigns.</p></header>
    {plans.length ? <ul className="grid gap-3">{plans.map((plan) => <li key={plan.id} className="rounded-2xl border border-zk-border bg-zk-surface p-5"><Link className="font-bold text-zk-text hover:text-zk-accent" href={marketingPath(slug, `plans/${encodeURIComponent(plan.id)}`)}>{plan.title}</Link><p className="mt-1 text-sm text-zk-text2">Revision {plan.currentRevision} · Updated {plan.updatedAt.toLocaleDateString()}</p></li>)}</ul> : <section className="rounded-2xl border border-zk-border bg-zk-surface p-6"><h2 className="font-bold text-zk-text">No saved plans yet</h2><p className="mt-2 max-w-2xl text-sm text-zk-text2">Plans will appear here after the marketing strategy context handoff is connected. This page does not create or execute plans.</p></section>}
  </main>;
}
