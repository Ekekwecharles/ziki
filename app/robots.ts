import type { MetadataRoute } from "next";
import { absoluteUrl } from "@/lib/site-url";

/**
 * Owns robots.txt rather than letting the platform generate it (#224).
 *
 * The previous file was only Vercel's auto-injected content-signals comment
 * block: no `User-agent` rules, no `Disallow`, and no `Content-Signal`
 * directives despite the preamble describing them at length.
 *
 * Issue pages (`/<org>/<project>/<number>`) and the public docs (`/docs`) are
 * intentionally left crawlable. Link previews are a supported feature (Slack /
 * WhatsApp / Discord unfurls of shared issue links), and those crawlers do
 * fetch the URL; docs are public reading before sign-up. Everything that must
 * not be walked - admin, settings, the API, agent pictures and the auth pages -
 * is disallowed here. Read access to issue pages for link-preview clients is a
 * separate, deliberate concern tracked in the User-Agent spoofing report.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          "/superadmin",
          "/settings",
          "/api/",
          // Agent pictures are response bytes, never pages to index.
          "/api/agent-pictures/",
          "/login",
          "/signup",
          // The sign-in callback is a control parameter, not a page of its own.
          "/signup?callbackUrl=*",
          "/forgot-password",
          "/reset-password",
          // Invite links, short business links and signed-in pages: nothing for search (#seo-pages).
          "/join",
          "/r/",
          "/session-expired",
          "/home",
          "/organisations",
          "/agents/mine",
          "/skills/contribute",
          // Malformed paths a crawler can stumble on from a broken link.
          "/$",
          "/&",
        ],
      },
    ],
    // Points crawlers at the sitemap (#310), on the configured origin.
    sitemap: absoluteUrl("/sitemap.xml"),
  };
}