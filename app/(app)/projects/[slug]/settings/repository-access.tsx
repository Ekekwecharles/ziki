import Link from "next/link";
import type { RepositoryAccess, RepositoryAccessState } from "@/lib/github/settings-access";

const STYLES: Record<RepositoryAccessState, { box: string; dot: string; heading: string }> = {
  ok: { box: "border-zk-border", dot: "bg-zk-ok-fg", heading: "App access verified" },
  not_accessible: { box: "border-zk-warn-fg/40 bg-zk-warn-bg", dot: "bg-zk-warn-fg", heading: "The app can't see this repository" },
  unverified: { box: "border-zk-border", dot: "bg-zk-muted", heading: "App access not verified" },
  no_installation: { box: "border-zk-border", dot: "bg-zk-muted", heading: "Not accessible" },
  invalid_url: { box: "border-zk-warn-fg/40 bg-zk-warn-bg", dot: "bg-zk-warn-fg", heading: "Invalid repository address" },
  not_configured: { box: "border-zk-border", dot: "bg-zk-muted", heading: "No repository configured" },
  check_failed: { box: "border-zk-border", dot: "bg-zk-muted", heading: "Access not checked" },
};

/** Per-repository GitHub App access, so a selected-repositories installation is visible here, not only on the readiness page. */
export function RepositoryAccessPanel({ access }: { access: RepositoryAccess[] }) {
  return (
    <div className="flex flex-col gap-2" aria-label="Repository access">
      <h3 className="m-0 text-sm font-bold text-zk-text">Repository access</h3>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {access.map((repository) => {
          const style = STYLES[repository.state];
          return (
            <li key={repository.key} className={`rounded-xl border p-3 ${style.box}`}>
              <p className="m-0 flex flex-wrap items-center gap-2 text-sm">
                <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${style.dot}`} />
                <span className="font-semibold text-zk-text">{style.heading}</span>
                <span className="rounded-full bg-zk-chip px-2 py-0.5 text-xs font-medium text-zk-text2">{repository.label}</span>
                <code className="font-mono text-xs text-zk-text2">{repository.name}</code>
              </p>
              <p className="m-0 mt-1 text-[13px] text-zk-text2">{repository.message}</p>
              {repository.state === "not_accessible" || repository.state === "check_failed" ? (
                <p className="m-0 mt-1 text-[13px]">
                  <Link href="/projects/readiness" className="font-semibold text-zk-accent underline">
                    Run the full readiness check
                  </Link>
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
