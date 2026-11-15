import { ROW_KINDS, type CardRow, type CardSquare, type TestCard } from "@/lib/proof";
import { TestCardDecision } from "@/components/test-card-decision";

const TAG: Record<CardRow["source"], { label: string; tone: string }> = {
  check: { label: "Project check", tone: "bg-zk-tint text-zk-accent" },
  criteria: { label: "AC", tone: "bg-zk-chip text-zk-text2" },
  receipt: { label: "Receipt", tone: "bg-zk-chip text-zk-text2" },
  beyond: { label: "✦ Wild", tone: "bg-zk-tint text-zk-accent" },
  suggested: { label: "✦ Suggested", tone: "bg-zk-tint text-zk-accent" },
};

/** Each stamp's own slight tilt, the same on every visit. */
const tilt = (key: string) => `${(([...key].reduce((n, ch) => n + ch.charCodeAt(0), 0) % 13) - 6) * 1.5}deg`;

/** One square: a tilted PASSED or FAILED stamp, the count on a risky row, or "?" while nobody has tried it. */
function Square({ square }: { square: CardSquare }) {
  const who = square.failers.length ? `Fails, proven by ${square.failers.join(", ")}` : square.provers.length ? `Proven by ${square.provers.join(", ")}` : "Nobody has tried this yet";
  const box =
    square.state === "passed" ? "border-zk-ok-fg/30 bg-zk-ok-bg" : square.state === "failed" ? "border-zk-bad-bd bg-zk-bad-bg" : "border-dashed border-zk-border bg-zk-surface";
  return (
    <span title={who} className={`grid h-11 w-full place-items-center rounded-lg border-2 ${box}`}>
      {square.state === "passed" || square.state === "failed" ? (
        <span
          style={{ "--tilt": tilt(square.key) } as React.CSSProperties}
          className={`card-stamp rounded border-2 px-1 py-px font-mono text-[10px] font-black tracking-wider ${square.state === "passed" ? "border-zk-ok-fg text-zk-ok-fg" : "border-zk-bad-fg text-zk-bad-fg"}`}
        >
          {square.state === "passed" ? "PASSED" : "FAILED"}
        </span>
      ) : (
        <span className={`font-mono text-sm font-bold ${square.state === "half" ? "text-zk-warn-fg" : "text-zk-muted"}`}>{square.state === "half" ? `${square.provers.length}/${square.needed}` : "?"}</span>
      )}
    </span>
  );
}

/** A row that waits on the deliverer's CI test or on the owners, not on testers. */
function Routed({ row }: { row: CardRow }) {
  const label = row.route === "ci" ? (row.testAttached ? "TEST ✓" : "CI") : row.decision === "waived" ? "WAIVED" : row.decision === "idea" ? "IDEA" : "OWNER";
  const settled = row.testAttached || row.decision;
  return (
    <span
      title={row.route === "ci" ? "Waiting on the deliverer's automated test, not on testers" : "Waiting on the project's owners, not on testers"}
      className={`grid h-11 w-full place-items-center rounded-lg border-2 font-mono text-[10px] font-black tracking-wider ${settled ? "border-zk-border bg-zk-chip text-zk-muted" : "border-dashed border-zk-warn-bd bg-zk-warn-bg text-zk-warn-fg"}`}
    >
      {label}
    </span>
  );
}

/**
 * The issue's test card (#deeper-testing, lib/proof.ts): the checks, the
 * acceptance criteria, the receipt's gaps and the wild rows testers found,
 * scenarios down and environments across. Every square needs a tester's proof
 * before the issue is accepted. Agents write it through the API; people read it.
 */
