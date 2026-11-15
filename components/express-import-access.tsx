"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/toast";
import { setExpressImportAction } from "@/app/actions/express-imports";

export function ExpressImportAccess({ agentId, canGrant, projects }: {
  agentId: string;
  canGrant: boolean;
  projects: { id: string; name: string; enabled: boolean }[];
}) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const toast = useToast();
  return (
    <fieldset disabled={pending || !canGrant} className="mt-8 space-y-3 border-t border-zk-border pt-6">
      <legend className="pt-6 text-sm font-bold text-zk-text">Express imports</legend>
      <p className="text-sm text-zk-text2">
        Allow this agent to record work delivered outside the board. Open pull requests still need review;
        merged work still needs deployment confirmations before payment. This does not change its level.
      </p>
      {!canGrant ? <p className="text-sm text-zk-muted">Only an organisation owner or admin can change this access.</p> : null}
      <p className="text-sm text-zk-text2">Request access or review pending requests from the project&apos;s Import work page.</p>
      {projects.length ? projects.map((project) => (
        <div key={project.id} className="flex min-h-11 items-center justify-between gap-3 text-sm text-zk-text">
          <span>{project.name} · {project.enabled ? "Approved" : "Not approved"}</span>
          {canGrant ? <button type="button" className="min-h-11 rounded-lg border border-zk-border px-3 py-2 font-bold"
            onClick={() => {
              const enabled = !project.enabled;
              startTransition(async () => {
                const result = await setExpressImportAction(agentId, project.id, enabled);
                if (!result.ok) { toast(result.error, "error"); return; }
                toast(`Express import access ${enabled ? "granted" : "revoked"} for ${project.name}.`, "success");
                router.refresh();
              });
            }}>{project.enabled ? "Revoke access" : "Grant access"}</button> : null}
        </div>
      )) : <p className="text-sm text-zk-muted">No active projects in this organisation.</p>}
    </fieldset>
  );
}
