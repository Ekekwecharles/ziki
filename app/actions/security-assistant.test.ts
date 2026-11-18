import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  addTargetAndCheck: vi.fn(),
  ask: vi.fn(),
  rate: vi.fn(),
  preview: vi.fn(),
  saveQuickScan: vi.fn(),
  findScannedCheck: vi.fn(),
  saveSiteMessage: vi.fn(),
  removeOwnScan: vi.fn(),
  findOwnScan: vi.fn(),
  scansNote: vi.fn(),
  kick: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// `after` runs its job once the action answers; here, at once, so a test can see what it starts.
vi.mock("next/server", () => ({ after: (job: () => unknown) => void job() }));
vi.mock("@/lib/security-checks/engine", () => ({ kickCheck: mocks.kick }));
vi.mock("@/lib/auth-helpers", () => ({ requireUser: vi.fn().mockResolvedValue({ id: "u1", role: "member" }) }));
vi.mock("@/lib/organisation-access", () => ({ currentOrganisationAccess: mocks.access }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: mocks.rate, RATE_LIMIT_MESSAGE: "Slow down." }));
vi.mock("@/lib/security-checks/entry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security-checks/entry")>()),
  addTargetAndCheck: mocks.addTargetAndCheck,
  saveQuickScan: mocks.saveQuickScan,
  findScannedCheck: mocks.findScannedCheck,
  removeOwnScan: mocks.removeOwnScan,
  findOwnScan: mocks.findOwnScan,
}));
vi.mock("@/lib/security-checks/assistant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security-checks/assistant")>()),
  askSecurityAssistant: mocks.ask,
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/security-checks/site-chat", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security-checks/site-chat")>()),
  saveSiteMessage: mocks.saveSiteMessage,
  scansContextNote: mocks.scansNote,
}));
vi.mock("@/lib/security-checks/preview", () => ({ previewScan: mocks.preview }));

import { removeScan, replaceScan, talkToSecurityAssistant } from "./security-assistant";

const say = (text: string) => [{ role: "user" as const, text }];

const SCAN = {
  ok: true,
  kind: "website",
  target: "settle.ng",
  checkedAt: "2026-11-13T10:00:00.000Z",
  checked: ["https", "certificate", "headers", "cookies", "email"],
  counts: { critical: 0, high: 1, medium: 1, low: 0 },
  findings: [
    { id: "hsts", severity: "high", area: "headers", title: "No HSTS header", detail: "Browsers may load it over HTTP SECRET" },
    { id: "dmarc", severity: "medium", area: "email", title: "No DMARC record", detail: "Mail can be faked SECRET" },
  ],
};

