import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  findTarget: vi.fn(),
  prove: vi.fn(),
  record: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT ${path}`);
  }),
  after: vi.fn(),
  kick: vi.fn<(db: unknown, checkId: string) => Promise<void>>(async () => undefined),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("@/lib/security-checks/engine", () => ({ kickCheck: mocks.kick }));
vi.mock("@/lib/auth-helpers", () => ({ requireUser: vi.fn().mockResolvedValue({ id: "u1", role: "member" }) }));
vi.mock("@/lib/organisation-access", () => ({ currentOrganisationAccess: mocks.access }));
vi.mock("@/lib/prisma", () => ({ prisma: { securityTarget: { findFirst: mocks.findTarget } } }));
vi.mock("@/lib/security-checks/ownership", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security-checks/ownership")>()),
  proveOwnership: mocks.prove,
  recordOwnership: mocks.record,
}));

import { verifySecurityTarget } from "./security-ownership";

const target = { id: "t1", organisationId: "org1", kind: "website", value: "settle.ng", ownershipToken: "ziki-verify-x", verifiedAt: null };

const PROOF = "SECURITY_OWNERSHIP_PROOF_REQUIRED";
const proofBefore = process.env[PROOF];

beforeEach(() => {
  vi.clearAllMocks();
  // The proof flow below runs with the setting on (14 Nov plan: off by default, kept for later).
  process.env[PROOF] = "true";
  mocks.access.mockResolvedValue({ organisationId: "org1", admin: false });
  mocks.findTarget.mockResolvedValue(target);
  mocks.record.mockResolvedValue({ checkId: "c1", queued: ["c1"] });
});

afterEach(() => {
  if (proofBefore === undefined) delete process.env[PROOF];
  else process.env[PROOF] = proofBefore;
});

describe("verifySecurityTarget with ownership proof off (14 Nov plan, D1)", () => {
  it("checks and records nothing and goes back to Security", async () => {
    delete process.env[PROOF];
    await expect(verifySecurityTarget("t1")).rejects.toThrow("REDIRECT /security");
    expect(mocks.findTarget).not.toHaveBeenCalled();
    expect(mocks.prove).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("treats any value but \"true\" as off", async () => {
    process.env[PROOF] = "false";
    await expect(verifySecurityTarget("t1")).rejects.toThrow("REDIRECT /security");
    expect(mocks.prove).not.toHaveBeenCalled();
  });
});

describe("verifySecurityTarget (#security-checks part 2)", () => {
  it("only reads targets in the client's own workspace", async () => {
    mocks.findTarget.mockResolvedValue(null);
    expect(await verifySecurityTarget("t1")).toEqual({ error: "That site isn't in this workspace." });
    expect(mocks.findTarget).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "t1", organisationId: "org1" } }));
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("lets no check start while no proof is there, and says why for each way", async () => {
    mocks.prove.mockImplementation(async (_target, method: string) => ({ ok: false, reason: `no ${method}` }));
    expect(await verifySecurityTarget("t1")).toEqual({ missing: { dns_txt: "no dns_txt", html_tag: "no html_tag" } });
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("records the first way that is there and goes back to Assets, where the free scan runs", async () => {
    mocks.prove.mockImplementation(async (_target, method: string) => (method === "html_tag" ? { ok: true } : { ok: false, reason: "no" }));
    await expect(verifySecurityTarget("t1")).rejects.toThrow("REDIRECT /security?check=c1");
    expect(mocks.record).toHaveBeenCalledWith("t1", "org1", "u1", "html_tag");
  });

  it("proves a server only by the file on it", async () => {
    mocks.findTarget.mockResolvedValue({ ...target, kind: "server", value: "8.8.4.4" });
    mocks.prove.mockResolvedValue({ ok: false, reason: "no" });
    expect(await verifySecurityTarget("t1")).toEqual({ missing: { server_file: "no" } });
    expect(mocks.prove.mock.calls.map((call) => call[1])).toEqual(["server_file"]);
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("never asks a proven target again", async () => {
    mocks.findTarget.mockResolvedValue({ ...target, verifiedAt: new Date() });
    await expect(verifySecurityTarget("t1")).rejects.toThrow("REDIRECT /security?check=c1");
    expect(mocks.prove).not.toHaveBeenCalled();
  });

  it("starts every check it let go at once, after the response, instead of waiting for the sweep", async () => {
    mocks.record.mockResolvedValue({ checkId: "c1", queued: ["c1", "c2"] });
    mocks.prove.mockResolvedValue({ ok: true });
    await expect(verifySecurityTarget("t1")).rejects.toThrow("REDIRECT /security?check=c1");
    // Nothing is started before the response: only scheduled.
    expect(mocks.kick).not.toHaveBeenCalled();
    expect(mocks.after).toHaveBeenCalledTimes(1);
    await mocks.after.mock.calls[0]![0]();
    expect(mocks.kick.mock.calls.map((call) => call[1])).toEqual(["c1", "c2"]);
  });

  it("schedules nothing when no check is waiting", async () => {
    mocks.record.mockResolvedValue({ checkId: null, queued: [] });
    mocks.prove.mockResolvedValue({ ok: true });
    await expect(verifySecurityTarget("t1")).rejects.toThrow("REDIRECT /security");
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("starts nothing while no proof is there", async () => {
    mocks.prove.mockResolvedValue({ ok: false, reason: "no" });
    await verifySecurityTarget("t1");
    expect(mocks.after).not.toHaveBeenCalled();
    expect(mocks.kick).not.toHaveBeenCalled();
  });
});
