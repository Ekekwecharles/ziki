import { redirect } from "next/navigation";

/**
 * The old "Add asset" page (#security-checks). Security is one page now
 * (14 Nov plan), so old links, and the public page's sign-up, land there,
 * carrying the address they scanned.
 */
export default async function NewSecurityCheckPage(props: { searchParams?: Promise<{ target?: string | string[] }> }) {
  const params = (await props.searchParams) ?? {};
  const target = typeof params.target === "string" ? params.target : "";
  redirect(target ? `/security?target=${encodeURIComponent(target)}` : "/security");
}
