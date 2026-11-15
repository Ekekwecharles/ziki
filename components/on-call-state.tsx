import type { OnCallState } from "@/lib/security-checks/on-call";

/** The dot beside a state: green online, orange quiet, grey when paused or without agents. The word beside it says the same, so colour is never the only sign. */
const DOT: Record<OnCallState, string> = {
  Online: "bg-zk-ok-fg",
  Quiet: "bg-[#ea580c]",
  Paused: "bg-zk-muted",
  "No agents": "bg-zk-muted",
};

export function OnCallStateLabel({ state }: { state: OnCallState }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-zk-text2">
      <span aria-hidden="true" className={`h-2 w-2 rounded-full ${DOT[state]}`} />
      {state}
    </span>
  );
}
