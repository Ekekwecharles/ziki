"use client";

import { useEffect } from "react";

/**
 * A one-time message carried in the address (`?error=…`, `?bought=1`). It is shown on arrival and the query is then
 * dropped from the address, so a refresh or a shared link doesn't bring it back.
 */
export function UrlNotice({ children, className, role }: { children: React.ReactNode; className: string; role: "alert" | "status" }) {
  useEffect(() => {
    try {
      window.history.replaceState(window.history.state, "", window.location.pathname);
    } catch {
      // The address stays as it is; the message just shows again on refresh.
    }
  }, []);
  return (
    <p role={role} className={className}>
      {children}
    </p>
  );
}
