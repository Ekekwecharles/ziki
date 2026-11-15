import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = { account: string; userId?: string | null; bugId?: string | null; kind: string; amount: number; sourceKey: string };
type Where = Record<string, unknown>;

/** The ledger tables in memory, so the real ledger code runs against them. */
const world = vi.hoisted(() => ({
  rows: [] as Array<{ account: string; userId?: string | null; bugId?: string | null; kind: string; amount: number; sourceKey: string }>,
  purchases: [] as Array<{ stripeSessionId: string }>,
  withdrawals: [] as Array<{
    id: string;
    userId: string;
    zik: number;
    status: string;
    amountCents?: number;
    idempotencyKey?: string;
    stripeTransferId?: string | null;
    failureReason?: string | null;
    createdAt?: Date;
  }>,
  /** What Stripe's transfers.create does next; a test sets it. */
  transfer: { create: async (_params: unknown, _options: { idempotencyKey: string }): Promise<{ id: string }> => ({ id: "tr_default" }) },
  bug: { status: "open", payoutReleasedAt: null as Date | null, organisationId: "org", reporterId: "owner", isDeleted: false },
}));

function matches(row: Record<string, unknown>, where: Where = {}): boolean {
  return Object.entries(where).every(([key, want]) => {
    if (want && typeof want === "object" && "in" in (want as object)) return ((want as { in: unknown[] }).in).includes(row[key]);
    return row[key] === want;
  });
}

const db = vi.hoisted(() => {
  const fake = {
    coinEntry: {
      createMany: async ({ data }: { data: Row[] }) => {
        let count = 0;
        for (const row of data) {
          if (world.rows.some((r) => r.sourceKey === row.sourceKey)) continue;
          if (row.amount === 0) throw new Error("amount must not be zero");
          world.rows.push({ userId: null, bugId: null, ...row });
          count += 1;
        }
        return { count };
      },
      aggregate: async ({ where }: { where: Where }) => {
        const found = world.rows.filter((r) => matches(r, where));
        return { _sum: { amount: found.length ? found.reduce((s, r) => s + r.amount, 0) : null } };
      },
      groupBy: async ({ by, where }: { by: string[]; where: Where }) => {
        const groups = new Map<string, { key: Record<string, unknown>; sum: number }>();
        for (const row of world.rows.filter((r) => matches(r, where))) {
          const key = Object.fromEntries(by.map((field) => [field, (row as Record<string, unknown>)[field]]));
          const id = JSON.stringify(key);
          const group = groups.get(id) ?? { key, sum: 0 };
          group.sum += row.amount;
          groups.set(id, group);
        }
        return [...groups.values()].map((g) => ({ ...g.key, _sum: { amount: g.sum } }));
      },
      findUnique: async ({ where }: { where: { sourceKey: string } }) => world.rows.find((r) => r.sourceKey === where.sourceKey) ?? null,
      count: async ({ where }: { where: Where }) => world.rows.filter((r) => matches(r, where)).length,
    },
    bug: {
      findUnique: async () => ({ ...world.bug }),
      findUniqueOrThrow: async () => ({ ...world.bug }),
    },
    membership: { findUnique: async () => null },
    user: { findUnique: async ({ where }: { where: { id: string } }) => ({ id: where.id }) },
    coinPurchase: {
      findUnique: async ({ where }: { where: { stripeSessionId: string } }) => world.purchases.find((p) => p.stripeSessionId === where.stripeSessionId) ?? null,
      create: async ({ data }: { data: { stripeSessionId: string } }) => {
        world.purchases.push(data);
        return { id: `purchase-${world.purchases.length}`, ...data };
      },
    },
    withdrawal: {
      findUnique: async ({ where }: { where: { id: string } }) => world.withdrawals.find((w) => w.id === where.id) ?? null,
      findMany: async ({ where }: { where: { status: string; createdAt: { lt: Date } } }) =>
        world.withdrawals
          .filter((w) => w.status === where.status && (w.stripeTransferId ?? null) === null && (w.createdAt ?? new Date(0)) < where.createdAt.lt)
          .map((w) => ({ ...w, user: { stripeAccountId: "acct_fixer" } })),
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const found = world.withdrawals.filter((w) => {
          const row = w as Record<string, unknown>;
          return Object.entries(where).every(([key, want]) => {
            if (want && typeof want === "object" && "in" in (want as object)) return ((want as { in: unknown[] }).in).includes(row[key]);
            if (want === null) return (row[key] ?? null) === null;
            return row[key] === want;
          });
        });
        for (const w of found) Object.assign(w, data);
        return { count: found.length };
      },
    },
    $queryRaw: async () => [],
    $transaction: async (run: (tx: unknown) => unknown) => run(fake),
  };
  return fake;
});

vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/coins/stripe", () => ({
  getStripe: () => ({
    paymentIntents: { retrieve: async () => Promise.reject(new Error("offline")) },
    transfers: { create: (params: unknown, options: { idempotencyKey: string }) => world.transfer.create(params, options) },
  }),
  stripeConfigured: () => true,
}));

import { fundIssue } from "@/lib/coins/fund";
import { refundEscrow, releaseEscrow } from "@/lib/coins/escrow";
import { escrowBalance, walletBalance, walletSummary } from "@/lib/coins/ledger";
import { estimateToZik, feeOf, planRelease, splitByWeight } from "@/lib/coins/math";
import { ledgerBalances } from "@/lib/coins/money";
import { recordPurchase } from "@/lib/coins/purchase";
import Stripe from "stripe";
import { failWithdrawal, retryPendingWithdrawals } from "@/lib/coins/withdraw";

const buy = (userId: string, zik: number, session: string) =>
  db.coinEntry.createMany({ data: [{ account: "wallet", userId, kind: "purchase", amount: zik, sourceKey: `purchase:${session}` }] });
const total = () => world.rows.reduce((sum, row) => sum + row.amount, 0);

beforeEach(() => {
  world.rows.length = 0;
  world.purchases.length = 0;
  world.withdrawals.length = 0;
  world.transfer.create = async () => ({ id: "tr_default" });
  Object.assign(world.bug, { status: "open", payoutReleasedAt: null });
});

describe("Ziks arithmetic", () => {
  it("takes the fee first and splits the rest by award, handing out every Zik", () => {
    expect(feeOf(100, 10)).toBe(10);
    expect(feeOf(105, 10)).toBe(11);
    const plan = planRelease(100, new Map([["solver", 6], ["tester", 3]]), 10);
    expect(plan?.fee).toBe(10);
    expect([...(plan?.shares ?? [])]).toEqual([["solver", 60], ["tester", 30]]);
    // Thirds don't divide evenly: the split still adds up exactly.
    const odd = splitByWeight(100, new Map([["a", 1], ["b", 1], ["c", 1]]));
    expect([...odd.values()].reduce((s, n) => s + n, 0)).toBe(100);
  });

  it("turns a reward estimate in dollars into whole Ziks, never fewer than one", () => {
    expect(estimateToZik(6.33)).toBe(63);
    expect(estimateToZik(3.67)).toBe(37);
    expect(estimateToZik(10)).toBe(100);
    expect(estimateToZik(0.01)).toBe(1);
  });

  it("releases nothing when nobody earned anything", () => {
    expect(planRelease(100, new Map(), 10)).toBeNull();
  });
});

