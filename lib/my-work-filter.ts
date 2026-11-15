import type { Prisma, WorkTrack } from "@prisma/client";

/** `?mywork=1` on the issue list: only the issues you are working on or bidding for. */
export const MY_WORK_PARAM = "mywork";

/** `?track=` on the issue list: "product" | "marketing" | "all". Defaults to "product". */
export const TRACK_PARAM = "track";

export function parseMyWorkFilter(raw: string | string[] | null | undefined): boolean {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === "1";
}

/** Parse track filter from query params. Returns "product" | "marketing" | "all". */
export function parseTrackFilter(raw: string | string[] | null | undefined): WorkTrack | "all" {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || value === "product") return "product";
  if (value === "marketing") return "marketing";
  if (value === "all") return "all";
  return "product";
}

/** Prisma where fragment for track filter. */
export function trackWhere(track: WorkTrack | "all"): Prisma.BugWhereInput {
  if (track === "all") return {};
  return { track };
}

/**
 * `?track=` on the Inbox. Unlike the issue list it defaults to "all": the Inbox
 * is a person's own record, so nothing is hidden until they ask (M-UI-8).
 */
export function parseInboxTrack(raw: string | string[] | null | undefined): WorkTrack | "all" {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === "product" || value === "marketing" ? value : "all";
}

/**
 * The notifications a track filter keeps. One that names no issue (an invite, a
 * organisation notice) isn't marketing work, so it stays under Product.
 */
export function notificationTrackWhere(track: WorkTrack | "all"): Prisma.NotificationWhereInput {
  if (track === "all") return {};
  if (track === "marketing") return { bug: { track } };
  return { AND: [{ OR: [{ bugId: null }, { bug: { track } }] }] };
}

/** The same rule for an escalation, which is filtered once loaded. */
export function escalationOnTrack(bug: { track: WorkTrack } | null, track: WorkTrack | "all"): boolean {
  if (track === "all") return true;
  return (bug?.track ?? "product") === track;
}

/** Filter linked escalations before their bounded query, keeping neutral items in Product. */
export function escalationTrackWhere(track: WorkTrack | "all") {
  if (track === "all") return {};
  if (track === "marketing") return { bug: { is: { track } } };
  return { OR: [{ bugId: null }, { bug: { is: { track } } }] };
}

/**
 * Your work: issues associated with you across the full lifecycle.
 * Includes:
 * - Live bids placed for you (not withdrawn)
 * - Active/offered claims held for you (not released)
 * - Issues directly assigned to you (assigneeId)
 * - Issues where your agent delivered work (delivery.beneficiaryUserId)
 * - Issues where your agent completed work (claim released with reason "resolved")
 * - Issues you reported (reporterId) - optional, for "Created by me" view
 * Bids, claims, and deliveries name the person they are for (`beneficiaryUserId`),
 * so your agents' work counts as yours.
 */
export function myWorkWhere(userId: string): Prisma.BugWhereInput {
  return {
    OR: [
      // Live bids for you
      { bids: { some: { beneficiaryUserId: userId, withdrawnAt: null } } },
      // Active/offered claims for you
      { claims: { some: { beneficiaryUserId: userId, status: { in: ["offered", "planning", "active"] }, releasedAt: null } } },
      // Directly assigned to you
      { assigneeId: userId },
      // Deliveries by your agents (agent completed work on your behalf)
      { deliveries: { some: { beneficiaryUserId: userId } } },
      // Claims released as "resolved" by your agents (work completed)
      { claims: { some: { beneficiaryUserId: userId, releaseReason: "resolved", releasedAt: { not: null } } } },
    ],
  };
}

/**
 * "Created by me" filter - issues where you are the reporter.
 * Separate from "My Work" which is about active involvement.
 */
export function createdByMeWhere(userId: string): Prisma.BugWhereInput {
  return { reporterId: userId };
}

/**
 * Project Overview's work list: issues that are yours to move, not finished
 * yet. A claim held or offered for you (or your agents) that hasn't been
 * released: assigned work, an offer to accept, a plan under review, and your
 * delivered work on its way to live. Open bids are only summed up above the
 * list (`yourOpenBidsWhere`), and importance marks don't count: they aren't work.
 */
export function yourWorkWhere(userId: string): Prisma.BugWhereInput {
  return {
    status: { notIn: ["resolved", "closed"] },
    claims: { some: { beneficiaryUserId: userId, status: { in: ["offered", "planning", "active"] }, releasedAt: null } },
  };
}

/** The open issues you (or your agents) bid on, waiting for an award: counted on Project Overview, not listed. */
export function yourOpenBidsWhere(userId: string): Prisma.BugWhereInput {
  return { status: "open", bids: { some: { beneficiaryUserId: userId, withdrawnAt: null, awardedAt: null } } };
}
