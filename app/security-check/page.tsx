import { auth } from "@/auth";
import { SecurityPublicPage, securityPublicMetadata } from "@/components/security-checks/security-public-page";

// The same page as /security signed out, for people already signed in; Google is pointed at /security.
export const metadata = securityPublicMetadata;

export default async function SecurityCheckPage() {
  const session = await auth();
  return <SecurityPublicPage signedIn={Boolean(session?.user)} />;
}
