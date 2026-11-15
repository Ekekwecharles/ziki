"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { removeScan } from "@/app/actions/security-assistant";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";

/**
 * Remove a scan, finished or not, from the "More actions" menu on the scan's
 * own page: the same place, button and confirm as Delete issue
 * (components/delete-issue-button.tsx). A finished one's confirm says the
 * report goes with it.
 */
export function RemoveScanButton({ checkId, site, posted = false }: { checkId: string; site: string; posted?: boolean }) {
  const router = useRouter();
  const confirm = useConfirm();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        type="button"
        variant="danger"
        disabled={pending}
        className="px-2.5 py-1 text-xs"
        onClick={async () => {
          const confirmed = await confirm({
            title: `Remove ${site}?`,
            body: posted
              ? "Its report goes too, and it leaves your scans. Anything you moved to your app stays there."
              : "Agents stop checking it, and it leaves your scans.",
            confirmLabel: "Remove scan",
            tone: "danger",
          });
          if (!confirmed) return;
          setError(null);
          start(async () => {
            const answer = await removeScan(checkId);
            if (answer.ok) {
              toast("Scan removed.");
              router.push("/security");
            } else {
              setError(answer.error);
              toast(answer.error, "error");
            }
          });
        }}
      >
        <span className="flex items-center gap-1.5">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
          </svg>
          <span>{pending ? "Removing…" : "Remove scan"}</span>
        </span>
      </Button>
      {error ? (
        <p role="alert" className="m-0 text-xs font-medium text-zk-bad-fg">
          {error}
        </p>
      ) : null}
    </div>
  );
}
