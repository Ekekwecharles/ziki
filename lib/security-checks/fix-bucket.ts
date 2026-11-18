import type { IdeaStatus, Status } from "@prisma/client";

export type FixBucket = "fixing" | "fixed" | "closed";

/** What a moved finding's fix needs: its issue and the idea before it. */
export type FixSource = {
  bug: { status: Status; isDeleted: boolean } | null;
  idea: { status: IdeaStatus; isDeleted: boolean } | null;
};

/**
 * Where a moved finding's fix stands: `fixed` once its issue is resolved, `closed` when the issue was closed or the
 * idea turned down, otherwise `fixing`. Deleted ideas and issues don't count.
 */
export function fixBucketOf(finding: FixSource): FixBucket {
  const bug = finding.bug && !finding.bug.isDeleted ? finding.bug : null;
  const idea = finding.idea && !finding.idea.isDeleted ? finding.idea : null;
  if (bug?.status === "resolved") return "fixed";
  if (bug?.status === "closed" || (!bug && (idea?.status === "rejected" || idea?.status === "archived"))) return "closed";
  return "fixing";
}