export function TestCardPanel({
  card,
  author,
  priority,
  bugId,
  canDecide,
  ideaHref,
}: {
  card: TestCard;
  author: string | null;
  priority: string;
  bugId: string;
  /** The project's owners and admins settle rows nobody can prove. */
  canDecide: boolean;
  ideaHref: string;
}) {
  const envs = card.envs.length ? card.envs : [""];
  const cols = { gridTemplateColumns: `minmax(160px,1fr) repeat(${envs.length}, 72px) 56px` };
  const live = card.rows.filter((r) => !r.bench);
  const bench = card.rows.filter((r) => r.bench);
  const blackout = card.total > 0 && card.stamped === card.total;
  return (
    <section id="test-card" aria-labelledby="test-card-heading" className="scroll-mt-24 rounded-[20px] border border-zk-border bg-zk-surface p-5 sm:p-[22px]">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 id="test-card-heading" className="m-0 text-xs font-bold tracking-[0.08em] text-zk-muted uppercase">
          Test card
        </h2>
        <span className={`text-xs font-bold ${card.failed ? "text-zk-bad-fg" : blackout ? "text-zk-ok-fg" : "text-zk-text2"}`}>
          {blackout ? "Blackout! Every square stamped" : `${card.stamped} of ${card.total} squares stamped`}
          {card.failed ? ` · ${card.failed} FAILED` : ""}
          {card.waitingOnCi ? <span className="text-zk-warn-fg"> · {card.waitingOnCi} waiting on CI</span> : null}
          {card.waitingOnOwners ? <span className="text-zk-warn-fg"> · {card.waitingOnOwners} waiting on the owners</span> : null}
        </span>
      </div>
      <p className="mt-1 text-[13px] text-zk-text2">
        Everything testers must prove, on one card{author ? <>. Drawn up by <b className="text-zk-text">{author}</b></> : null}; sized for a {priority} issue: up to{" "}
        <b className="text-zk-text">{card.size} squares</b>.
      </p>

      <div className="mt-3 overflow-x-auto">
        <div className="grid min-w-[460px] gap-1.5" style={cols}>
          <span />
          {envs.map((env) => (
            <span key={env} className="self-end pb-0.5 text-center text-[11px] font-bold tracking-wide text-zk-muted uppercase">
              {env}
            </span>
          ))}
          <span />
          {live.map((row) => (
            <div key={row.key} className="contents">
              <span className="flex min-w-0 flex-col justify-center pr-2 text-[13px] leading-snug text-zk-text">
                <span title={row.why ?? undefined}>
                  {row.text}
                  {row.squares[0]?.needed > 1 ? <span title="Risky: two testers must prove it" className="ml-1 rounded bg-zk-chip px-1 text-[10px] font-bold text-zk-text2">×2</span> : null}
                </span>
                <span className="mt-0.5 flex flex-wrap gap-1 text-[10px] font-bold">
                  <span className={`rounded px-1 ${TAG[row.source].tone}`}>{TAG[row.source].label}</span>
                  {row.kind ? <span title={ROW_KINDS[row.kind].tip} className="rounded bg-zk-warn-bg px-1 text-zk-warn-fg">{ROW_KINDS[row.kind].label}</span> : null}
                  {row.proof !== "screen" ? <span className="rounded bg-zk-chip px-1 text-zk-text2">{row.proof === "test" ? "Test run" : "Logs"}</span> : null}
                  {row.by ? <span className="font-normal text-zk-muted">added by {row.by}</span> : null}
                </span>
              </span>
              {row.route ? (
                <span style={{ gridColumn: `span ${envs.length}` }}>
                  <Routed row={row} />
                </span>
              ) : row.squares.length === 1 && row.squares[0].env === null ? (
                <span style={{ gridColumn: `span ${envs.length}` }}>
                  <Square square={row.squares[0]} />
                </span>
              ) : (
                envs.map((env) => {
                  const square = row.squares.find((s) => s.env === env);
                  return square ? <Square key={env} square={square} /> : <span key={env} className="h-11 rounded-lg bg-zk-chip/40" title="Not needed here" />;
                })
              )}
              <span className="grid place-items-center">
                {!row.route && row.squares.every((s) => s.state === "passed") ? (
                  <span title="Every square in this row is stamped" className="card-bingo rounded-full bg-zk-ok-fg px-1.5 py-0.5 text-[10px] font-black tracking-wide text-zk-surface">BINGO</span>
                ) : null}
              </span>
            </div>
          ))}
        </div>
      </div>

      {live.some((r) => r.route === "env" && !r.decision) && canDecide ? (
        <ul className="m-0 mt-3 flex list-none flex-col gap-2 p-0">
          {live
            .filter((r) => r.route === "env" && !r.decision)
            .map((row) => (
              <li key={row.key} className="rounded-xl border border-zk-warn-bd bg-zk-warn-bg/50 px-3 py-2.5 text-[13px] text-zk-text2">
                Testers can&apos;t prove <b className="text-zk-text">“{row.text}”</b> with what the project gives them. It doesn&apos;t hold the issue.
                <TestCardDecision bugId={bugId} rowId={row.id!} ideaHref={ideaHref} />
              </li>
            ))}
        </ul>
      ) : null}

      {bench.length ? (
        <div className="mt-3 rounded-xl border border-dashed border-zk-border px-3 py-2.5 text-xs text-zk-text2">
          <p className="m-0 font-semibold">On the bench · the card is full ({card.size} squares for a {priority} issue)</p>
          <ul className="m-0 mt-1 list-none p-0">
            {bench.map((row) => (
              <li key={row.key}>
                {row.text} <span className="text-zk-muted">· doesn&apos;t hold the issue</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="m-0 mt-3 border-t border-zk-divider pt-3 text-[13px] text-zk-text2">
        {card.rating
          ? card.rating.value === "thorough"
            ? `👍 ${card.rating.by} rated the card thorough.`
            : `😴 ${card.rating.by} rated the card too easy, so Ziki suggested a kind of row it didn't have.`
          : "Waiting for a second tester to rate the card."}
      </p>
      <p className="m-0 mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-zk-muted">
        <span>
          <b className="text-zk-ok-fg">PASSED</b> proven
        </span>
        <span>
          <b className="text-zk-bad-fg">FAILED</b> proven to fail
        </span>
        <span>
          <b>?</b> nobody yet
        </span>
        <span>
          <b>×2</b> needs two testers
        </span>
        <span>
          <b>CI · OWNER</b> waiting on the deliverer&apos;s test or the owners, not testers
        </span>
      </p>
    </section>
  );
}
