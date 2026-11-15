import { RejectedIdeas } from "@/components/marketing/rejected-ideas/rejected-ideas";
import type { RejectedIdeasResult } from "@/components/marketing/rejected-ideas/model";
import { projectRef } from "@/lib/project-paths";
import { requireProject } from "@/lib/project-route";
import { readRejectedIdeas } from "./data";

export const metadata = { title: "Rejected ideas" };

type Props = {
  params: Promise<{ org: string; project: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/** `/<slug>/marketing/ideas/rejected`: marketing ideas a manager rejected, plus archived ones, with their verdicts. */
export default async function RejectedIdeasPage({ params, searchParams }: Props) {
  const { org, project: projectSlug } = await params;
  const slug = projectRef(org, projectSlug);
  const query = await searchParams;
  const context = await requireProject(org, projectSlug);
  let result: RejectedIdeasResult;
  try {
    result = await readRejectedIdeas(context, query.page);
  } catch (error) {
    console.error("[marketing ideas] Failed to read rejected ideas", error);
    result = { ok: false };
  }
  return <RejectedIdeas slug={slug} initial={result} />;
}
