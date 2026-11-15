import Link from "next/link";
import { buildPaginationUrl, getPaginationRange } from "@/lib/pagination";

export interface PaginationControlsProps {
  page: number;
  totalPages: number;
  totalCount: number;
  from: number;
  to: number;
  queryParams: Record<string, string | undefined>;
  basePath: string;
  itemLabel?: string;
  /** For a word that doesn't take an "s" ("person" and "people"). */
  itemLabelPlural?: string;
}

export function PaginationControls({
  page,
  totalPages,
  totalCount,
  from,
  to,
  queryParams,
  basePath,
  itemLabel = "issue",
  itemLabelPlural,
}: PaginationControlsProps) {
  if (totalCount === 0) return null;

  const range = getPaginationRange(page, totalPages);
  const prevUrl = page > 1 ? buildPaginationUrl(basePath, page - 1, queryParams) : null;
  const nextUrl =
    page < totalPages ? buildPaginationUrl(basePath, page + 1, queryParams) : null;

  const pill =
    "inline-flex min-h-10 items-center justify-center rounded-full border border-zk-border bg-zk-surface px-3.5 text-xs font-bold text-zk-text transition hover:bg-zk-chip focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-electric-blue";
  const pillDisabled =
    "inline-flex min-h-10 cursor-not-allowed items-center justify-center rounded-full border border-zk-border bg-zk-chip px-3.5 text-xs font-bold text-zk-muted";

  return (
    <nav
      aria-label="Pagination"
      className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="text-xs text-zk-muted">
        Showing <span className="font-semibold text-zk-text">{from}</span>–
        <span className="font-semibold text-zk-text">{to}</span> of{" "}
        <span className="font-semibold text-zk-text">{totalCount}</span>{" "}
        {totalCount === 1 ? itemLabel : (itemLabelPlural ?? `${itemLabel}s`)}
      </div>

      {totalPages > 1 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {prevUrl ? (
            <Link href={prevUrl} className={pill}>Previous</Link>
          ) : (
            <span aria-disabled="true" className={pillDisabled}>Previous</span>
          )}

          <div className="flex items-center gap-1">
            {range.map((item, index) => {
              if (item === "...") {
                return (
                  <span key={`ellipsis-${index}`} className="px-1.5 text-xs text-zk-muted">…</span>
                );
              }
              const isCurrent = item === page;
              const url = buildPaginationUrl(basePath, item, queryParams);
              return isCurrent ? (
                <span
                  key={item}
                  aria-current="page"
                  className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-electric-blue-strong text-xs font-bold text-white"
                >
                  {item}
                </span>
              ) : (
                <Link
                  key={item}
                  href={url}
                  className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-zk-border bg-zk-surface text-xs font-bold text-zk-text transition hover:bg-zk-chip focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-electric-blue"
                >
                  {item}
                </Link>
              );
            })}
          </div>

          {nextUrl ? (
            <Link href={nextUrl} className={pill}>Next</Link>
          ) : (
            <span aria-disabled="true" className={pillDisabled}>Next</span>
          )}
        </div>
      )}
    </nav>
  );
}
