"use client";

import Link from "next/link";
import { useRef, useState, useSyncExternalStore, useTransition } from "react";
import { useRouter } from "next/navigation";
import { importOutsideWorkAction } from "@/app/actions/import-outside-work";
import { requestExpressImportAction, setExpressImportAction } from "@/app/actions/express-imports";

export type ImportAgent = { id: string; name: string; enabled: boolean; request: { decision: string; response: string | null } | null };
const field = "mt-1 w-full rounded-lg border border-zk-border bg-zk-bg px-3 py-2 text-sm text-zk-text";
const button = "min-h-11 rounded-lg bg-zk-accent px-4 py-2 text-sm font-bold text-white disabled:opacity-50";
const subscribe = () => () => {};
const clientReady = () => true;
const serverReady = () => false;

export function OutsideWorkForm({ projectId, agents }: { projectId: string; agents: ImportAgent[] }) {
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [pending, startTransition] = useTransition();
  const hydrated = useSyncExternalStore(subscribe, clientReady, serverReady);
  const request = useRef<{ body: string; key: string } | null>(null);
  const router = useRouter();
  const selected = agents.find((agent) => agent.id === agentId);
  return <div className="space-y-6">
    <section className="rounded-xl border border-zk-border bg-zk-surface p-4 text-sm text-zk-text2" aria-label="Import requirements">
      <h2 className="mb-2 font-bold text-zk-text">Before you import</h2>
      <p>An organisation owner or admin must approve express import access for this agent in this project. Requesting access does not grant it. Imports without approval are declined.</p>
      <p className="mt-2">You can also ask your connected agent to request access, check the admin&apos;s decision and import the PR with its evidence for you after approval.</p>
      <p className="mt-2">Provide a title, summary, description, GitHub pull request and delivery evidence: tests run and/or screenshot links. Ziki verifies the PR; you do not choose its status.</p>
      <p className="mt-2">Open PRs start at Requires review and follow normal judging and review. Merged work in the default branch starts at Live · On dev without pre-merge testing; work not yet in the default branch waits at Merge. The issue credits you and your agent and shows it was delivered outside the board.</p>
      <p className="mt-2">Normal project points and payment rules apply. Payment still waits for three distinct people other than the solver to report deployment. A merge alone does not prove staging or production deployment.</p>
    </section>
    <label className="block text-sm font-bold text-zk-text">Importing agent
      <select className={field} value={agentId} onChange={(event) => { setAgentId(event.target.value); setError(""); setMessage(""); }} disabled={pending || !agents.length}>
        {!agents.length ? <option value="">No active agents of yours in this organisation</option> : agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} — {agent.enabled ? "Express approved" : "Approval required"}</option>)}
      </select>
    </label>
    {selected ? <section className="rounded-xl border border-zk-border p-4 text-sm text-zk-text2" aria-label="Express access">
      <p className="font-bold text-zk-text">{selected.enabled ? "Express import access approved" : "Express import access required"}</p>
      {selected.request ? <p className="mt-2">Request: {selected.request.decision}. {selected.request.response}</p> : null}
      {!selected.enabled && selected.request?.decision !== "pending" ? <form className="mt-3 space-y-3" onSubmit={(event) => {
        event.preventDefault(); const data = new FormData(event.currentTarget); setError(""); setMessage("");
        startTransition(async () => {
          const result = await requestExpressImportAction(agentId, projectId, String(data.get("reason") ?? ""));
          if (!result.ok) { setError(result.error); return; }
          setMessage("Access requested. An organisation owner or admin must review it before this agent can import."); router.refresh();
        });
      }}><label className="block">Why does this agent need express imports?<textarea name="reason" required maxLength={2000} className={field} rows={3} /></label><button disabled={pending || !hydrated} className={button}>Request admin approval</button></form> : null}
      {selected.request?.decision === "pending" && !selected.enabled ? <p className="mt-2">Waiting for an organisation owner or admin. You cannot approve your own request unless you are an organisation admin.</p> : null}
    </section> : null}
    {error ? <p role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-zk-text">{error}</p> : null}
    {message ? <p role="status" className="text-sm text-zk-text">{message}</p> : null}
    <form className="space-y-4" onSubmit={(event) => {
      event.preventDefault(); const data = new FormData(event.currentTarget); setError(""); setMessage("");
      const body = { title: String(data.get("title") ?? ""), summary: String(data.get("summary") ?? ""), description: String(data.get("description") ?? ""), pullRequestUrl: String(data.get("pullRequestUrl") ?? ""), screenshots: String(data.get("screenshots") ?? "").split(/\r?\n/).map((url) => url.trim()).filter(Boolean), ...(String(data.get("testResults") ?? "").trim() ? { testResults: String(data.get("testResults")) } : {}) };
      const identity = JSON.stringify({ agentId, projectId, body });
      if (request.current?.body !== identity) request.current = { body: identity, key: crypto.randomUUID() };
      const key = request.current.key;
      startTransition(async () => {
        const result = await importOutsideWorkAction(agentId, projectId, body, key);
        if (!result.ok) { setError(result.error); return; }
        router.push(result.href); router.refresh();
      });
    }}>
      <label className="block text-sm font-bold text-zk-text">Title<input name="title" required maxLength={200} className={field} /></label>
      <label className="block text-sm font-bold text-zk-text">Summary<textarea name="summary" required maxLength={300} rows={2} className={field} /></label>
      <p className="text-sm text-zk-text2">Keep the summary to two sentences or fewer.</p>
      <label className="block text-sm font-bold text-zk-text">Description<textarea name="description" required maxLength={10000} rows={5} className={field} /></label>
      <label className="block text-sm font-bold text-zk-text">GitHub pull request<input name="pullRequestUrl" type="url" required placeholder="https://github.com/owner/repo/pull/123" className={field} /></label>
      <label className="block text-sm font-bold text-zk-text">Tests run and results<textarea name="testResults" maxLength={20000} rows={4} className={field} placeholder="Commands run, results, and any verification limitations" /></label>
      <label className="block text-sm font-bold text-zk-text">Screenshot links<textarea name="screenshots" rows={3} className={field} placeholder="One screenshot URL per line" /></label>
      <p className="text-sm text-zk-text2">Include test results, screenshot links, or both. Evidence is required.</p>
      <button disabled={pending || !hydrated || !agentId} className={button}>{pending ? "Submitting…" : "Import delivered work"}</button>
    </form>
  </div>;
}

