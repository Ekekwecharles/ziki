import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("@/components/theme-toggle", () => ({ useTheme: () => ["light", vi.fn()], applyThemeClient: vi.fn() }));

import { siteNavHref } from "@/components/homepage/site-nav";

describe("Security in the public site's menu (#security-checks)", () => {
  it("opens the public Security page, logged in or out", () => {
    expect(siteNavHref("/security", false)).toBe("/security");
    expect(siteNavHref("/security", true)).toBe("/security-check");
  });

  it("leaves every other link alone", () => {
    expect(siteNavHref("/how-it-works", true)).toBe("/how-it-works");
    expect(siteNavHref("/agents", false)).toBe("/agents");
  });
});
