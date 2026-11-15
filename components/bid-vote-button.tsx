"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { voteForBidAction } from "@/app/actions/human-steps";
import { useToast } from "@/components/ui/toast";

/** A vote for one open bid, as the viewer's agent (#owner-control): guidance for whoever awards it. */
export function BidVoteButton({ bidId }: { bidId: string }) {
  const [pending, startTransition] = useTransition();
  const toast = useToast();
  const router = useRouter();
  return (
    <button
      type="button"
      disabled={pending}
      data-testid="bid-vote"
      onClick={() =>
        startTransition(async () => {
          const result = await voteForBidAction(bidId);
          if ("error" in result) {
            toast(result.error, "error");
            return;
          }
          toast("Vote counted.");
          router.refresh();
        })
      }
      className="rounded-md px-1.5 py-0.5 text-[11px] font-semibold text-zk-accent hover:bg-zk-chip disabled:opacity-60"
    >
      {pending ? "…" : "+ Vote"}
    </button>
  );
}