export function ExpressImportRequestQueue({ projectId, requests }: { projectId: string; requests: { agentId: string; name: string; username: string | null; owner: string; reason: string }[] }) {
  const [pending, startTransition] = useTransition();
  const hydrated = useSyncExternalStore(subscribe, clientReady, serverReady);
  const [error, setError] = useState("");
  const router = useRouter();
  return <section className="mt-10 space-y-4 border-t border-zk-border pt-6">
    <h2 className="text-lg font-bold text-zk-text">Admin: express access requests</h2>
    <p className="text-sm text-zk-text2">Only organisation owners and admins can approve or decline. Approval applies to this agent and this project only.</p>
    {error ? <p role="alert" className="text-sm text-red-500">{error}</p> : null}
    {!requests.length ? <p className="text-sm text-zk-text2">No pending requests.</p> : requests.map((request) => <form key={request.agentId} className="space-y-3 rounded-xl border border-zk-border p-4" onSubmit={(event) => {
      event.preventDefault(); const data = new FormData(event.currentTarget); const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
      const approved = submitter?.value === "approve"; setError("");
      startTransition(async () => {
        const result = await setExpressImportAction(request.agentId, projectId, approved, String(data.get("response") ?? ""));
        if (!result.ok) { setError(result.error); return; } router.refresh();
      });
    }}>
      <p className="font-bold text-zk-text">{request.username ? <Link href={`/agent/${encodeURIComponent(request.username)}/edit/level`} className="underline">{request.name}</Link> : request.name} · {request.owner}</p>
      <p className="whitespace-pre-wrap text-sm text-zk-text2">{request.reason}</p>
      <label className="block text-sm text-zk-text">Admin response<textarea name="response" maxLength={2000} className={field} rows={2} /></label>
      <div className="flex flex-wrap gap-3"><button name="decision" value="approve" disabled={pending || !hydrated} className={button}>Approve access</button><button name="decision" value="decline" disabled={pending || !hydrated} className="min-h-11 rounded-lg border border-zk-border px-4 py-2 text-sm font-bold text-zk-text disabled:opacity-50">Decline request</button></div>
    </form>)}
  </section>;
}
