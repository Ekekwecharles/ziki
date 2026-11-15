import Link from "next/link";
import { notFound } from "next/navigation";
import { loadMovePage } from "@/lib/security-checks/fix";
import { requireUser } from "@/lib/auth-helpers";
import { currentOrganisationAccess } from "@/lib/organisation-access";
import { isSuperAdmin } from "@/lib/roles";
import { FixOnZiki } from "@/components/security-checks/fix-on-ziki";

export const metadata = { title: "Move to your app" };

export default async function MoveFindingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const access = await currentOrganisationAccess(user.id, user.role);
  if (!access.organisationId || !access.membershipRole) notFound();
  const check = await loadMovePage({
    userId: user.id,
    organisationId: access.organisationId,
    superAdmin: isSuperAdmin(user.role),
  }, id);
  if (!check) notFound();

  return (
    <main className="mx-auto w-full max-w-2xl space-y-6 px-4 pb-12 pt-5 sm:px-6 sm:pt-8">
      <Link className="inline-flex items-center gap-2 text-sm font-medium text-zk-accent hover:underline" href={`/security/checks/${encodeURIComponent(id)}`}>
        <span aria-hidden="true">←</span> Back to report
      </Link>
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-zk-text sm:text-3xl">Move to your app</h1>
        <p className="mt-1 break-all text-sm text-zk-text2">{check.asset}</p>
      </header>
      {!check.posted ? <p role="status">You can move findings once the report is posted.</p>
        : check.results.length === 0 ? <p role="status">There are no findings to move.</p>
        : <FixOnZiki checkId={id} results={check.results} standalone />}
    </main>
  );
}
