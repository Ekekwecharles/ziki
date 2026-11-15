import type { Prisma } from "@prisma/client";

export const BUG_SORT_OPTIONS = [
  "newest",
  "recently_updated",
  "importance",
  "least_important",
  "title",
  "title_desc",
  "status",
  "status_desc",
  "reward",
  "reward_low",
] as const;
export type BugSortOption = (typeof BUG_SORT_OPTIONS)[number];

/** #importance: upvotes are now Importance; the most important issues come first. */
export const DEFAULT_BUG_SORT: BugSortOption = "importance";

export const bugSortLabels: Record<BugSortOption, string> = {
  newest: "Newest",
  recently_updated: "Recently Updated",
  importance: "Most important",
  least_important: "Least important",
  title: "Title (A–Z)",
  title_desc: "Title (Z–A)",
  status: "Status (earliest step first)",
  status_desc: "Status (latest step first)",
  reward: "Highest reward",
  reward_low: "Lowest reward",
};

export const bugSortDescriptions: Record<BugSortOption, string> = {
  newest: "newest",
  recently_updated: "recently updated",
  importance: "most important",
  least_important: "least important",
  title: "title, A to Z",
  title_desc: "title, Z to A",
  status: "status, earliest step first",
  status_desc: "status, latest step first",
  reward: "highest reward",
  reward_low: "lowest reward",
};

/** Sort key for bug lists: most important first, then most recently updated. */
export type BugPopularitySortKey = {
  voteCount: number;
  updatedAt: Date | string;
};

export function isBugSortOption(value: unknown): value is BugSortOption {
  return (
    typeof value === "string" &&
    (BUG_SORT_OPTIONS as readonly string[]).includes(value)
  );
}

export function parseBugSort(
  raw?: string | string[] | null,
  /** What to use when the value is missing or unrecognised. */
  fallback: BugSortOption = DEFAULT_BUG_SORT,
): BugSortOption {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase().replace(/-/g, "_");
  if (normalized === "newest" || normalized === "new") {
    return "newest";
  }
  if (
    normalized === "recently_updated" ||
    normalized === "updated" ||
    normalized === "recent"
  ) {
    return "recently_updated";
  }
  if (normalized === "importance" || normalized === "most_important" || normalized === "important") {
    return "importance";
  }
  if (normalized === "least_important" || normalized === "least_importance" || normalized === "importance_asc") {
    return "least_important";
  }
  if (normalized === "reward" || normalized === "reward_low") return normalized;
  if (normalized === "title" || normalized === "title_desc" || normalized === "status" || normalized === "status_desc") {
    return normalized;
  }
  return fallback;
}

export function getBugOrderBy(
  sort: BugSortOption,
  /** Boosted issues pin to the top. Off for a personal list (#312). */
  { boostFirst = true }: { boostFirst?: boolean } = {},
): Prisma.BugOrderByWithRelationInput[] {
  const baseOrder: Prisma.BugOrderByWithRelationInput[] = (() => {
    switch (sort) {
      case "newest":
        return [{ createdAt: "desc" }, { id: "desc" }];
      case "recently_updated":
        return [{ updatedAt: "desc" }, { id: "desc" }];
      case "importance":
        return [
          { voteCount: "desc" },
          { updatedAt: "desc" },
          { createdAt: "desc" },
        ];
      case "least_important":
        return [
          { voteCount: "asc" },
          { updatedAt: "desc" },
          { createdAt: "desc" },
        ];
      case "title":
        return [{ title: "asc" }, { id: "asc" }];
      case "title_desc":
        return [{ title: "desc" }, { id: "desc" }];
      // The Substatus enum is declared in workflow order, so the database sorts by step.
      case "status":
        return [{ substatus: "asc" }, { updatedAt: "desc" }, { id: "desc" }];
      case "status_desc":
        return [{ substatus: "desc" }, { updatedAt: "desc" }, { id: "desc" }];
      // #rewards: what solving it pays; equal rewards, the most important first.
      case "reward":
        return [{ reward: "desc" }, { voteCount: "desc" }, { id: "desc" }];
      case "reward_low":
        return [{ reward: "asc" }, { voteCount: "desc" }, { id: "desc" }];
    }
  })();

  // Boosted tickets always take precedence at the top, followed by active sort
  return boostFirst
    ? [{ isBoosted: "desc" }, { boostedAt: "desc" }, ...baseOrder]
    : baseOrder;
}

export function compareBoosted<
  T extends { isBoosted?: boolean; boostedAt?: Date | string | null },
