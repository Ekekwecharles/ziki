import { requireProject } from "@/lib/project-route";
import { projectRef } from "@/lib/project-paths";
import { Library } from "@/components/marketing/library/library";
import type { LibraryResult } from "@/components/marketing/library/model";
import { readLibrary } from "./data";

export const metadata = { title: "Output box" };

export default async function LibraryPage({ params }: { params: Promise<{ org: string; project: string }> }) {
  const { org, project: projectSlug } = await params;
  const slug = projectRef(org, projectSlug);
  const context = await requireProject(org, projectSlug);
  let result: LibraryResult;
  try {
    result = { ok: true, items: await readLibrary(context) };
  } catch (error) {
    console.error("[library] Failed to read published marketing deliveries", error);
    result = { ok: false };
  }
  return <Library slug={slug} initial={result} />;
}
