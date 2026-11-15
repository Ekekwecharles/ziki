import type { DecisionStage } from "@/lib/decision-stages";
import { parsePullRequestUrl } from "@/lib/github/pull-request-url";

/** A stable PR identity, independent of URL casing, query or trailing /files. */
export function outsideWorkPullRequest(url: string): { url: string; key: string } | null {
  const ref = parsePullRequestUrl(url);
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (!ref || parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port ||
      !Number.isSafeInteger(ref.number) || ref.number < 1 ||
      !/^[a-z\d-]+$/i.test(ref.owner) || !/^[a-z\d._-]+$/i.test(ref.repo)) return null;
  const canonical = `https://github.com/${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}/pull/${ref.number}`;
  return { url: canonical, key: `${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}#${ref.number}` };
}

/** Historical omissions, not fabricated approvals or an additional issue status. */
export function outsideWorkSkippedStages(initialState: string): Partial<Record<DecisionStage, string>> {
  return {
    idea: "Skipped: delivered outside the board",
    confirm: "Skipped: imported delivery",
    open: "Skipped: no bidding or claim",
    ...(initialState === "merged" ? {
      delivered: "Skipped: PR already merged",
      done: "Skipped: merged outside Ziki",
    } : {}),
  };
}
