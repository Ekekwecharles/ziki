import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { siteContextNote } from "./site-chat";
import type { PreviewSummary } from "./preview-summary";

const quick = {
  kind: "website",
  target: "settle.ng",
  checkedAt: "2026-11-14T10:00:00.000Z",
  total: 2,
  counts: { critical: 0, high: 0, medium: 1, low: 1 },
  risk: "medium",
  areas: [],
  rows: [
    { severity: "medium", area: "headers", price: 2, label: "Security headers", title: "No Content Security Policy" },
    { severity: "low", area: "cookies", price: 1, label: "Cookies", title: "Scripts on the page can read cookies" },
  ],
} as PreviewSummary;

describe("what the site chat tells Claude (#security-checks)", () => {
  it("gives the quick scan's counts and public titles, and the report's counts", () => {
    const note = siteContextNote("settle.ng", quick, { posted: true, findings: 4, unlocked: 1 });
    expect(note).toContain("Site: settle.ng.");
    expect(note).toContain("2 problems (1 medium, 1 low)");
    expect(note).toContain("- medium: No Content Security Policy (Security headers)");
    expect(note).toContain("ready, 4 findings, 1 unlocked");
  });

  it("says when there's no quick scan and the agents are still checking", () => {
    const note = siteContextNote("github.com/settle/app", null, { posted: false, findings: 0, unlocked: 0 });
    expect(note).toContain("No quick browser scan");
    expect(note).toContain("agents are still checking it");
  });
});
