import { describe, expect, it } from "vitest";

import { securityReturnPath } from "@/lib/security-return-path";

describe("after creating a first workspace from Security (#security-checks)", () => {
  it("goes back to Security with the scanned site", () => {
    expect(securityReturnPath("/security?target=yourshop.com")).toBe("/security?target=yourshop.com");
    expect(securityReturnPath("/security")).toBe("/security");
  });

  it("goes nowhere else: other pages, other sites and tricks fall back to home", () => {
    for (const next of ["/settings", "/securityx", "https://evil.example/security", "//evil.example/security", "/login?callbackUrl=/security", null, undefined, ""]) {
      expect(securityReturnPath(next)).toBeNull();
    }
  });
});
