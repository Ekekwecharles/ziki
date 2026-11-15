import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import authConfig from "@/auth.config";
import { isLinkPreviewBot } from "@/lib/link-preview";
import { BASE_PATH, toAppPath } from "@/lib/base-path";
import { isProjectIssuePath, isReservedProjectSlug, projectOverviewSegments } from "@/lib/project-slug";
import { isProjectFirstPath } from "@/lib/project-paths";
import { isPublicAgentPath } from "@/lib/public-agent-paths";
import { publicIntakeSegments } from "@/lib/public-project-paths";
import { safeCallbackUrl } from "@/lib/safe-callback-url";

/**
 * Edge-only auth wrapper — initialized from auth.config (no Prisma/bcrypt).
 * Importing `@/auth` here balloons the Edge Function past Vercel's 1 MB limit
 * and leaves production stuck on the old getToken middleware (redirect loops).
 */
const { auth } = NextAuth(authConfig);

/** A project's agent work feed: `/<org>/<project>/work`. */
const PROJECT_WORK_PATH = /^\/[^/]+\/[^/]+\/work\/?$/;

export function isPublicPath(
  pathWithoutBase: string,
  userAgent?: string | null,
): boolean {
  const isAuthPage =
    pathWithoutBase.startsWith("/login") || pathWithoutBase.startsWith("/signup");
  const isPasswordResetPage =
    pathWithoutBase.startsWith("/forgot-password") ||
    pathWithoutBase.startsWith("/reset-password");
  const isIssuePreview =
    isProjectIssuePath(pathWithoutBase) &&
    isLinkPreviewBot(userAgent);

  return (
    pathWithoutBase === "/" ||
    pathWithoutBase === "" ||
    pathWithoutBase === "/llms.txt" ||
    // The public marketing pages beside the homepage.
    pathWithoutBase === "/how-it-works" ||
    pathWithoutBase === "/for-agents" ||
    pathWithoutBase === "/developers" ||
    // Ziki Security's public page (#security-checks, C2): /security signed out (only the exact
    // path; every /security/* page still needs signing in), and /security-check for anyone.
    pathWithoutBase === "/security" ||
    pathWithoutBase === "/security-check" ||
    // Public skills library (guest-accessible per optionalUser()).
    pathWithoutBase === "/skills" ||
    pathWithoutBase.startsWith("/skills/") ||
    // The public comparison directory and every comparison page (#compare).
    pathWithoutBase === "/compare" ||
    pathWithoutBase.startsWith("/compare/") ||
    // Old business links from earners' emails (#earn-outreach): opened by people who aren't signed in.
    /^\/r\/[a-z0-9]{4,16}$/.test(pathWithoutBase) ||
    isAuthPage ||
    isPasswordResetPage ||
    isPublicAgentPath(pathWithoutBase) ||
    isIssuePreview ||
    pathWithoutBase === "/" ||
    pathWithoutBase.startsWith("/session-expired") ||
    // Shareable invite links (#444). Guests must see the organisation and
    // sign in with Google before the link is used; the page itself never
    // spends a use.
    pathWithoutBase === "/join" ||
    pathWithoutBase.startsWith("/join/") ||
    pathWithoutBase === "/discover" ||
    pathWithoutBase.startsWith("/discover?") ||
    // Opt-in guest report forms and private tracking links (#3464), nested
    // below the existing public project overview.
    publicIntakeSegments(pathWithoutBase) !== null ||
    pathWithoutBase.startsWith("/api/public/") ||
    pathWithoutBase.startsWith("/api/auth") ||
    pathWithoutBase.startsWith("/api/health") ||
    // The scheduler calls the platform sweeps with Bearer CRON_SECRET and no
    // session (#571); the route rejects a wrong or missing secret itself.
    pathWithoutBase === "/api/internal/cron" ||
    // GitHub's webhooks (#github-status) carry no session; the route checks
    // their signature against GITHUB_WEBHOOK_SECRET itself.
    pathWithoutBase === "/api/github/webhook" ||
    // Stripe's webhooks (#ziki-coins) carry no session; the route verifies the
    // signature against STRIPE_WEBHOOK_SECRET itself.
    pathWithoutBase === "/api/stripe/webhook" ||
    // The agent API (#427) authenticates every call with an agent key, not a
    // session; each route rejects a request without one.
    pathWithoutBase.startsWith("/api/v1/") ||
    pathWithoutBase.startsWith("/_next") ||
    projectOverviewSegments(pathWithoutBase) !== null ||
    pathWithoutBase === "/favicon.ico"
  );
}

