import { describe, expect, it, vi } from "vitest";

vi.mock("next-auth", () => ({ default: () => ({ auth: (handler: unknown) => handler }) }));
vi.mock("@/auth.config", () => ({ default: {} }));
vi.mock("@/app/actions/security-preview", () => ({ runPublicScan: vi.fn() }));
vi.mock("@/app/actions/security-assistant", () => ({ addSecurityAsset: vi.fn() }));
import { isPublicPath } from "@/middleware";
import { isReservedProjectSlug } from "@/lib/project-slug";
import { addAssetPath } from "@/components/security-checks/public-scan";

describe("Ziki Security's public page (#security-checks, C2)", () => {
  it("is open to everyone, while every other Security page still needs signing in", () => {
    expect(isPublicPath("/security")).toBe(true);
    expect(isPublicPath("/security-check")).toBe(true);
    expect(isPublicPath("/security/new")).toBe(false);
    expect(isPublicPath("/security/targets/t1/verify")).toBe(false);
    expect(isPublicPath("/security/checks/c1/pay")).toBe(false);
    expect(isPublicPath("/security/work")).toBe(false);
  });

  it("can't be taken by an organisation's name", () => {
    expect(isReservedProjectSlug("security-check")).toBe(true);
  });

  it("brings the scanned address through sign-up to the Security page, where its scan starts", () => {
    expect(addAssetPath("yourshop.com")).toBe("/security?target=yourshop.com");
    expect(addAssetPath("api.shop.ng:8443")).toBe("/security?target=api.shop.ng%3A8443");
  });
});
