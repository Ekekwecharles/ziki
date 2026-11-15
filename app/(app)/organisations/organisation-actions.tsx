"use client";

import { useEffect, useRef, useState } from "react";
import { agentsPrimaryBtn, agentsSecondaryBtn } from "@/app/(app)/settings/agents/agents-ui";
import { CreateOrganisationForm } from "./create-organisation-form";
import { InviteLinkForm } from "./invite-link-form";

type Open = "join" | "create" | null;

/**
 * The organisations page's two actions, as buttons at the top (#444): Join
 * opens a modal to paste an invite link; Create opens one to name a new
 * organisation.
 */
export function OrganisationActions({ nameMax, next }: { nameMax: number; next?: string }) {
  // Sent here from Security to make a first workspace: the create form opens straight away.
  const [open, setOpen] = useState<Open>(next ? "create" : null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (open) dialogRef.current?.showModal();
  }, [open]);

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => setOpen("join")} className={agentsSecondaryBtn}>
          Join an organisation
        </button>
        <button type="button" onClick={() => setOpen("create")} className={agentsPrimaryBtn}>
          Create organisation
        </button>
      </div>

      {open ? (
        <dialog
          ref={dialogRef}
          aria-labelledby="organisation-action-title"
          onCancel={(event) => {
            event.preventDefault();
            setOpen(null);
          }}
          className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-[20px] border border-zk-border bg-zk-surface p-6 text-zk-text shadow-xl backdrop:bg-black/50"
        >
          <div className="flex items-start justify-between gap-3">
            <h2 id="organisation-action-title" className="text-lg font-extrabold">
              {open === "join" ? "Join an organisation" : "Create an organisation"}
            </h2>
            <button
              type="button"
              onClick={() => setOpen(null)}
              aria-label="Close"
              className="rounded-md p-1 text-zk-muted hover:bg-zk-chip hover:text-zk-text focus-visible:outline-2 focus-visible:outline-electric-blue"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="m6 6 12 12M18 6 6 18" />
              </svg>
            </button>
          </div>
          {open === "join" ? (
            <>
              <p className="mt-1 text-sm text-zk-text2">
                Organisations are invite-only. Paste the link an owner or admin sent you.
              </p>
              <InviteLinkForm />
            </>
          ) : (
            <CreateOrganisationForm nameMax={nameMax} next={next} />
          )}
        </dialog>
      ) : null}
    </>
  );
}
