"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { marketingPath, type ProjectRef } from "@/lib/project-paths";
import type { MarketingPlanStrategyInput } from "@/lib/validations/structured-marketing-plan";
import { saveMarketingPlanDraftAction } from "@/app/(app)/[org]/[project]/marketing/plans/actions";
import { decideMarketingActivityAction, finalizeMarketingPlanAction } from "@/app/(app)/[org]/[project]/marketing/plans/[planId]/approval-actions";

type Plan = { id: string; title: string; revisions: Array<{ revision: number; version: number; status: string; source: { contextId: string; revision: string }; strategy: MarketingPlanStrategyInput; createdAt: Date; updatedAt: Date; approvedAt?: Date | null; approvedById?: string | null; decisions: Array<{ activityId: string; decision: "approved" | "rejected"; decidedById: string; decidedAt: Date; history: Array<{ decision: string; actorId: string; createdAt: Date }> }> }> };
const sections = ["Overview", "Objectives", "Audiences", "Channels", "Activities", "Budget & timeline"] as const;
type Section = typeof sections[number];
const panel = "rounded-2xl border border-zk-border bg-zk-surface p-5 sm:p-6";
const label = "mb-1 block text-sm font-semibold text-zk-text";

export function PlanEditor({ slug, plan, revision, canApprove }: { slug: ProjectRef; plan: Plan; revision: Plan["revisions"][number]; canApprove: boolean }) {
  const [title, setTitle] = useState(plan.title);
  const [strategy, setStrategy] = useState<MarketingPlanStrategyInput>(revision.strategy);
  const [section, setSection] = useState<Section>(sections[0]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();
  const readOnly = revision.status === "approved";
  const change = (patch: Partial<MarketingPlanStrategyInput>) => { setStrategy((current) => ({ ...current, ...patch })); setSaved(false); };

  function save() {
    if (readOnly) return;
    setError(null); setSaved(false);
    startTransition(async () => {
      const result = await saveMarketingPlanDraftAction(slug, plan.id, { title, strategy, source: revision.source, expectedRevision: revision.revision, expectedVersion: revision.version });
      if (result.error) setError(result.error);
      else if (result.saved) { setSaved(true); window.location.reload(); }
    });
  }
  function decide(activityId: string, decision: "approved" | "rejected") {
    setError(null);
    startTransition(async () => {
      const result = await decideMarketingActivityAction(slug, plan.id, { revision: revision.revision, version: revision.version, activityId, decision });
      if (result.error) setError(result.error); else window.location.reload();
    });
  }
  function finalize() {
    setError(null);
    startTransition(async () => {
      const result = await finalizeMarketingPlanAction(slug, plan.id, { revision: revision.revision, version: revision.version });
      if (result.error) setError(result.error); else window.location.reload();
    });
  }

  const textarea = (id: string, name: string, value: string, onChange: (value: string) => void, rows = 3) => <div><label className={label} htmlFor={id}>{name}</label><Textarea id={id} rows={rows} value={value} onChange={(e) => { onChange(e.target.value); setSaved(false); }} /></div>;
  const addText = (kind: "objectives" | "audiences") => kind === "objectives"
    ? change({ objectives: [...strategy.objectives, { id: crypto.randomUUID(), text: "New objective", basis: "unknown" }] })
    : change({ audiences: [...strategy.audiences, { id: crypto.randomUUID(), description: "New audience", basis: "unknown" }] });

  return <div>
    <header className="mb-5 flex flex-wrap items-start justify-between gap-4"><div><a href={marketingPath(slug, "plans")} className="text-sm font-semibold text-zk-accent hover:underline">← All plans</a><h1 className="mt-2 text-2xl font-extrabold text-zk-text">Review your plan</h1><p className="mt-1 text-sm text-zk-text2">Revision {revision.revision} · Version {revision.version} · {revision.status}</p></div><div className="flex gap-2"><Button type="button" variant="secondary" disabled={pending || readOnly} onClick={save}>{pending ? "Saving…" : "Save draft"}</Button></div></header>
    <p className="mb-5 rounded-xl border border-zk-border bg-zk-surface px-4 py-3 text-sm text-zk-text2">{readOnly ? `This revision was confirmed${revision.approvedAt ? ` on ${new Date(revision.approvedAt).toLocaleDateString()}` : ""}. It is preserved as read-only.` : "Edits are saved as a draft. Saving does not approve the plan, create marketing tasks, or launch campaigns."}</p>
    <div className="grid gap-5 lg:grid-cols-[220px_minmax(0,1fr)]">
      <nav aria-label="Plan sections" className="flex gap-2 overflow-x-auto lg:flex-col">{sections.map((item, index) => <button key={item} type="button" aria-current={section === item ? "step" : undefined} onClick={() => setSection(item)} className={`shrink-0 rounded-xl border px-3 py-2 text-left text-sm font-semibold ${section === item ? "border-electric-blue bg-zk-tint text-zk-accent" : "border-zk-border bg-zk-surface text-zk-text2"}`}><span className="mr-2 opacity-60">{index + 1}</span>{item}</button>)}</nav>
      <section className={panel}><fieldset disabled={readOnly} className="min-w-0">
        {section === "Overview" && <div className="grid gap-4">{textarea("plan-title", "Plan title", title, setTitle, 1)}{textarea("business-summary", "Business summary", strategy.businessSummary.text, (text) => change({ businessSummary: { ...strategy.businessSummary, text } }) )}{textarea("assumptions", "Assumptions", strategy.assumptions.join("\n"), (text) => change({ assumptions: text.split("\n").filter(Boolean) }))}</div>}
        {section === "Objectives" && <div className="space-y-4"><div className="flex justify-between"><h2 className="font-bold text-zk-text">Objectives</h2><Button type="button" variant="secondary" onClick={() => addText("objectives")}>Add objective</Button></div>{strategy.objectives.map((item, i) => <div key={item.id} className="flex gap-2"><div className="flex-1">{textarea(`objective-${item.id}`, `Objective ${i + 1}`, item.text, (text) => change({ objectives: strategy.objectives.map((row) => row.id === item.id ? { ...row, text } : row) }), 2)}</div><button type="button" aria-label={`Remove objective ${i + 1}`} className="self-end rounded-lg px-3 py-2 text-sm text-zk-text2 hover:bg-zk-chip" onClick={() => change({ objectives: strategy.objectives.filter((row) => row.id !== item.id) })}>Remove</button></div>)}</div>}
        {section === "Audiences" && <div className="space-y-4"><div className="flex justify-between"><h2 className="font-bold text-zk-text">Audiences</h2><Button type="button" variant="secondary" onClick={() => addText("audiences")}>Add audience</Button></div>{strategy.audiences.map((item, i) => <div key={item.id} className="flex gap-2"><div className="flex-1">{textarea(`audience-${item.id}`, `Audience ${i + 1}`, item.description, (description) => change({ audiences: strategy.audiences.map((row) => row.id === item.id ? { ...row, description } : row) }), 2)}</div><button type="button" aria-label={`Remove audience ${i + 1}`} className="self-end rounded-lg px-3 py-2 text-sm text-zk-text2 hover:bg-zk-chip" onClick={() => change({ audiences: strategy.audiences.filter((row) => row.id !== item.id) })}>Remove</button></div>)}</div>}
        {section === "Channels" && <div className="space-y-4"><div className="flex justify-between"><h2 className="font-bold text-zk-text">Channels</h2><Button type="button" variant="secondary" onClick={() => change({ channels: [...strategy.channels, { id: crypto.randomUUID(), name: "New channel", rationale: "", basis: "unknown" }] })}>Add channel</Button></div>{strategy.channels.map((item, i) => <div key={item.id} className="grid gap-3 rounded-xl border border-zk-border p-4 sm:grid-cols-[1fr_2fr_auto]"><div>{textarea(`channel-name-${item.id}`, `Channel ${i + 1}`, item.name, (name) => change({ channels: strategy.channels.map((row) => row.id === item.id ? { ...row, name } : row) }), 1)}</div><div>{textarea(`channel-why-${item.id}`, "Rationale", item.rationale, (rationale) => change({ channels: strategy.channels.map((row) => row.id === item.id ? { ...row, rationale } : row) }), 1)}</div><button type="button" aria-label={`Remove channel ${i + 1}`} className="text-sm text-zk-text2" onClick={() => change({ channels: strategy.channels.filter((row) => row.id !== item.id), activities: strategy.activities.map((activity) => activity.channelId === item.id ? { ...activity, channelId: null } : activity) })}>Remove</button></div>)}</div>}
        {section === "Activities" && <div className="space-y-4"><div className="flex justify-between"><h2 className="font-bold text-zk-text">Activities</h2><Button type="button" variant="secondary" onClick={() => change({ activities: [...strategy.activities, { channelId: null, title: "New activity", description: "Describe the work", basis: "unknown", priority: "medium", budget: { amount: null, currency: null }, suggestedStart: null, suggestedEnd: null, dependencies: [], expectedOutcome: "Not set", measurements: [] }] })}>Add activity</Button></div>{strategy.activities.map((item, i) => { const decision = revision.decisions.find((entry) => entry.activityId === item.id); return <article key={item.id ?? `new-${i}`} className="grid gap-3 rounded-xl border border-zk-border p-4"><div className="flex items-start gap-2"><div className="flex-1">{textarea(`activity-title-${i}`, `Activity ${i + 1}`, item.title, (title) => change({ activities: strategy.activities.map((row, index) => index === i ? { ...row, title } : row) }), 1)}</div><button type="button" aria-label={`Remove activity ${i + 1}`} className="mt-6 text-sm text-zk-text2" onClick={() => change({ activities: strategy.activities.filter((_, index) => index !== i) })}>Remove</button></div>{textarea(`activity-desc-${i}`, "Description", item.description, (description) => change({ activities: strategy.activities.map((row, index) => index === i ? { ...row, description } : row) }), 2)}<label className="text-sm font-semibold text-zk-text">Channel<select aria-label={`Channel for activity ${i + 1}`} className="mt-1 block w-full rounded-xl border border-zk-border bg-zk-surface p-3" value={item.channelId ?? ""} onChange={(e) => change({ activities: strategy.activities.map((row, index) => index === i ? { ...row, channelId: e.target.value || null } : row) })}><option value="">Unassigned</option>{strategy.channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.name}</option>)}</select></label>{canApprove && item.id && <div className="flex flex-wrap items-center gap-2 border-t border-zk-border pt-3"><span className="mr-auto text-sm text-zk-text2">Decision: {decision?.decision ?? "Not reviewed"}{decision && ` · ${decision.history.length} decision ${decision.history.length === 1 ? "record" : "records"}`}</span><Button type="button" variant="secondary" onClick={() => decide(item.id!, "approved")}>Approve activity</Button><Button type="button" variant="secondary" onClick={() => decide(item.id!, "rejected")}>Reject activity</Button>{Boolean(decision?.history.length) && <ol aria-label={`Decision history for activity ${i + 1}`} className="w-full text-xs text-zk-text2">{decision!.history.map((event, index) => <li key={`${event.createdAt}-${index}`}>{event.decision} · {new Date(event.createdAt).toLocaleString()}</li>)}</ol>}</div>}</article>; })}</div>}
        {section === "Budget & timeline" && <div className="space-y-4"><h2 className="font-bold text-zk-text">Budget and timeline</h2>{strategy.activities.length === 0 ? <p className="text-sm text-zk-text2">Add activities first to set their budgets and dates.</p> : strategy.activities.map((item, i) => <article key={item.id ?? `new-${i}`} className="grid gap-3 rounded-xl border border-zk-border p-4 sm:grid-cols-3"><strong className="sm:col-span-3 text-zk-text">{item.title}</strong><div><label htmlFor={`budget-${i}`} className="text-sm text-zk-text2">Budget amount</label><Input id={`budget-${i}`} type="number" min="0" value={item.budget.amount ?? ""} onChange={(e) => { const amount = e.target.value === "" ? null : Number(e.target.value); change({ activities: strategy.activities.map((row, index) => index === i ? { ...row, budget: { amount, currency: amount === null ? null : row.budget.currency ?? "USD" } } : row) }); }} /></div><div><label htmlFor={`currency-${i}`} className="text-sm text-zk-text2">Currency</label><Input id={`currency-${i}`} maxLength={3} value={item.budget.currency ?? ""} onChange={(e) => change({ activities: strategy.activities.map((row, index) => index === i ? { ...row, budget: { ...row.budget, currency: e.target.value.toUpperCase() || null } } : row) })} /></div><div><label htmlFor={`start-date-${i}`} className="text-sm text-zk-text2">Start date</label><Input id={`start-date-${i}`} type="date" value={item.suggestedStart ?? ""} onChange={(e) => change({ activities: strategy.activities.map((row, index) => index === i ? { ...row, suggestedStart: e.target.value || null } : row) })} /></div><div><label htmlFor={`end-date-${i}`} className="text-sm text-zk-text2">End date</label><Input id={`end-date-${i}`} type="date" value={item.suggestedEnd ?? ""} onChange={(e) => change({ activities: strategy.activities.map((row, index) => index === i ? { ...row, suggestedEnd: e.target.value || null } : row) })} /></div></article>)}</div>}
        {error && <p role="alert" className="mt-5 text-sm font-semibold text-red-700">{error}</p>}{saved && <p role="status" className="mt-5 text-sm font-semibold text-green-700">Draft saved.</p>}
        </fieldset><footer className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-zk-border pt-4"><span className="text-xs text-zk-text2">Source context: {revision.source.contextId} · {revision.source.revision}</span><div className="flex gap-2">{canApprove && !readOnly && <Button type="button" variant="primary" disabled={pending} onClick={finalize}>Confirm final plan</Button>}<Button type="button" variant="secondary" disabled={pending || readOnly} onClick={save}>{pending ? "Saving…" : "Save draft"}</Button></div></footer>
      </section>
    </div>
    <section className={`${panel} mt-5`}><h2 className="font-bold text-zk-text">Revision history</h2><ol className="mt-3 flex flex-wrap gap-3">{plan.revisions.map((item) => <li key={item.revision} className="rounded-lg bg-zk-chip px-3 py-2 text-sm text-zk-text2">Revision {item.revision} · v{item.version} · {item.status}</li>)}</ol></section>
  </div>;
}
