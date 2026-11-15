import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  unlockFindings: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT ${path}`);
  }),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/auth-helpers", () => ({ requireUser: vi.fn().mockResolvedValue({ id: "u1", role: "member" }) }));
vi.mock("@/lib/organisation-access", () => ({ currentOrganisationAccess: mocks.access }));
vi.mock("@/lib/security-checks/payment", () => ({ unlockFindings: mocks.unlockFindings }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { unlockSecurityFindings } from "./security-checks";

describe("unlockSecurityFindings (#security-checks, plan C1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.access.mockResolvedValue({ organisationId: "org1", admin: true });
  });

  it("refuses anyone who is not an owner or admin", async () => {
    mocks.access.mockResolvedValue({ organisationId: "org1", admin: false });
    await expect(unlockSecurityFindings("c1", "all")).resolves.toEqual({ error: expect.stringContaining("owners and admins") });
    expect(mocks.unlockFindings).not.toHaveBeenCalled();
  });

  it("unlocks all or the chosen findings on the person's own check, then goes back to Your sites", async () => {
    mocks.unlockFindings.mockResolvedValue({ ok: true, unlocked: 3, coins: 9 });
    await expect(unlockSecurityFindings("c1", "all")).rejects.toThrow("REDIRECT /security?check=c1&unlocked=3");
    expect(mocks.unlockFindings).toHaveBeenCalledWith("c1", "org1", "u1", "all");

    mocks.unlockFindings.mockResolvedValue({ ok: true, unlocked: 1, coins: 3 });
    await expect(unlockSecurityFindings("c1", ["r2"])).rejects.toThrow("REDIRECT /security?check=c1&unlocked=1");
    expect(mocks.unlockFindings).toHaveBeenLastCalledWith("c1", "org1", "u1", ["r2"]);
  });

  it("needs at least one finding, and says why nothing was unlocked", async () => {
    expect((await unlockSecurityFindings("c1", [])).error).toMatch(/at least one/);
    expect(mocks.unlockFindings).not.toHaveBeenCalled();

    mocks.unlockFindings.mockResolvedValue({ ok: false, reason: "not_posted" });
    expect((await unlockSecurityFindings("c1", "all")).error).toMatch(/isn't ready/);
    mocks.unlockFindings.mockResolvedValue({ ok: false, reason: "not_found" });
    expect((await unlockSecurityFindings("c1", "all")).error).toMatch(/isn't one of yours/);
    mocks.unlockFindings.mockResolvedValue({ ok: false, reason: "nothing_to_unlock" });
    expect((await unlockSecurityFindings("c1", "all")).error).toMatch(/already unlocked/);
  });

  it("needs a workspace", async () => {
    mocks.access.mockResolvedValue({ organisationId: null, admin: false });
    expect((await unlockSecurityFindings("c1", "all")).error).toMatch(/workspace/);
  });
});
