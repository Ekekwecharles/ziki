import type { Metadata } from "next";

import { LoadError } from "@/components/load-error";
import { MarketingSettings } from "@/components/marketing/settings/settings";
import { projectRef } from "@/lib/project-paths";
import { logLoadFailure } from "@/lib/load-error";
import { requireProject } from "@/lib/project-route";

import { readMarketingSettings } from "./data";

export const metadata: Metadata = { title: "Marketing settings" };

/**
 * `/<slug>/marketing/settings`: the project's marketing brief, task types and
 * revision limit (M-UI-7). Organisation owners and admins manage it; members read
 * it. Reachable by address until M-LAUNCH-1 adds the section's navigation.
 */
export default async function MarketingSettingsPage({ params }: { params: Promise<{ org: string; project: string }> }) {
  const { org, project: projectSlug } = await params;
  const slug = projectRef(org, projectSlug);
  const context = await requireProject(org, projectSlug);

  let data;
  try {
    data = await readMarketingSettings(context);
  } catch (error) {
    return (
      <LoadError
        title="Marketing settings could not be loaded"
        reference={logLoadFailure("[marketing settings] read failed", error)}
      />
    );
  }
  return <MarketingSettings slug={slug} data={data} />;
}
