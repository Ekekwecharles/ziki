import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { PRODUCT_TRACK } from "@/lib/marketing/track";
import { checkOptions, loadProofRules } from "@/lib/proof";
import { ProofRulesEditor } from "@/components/proof-rules-editor";
import { loadOrg } from "../org-context";
import { OrgPageHeader } from "../org-ui";

export const metadata = { title: "Checks" };

/**
 * What every project in the organisation must prove (#deeper-testing): checks
 * for every issue and per issue type, and the checks the owners write. Only
 * owners reach it; a project shows these read-only in its own Checks.
 */
export default async function OrgChecksPage() {
  const { org } = await loadOrg();
  if (!org?.owner) notFound();
  const [rules, types] = await Promise.all([
    loadProofRules(prisma, org.id),
    prisma.issueType.findMany({ where: { organisationId: org.id, isActive: true, ...PRODUCT_TRACK }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
  return (
    <div className="space-y-4">
      <OrgPageHeader title="Checks">
        What every project in {org.name} must prove before a fix counts as tested. Builds and tests are already read from the pull request. Each project adds its own on top, in its settings.
      </OrgPageHeader>
      <section className="flex flex-col gap-4 rounded-[20px] border border-zk-border bg-zk-surface p-5 sm:p-6">
        <div className="flex flex-col gap-1">
          <h3 className="m-0 text-lg font-bold text-zk-text">For every project</h3>
          <p className="m-0 text-sm text-zk-text2">
            Every project in {org.name} starts with these. A project can add checks for its own areas, but can&apos;t remove these. Rules by issue type live here, since types belong to the organisation.
          </p>
        </div>
        <ProofRulesEditor projectId={null} rules={rules.rules.filter((r) => !r.projectId)} checks={checkOptions(rules)} scopes={types} editable />
      </section>
    </div>
  );
}
