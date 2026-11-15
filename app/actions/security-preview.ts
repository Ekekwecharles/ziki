"use server";

import { headers } from "next/headers";
import { auth } from "@/auth";
import { previewScan } from "@/lib/security-checks/preview";
import { summarisePreview, type PreviewSummary } from "@/lib/security-checks/preview-summary";

export type PublicScanAnswer = { ok: true; summary: PreviewSummary } | { ok: false; reason: string };

/**
 * The quick scan behind the box on the public Ziki Security page
 * (#security-checks, part C2). Code only, no AI, using Dave's preview scan:
 * rate-limited per visitor (the signed-in person, else their address), and it
 * returns counts only, never what was found.
 */
export async function runPublicScan(link: string): Promise<PublicScanAnswer> {
  const session = await auth();
  const result = await previewScan(typeof link === "string" ? link : "", { visitor: await visitorKey(session?.user?.id) });
  if (!result.ok) return { ok: false, reason: result.reason };
  return { ok: true, summary: summarisePreview(result) };
}

/** Who to count scans against: the person when signed in, else the address Cloudflare saw (which a visitor can't fake). */
async function visitorKey(userId: string | undefined): Promise<string> {
  if (userId) return `user:${userId}`;
  const list = await headers();
  const address = list.get("cf-connecting-ip") ?? list.get("x-real-ip") ?? list.get("x-forwarded-for")?.split(",")[0]?.trim();
  return `ip:${address || "unknown"}`;
}
