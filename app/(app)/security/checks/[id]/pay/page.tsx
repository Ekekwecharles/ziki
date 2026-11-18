import Link from "next/link";
import { notFound } from "next/navigation";
import type { SecuritySeverity } from "@prisma/client";
import { requireUser } from "@/lib/auth-helpers";
import { currentOrganisationAccess } from "@/lib/organisation-access";
import { prisma } from "@/lib/prisma";
import { walletBalance } from "@/lib/coins/ledger";
import { CHECK_STATUS_LABEL, TARGET_KIND_LABEL, isReportPosted } from "@/lib/security-checks";
import { findingPrice } from "@/lib/security-checks/payment";
import { SECURITY_SEVERITIES, SEVERITY_LABEL } from "@/lib/security-severity";
import { KindIcon } from "@/components/security-checks/entry-box";
import { UnlockFixesForm, type UnlockRow } from "@/components/security-checks/unlock-fixes-form";
import { ZikAmount } from "@/components/zik-symbol";

export const metadata = { title: "Unlock fixes" };

/**
 * Unlock fixes (#security-checks, plan C1). The scan is free; each finding
 * costs its severity's price to unlock (critical 5, high 3, medium 2, low 1
 * Ziks), and the client unlocks all of them or the ones they pick. The report
 * links here with `?results=id1,id2` to preselect. A locked finding's title
 * and details never reach this page: only its severity and price.
 */
export default async function UnlockFixesPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ results?: string | string[] }>;
}) {
  const [{ id }, query, user] = await Promise.all([params, searchParams ?? Promise.resolve({} as { results?: string | string[] }), requireUser()]);
  const access = await currentOrganisationAccess(user.id, user.role);
  if (!access.organisationId) notFound();

  const check = await prisma.securityCheck.findFirst({
    // Only the person who asked for the check can see or unlock it.
    where: { id, organisationId: access.organisationId, requestedById: user.id },
    select: {
      id: true,
      status: true,
      postedAt: true,
      target: { select: { kind: true, value: true } },
      // Severity, price and whether it's unlocked: never the title or details here.
      results: { select: { id: true, severity: true, priceCoins: true, unlockedAt: true } },
    },
  });
  if (!check) notFound();

  const balance = await walletBalance(prisma, user.id);
  const back = `/security?check=${encodeURIComponent(check.id)}`;
  const site = check.target.value;
  const kind = check.target.kind;
  const posted = isReportPosted(check);
  const rows = toRows(check.results);
  const preselected = typeof query.results === "string" ? query.results.split(",").filter(Boolean) : [];

  return (
    <div className="mx-auto flex w-full max-w-[560px] flex-col pb-12 pt-2">
      <Link href={back} className="inline-flex w-fit items-center gap-1.5 text-sm text-zk-text2 hover:text-zk-text">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
        Assets
      </Link>

      {/* The site breaks only when it can't fit a line, not mid-word on every phone. */}
      <h1 className="mb-0 mt-8 text-2xl font-bold leading-tight tracking-tight text-zk-text sm:text-[28px]">
        Unlock fixes for <span className="wrap-break-word">{site}</span>
      </h1>
      <p className="mb-0 mt-2 text-[15px] leading-relaxed text-zk-text2">
        Unlock a finding to see what&apos;s wrong in full and how to fix it. You pay per finding, by how serious it is.
      </p>

      <div className="mt-6 flex items-center gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-zk-border bg-zk-surface">
          <KindIcon kind={kind} className="h-[18px] w-[18px] text-zk-text2" />
        </span>
        <p className="m-0 min-w-0 text-[15px]">
          <span className="font-semibold text-zk-text">{site}</span>
          <span className="text-zk-muted"> · {TARGET_KIND_LABEL[kind]}</span>
        </p>
      </div>

      <div className="mt-5">
        {!posted ? (
          <div role="status" className="rounded-2xl border border-zk-border bg-zk-surface px-5 py-4">
            <p className="m-0 font-semibold text-zk-text">The report isn&apos;t ready yet</p>
            <p className="m-0 mt-1 text-sm text-zk-text2">
              {check.status === "awaiting_ownership"
                ? `Show ${site} is yours first, then the scan starts.`
                : `Status: ${CHECK_STATUS_LABEL[check.status]}. You can unlock fixes once the report is posted.`}
            </p>
            <Link href={back} className="mt-3 inline-flex text-sm font-semibold text-zk-accent hover:underline">Back to assets</Link>
          </div>
        ) : rows.length === 0 ? (
          <div role="status" className="rounded-2xl border border-zk-border bg-zk-surface px-5 py-4">
            <p className="m-0 font-semibold text-zk-ok-fg">No problems found</p>
            <p className="m-0 mt-1 text-sm text-zk-text2">Agents checked {site} and found nothing to fix, so there&apos;s nothing to unlock.</p>
          </div>
        ) : rows.every((row) => row.unlocked) ? (
          <div role="status" className="rounded-2xl border border-zk-border bg-zk-surface px-5 py-4">
            <p className="m-0 font-semibold text-zk-ok-fg">Every fix is unlocked</p>
            <p className="m-0 mt-1 text-sm text-zk-text2">Open the report to read each problem and how to fix it.</p>
            <Link href={`/security/checks/${check.id}`} className="mt-3 inline-flex text-sm font-semibold text-zk-accent hover:underline">Open the report</Link>
          </div>
        ) : (
          <UnlockFixesForm checkId={check.id} rows={rows} preselected={preselected} backHref={back} />
        )}
      </div>

      <p className="mb-0 mt-6 text-center text-xs text-zk-muted">
        Prices: critical <ZikAmount amount={5} />, high <ZikAmount amount={3} />, medium <ZikAmount amount={2} />, low <ZikAmount amount={1} />. You have <ZikAmount amount={balance} />.{" "}
        <Link href="/coins" className="font-semibold text-zk-accent hover:underline">Buy Ziks</Link>
      </p>
    </div>
  );
}

/** Worst first, numbered within each severity ("High problem 2"), so no locked title is needed. */
function toRows(results: { id: string; severity: SecuritySeverity; priceCoins: number | null; unlockedAt: Date | null }[]): UnlockRow[] {
  const order = new Map(SECURITY_SEVERITIES.map((severity, index) => [severity, index]));
  const sorted = [...results].sort((a, b) => (order.get(a.severity) ?? 9) - (order.get(b.severity) ?? 9) || a.id.localeCompare(b.id));
  const seen = new Map<SecuritySeverity, number>();
  return sorted.map((result) => {
    const n = (seen.get(result.severity) ?? 0) + 1;
    seen.set(result.severity, n);
    return {
      id: result.id,
      severity: result.severity,
      label: `${SEVERITY_LABEL[result.severity]} problem ${n}`,
      price: findingPrice(result),
      unlocked: result.unlockedAt !== null,
    };
  });
}
