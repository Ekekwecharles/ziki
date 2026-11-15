
import { type ProjectRef } from "@/lib/project-paths";
import { Badge } from "@/components/ui/badge";
import type { MarketingBriefKey, MarketingSettingsData, MarketingTaskType } from "./model";
import { BriefForm } from "./brief-form";
import { RevisionLimitForm } from "./revision-limit-form";
import { TypesManager } from "./types-manager";

const BRIEF_LABELS: { key: MarketingBriefKey; label: string }[] = [
  { key: "product", label: "Product" },
  { key: "audience", label: "Audience" },
  { key: "currentFocus", label: "Current focus" },
  { key: "outOfScope", label: "Out of scope" },
];

const card = "rounded-[20px] border border-zk-border bg-zk-surface p-5 sm:p-6";

function heading(name: string, id: string) {
  return <h2 id={id} className="m-0 text-base font-bold text-zk-text">{name}</h2>;
}

/** Members read the settings; the panels are offered without their forms. */
function TypesReadOnly({ types }: { types: MarketingTaskType[] }) {
  return (
    <section aria-labelledby="marketing-types" className={card}>
      {heading("Task types", "marketing-types")}
      {types.length === 0 ? (
        <p className="mt-2 text-sm text-zk-muted">No marketing task types yet.</p>
      ) : (
        <ul className="mt-3 flex list-none flex-col gap-2 p-0">
          {types.map((type) => (
            <li key={type.id} className="flex flex-wrap items-center gap-2 text-sm text-zk-text2">
              <Badge className="bg-zk-chip text-zk-text">{type.name}</Badge>
              <span>{type.description ?? "—"}</span>
              {!type.isActive ? (
                <span className="rounded-full bg-zk-chip px-2.5 py-0.5 text-xs text-zk-muted">Inactive</span>
              ) : null}
              {type.usage > 0 ? (
                <span className="text-xs text-zk-muted">
                  {type.usage} task{type.usage === 1 ? "" : "s"}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * `/<slug>/marketing/settings`'s content (M-UI-7): the brief agents read, the
 * marketing task types, and the revision limit dial. Owners and admins manage
 * all three; members see them read-only. Reward amounts stay in the existing
 * project settings, so no points appear here (D7).
 */
export function MarketingSettings({
  slug,
  data,
}: {
  slug: ProjectRef;
  data: MarketingSettingsData;
}) {
  const { revisionLimit, canManage, types, brief } = data;

  if (!canManage) {
    return (
      <div className="flex flex-col gap-5 pb-10">

        <header className="flex flex-col gap-3">
          <h1 className="m-0 text-[28px] font-extrabold leading-tight tracking-[-0.02em] text-zk-text">
            Marketing settings
          </h1>
          <p className="m-0 max-w-2xl text-sm leading-relaxed text-zk-text2">
            The project brief, the marketing task types and the revision limit.
          </p>
        </header>

        <div className={card} role="note">
          <p className="m-0 text-sm font-medium text-zk-text">
            Only organisation owners and admins can change marketing settings.
          </p>
          <p className="m-0 mt-1 text-sm text-zk-text2">Everything below is read-only for you.</p>
        </div>

        <section aria-labelledby="marketing-brief" className={card}>
          {heading("Brief", "marketing-brief")}
          <p className="mt-2 text-sm text-zk-text2">
            What agents should know before proposing or delivering marketing work.
          </p>
          <dl className="m-0 mt-3 flex flex-col gap-3 text-sm">
            {BRIEF_LABELS.map(({ key, label }) => (
              <div key={key}>
                <dt className="font-medium text-zk-text">{label}</dt>
                <dd className="m-0 whitespace-pre-wrap break-words text-zk-text2">{brief[key] || "—"}</dd>
              </div>
            ))}
          </dl>
        </section>

        <TypesReadOnly types={types} />

        <section aria-labelledby="marketing-revision-limit" className={card}>
          {heading("Revision limit", "marketing-revision-limit")}
          <p className="mt-2 text-sm text-zk-text2">
            A marketing delivery can be sent back up to{" "}
            <b className="font-semibold text-zk-text">
              {revisionLimit} time{revisionLimit === 1 ? "" : "s"}
            </b>{" "}
            before the task reopens for bids.
          </p>
        </section>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 pb-10">

      <header className="flex flex-col gap-3">
        <h1 className="m-0 text-[28px] font-extrabold leading-tight tracking-[-0.02em] text-zk-text">
          Marketing settings
        </h1>
        <p className="m-0 max-w-2xl text-sm leading-relaxed text-zk-text2">
          The project brief, the marketing task types and the revision limit. Reward amounts stay in the
          project&apos;s existing settings: every task pays its own reward.
        </p>
      </header>

      <BriefForm slug={slug} initial={brief} />
      <TypesManager slug={slug} types={types} />
      <RevisionLimitForm slug={slug} current={revisionLimit} />
    </div>
  );
}
