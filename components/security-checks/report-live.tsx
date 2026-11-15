"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

const EVERY_MS = 5_000;

/**
 * Keeps a running check's page live (12 Nov plan, S1): parts turn from waiting
 * to checking to done without a reload. Agents ask for work every 5–10
 * seconds, so the page re-reads itself every 5 seconds while it is showing,
 * and at once when you come back to the tab. The page renders it only until
 * the report is posted.
 */
export function ReportLive() {
  const router = useRouter();
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const timer = window.setInterval(refresh, EVERY_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [router]);
  return null;
}