describe("funding an issue", () => {
  it("never takes a wallet below zero, and funds once per request", async () => {
    await buy("owner", 50, "s1");
    await expect(fundIssue("owner", "bug", 60, "request-0001")).rejects.toMatchObject({ code: "insufficient_ziks" });
    expect(await walletBalance(db as never, "owner")).toBe(50);

    expect(await fundIssue("owner", "bug", 20, "request-0002")).toEqual({ funded: true, escrow: 20 });
    expect(await fundIssue("owner", "bug", 20, "request-0002")).toEqual({ funded: false, escrow: 20 });
    expect(await walletBalance(db as never, "owner")).toBe(30);
    expect(total()).toBe(50);
  });

  it("refuses someone who doesn't own the issue, and a finished issue", async () => {
    await buy("stranger", 50, "s2");
    await expect(fundIssue("stranger", "bug", 10, "request-0003")).rejects.toMatchObject({ code: "not_allowed" });
    await buy("owner", 50, "s3");
    world.bug.status = "closed";
    await expect(fundIssue("owner", "bug", 10, "request-0004")).rejects.toMatchObject({ code: "closed" });
  });
});

describe("releasing and refunding escrow", () => {
  it("pays the earners by their awards, keeps the fee, and balances to the Ziks bought", async () => {
    await buy("owner", 100, "s4");
    await fundIssue("owner", "bug", 100, "request-0005");
    const awards = [{ userId: "solver", points: 6 }, { userId: "tester", points: 3 }];

    const result = await releaseEscrow(db as never, "bug", awards);

    expect(result).toEqual({ released: 90, fee: 10, paidTo: ["solver", "tester"] });
    expect(await walletBalance(db as never, "solver")).toBe(60);
    expect(await walletBalance(db as never, "tester")).toBe(30);
    expect(await escrowBalance(db as never, "bug")).toBe(0);
    expect(world.rows.filter((r) => r.account === "revenue").reduce((s, r) => s + r.amount, 0)).toBe(10);
    expect(total()).toBe(100);
    expect(ledgerBalances({ bought: 100, withdrawn: 0, inLedger: total() }).difference).toBe(0);

    // The same release again finds the escrow empty and pays nothing more.
    expect(await releaseEscrow(db as never, "bug", awards)).toBeNull();
    expect(await walletBalance(db as never, "solver")).toBe(60);
  });

  it("gives unused escrow back to whoever funded it when the issue closes", async () => {
    await buy("owner", 100, "s5");
    await fundIssue("owner", "bug", 40, "request-0006");
    expect(await refundEscrow(db as never, "bug")).toBe(40);
    expect(await walletBalance(db as never, "owner")).toBe(100);
    expect(await escrowBalance(db as never, "bug")).toBe(0);
    expect(await refundEscrow(db as never, "bug")).toBe(0);
  });
});

describe("Stripe webhook purchases", () => {
  const session = (over: Record<string, unknown> = {}) =>
    ({ id: "cs_1", mode: "payment", payment_status: "paid", amount_total: 500, currency: "usd", payment_intent: "pi_1", metadata: { userId: "owner", packId: "starter" }, ...over }) as never;

  it("credits the wallet once, however many times Stripe delivers the event", async () => {
    expect(await recordPurchase(session())).toBe("recorded");
    expect(await recordPurchase(session())).toBe("duplicate");
    expect(await walletBalance(db as never, "owner")).toBe(50);
    expect(world.purchases).toHaveLength(1);
  });

  it("credits nothing for an unpaid session, or one that paid less than the pack costs", async () => {
    expect(await recordPurchase(session({ payment_status: "unpaid" }))).toBe("ignored");
    expect(await recordPurchase(session({ id: "cs_2", amount_total: 100 }))).toBe("ignored");
    expect(await walletBalance(db as never, "owner")).toBe(0);
  });
});

