import Link from "next/link";
import { notFound } from "next/navigation";
import "@/components/security-finding.css";
import { requireUser } from "@/lib/auth-helpers";
import { currentOrganisationAccess } from "@/lib/organisation-access";
import { THREAT_LABEL } from "@/lib/security-checks/check-list";
import { loadCheckFinding } from "@/lib/security-checks/finding-page";
import { ZikAmount } from "@/components/zik-symbol";

export const metadata = { title: "Security finding" };

const WHAT_IT_MEANS = {
  critical: "Someone could take over accounts, read other people's data or run their own code. Fix this first.",
  high: "Secrets or private pages could be reached by people who shouldn't see them.",
  medium: "A real weakness, though an attacker would need something else to go wrong too.",
  low: "Hardening: not urgent, but it makes your site harder to attack.",
} as const;

const FIX_STATE = { fixing: "Being fixed", fixed: "Fixed", closed: "Closed" } as const;

const PRIMARY =
  "inline-flex h-10 items-center justify-center gap-2 rounded-full bg-electric-blue-strong px-5 text-sm font-bold text-white hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-electric-blue focus-visible:ring-offset-2";

/**
 * One finding of a security check (16 Nov, Hamzat): one section with the threat, where it was found, what's
 * wrong, and "Fix it for me", which sends it to the workspace's project for agents to fix.
 */
export default async function SecurityFindingPage({ params }: { params: Promise<{ id: string; resultId: string }> }) {
  const [{ id, resultId }, user] = await Promise.all([params, requireUser()]);
  const access = await currentOrganisationAccess(user.id, user.role);
  if (!access.organisationId) notFound();
  const finding = await loadCheckFinding(id, resultId, access.organisationId, user.id);
  if (!finding) notFound();

  const fixHref = `/security/checks/${encodeURIComponent(finding.checkId)}?fix=${encodeURIComponent(finding.id)}#fix-panel`;
  const connected = finding.projects.some((project) => project.codeConnected);
  const firstProject = finding.projects[0];

  return (
    <div className="flex w-full flex-col gap-4 pb-10 sm:gap-6">
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center px-0.5 text-[13px] text-zk-text2">
        <ol className="flex min-w-0 flex-wrap items-center gap-0.5">
          <li>
            <Link href="/security" className="block rounded-md px-1.5 py-0.5 font-bold text-zk-text hover:bg-zk-chip">Security</Link>
          </li>
          <li aria-hidden="true" className="text-zk-muted">/</li>
          <li className="min-w-0">
            <Link href={`/security/checks/${encodeURIComponent(finding.checkId)}`} className="block truncate rounded-md px-1.5 py-0.5 hover:bg-zk-chip">{finding.site}</Link>
          </li>
          <li aria-hidden="true" className="text-zk-muted">/</li>
          <li aria-current="page" className="truncate px-1.5">Finding</li>
        </ol>
      </nav>

      <section aria-labelledby="finding-title" className="rounded-[20px] border border-zk-border bg-zk-surface p-4 sm:p-6">
        <p className="m-0 flex flex-wrap items-center gap-2 text-xs text-zk-text2">
          <span className={`security-severity security-severity--${finding.severity} inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-bold`}>
            {THREAT_LABEL[finding.severity]}
          </span>
          <span>Found in: {finding.area}</span>
        </p>
        <h1 id="finding-title" className="mt-2 wrap-break-word text-2xl font-extrabold tracking-[-0.02em] text-zk-text sm:text-[28px]">{finding.title}</h1>
        <p className="mt-1 text-sm font-semibold text-zk-text">{WHAT_IT_MEANS[finding.severity]}</p>
        <div className="mt-4">
          <h2 className="text-sm font-semibold text-zk-text">What we found</h2>
          <p className="mt-1 whitespace-pre-line text-sm text-zk-text2">{finding.description}</p>
        </div>
        {finding.howToFix ? (
          <div className="mt-4">
            <h2 className="text-sm font-semibold text-zk-text">How to fix it</h2>
            <p className="mt-1 whitespace-pre-line text-sm text-zk-text2">{finding.howToFix}</p>
          </div>
        ) : null}

        <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-zk-border pt-4">
          {finding.fix ? (
            <Link href={finding.fix.issue?.href ?? finding.fix.findingHref} className={PRIMARY}>
              {finding.fix.issue ? `Issue #${finding.fix.issue.number}` : "In your app"} · {FIX_STATE[finding.fix.bucket]}
            </Link>
          ) : (
            <>
              <Link href={fixHref} className={PRIMARY}>
                {finding.price ? <span>Fix it for me · <ZikAmount amount={finding.price} /></span> : "Fix it for me"}
              </Link>
              {!connected && firstProject ? (
                <p className="m-0 text-xs text-zk-text2">
                  Agents fix it with a pull request once your code is connected.{" "}
                  <Link href={`/projects/${encodeURIComponent(firstProject.slug)}/settings?section=github`} className="font-semibold text-zk-accent hover:underline">
                    Connect your code
                  </Link>
                </p>
              ) : null}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
