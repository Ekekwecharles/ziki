import { describe, expect, it, vi } from "vitest";
import { agentState, buildCallLog, cancelOnCallInvite, inviteToOnCall, listOnCallPeople, pageCallLog, personState, resolveInviteEmail, respondToOnCallInvite, searchPeopleForOnCall } from "@/lib/security-checks/on-call";

/** A fake Prisma client: every model method is a mock, and $transaction runs the callback on the same fake. */
function fakeDb() {
  const db = {
    user: { findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    onCallInvite: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
    notification: { create: vi.fn() },
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation((fn: (tx: typeof db) => unknown) => fn(db));
  return db;
}
const asDb = (db: ReturnType<typeof fakeDb>) => db as never;
const now = new Date("2026-11-13T10:00:00Z");

describe("inviting a person to go on call (#on-call)", () => {
  const person = { id: "u1", onCallAt: null, securityClearedAt: null };

  it("creates the invite by lowercase email and tells a person with an account in their inbox", async () => {
    const db = fakeDb();
    db.user.findUnique.mockResolvedValue(person);
    db.onCallInvite.findFirst.mockResolvedValue(null);
    db.onCallInvite.create.mockResolvedValue({ id: "inv1" });
    expect(await inviteToOnCall(asDb(db), { email: "  Hamzat@Example.com ", invitedById: "admin", clearForSecurity: true })).toEqual({ inviteId: "inv1" });
    expect(db.user.findUnique.mock.calls[0][0].where).toEqual({ email: "hamzat@example.com" });
    expect(db.onCallInvite.create.mock.calls[0][0].data).toEqual({ email: "hamzat@example.com", invitedById: "admin", clearForSecurity: true });
    expect(db.notification.create.mock.calls[0][0].data).toMatchObject({ userId: "u1", kind: "on_call_invite" });
  });

  it("invites someone with no account yet, with no inbox note", async () => {
    const db = fakeDb();
    db.user.findUnique.mockResolvedValue(null);
    db.onCallInvite.findFirst.mockResolvedValue(null);
    db.onCallInvite.create.mockResolvedValue({ id: "inv2" });
    await inviteToOnCall(asDb(db), { email: "new@example.com", invitedById: "admin", clearForSecurity: false });
    expect(db.notification.create).not.toHaveBeenCalled();
  });

  it("refuses a bad address, a person already on call, or one already invited", async () => {
    const cases: [string, unknown, unknown, string][] = [
      ["not-an-email", null, null, "invalid_email"],
      ["a@b.co", { ...person, onCallAt: now }, null, "already_on_call"],
      ["a@b.co", person, { id: "old" }, "already_invited"],
    ];
    for (const [email, found, pending, code] of cases) {
      const db = fakeDb();
      db.user.findUnique.mockResolvedValue(found);
      db.onCallInvite.findFirst.mockResolvedValue(pending);
      await expect(inviteToOnCall(asDb(db), { email, invitedById: "admin", clearForSecurity: false })).rejects.toMatchObject({ code });
      expect(db.onCallInvite.create).not.toHaveBeenCalled();
    }
  });

  it("still invites someone on call who is not yet cleared when the invite clears them", async () => {
    const db = fakeDb();
    db.user.findUnique.mockResolvedValue({ ...person, onCallAt: now });
    db.onCallInvite.findFirst.mockResolvedValue(null);
    db.onCallInvite.create.mockResolvedValue({ id: "inv3" });
    await expect(inviteToOnCall(asDb(db), { email: "a@b.co", invitedById: "admin", clearForSecurity: true })).resolves.toEqual({ inviteId: "inv3" });
  });

  it("lets staff withdraw only a pending invite", async () => {
    const db = fakeDb();
    db.onCallInvite.updateMany.mockResolvedValue({ count: 0 });
    await expect(cancelOnCallInvite(asDb(db), "inv1", now)).rejects.toMatchObject({ code: "not_pending" });
  });
});

describe("the invited person answering (#on-call)", () => {
  const invite = (clearForSecurity: boolean) => ({ id: "inv1", email: "owner@example.com", clearForSecurity });
  const signedIn = { email: "Owner@Example.com" };

  it("accepting puts the person on call, and clears them for security only when the invite says so", async () => {
    for (const clear of [true, false]) {
      const db = fakeDb();
      db.onCallInvite.findUnique.mockResolvedValue(invite(clear));
      db.user.findUnique.mockResolvedValue(signedIn);
      db.onCallInvite.updateMany.mockResolvedValue({ count: 1 });
      await respondToOnCallInvite(asDb(db), { inviteId: "inv1", userId: "u1", accept: true }, now);
      expect(db.user.update.mock.calls[0][0]).toEqual({ where: { id: "u1" }, data: clear ? { onCallAt: now, securityClearedAt: now } : { onCallAt: now } });
    }
  });

  it("declining changes nothing on the person", async () => {
    const db = fakeDb();
    db.onCallInvite.findUnique.mockResolvedValue(invite(true));
    db.user.findUnique.mockResolvedValue(signedIn);
    db.onCallInvite.updateMany.mockResolvedValue({ count: 1 });
    await respondToOnCallInvite(asDb(db), { inviteId: "inv1", userId: "u1", accept: false }, now);
    expect(db.onCallInvite.updateMany.mock.calls[0][0].data).toMatchObject({ status: "declined" });
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("only the person with that email may answer, and only once", async () => {
    const db = fakeDb();
    db.onCallInvite.findUnique.mockResolvedValue(invite(false));
    db.user.findUnique.mockResolvedValue({ email: "someone-else@example.com" });
    await expect(respondToOnCallInvite(asDb(db), { inviteId: "inv1", userId: "u2", accept: true }, now)).rejects.toMatchObject({ code: "not_yours" });
    db.user.findUnique.mockResolvedValue(signedIn);
    db.onCallInvite.updateMany.mockResolvedValue({ count: 0 });
    await expect(respondToOnCallInvite(asDb(db), { inviteId: "inv1", userId: "u1", accept: true }, now)).rejects.toMatchObject({ code: "not_pending" });
    expect(db.user.update).not.toHaveBeenCalled();
  });
});

describe("the call log (#on-call)", () => {
  const owner = { owner: { name: "Ada", email: "ada@example.com" } };

  it("says who picked up each part and how fast, and flags a part nobody took", () => {
    const log = buildCallLog(
      [
        { createdAt: new Date("2026-11-13T09:00:00Z"), assignedAt: new Date("2026-11-13T09:00:30Z"), title: "Headers", agent: owner },
        { createdAt: new Date("2026-11-13T09:30:00Z"), assignedAt: null, title: "Secrets", agent: null },
        { createdAt: new Date("2026-11-13T09:58:00Z"), assignedAt: null, title: "Fresh", agent: null },
      ],
      [{ createdAt: new Date("2026-11-13T08:00:00Z"), organisation: { name: "Settle" }, agent: { owner: { name: null, email: "bo@example.com" } } }],
      now,
    );
    expect(log.map((l) => l.what)).toEqual(["Security check part: Fresh", "Security check part: Secrets", "Security check part: Headers", "New workspace: Settle"]);
    expect(log[0]).toMatchObject({ pickedUpBy: null, missed: false });
    expect(log[1]).toMatchObject({ pickedUpBy: null, missed: true });
    expect(log[2]).toMatchObject({ pickedUpBy: "Ada", waitMs: 30_000, missed: false });
    expect(log[3]).toMatchObject({ pickedUpBy: "bo@example.com", waitMs: 0 });
  });
});

describe("the invite box: search as you type, and names (#on-call)", () => {
  it("searches by name or email, case-insensitively, and says who is already on call or invited", async () => {
    const db = fakeDb();
    db.user.findMany.mockResolvedValue([
      { id: "u1", name: "Hamzat Adebayo", email: "Hamzat@Example.com", onCallAt: now },
      { id: "u2", name: "Hamza Bello", email: "hbello@example.com", onCallAt: null },
      { id: "u3", name: "Hamid Okoro", email: "hamid@example.com", onCallAt: null },
    ]);
    db.onCallInvite.findMany.mockResolvedValue([{ email: "hbello@example.com" }]);
    const found = await searchPeopleForOnCall("  HAM ", asDb(db));
    expect(db.user.findMany.mock.calls[0]![0].where).toEqual({
      OR: [{ name: { contains: "HAM", mode: "insensitive" } }, { email: { contains: "HAM", mode: "insensitive" } }],
    });
    expect(found.map((p) => [p.name, p.state])).toEqual([
      ["Hamzat Adebayo", "on_call"],
      ["Hamza Bello", "invited"],
      ["Hamid Okoro", null],
    ]);
    expect(db.onCallInvite.findMany.mock.calls[0]![0].where).toMatchObject({ status: "pending", email: { in: ["hamzat@example.com", "hbello@example.com", "hamid@example.com"] } });
  });

  it("does not search for fewer than 2 characters, and asks nothing about invites when nobody matches", async () => {
    const db = fakeDb();
    expect(await searchPeopleForOnCall("h", asDb(db))).toEqual([]);
    expect(await searchPeopleForOnCall("   ", asDb(db))).toEqual([]);
    expect(db.user.findMany).not.toHaveBeenCalled();
    db.user.findMany.mockResolvedValue([]);
    expect(await searchPeopleForOnCall("zz", asDb(db))).toEqual([]);
    expect(db.onCallInvite.findMany).not.toHaveBeenCalled();
  });

  it("an email stays an email; a name must match exactly one person", async () => {
    const db = fakeDb();
    expect(await resolveInviteEmail(" new@example.com ", asDb(db))).toBe("new@example.com");
    expect(db.user.findMany).not.toHaveBeenCalled();

    db.user.findMany.mockResolvedValue([{ email: "hamzat@example.com" }]);
    expect(await resolveInviteEmail("hamzat adebayo", asDb(db))).toBe("hamzat@example.com");
    expect(db.user.findMany.mock.calls[0]![0].where).toEqual({ name: { equals: "hamzat adebayo", mode: "insensitive" } });

    db.user.findMany.mockResolvedValue([{ email: "a@example.com" }, { email: "b@example.com" }]);
    await expect(resolveInviteEmail("Ada", asDb(db))).rejects.toMatchObject({ code: "ambiguous" });
    db.user.findMany.mockResolvedValue([]);
    await expect(resolveInviteEmail("Nobody", asDb(db))).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("the staff list of people on call (#on-call)", () => {
  const seen = (minutesAgo: number) => ({ lastUsedAt: new Date(now.getTime() - minutesAgo * 60_000) });

  it("a person is as online as their best agent: online, else quiet, else paused, and none without agents", () => {
    const recent = { pausedAt: null, apiKeys: [seen(2)] };
    const stale = { pausedAt: null, apiKeys: [seen(90)] };
    const paused = { pausedAt: now, apiKeys: [seen(1)] };
    expect(agentState(recent, now)).toBe("Online");
    expect(agentState(stale, now)).toBe("Quiet");
    expect(agentState(paused, now)).toBe("Paused");
    expect(personState([stale, recent], now)).toBe("Online");
    expect(personState([stale, paused], now)).toBe("Quiet");
    expect(personState([paused], now)).toBe("Paused");
    expect(personState([], now)).toBe("No agents");
    // Never seen counts as quiet, and a paused agent's recent use doesn't make a person online.
    expect(personState([{ pausedAt: null, apiKeys: [] }, paused], now)).toBe("Quiet");
  });

  it("searches names and emails case-insensitively, pages the list, and shows only name, email, state and clearance", async () => {
    const db = fakeDb();
    db.user.count.mockResolvedValue(13);
    db.user.findMany.mockResolvedValue([
      { id: "u1", name: "Tolu Adeyemi", email: "tolu@example.com", securityClearedAt: now, agents: [{ pausedAt: null, apiKeys: [seen(1)] }] },
      { id: "u2", name: "Kemi Bakare", email: "kemi@example.com", securityClearedAt: null, agents: [] },
    ]);
    const { total, people } = await listOnCallPeople({ q: "  TOL ", skip: 10, take: 10 }, now, asDb(db));
    expect(total).toBe(13);
    const where = db.user.findMany.mock.calls[0]![0].where;
    expect(where).toEqual({
      onCallAt: { not: null },
      OR: [{ name: { contains: "TOL", mode: "insensitive" } }, { email: { contains: "TOL", mode: "insensitive" } }],
    });
    expect(db.user.findMany.mock.calls[0]![0]).toMatchObject({ skip: 10, take: 10 });
    expect(db.user.count.mock.calls[0]![0].where).toEqual(where);
    expect(people).toEqual([
      { id: "u1", name: "Tolu Adeyemi", email: "tolu@example.com", state: "Online", cleared: true },
      { id: "u2", name: "Kemi Bakare", email: "kemi@example.com", state: "No agents", cleared: false },
    ]);
  });

  it("without a search it lists everyone who is on call", async () => {
    const db = fakeDb();
    db.user.count.mockResolvedValue(0);
    db.user.findMany.mockResolvedValue([]);
    await listOnCallPeople({}, now, asDb(db));
    expect(db.user.findMany.mock.calls[0]![0].where).toEqual({ onCallAt: { not: null } });
  });
});

describe("paging the call log (#on-call)", () => {
  const line = (n: number, missed: boolean) => ({
    kind: "security_part" as const,
    at: new Date(now.getTime() - n * 60_000),
    what: `Part ${n}`,
    pickedUpBy: missed ? null : "Ada",
    waitMs: missed ? null : 1000,
    missed,
  });
  const lines = Array.from({ length: 25 }, (_, n) => line(n, n % 5 === 0));

  it("shows ten a page and counts what was missed over the whole log", () => {
    const first = pageCallLog(lines, { page: 1 });
    expect(first.lines).toHaveLength(10);
    expect(first.pagination).toMatchObject({ totalCount: 25, totalPages: 3, from: 1, to: 10 });
    expect(first.totalLines).toBe(25);
    expect(first.missed).toBe(5);
    expect(pageCallLog(lines, { page: 3 }).lines).toHaveLength(5);
    // A page past the end is the last page.
    expect(pageCallLog(lines, { page: 99 }).pagination.page).toBe(3);
  });

  it("can show only the missed lines, paged on their own", () => {
    const only = pageCallLog(lines, { missedOnly: true, perPage: 2 });
    expect(only.lines.every((l) => l.missed)).toBe(true);
    expect(only.pagination).toMatchObject({ totalCount: 5, totalPages: 3 });
    expect(only.totalLines).toBe(25);
  });
});
