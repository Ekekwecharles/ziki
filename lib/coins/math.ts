/**
 * Ziki Coins arithmetic (#ziki-coins). Pure functions, no database: every amount
 * is a whole number of Ziks, and every split hands out exactly what it was
 * given, so no Zik is ever created or lost by rounding.
 */

/** What one Zik is worth in US cents. The one place this lives. */
export const ZIK_CENTS = 10;

export function zikToCents(zik: number): number {
  return zik * ZIK_CENTS;
}

/** An issue's reward estimate in dollars (the average of the planning-poker estimates), as whole Ziks. At least one. */
export function estimateToZik(dollars: number): number {
  return Math.max(1, Math.round((dollars * 100) / ZIK_CENTS));
}

export function formatZik(zik: number): string {
  return `${zik.toLocaleString("en-US")} Zik${zik === 1 ? "" : "s"}`;
}

export function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** The packs on the Buy Ziks page. Priced at the Zik's value, so a pack is exactly its Ziks in dollars. */
export const ZIK_PACKS = [
  { id: "starter", zik: 50, label: "Starter" },
  { id: "builder", zik: 150, label: "Builder" },
  { id: "team", zik: 500, label: "Team" },
  { id: "studio", zik: 1500, label: "Studio" },
] as const;

export type ZikPack = (typeof ZIK_PACKS)[number];

export function findPack(id: unknown): ZikPack | null {
  return ZIK_PACKS.find((pack) => pack.id === id) ?? null;
}

/** The largest amount that moves in one go: a typo can't fund a million Ziks. */
export const MAX_FUND_ZIK = 100_000;

/** Ziki's share of released escrow, a whole percent from `ZIKI_FEE_PERCENT` (0–100, default 10). */
export function feePercent(raw: string | undefined = process.env.ZIKI_FEE_PERCENT): number {
  const value = raw === undefined || raw.trim() === "" ? 10 : Number(raw);
  if (!Number.isFinite(value)) return 10;
  return Math.min(100, Math.max(0, value));
}

/** The fee on `total` Ziks, rounded to the nearest Zik, never more than the total. */
export function feeOf(total: number, percent: number = feePercent()): number {
  if (total <= 0) return 0;
  return Math.min(total, Math.round((total * percent) / 100));
}

/**
 * Splits `total` Ziks across the keys by weight (largest remainder), so the
 * shares add up to exactly `total`. Ties go to the earlier key, so the same
 * input always gives the same split. Keys with no weight get nothing.
 */
export function splitByWeight(total: number, weights: ReadonlyMap<string, number>): Map<string, number> {
  const shares = new Map<string, number>();
  const entries = [...weights].filter(([, weight]) => weight > 0);
  const sum = entries.reduce((acc, [, weight]) => acc + weight, 0);
  if (total <= 0 || sum <= 0) return shares;
  let given = 0;
  const remainders: { key: string; remainder: number; order: number }[] = [];
  entries.forEach(([key, weight], order) => {
    const exact = (total * weight) / sum;
    const floor = Math.floor(exact);
    shares.set(key, floor);
    given += floor;
    remainders.push({ key, remainder: exact - floor, order });
  });
  remainders.sort((a, b) => b.remainder - a.remainder || a.order - b.order);
  for (let i = 0; given < total && i < remainders.length; i += 1, given += 1) {
    const key = remainders[i].key;
    shares.set(key, (shares.get(key) ?? 0) + 1);
  }
  for (const [key, share] of [...shares]) if (share === 0) shares.delete(key);
  return shares;
}

export type EscrowRelease = {
  fee: number;
  /** What each earner gets, summing to `escrow - fee`. */
  shares: Map<string, number>;
};

/**
 * What releasing an issue's escrow pays: Ziki's fee first, then the rest split
 * among the earners by what each earned under Ziki's reward roles (solver,
 * reviewers, dispatcher). With nobody to pay, nothing is released.
 */
export function planRelease(escrow: number, earnerWeights: ReadonlyMap<string, number>, percent: number = feePercent()): EscrowRelease | null {
  if (escrow <= 0) return null;
  const hasEarner = [...earnerWeights.values()].some((weight) => weight > 0);
  if (!hasEarner) return null;
  const fee = feeOf(escrow, percent);
  return { fee, shares: splitByWeight(escrow - fee, earnerWeights) };
}