describe("talkToSecurityAssistant (#security-checks, plan C3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.access.mockResolvedValue({ organisationId: "org1", admin: true });
    mocks.rate.mockReturnValue({ allowed: true });
    mocks.addTargetAndCheck.mockResolvedValue({ targetId: "t1", checkId: "c1", verified: false, reused: false });
    mocks.preview.mockResolvedValue(SCAN);
    mocks.findScannedCheck.mockResolvedValue(null);
    mocks.scansNote.mockResolvedValue("");
  });

  it("doesn't scan a site again that this person already scanned; it says so and shows its saved result", async () => {
    mocks.findScannedCheck.mockResolvedValue({ checkId: "c-old", summary: null, finished: false });
    const answer = await talkToSecurityAssistant(say("https://www.settle.ng"));
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.addTargetAndCheck).not.toHaveBeenCalled();
    expect(answer).toMatchObject({ kind: "scan", already: true, finished: false, checkId: "c-old", summary: null, note: expect.stringContaining("settle.ng is already in your scans") });
  });

  it("says a site already scanned is finished once its agents' report is posted, so the chat offers See results", async () => {
    mocks.findScannedCheck.mockResolvedValue({ checkId: "c-old", summary: null, finished: true });
    await expect(talkToSecurityAssistant(say("https://www.settle.ng"))).resolves.toMatchObject({ kind: "scan", already: true, finished: true, checkId: "c-old" });
  });

  it("refuses anyone who is not an owner or admin, before scanning, asking the AI or saving anything", async () => {
    mocks.access.mockResolvedValue({ organisationId: "org1", admin: false });
    await expect(talkToSecurityAssistant(say("https://www.settle.ng"))).resolves.toMatchObject({ kind: "error", error: expect.stringContaining("owners and admins") });
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.ask).not.toHaveBeenCalled();
    expect(mocks.addTargetAndCheck).not.toHaveBeenCalled();
  });

  it("scans a plain link without the AI, adds it to the person's scans at once, and saves the quick scan", async () => {
    const answer = await talkToSecurityAssistant(say("https://www.settle.ng"));
    expect(mocks.ask).not.toHaveBeenCalled();
    expect(mocks.preview).toHaveBeenCalledWith("settle.ng", { visitor: "user:u1" });
    // No proof step: added straight away (14 Nov plan).
    expect(mocks.addTargetAndCheck).toHaveBeenCalledWith("org1", "u1", expect.objectContaining({ kind: "website", value: "settle.ng" }));
    expect(mocks.saveQuickScan).toHaveBeenCalledWith("t1", expect.objectContaining({ total: 2, risk: "high" }));
    // Started as soon as it is added, not left for the one-minute sweep (which kept a scan waiting for minutes, 15 Nov).
    expect(mocks.kick).toHaveBeenCalledTimes(1);
    expect(mocks.kick).toHaveBeenCalledWith(expect.anything(), "c1");
    expect(answer).toMatchObject({ kind: "scan", target: "settle.ng", checkId: "c1", summary: { total: 2, risk: "high" } });
    // What any browser sees is shown as titles; the detail never leaves the server.
    expect(JSON.stringify(answer)).toContain("No HSTS header");
    expect(JSON.stringify(answer)).not.toContain("SECRET");
    expect(JSON.stringify(mocks.saveQuickScan.mock.calls[0][1])).not.toContain("SECRET");
  });

  it("adds nothing for a site the scan couldn't reach, but still adds it when only the limit was hit", async () => {
    mocks.preview.mockResolvedValue({ ok: false, reason: "We couldn't reach settle.ng just now." });
    expect(await talkToSecurityAssistant(say("settle.ng"))).toMatchObject({ kind: "scan", reply: "", summary: null, note: "We couldn't reach settle.ng just now.", checkId: null });
    expect(mocks.addTargetAndCheck).not.toHaveBeenCalled();

    mocks.preview.mockResolvedValue({ ok: false, reason: "Too many scans.", retryAfterSeconds: 120 });
    expect(await talkToSecurityAssistant(say("settle.ng"))).toMatchObject({ kind: "scan", summary: null, checkId: "c1" });
  });

  it("quick-scans a GitHub repo like any other asset and adds it", async () => {
    mocks.preview.mockResolvedValue({ ...SCAN, kind: "repo", target: "settle/app", checked: ["secrets", "policy"], counts: { critical: 0, high: 1, medium: 0, low: 1 }, findings: [
      { id: "s", severity: "high", area: "secrets", title: "A file that usually holds secrets", detail: ".env SECRET" },
      { id: "p", severity: "low", area: "policy", title: "No security policy", detail: "No SECURITY.md SECRET" },
    ] });
    const answer = await talkToSecurityAssistant(say("github.com/settle/app"));
    // The scan reads its link back through the same parser, so a repo must go in as a GitHub address, not "owner/name".
    expect(mocks.preview).toHaveBeenCalledWith("github.com/settle/app", { visitor: "user:u1" });
    expect(mocks.addTargetAndCheck).toHaveBeenCalledTimes(1);
    expect(answer).toMatchObject({ kind: "scan", target: "github.com/settle/app", summary: { kind: "repo", total: 2, risk: "high" } });
    expect(JSON.stringify(answer)).not.toContain("SECRET");
  });

  it("still adds a repo it can't see, such as a private one", async () => {
    mocks.preview.mockResolvedValue({ ok: false, reason: "We couldn't see that repo on GitHub." });
    const answer = await talkToSecurityAssistant(say("github.com/settle/private-app"));
    expect(mocks.addTargetAndCheck).toHaveBeenCalledTimes(1);
    expect(mocks.saveQuickScan).not.toHaveBeenCalled();
    expect(answer).toMatchObject({ kind: "scan", summary: null, note: "We couldn't see that repo on GitHub.", checkId: "c1" });
  });

  it("refuses a private address without asking the AI", async () => {
    const answer = await talkToSecurityAssistant(say("192.168.1.1"));
    expect(mocks.ask).not.toHaveBeenCalled();
    expect(mocks.addTargetAndCheck).not.toHaveBeenCalled();
    expect(answer.kind).toBe("reply");
  });

  it("lets the AI answer plain words, and scans the site it picks out after checking it again", async () => {
    mocks.ask.mockResolvedValue({ reply: "Here's a quick look.", target: "my site is settle.ng" });
    expect(await talkToSecurityAssistant(say("I want to secure my shop"))).toMatchObject({ kind: "reply" });
    expect(mocks.preview).not.toHaveBeenCalled();

    mocks.ask.mockResolvedValue({ reply: "Here's a quick look.", target: "settle.ng" });
    const answer = await talkToSecurityAssistant(say("It's settle dot ng, the website"));
    expect(answer).toMatchObject({ kind: "scan", reply: "Here's a quick look.", target: "settle.ng", checkId: "c1" });
    expect(mocks.addTargetAndCheck).toHaveBeenCalledTimes(1);
  });

  it("answers follow-ups about the person's own scans: the AI gets their scans, read on the server for this workspace and person", async () => {
    mocks.scansNote.mockResolvedValue("- settle.ng: Quick browser scan: 2 problems (1 medium, 1 low). Agents' report: not ready yet. Status: Checking, 2 of 6 parts done.");
    mocks.ask.mockResolvedValue({ reply: "settle.ng is being checked: 2 of 6 parts are done.", target: null });
    const answer = await talkToSecurityAssistant(say("what's happening with my site?"));
    expect(mocks.scansNote).toHaveBeenCalledWith("org1", "u1");
    expect(mocks.ask).toHaveBeenCalledWith(expect.any(Array), expect.stringContaining("2 of 6 parts done"));
    expect(answer).toEqual({ kind: "reply", reply: "settle.ng is being checked: 2 of 6 parts are done." });
    expect(mocks.addTargetAndCheck).not.toHaveBeenCalled();
  });

  it("never adds a private address the AI picks out", async () => {
    mocks.ask.mockResolvedValue({ reply: "Okay.", target: "10.0.0.4" });
    const answer = await talkToSecurityAssistant(say("check my server at ten zero zero four"));
    expect(mocks.addTargetAndCheck).not.toHaveBeenCalled();
    expect(answer.kind).toBe("reply");
  });

  it("asks for the address plainly when the AI can't answer, and stops at the rate limit", async () => {
    mocks.ask.mockResolvedValue(null);
    const answer = await talkToSecurityAssistant(say("hello"));
    expect(answer).toMatchObject({ kind: "reply" });
    expect((answer as { reply: string }).reply).toMatch(/website, a server address or a GitHub repo/);

    mocks.rate.mockReturnValue({ allowed: false });
    expect(await talkToSecurityAssistant(say("hello again"))).toEqual({ kind: "error", error: "Slow down." });
    expect(mocks.ask).toHaveBeenCalledTimes(1);
  });

  it("needs a workspace", async () => {
    mocks.access.mockResolvedValue({ organisationId: null, admin: false });
    expect((await talkToSecurityAssistant(say("settle.ng"))).kind).toBe("error");
  });

  it("removes one of your scans, finished or not", async () => {
    mocks.removeOwnScan.mockResolvedValue(true);
    expect(await removeScan("c1")).toEqual({ ok: true });
    expect(mocks.removeOwnScan).toHaveBeenCalledWith("org1", "u1", "c1");
    mocks.removeOwnScan.mockResolvedValue(false);
    expect(await removeScan("c-gone")).toMatchObject({ ok: false, error: expect.stringContaining("already removed") });
  });

  it("Replace: scans a site already in your scans again and saves the new result over the old one", async () => {
    // Never quick-scanned before, so it looks afresh rather than reusing a quick scan from the last 10 minutes.
    mocks.findOwnScan.mockResolvedValue({ checkId: "c1", targetId: "t1", target: { id: "t1", kind: "website", value: "settle.ng", previewAt: null } });
    const answer = await replaceScan("c1");
    expect(mocks.preview).toHaveBeenCalledWith("settle.ng", { visitor: "user:u1", fresh: true });
    expect(mocks.saveQuickScan).toHaveBeenCalledWith("t1", expect.objectContaining({ total: 2 }));
    expect(mocks.addTargetAndCheck).not.toHaveBeenCalled();
    expect(answer).toMatchObject({ ok: true, summary: { total: 2 } });
    expect(JSON.stringify(answer)).not.toContain("SECRET");
    mocks.findOwnScan.mockResolvedValue(null);
    expect(await replaceScan("someone-elses")).toMatchObject({ ok: false });
  });

  it("keeps the conversation that led to a scan as the start of that site's saved chat", async () => {
    await talkToSecurityAssistant(say("https://www.settle.ng"));
    expect(mocks.saveSiteMessage).toHaveBeenCalledWith("org1", "u1", "t1", "user", "https://www.settle.ng");
    expect(mocks.saveSiteMessage).toHaveBeenCalledWith("org1", "u1", "t1", "assistant", expect.stringContaining("When you added it, the quick scan found 2 problems (1 high, 1 medium)."));
    expect(JSON.stringify(mocks.saveSiteMessage.mock.calls)).not.toContain("SECRET");
  });
});