describe("withdrawals", () => {
  it("lets a person withdraw what they earned, not what they bought", async () => {
    await buy("fixer", 500, "s6");
    expect((await walletSummary(db as never, "fixer")).withdrawable).toBe(0);
    await db.coinEntry.createMany({ data: [{ account: "wallet", userId: "fixer", kind: "release", amount: 120, sourceKey: "release:x:fixer:wallet" }] });
    expect(await walletSummary(db as never, "fixer")).toEqual({ balance: 620, earned: 120, withdrawable: 120 });
  });

  it("puts a failed transfer's Ziks back once, however many times Stripe says so", async () => {
    await db.coinEntry.createMany({
      data: [
        { account: "wallet", userId: "fixer", kind: "release", amount: 400, sourceKey: "release:y:fixer:wallet" },
        { account: "wallet", userId: "fixer", kind: "withdrawal", amount: -400, sourceKey: "withdrawal:w1" },
      ],
    });
    world.withdrawals.push({ id: "w1", userId: "fixer", zik: 400, status: "pending" });
    expect(await walletBalance(db as never, "fixer")).toBe(0);

    expect(await failWithdrawal("w1", "Stripe reversed the transfer.")).toBe(true);
    expect(await failWithdrawal("w1", "Stripe reversed the transfer.")).toBe(false);

    expect(await walletBalance(db as never, "fixer")).toBe(400);
    expect(world.withdrawals[0].status).toBe("failed");
    expect((await walletSummary(db as never, "fixer")).withdrawable).toBe(400);
  });

  describe("when Stripe is still holding the platform's money", () => {
    const noFundsYet = () =>
      Promise.reject(new Stripe.errors.StripeInvalidRequestError({ type: "invalid_request_error", code: "balance_insufficient", message: "insufficient available funds" }));
    const debited = (id: string, createdAt: Date) => {
      world.withdrawals.push({ id, userId: "fixer", zik: 450, amountCents: 4500, status: "pending", idempotencyKey: `key-${id}`, stripeTransferId: null, createdAt });
      return db.coinEntry.createMany({
        data: [
          { account: "wallet", userId: "fixer", kind: "release", amount: 450, sourceKey: `release:${id}:fixer:wallet` },
          { account: "wallet", userId: "fixer", kind: "withdrawal", amount: -450, sourceKey: `withdrawal:${id}` },
        ],
      });
    };
    const now = new Date("2026-11-15T12:00:00Z");
    const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

    it("keeps the withdrawal waiting with the Ziks reserved, then sends it once the money is available", async () => {
      await debited("w3", minutesAgo(10));
      const usedKeys: string[] = [];
      world.transfer.create = (_params, options) => {
        usedKeys.push(options.idempotencyKey);
        return noFundsYet();
      };

      expect(await retryPendingWithdrawals(now)).toMatchObject({ checked: 1, waiting: 1, sent: 0, returned: 0 });
      expect(world.withdrawals[0].status).toBe("pending");
      expect(await walletBalance(db as never, "fixer")).toBe(0);

      world.transfer.create = async (_params, options) => {
        usedKeys.push(options.idempotencyKey);
        return { id: "tr_1" };
      };
      expect(await retryPendingWithdrawals(now)).toMatchObject({ checked: 1, sent: 1, waiting: 0 });
      expect(world.withdrawals[0].stripeTransferId).toBe("tr_1");
      // Stripe would replay the refusal for the first key, so the second try used a new one.
      expect(usedKeys[1]).not.toBe(usedKeys[0]);

      // Sent once: nothing left to retry.
      expect(await retryPendingWithdrawals(now)).toMatchObject({ checked: 0 });
    });

    it("doesn't touch a withdrawal made moments ago, and gives the Ziks back after two weeks of waiting", async () => {
      await debited("w4", minutesAgo(0.5));
      world.transfer.create = noFundsYet;
      expect(await retryPendingWithdrawals(now)).toMatchObject({ checked: 0 });

      world.withdrawals[0].createdAt = new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000);
      expect(await retryPendingWithdrawals(now)).toMatchObject({ checked: 1, returned: 1 });
      expect(world.withdrawals[0].status).toBe("failed");
      expect(await walletBalance(db as never, "fixer")).toBe(450);
    });
  });
});