>(a: T, b: T): number {
  const aBoosted = Boolean(a.isBoosted);
  const bBoosted = Boolean(b.isBoosted);
  if (aBoosted !== bBoosted) {
    return aBoosted ? -1 : 1;
  }
  if (aBoosted && bBoosted) {
    const aTime = a.boostedAt ? new Date(a.boostedAt).getTime() : 0;
    const bTime = b.boostedAt ? new Date(b.boostedAt).getTime() : 0;
    if (bTime !== aTime) return bTime - aTime;
  }
  return 0;
}

export function compareBugsByPopularity(
  a: BugPopularitySortKey,
  b: BugPopularitySortKey,
): number {
  if (b.voteCount !== a.voteCount) {
    return b.voteCount - a.voteCount;
  }
  return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
}

export function compareBugsByLowestVotes(
  a: BugPopularitySortKey,
  b: BugPopularitySortKey,
): number {
  if (a.voteCount !== b.voteCount) {
    return a.voteCount - b.voteCount;
  }
  return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
}

export function compareBugsByNewest(
  a: { createdAt: Date | string; id?: string },
  b: { createdAt: Date | string; id?: string },
): number {
  const diff =
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  if (diff !== 0) return diff;
  if (a.id && b.id) return b.id.localeCompare(a.id);
  return 0;
}

export function compareBugsByRecentlyUpdated(
  a: { updatedAt?: Date | string; createdAt: Date | string; id?: string },
  b: { updatedAt?: Date | string; createdAt: Date | string; id?: string },
): number {
  const diff =
    new Date(b.updatedAt ?? b.createdAt).getTime() -
    new Date(a.updatedAt ?? a.createdAt).getTime();
  if (diff !== 0) return diff;
  if (a.id && b.id) return b.id.localeCompare(a.id);
  return 0;
}

export type BugSortableItem = {
  id?: string;
  voteCount: number;
  isBoosted?: boolean;
  boostedAt?: Date | string | null;
  createdAt: Date | string;
  updatedAt?: Date | string;
  title?: string;
  substatus?: string;
  /** #rewards: what solving it pays, in $. */
  reward?: number | { toNumber(): number } | null;
};

function rewardOf(item: BugSortableItem): number {
  const value = item.reward;
  return value == null ? 0 : typeof value === "number" ? value : value.toNumber();
}

/** The Substatus enum's order (prisma/schema.prisma), which is the workflow order. */
const SUBSTATUS_RANK = [
  "requires_confirmation", "open", "in_progress", "requires_review", "accepted",
  "ready_to_merge", "error", "on_dev", "on_staging", "on_prod", "published", "force_merged", "merged_broken", "closed",
];
function substatusRank(value?: string): number {
  const rank = value ? SUBSTATUS_RANK.indexOf(value) : -1;
  return rank === -1 ? SUBSTATUS_RANK.length : rank;
}

export function sortBugsByPopularity<T extends BugPopularitySortKey>(
  bugs: T[],
): T[] {
  return [...bugs].sort(compareBugsByPopularity);
}

export function sortBugs<T extends BugSortableItem>(
  bugs: T[],
  sort: BugSortOption,
): T[] {
  return [...bugs].sort((a, b) => {
    const boostDiff = compareBoosted(a, b);
    if (boostDiff !== 0) return boostDiff;
    switch (sort) {
      case "newest":
        return compareBugsByNewest(a, b);
      case "recently_updated":
        return compareBugsByRecentlyUpdated(a, b);
      case "importance":
        return compareBugsByPopularity(
          { voteCount: a.voteCount, updatedAt: a.updatedAt ?? a.createdAt },
          { voteCount: b.voteCount, updatedAt: b.updatedAt ?? b.createdAt },
        );
      case "least_important":
        return compareBugsByLowestVotes(
          { voteCount: a.voteCount, updatedAt: a.updatedAt ?? a.createdAt },
          { voteCount: b.voteCount, updatedAt: b.updatedAt ?? b.createdAt },
        );
      case "title":
      case "title_desc": {
        const diff = (a.title ?? "").localeCompare(b.title ?? "");
        return (sort === "title" ? diff : -diff) || compareBugsByNewest(a, b);
      }
      case "status":
      case "status_desc": {
        const diff = substatusRank(a.substatus) - substatusRank(b.substatus);
        return (sort === "status" ? diff : -diff) || compareBugsByRecentlyUpdated(a, b);
      }
      case "reward":
      case "reward_low": {
        const diff = rewardOf(b) - rewardOf(a);
        return (sort === "reward" ? diff : -diff) || b.voteCount - a.voteCount;
      }
    }
  });
}
