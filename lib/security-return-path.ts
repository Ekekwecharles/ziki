import { safeCallbackUrl } from "@/lib/safe-callback-url";

/**
 * Where to go after creating an organisation (#security-checks): only back to
 * Security, carrying the site scanned on the public page, so that person's
 * scan carries on. Anything else is null, and creating goes home as before.
 */
export function securityReturnPath(value: FormDataEntryValue | string | null | undefined): string | null {
  const path = safeCallbackUrl(value, "");
  return path === "/security" || path.startsWith("/security?") ? path : null;
}