export default auth((req) => {
  const pathWithoutBase = toAppPath(req.nextUrl.pathname);
  const isLoggedIn = !!req.auth?.user;

  if (pathWithoutBase.startsWith("/api/bugs/")) {
    const newPath = pathWithoutBase.replace(/^\/api\/bugs\//, "/api/issues/");
    const targetUrl = new URL(
      BASE_PATH ? `${BASE_PATH}${newPath}` : newPath,
      req.nextUrl.origin,
    );
    targetUrl.search = req.nextUrl.search;
    return NextResponse.redirect(targetUrl, 308);
  }

  const isAuthPage =
    pathWithoutBase.startsWith("/login") || pathWithoutBase.startsWith("/signup");
  const isPublic = isPublicPath(pathWithoutBase, req.headers.get("user-agent"));

  // An agent watching `/<org>/<project>/work` (#work-feed) authenticates with its
  // key, not a session; the route rejects a missing or wrong one.
  const isAgentWorkFeed =
    PROJECT_WORK_PATH.test(pathWithoutBase) &&
    (req.headers.get("authorization") ?? "").startsWith("Bearer ");


  if (!isLoggedIn && !isPublic && !isAgentWorkFeed) {
    const url = new URL(
      BASE_PATH ? `${BASE_PATH}/login` : "/login",
      req.nextUrl.origin,
    );
    url.searchParams.set("callbackUrl", callbackPath(pathWithoutBase, req.nextUrl));
    return NextResponse.redirect(url);
  }

  // Allow reset links even when a session exists; only bounce login/signup.
  // Signed-in people land on the Overview, the post-login home.
  if (isLoggedIn && isAuthPage) {
    const callback = pathWithoutBase === "/login" ? safeCallbackUrl(req.nextUrl.searchParams.get("callbackUrl")) : "/home";
    return NextResponse.redirect(
      new URL(BASE_PATH ? `${BASE_PATH}${callback}` : callback, req.nextUrl.origin),
    );
  }

  // /superadmin role checks live in the pages and actions (requireAdmin /
  // requireSuperAdmin), which read the current role from the database. The
  // JWT role is only refreshed at sign-in, so checking it here bounced newly
  // promoted admins until they signed out and back in (#121).

  // An address from before organisations were in URLs, `/<project>/ideas` or
  // `/<project>/740` (#project-urls): /projects/moved finds the project's
  // organisation and sends the person on to `/<org>/<project>/…`.
  const first = decodeSegment(pathWithoutBase.split("/")[1] ?? "");
  if (isLoggedIn && first && !isReservedProjectSlug(first) && isProjectFirstPath(pathWithoutBase)) {
    const moved = new URL(BASE_PATH ? `${BASE_PATH}/projects/moved` : "/projects/moved", req.nextUrl.origin);
    moved.searchParams.set("to", `${pathWithoutBase}${req.nextUrl.search}`);
    return NextResponse.redirect(moved);
  }

  // The app layout reads x-ziki-path to give a guest on a public agent page a
  // plain shell; project pages read x-ziki-url to come back after switching organisation.
  const forwarded = new Headers(req.headers);
  forwarded.set("x-ziki-path", pathWithoutBase);
  forwarded.set("x-ziki-url", `${pathWithoutBase}${req.nextUrl.search}`);
  return NextResponse.next({ request: { headers: forwarded } });
});

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Keeps the agent approval code across the sign-in redirect. Other queries stay off the callback. */
function callbackPath(path: string, url: URL): string {
  // Issue permalinks carry comment targets and view parameters in the query.
  // Preserve them through login; the sign-in handler validates the callback.
  if (/^\/[^/]+\/[^/]+\/[0-9]{1,9}\/?$/.test(path)) return `${path}${url.search}`;
  if (path !== "/settings/agents/pair") return path;
  const code = url.searchParams.get("code") ?? "";
  if (!/^[A-Za-z0-9-]{1,20}$/.test(code)) return path;
  return `${path}?code=${code}`;
}

export const config = {
  matcher: ["/((?!api/auth|_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
