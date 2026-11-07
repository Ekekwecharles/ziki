import { beforeEach, describe, expect, it, vi } from "vitest";

/** Changing the password from Settings (#568): fresh re-authentication, and no agent key survives it. */
const db = vi.hoisted(() => {
  const tx = {
    user: { update: vi.fn() },
    agentApiKey: { updateMany: vi.fn() },
  };
  return {
    tx,
    prisma: {
      user: { findUnique: vi.fn() },
      $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
    },
  };
});
const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  confirmIdentity: vi.fn(),
  consumeAuthRateLimit: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: db.prisma }));
vi.mock("@/lib/auth-helpers", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/lib/two-factor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/two-factor")>()),
  confirmIdentity: mocks.confirmIdentity,
}));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  consumeAuthRateLimit: mocks.consumeAuthRateLimit,
}));
vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(), smtpConfigured: () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));

import { changePasswordAction } from "@/app/actions/settings";
import { WRONG_PASSWORD_MESSAGE } from "@/lib/two-factor";

const form = (fields: Record<string, string> = {}) => {
  const data = new FormData();
  const values = { currentPassword: "old-Password-1", password: "New-Password-42!", confirmPassword: "New-Password-42!", ...fields };
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue({ id: "u1", email: "ada@example.com" });
  mocks.consumeAuthRateLimit.mockResolvedValue({ allowed: true });
  db.prisma.user.findUnique.mockResolvedValue({ email: "ada@example.com", passwordHash: "hash" });
  mocks.confirmIdentity.mockResolvedValue({ ok: true });
});

describe("changePasswordAction (#568)", () => {
  it("re-authenticates with the current password and no code when two-factor is off", async () => {
    expect(await changePasswordAction(undefined, form())).toEqual({ ok: true });
    expect(mocks.confirmIdentity).toHaveBeenCalledWith("u1", { password: "old-Password-1", code: undefined });
  });

  it("revokes the owner's live agent keys in the same transaction as the new password", async () => {
    expect(await changePasswordAction(undefined, form())).toEqual({ ok: true });
    expect(db.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(db.tx.user.update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { passwordHash: expect.any(String), sessionVersion: { increment: 1 } },
    });
    expect(db.tx.agentApiKey.updateMany).toHaveBeenCalledWith({
      where: { revokedAt: null, agent: { ownerUserId: "u1" } },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it("passes the code to the identity check when two-factor is on", async () => {
    expect(await changePasswordAction(undefined, form({ code: "123456" }))).toEqual({ ok: true });
    expect(mocks.confirmIdentity).toHaveBeenCalledWith("u1", { password: "old-Password-1", code: "123456" });
  });

  it("refuses without the code when two-factor is on, and changes nothing", async () => {
    mocks.confirmIdentity.mockResolvedValue({ ok: false, error: "Enter a code from your authenticator app or a backup code." });
    const result = await changePasswordAction(undefined, form());
    expect(result).toMatchObject({ error: "Enter a code from your authenticator app or a backup code.", field: "code" });
    expect(db.prisma.$transaction).not.toHaveBeenCalled();
    expect(db.tx.agentApiKey.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a wrong code, and changes nothing", async () => {
    mocks.confirmIdentity.mockResolvedValue({ ok: false, error: "That code isn't right." });
    expect(await changePasswordAction(undefined, form({ code: "000000" }))).toMatchObject({ field: "code" });
    expect(db.prisma.$transaction).not.toHaveBeenCalled();
    expect(db.tx.agentApiKey.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a wrong current password on its own field, and changes nothing", async () => {
    mocks.confirmIdentity.mockResolvedValue({ ok: false, error: WRONG_PASSWORD_MESSAGE });
    expect(await changePasswordAction(undefined, form())).toMatchObject({
      error: "Your current password is incorrect.",
      field: "currentPassword",
    });
    expect(db.prisma.$transaction).not.toHaveBeenCalled();
    expect(db.tx.agentApiKey.updateMany).not.toHaveBeenCalled();
  });

  it("passes other identity errors (too many attempts) through unchanged", async () => {
    mocks.confirmIdentity.mockResolvedValue({ ok: false, error: "Too many attempts. Wait a few minutes and try again." });
    expect(await changePasswordAction(undefined, form())).toEqual({ error: "Too many attempts. Wait a few minutes and try again." });
    expect(db.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("answers the rate limit before checking any credential", async () => {
    mocks.consumeAuthRateLimit.mockResolvedValue({ allowed: false });
    expect(await changePasswordAction(undefined, form())).toMatchObject({ error: expect.any(String) });
    expect(mocks.confirmIdentity).not.toHaveBeenCalled();
  });

  it("refuses an account with no password", async () => {
    db.prisma.user.findUnique.mockResolvedValue({ email: "ada@example.com", passwordHash: null });
    expect(await changePasswordAction(undefined, form())).toEqual({ error: "Password changes are only available for password-based accounts." });
    expect(mocks.confirmIdentity).not.toHaveBeenCalled();
  });
});
