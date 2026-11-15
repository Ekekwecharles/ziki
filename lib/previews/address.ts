import { createHash } from "node:crypto";

/**
 * Where a pull request's preview lives (#previews). Must match the preview
 * builder's deploy step (zedu-vulcan/ziki-preview-builder, preview.yml):
 *
 *   repo_id=$(printf '%s' "${REPOSITORY,,}" | sha256sum | cut -c1-10)
 *   branch="pr-$PR-$repo_id"
 *
 * Cloudflare Pages serves the branch's latest upload at
 * https://<branch>.<pages project>.pages.dev, so the address is known before
 * the build finishes and stays the same across new commits.
 */

export const DEFAULT_PAGES_PROJECT = "ziki-previews";

/** The Pages branch for `owner/name` pull request `pullNumber`. */
export function previewBranch(repository: string, pullNumber: number): string {
  const repoId = createHash("sha256").update(repository.toLowerCase()).digest("hex").slice(0, 10);
  return `pr-${pullNumber}-${repoId}`;
}

/** The pull request's preview address. */
export function previewUrl(repository: string, pullNumber: number, pagesProject = DEFAULT_PAGES_PROJECT): string {
  return `https://${previewBranch(repository, pullNumber)}.${pagesProject}.pages.dev`;
}
