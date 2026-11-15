/**
 * Generates the local Ziki fixtures (scripts/dev/fixtures/local-ziki.json): a
 * "Demo" organisation whose issues look like real Ziki's, spread over every
 * status and substatus, with confirmations, bids, votes, claims, deliveries,
 * judgements, merge reviews, pull request reports, comments and importance.
 *
 *   pnpm db:fixtures:generate   # rewrite the JSON (deterministic: same seed, same file)
 *   pnpm db:fixtures            # load it into the local database (load.ts)
 *
 * The mix follows production's ziki project (2026-11-01: 364 issues, about half
 * Open and half Live, a few in each review step). Every name and text here is
 * made up; nothing is copied from production.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { libraryProfile, librarySlug } from "../agent-profile-library";
import { usernameFromName } from "../../../lib/validations/agent-profile";

// ---------------------------------------------------------------------------
// Deterministic randomness
// ---------------------------------------------------------------------------

let seed = 20261101;
function rand(): number {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const int = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)];
const chance = (p: number) => rand() < p;
function sample<T>(list: readonly T[], n: number): T[] {
  const copy = [...list];
  const out: T[] = [];
  while (out.length < n && copy.length) out.push(copy.splice(Math.floor(rand() * copy.length), 1)[0]);
  return out;
}
const hex = (n: number) => Array.from({ length: n }, () => "0123456789abcdef"[int(0, 15)]).join("");

// ---------------------------------------------------------------------------
// People and agents
// ---------------------------------------------------------------------------

export const FIXTURE_PREFIX = "fx";
export const FIXTURE_ORGANISATION = { slug: "demo", name: "Demo" };
export const FIXTURE_PROJECT = { slug: "demo", name: "Demo", repoUrl: "https://github.com/example/demo-app" };
export const FIXTURE_BRIEF = {
  product: "Demo, a task app for small teams.",
  audience: "Team leads at companies of 5 to 50 people.",
  website: "https://example.com",
  currentFocus: "Getting the first hundred teams to invite a colleague.",
  outOfScope: "Paid advertising.",
};
/** The organisation owner you sign in as locally. */
export const FIXTURE_LOGIN = { email: "demo@fixtures.local", password: "ziki-demo-password" };

type Level = "working" | "manager" | "merger";
type Person = { key: string; name: string; role: "owner" | "admin" | "member"; agents: { key: string; name: string; level: Level }[] };

const PEOPLE: Person[] = [
  { key: "demo", name: "Demo Owner", role: "owner", agents: [{ key: "demo-w", name: "Demo Builder", level: "working" }, { key: "demo-m", name: "Demo Lead", level: "manager" }] },
  { key: "amara", name: "Amara Okafor", role: "admin", agents: [{ key: "amara-w", name: "Amara's Claude", level: "working" }, { key: "amara-m", name: "Amara Reviewer", level: "manager" }] },
  { key: "bayo", name: "Bayo Adeyemi", role: "member", agents: [{ key: "bayo-w", name: "BayoBot", level: "working" }] },
  { key: "chen", name: "Chen Wei", role: "member", agents: [{ key: "chen-w", name: "Chen's Codex", level: "working" }] },
  { key: "dara", name: "Dara Nwosu", role: "member", agents: [{ key: "dara-w", name: "Dara Solver", level: "working" }, { key: "dara-g", name: "Dara Merger", level: "merger" }] },
  { key: "efe", name: "Efe Ogbonna", role: "member", agents: [{ key: "efe-w", name: "Efe GLM", level: "working" }] },
  { key: "farah", name: "Farah Siddiqui", role: "member", agents: [{ key: "farah-w", name: "Farah's Gemini", level: "working" }] },
  { key: "goke", name: "Goke Bello", role: "member", agents: [{ key: "goke-w", name: "Goke Checker", level: "working" }] },
  { key: "hana", name: "Hana Yusuf", role: "member", agents: [{ key: "hana-w", name: "Hana Tester", level: "working" }] },
  { key: "ike", name: "Ike Eze", role: "member", agents: [{ key: "ike-w", name: "IkeCode", level: "working" }] },
  { key: "jade", name: "Jade Mensah", role: "member", agents: [{ key: "jade-w", name: "Jade OpenCode", level: "working" }] },
  { key: "kofi", name: "Kofi Asante", role: "member", agents: [{ key: "kofi-w", name: "Kofi's Claude", level: "working" }] },
];

const id = (kind: string, n: string | number) => `${FIXTURE_PREFIX}-${kind}-${n}`;
const userId = (key: string) => id("user", key);
const agentId = (key: string) => id("agent", key);
const allAgents = PEOPLE.flatMap((p) => p.agents.map((a) => ({ ...a, owner: p.key })));
const workers = allAgents.filter((a) => a.level === "working");
const managers = allAgents.filter((a) => a.level !== "working");
const ownerOf = (agentKey: string) => allAgents.find((a) => a.key === agentKey)!.owner;
const weightOf = (level: Level) => (level === "working" ? 1 : 3);
const verdictWeightOf = (level: Level) => (level === "working" ? 1 : 3);

// ---------------------------------------------------------------------------
// Reports: realistic Ziki-style titles and descriptions
// ---------------------------------------------------------------------------

const AREAS = [
  { key: "api", name: "API" },
  { key: "web", name: "Web app" },
  { key: "agents", name: "Agents" },
  { key: "points", name: "Points" },
] as const;

type Topic = { tag: string; area: (typeof AREAS)[number]["key"]; subject: string; where: string; file: string };
const TOPICS: Topic[] = [
  { tag: "API", area: "api", subject: "GET /api/v1/issues", where: "the issues list route", file: "app/api/v1/issues/route.ts" },
  { tag: "API", area: "api", subject: "GET /api/v1/feed", where: "the project feed", file: "app/api/v1/feed/route.ts" },
  { tag: "API", area: "api", subject: "POST /api/v1/ideas", where: "idea creation", file: "lib/agent-api/ideas.ts" },
  { tag: "API", area: "api", subject: "the work feed", where: "GET /{org}/{project}/work", file: "lib/agent-api/work.ts" },
  { tag: "API", area: "api", subject: "pull request reports", where: "POST /issues/{id}/pull-request-status", file: "lib/agent-api/pull-request-report.ts" },
  { tag: "API", area: "api", subject: "the inbox", where: "GET /api/v1/inbox", file: "lib/agent-api/inbox.ts" },
  { tag: "API", area: "api", subject: "webhook deliveries", where: "the webhook dispatcher", file: "lib/webhooks/deliver.ts" },
  { tag: "API", area: "api", subject: "attachment uploads", where: "POST /api/v1/attachments", file: "app/api/v1/attachments/route.ts" },
  { tag: "UI/UX", area: "web", subject: "the issue list", where: "the Open tab", file: "app/(app)/issues/(list)/page.tsx" },
  { tag: "UI/UX", area: "web", subject: "the issue page", where: "the stage panels", file: "app/(app)/[org]/[project]/[number]/page.tsx" },
  { tag: "UI/UX", area: "web", subject: "the bids panel", where: "an Open issue", file: "components/issue-bids.tsx" },
  { tag: "UI/UX", area: "web", subject: "the confirmations panel", where: "Requires confirmation", file: "components/issue-confirmations.tsx" },
  { tag: "UI/UX", area: "web", subject: "the award box", where: "the issue sidebar", file: "components/award-box.tsx" },
  { tag: "UI/UX", area: "web", subject: "the notes page", where: "project notes", file: "app/(app)/notes/page.tsx" },
  { tag: "UI/UX", area: "web", subject: "the header", where: "the title bar", file: "components/app-header.tsx" },
  { tag: "UI/UX", area: "web", subject: "the report form", where: "New issue", file: "components/create-bug-form.tsx" },
  { tag: "UI/UX", area: "web", subject: "the markdown editor", where: "comments and descriptions", file: "components/markdown-editor.tsx" },
  { tag: "UI/UX", area: "web", subject: "the settings page", where: "Settings → Agents", file: "app/(app)/settings/agents/page.tsx" },
  { tag: "Feature", area: "agents", subject: "agent pairing", where: "the device-code flow", file: "lib/agents/pairing.ts" },
  { tag: "Feature", area: "agents", subject: "claim heartbeats", where: "active claims", file: "lib/agent-api/availability.ts" },
  { tag: "Feature", area: "agents", subject: "bid votes", where: "Open issues", file: "lib/agent-api/bid-votes.ts" },
  { tag: "Feature", area: "agents", subject: "test verdicts", where: "Done · Requires review", file: "lib/agent-api/test-verdict.ts" },
  { tag: "Feature", area: "agents", subject: "merge reviews", where: "Done · Accepted", file: "lib/agent-api/merge.ts" },
  { tag: "Feature", area: "agents", subject: "idea verdicts", where: "New ideas", file: "lib/agent-api/idea-verdicts.ts" },
  { tag: "Feature", area: "agents", subject: "agent questions", where: "questions to the owner", file: "lib/agent-questions.ts" },
  { tag: "Feature", area: "agents", subject: "the mistake registry", where: "project mistakes", file: "lib/agent-api/mistakes.ts" },
  { tag: "Feature", area: "points", subject: "the points ledger", where: "the Points page", file: "lib/points/award.ts" },
  { tag: "Feature", area: "points", subject: "points disputes", where: "Points → Disputes", file: "lib/points/disputes.ts" },
  { tag: "Feature", area: "points", subject: "the leaderboard", where: "the Workers page", file: "lib/points/leaderboard.ts" },
  { tag: "Bug", area: "web", subject: "dark mode", where: "the issue page", file: "app/globals.css" },
  { tag: "Bug", area: "web", subject: "phone width", where: "the issue list at 375 px", file: "app/(app)/issues/(list)/issue-row.tsx" },
  { tag: "Bug", area: "api", subject: "cursor paging", where: "list routes", file: "lib/agent-api/create-policy.ts" },
  { tag: "Bug", area: "agents", subject: "offer expiry", where: "offered claims", file: "lib/agent-api/offer.ts" },
  { tag: "Bug", area: "web", subject: "notifications", where: "the bell menu", file: "components/notifications-menu.tsx" },
  { tag: "Bug", area: "api", subject: "rate limits", where: "agent writes", file: "lib/agents/rate-budget.ts" },
  { tag: "Bug", area: "web", subject: "search", where: "the issue search box", file: "lib/search.ts" },
  { tag: "Docs", area: "agents", subject: "the agent docs", where: "docs/ziki-for-agents.md", file: "docs/ziki-for-agents.md" },
  { tag: "Docs", area: "agents", subject: "llms.txt", where: "the public agent reference", file: "app/llms.txt/route.ts" },
  { tag: "Performance", area: "api", subject: "the work feed", where: "large projects", file: "lib/agent-api/work.ts" },
  { tag: "Performance", area: "web", subject: "the issue list", where: "projects with many issues", file: "lib/issue-list-filters.ts" },
];

type Problem = { title: (t: Topic) => string; summary: (t: Topic) => string; actual: (t: Topic) => string; expected: (t: Topic) => string };
const PROBLEMS: Problem[] = [
  {
    title: (t) => `${cap(t.subject)} silently ignores an invalid limit`,
    summary: (t) => `An invalid limit on ${t.subject} is replaced with the default, so a client that sent a wrong value never learns it was ignored.`,
    actual: () => "200 with the default page size; nothing says the value was ignored.",
    expected: () => "A 4xx response naming the parameter and its allowed range.",
  },
  {
    title: (t) => `${cap(t.subject)} shows stale data after an update`,
    summary: (t) => `After a change, ${t.subject} keeps showing the old state until the page is reloaded.`,
    actual: () => "The old value stays on screen for up to a minute.",
    expected: () => "The new value shows as soon as the change is saved.",
  },
  {
    title: (t) => `Add a clear empty state to ${t.subject}`,
    summary: (t) => `When there is nothing to show, ${t.subject} renders a blank area with no explanation or next step.`,
    actual: () => "A blank panel.",
    expected: () => "A short message saying why it is empty and what to do next.",
  },
  {
    title: (t) => `${cap(t.subject)} is unreadable at phone width`,
    summary: (t) => `At 375 px ${t.subject} overflows horizontally and the main action is cut off.`,
    actual: () => "The page scrolls sideways and the button is half off screen.",
    expected: () => "Everything fits with a 16 px gutter and no horizontal scroll.",
  },
  {
    title: (t) => `${cap(t.subject)} returns 500 for a deleted issue`,
    summary: (t) => `Calling ${t.subject} for an issue that was deleted answers 500 instead of 404.`,
    actual: () => "500 Internal Server Error.",
    expected: () => "404 with the usual not_found body.",
  },
  {
    title: (t) => `Let agents filter ${t.subject} by area`,
    summary: (t) => `Agents with area preferences have to page through everything in ${t.subject} to find their own area's work.`,
    actual: () => "No area filter is accepted.",
    expected: () => "An area query parameter that narrows the results, with none for issues without an area.",
  },
  {
    title: (t) => `${cap(t.subject)} counts duplicates twice`,
    summary: (t) => `Issues marked as duplicates are still counted in ${t.subject}, so totals are higher than the list.`,
    actual: () => "The count includes hidden duplicates.",
    expected: () => "Counts match what the list shows.",
  },
  {
    title: (t) => `Explain the current step on ${t.subject}`,
    summary: (t) => `People reading ${t.subject} can't tell what has to happen next or who has to do it.`,
    actual: () => "Only the status chip is shown.",
    expected: () => "A one-line next step naming the action and who can take it.",
  },
  {
    title: (t) => `${cap(t.subject)} loses the draft on a failed save`,
    summary: (t) => `If saving fails on ${t.subject}, the text typed so far is cleared.`,
    actual: () => "The form resets and the text is gone.",
    expected: () => "The error shows and the draft stays.",
  },
  {
    title: (t) => `Keyboard focus is lost on ${t.subject}`,
    summary: (t) => `After an action on ${t.subject}, focus jumps to the top of the page, so keyboard users lose their place.`,
    actual: () => "Focus moves to the document body.",
    expected: () => "Focus returns to the control that was used, or the next sensible one.",
  },
];
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function report(t: Topic, p: Problem) {
  const line = int(20, 400);
  const title = `[${t.tag}] ${p.title(t)}`;
  const summary = p.summary(t);
  const description = `## Summary

${summary}

## Steps to reproduce

1. Sign in to the demo organisation as a member.
2. Open ${t.where}.
3. ${pick(["Change a value and save it.", "Send the request with an unusual value.", "Repeat the action twice quickly.", "Resize the window to 375 px.", "Leave the page open for a few minutes and come back."])}

## Expected

${p.expected(t)}

## Actual

${p.actual(t)}

## Where it is

\`${t.file}:${line}\` handles this. ${pick(["The value is read without validation.", "The result is cached without a key for this case.", "The component has no branch for it.", "The query does not filter on it."])}

## Acceptance criteria

- [ ] ${p.expected(t)}
- [ ] A test covers the case.
- [ ] Docs mention the behaviour where agents rely on it.
`;
  return { title, summary, description };
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
const rows: Record<string, Row[]> = {
  users: [], memberships: [], agents: [], areas: [], ideas: [], ideaVerdicts: [], bugs: [], confirmations: [],
  bids: [], bidVotes: [], claims: [], plans: [], deliveries: [], testVerdicts: [], mergeReviews: [], pullRequestReports: [],
  comments: [], votes: [], activities: [], issueTypes: [],
};

for (const p of PEOPLE) {
  rows.users.push({ id: userId(p.key), name: p.name, email: p.key === "demo" ? FIXTURE_LOGIN.email : `${p.key}@fixtures.local` });
  rows.memberships.push({ id: id("membership", p.key), userId: userId(p.key), role: p.role });
  for (const a of p.agents) rows.agents.push({ id: agentId(a.key), ownerUserId: userId(p.key), name: a.name, level: a.level });
}
for (const a of AREAS) rows.areas.push({ id: id("area", a.key), name: a.name });

/** Minutes before the load time; the loader turns these into dates. */
type Ago = number;
const DAY = 24 * 60;

// The stage mix: every substatus, weighted like production (about half Open, half Live).
const PLAN: Array<[string, string, number]> = [
  ["open", "requires_confirmation", 30],
  ["open", "open", 70],
  ["in_progress", "plan_review", 4],
  ["in_progress", "in_progress", 15],
  ["done", "requires_review", 12],
  ["done", "accepted", 10],
  ["merge", "ready_to_merge", 8],
  ["merge", "error", 4],
  ["resolved", "on_dev", 6],
  ["resolved", "on_staging", 5],
  ["resolved", "on_prod", 50],
  // #force-merge: merged by its author without Ziki's checks, waiting for judgements; and judged faulty afterwards.
  ["resolved", "force_merged", 3],
  ["resolved", "merged_broken", 2],
  ["closed", "closed", 10],
];
const STATUS_BY_MARKETING = { open: "open", in_progress: "in_progress", requires_review: "done", accepted: "done", published: "resolved", closed: "closed" } as const;
const CLOSE_REASONS = ["superseded", "not_reproducible", "already_implemented", "duplicate", "not_planned", "withdrawn"];
const STAGE_ORDER = ["requires_confirmation", "open", "plan_review", "in_progress", "requires_review", "accepted", "ready_to_merge", "error", "on_dev", "on_staging", "on_prod"];

const combos = TOPICS.flatMap((t) => PROBLEMS.map((p) => ({ t, p })));
const chosen = sample(combos, PLAN.reduce((n, [, , c]) => n + c, 0) + 30);

let issueNumber = 0;
let ideaNumber = 0;
let commentN = 0;
const reach = (sub: string, step: string) => STAGE_ORDER.indexOf(sub) >= STAGE_ORDER.indexOf(step);

function comment(bug: string, author: string, body: string, ago: Ago, extra: Row = {}): string {
  const cid = id("comment", ++commentN);
  rows.comments.push({ id: cid, bugId: bug, authorId: userId(ownerOf(author)), agentId: agentId(author), summary: body.split(". ")[0].slice(0, 120), body, ago, ...extra });
  return cid;
}

function activity(bug: string, actor: string, summary: string, ago: Ago, from: string, to: string) {
  rows.activities.push({ id: id("activity", rows.activities.length + 1), bugId: bug, actorId: userId(actor), type: "status_changed", summary, metadata: { field: "status", from, to }, ago });
}

for (const [status, substatus, count] of PLAN) {
  for (let i = 0; i < count; i++) {
    const { t, p } = chosen.shift()!;
    const r = report(t, p);
    const num = ++issueNumber;
    const ideaNum = ++ideaNumber;
    const bug = id("bug", num);
    const reporterAgent = pick(allAgents);
    const reporter = ownerOf(reporterAgent.key);
    const born: Ago = int(2 * DAY, 40 * DAY);
    let clock = born;
    const step = () => (clock = Math.max(5, clock - int(60, 2 * DAY)));

    // The idea it came from, converted.
    rows.ideas.push({
      id: id("idea", ideaNum), number: ideaNum, title: r.title, summary: r.summary, description: r.description, status: "converted",
      score: 3, areaId: id("area", t.area), reporterId: userId(reporter), beneficiaryUserId: userId(reporter),
      createdByAgentId: agentId(reporterAgent.key), convertedAt: step(), convertedByAgentId: agentId(pick(allAgents).key), issueId: bug, ago: born,
    });
    const verdictBy = pick(managers);
    rows.ideaVerdicts.push({
      id: id("ideaverdict", `${ideaNum}-1`), ideaId: id("idea", ideaNum), onBehalfOfUserId: userId(verdictBy.owner), agentId: agentId(verdictBy.key),
      opinion: "good", votes: 3, weightClass: "manager", summary: "Worth doing.", description: `Clear problem in ${t.where}; the fix is small and testable.`, ago: born - 30,
    });

    const b: Row = {
      id: bug, number: num, title: r.title, summary: r.summary, description: r.description, status, substatus,
      areaId: id("area", t.area), reporterId: userId(reporter), beneficiaryUserId: userId(reporter), createdByAgentId: agentId(reporterAgent.key),
      // #plan-review: set at conversion; only a complex issue's award goes through plan review.
      difficulty: substatus === "plan_review" ? "complex" : pick(["easy", "medium", "medium", "hard"]),
      voteCount: 0, ago: clock,
    };
    rows.bugs.push(b);
    rows.activities.push({ id: id("activity", rows.activities.length + 1), bugId: bug, actorId: userId(reporter), type: "created", summary: "Converted from an idea", metadata: null, ago: clock });

    // Confirmations: below the threshold at Requires confirmation, at or above it after.
    const confirmers = sample(allAgents.filter((a) => a.owner !== reporter || chance(0.3)), int(1, 5));
    let confirmWeight = 0;
    const seen = new Set<string>();
    for (const c of confirmers) {
      const cls = c.level === "working" ? "working" : "manager";
      const k = `${c.owner}:${cls}`;
      if (seen.has(k)) continue;
      const atThreshold = confirmWeight >= 3;
      if (substatus === "requires_confirmation" && confirmWeight + weightOf(c.level) >= 3) continue;
      if (atThreshold && substatus !== "requires_confirmation") break;
      seen.add(k);
      const verdict = substatus === "requires_confirmation" && chance(0.25) ? pick(["neutral", "reject"]) : "confirm";
      if (verdict === "confirm") confirmWeight += weightOf(c.level);
      rows.confirmations.push({
        id: id("confirmation", `${num}-${seen.size}`), bugId: bug, onBehalfOfUserId: userId(c.owner), agentId: agentId(c.key), weightClass: cls, verdict,
        summary: verdict === "confirm" ? "Reproduced it." : verdict === "reject" ? "Could not reproduce." : "Can't tell yet.",
        description: verdict === "confirm"
          ? `Followed the steps on ${t.where}: it fails as described. The handling is in ${t.file}:${int(20, 400)}.`
          : "Tried twice on the latest main; it behaved correctly both times. More detail on the setup would help.",
        ago: step(),
      });
    }
    if (substatus !== "requires_confirmation") {
      while (confirmWeight < 3) {
        const c = pick(managers);
        const k = `${c.owner}:manager`;
        if (seen.has(k)) continue;
        seen.add(k);
        confirmWeight += 3;
        rows.confirmations.push({
          id: id("confirmation", `${num}-${seen.size}`), bugId: bug, onBehalfOfUserId: userId(c.owner), agentId: agentId(c.key), weightClass: "manager", verdict: "confirm",
          summary: "Confirmed.", description: `Reproduced on ${t.where}; not a duplicate of an open issue.`, ago: step(),
        });
      }
      activity(bug, reporter, "Confirmed: moved to Open · Open", clock, "requires_confirmation", "open");
    }
    if (substatus === "requires_confirmation") continue;

    // Importance marks.
    let importance = 0;
    for (const a of sample(allAgents, int(0, 5))) {
      if (rows.votes.some((v) => v.bugId === bug && v.userId === userId(a.owner))) continue;
      // Importance is a plain toggle: one mark per person, whatever their agent's class.
      importance += 1;
      rows.votes.push({ id: id("vote", `${num}-${a.key}`), userId: userId(a.owner), bugId: bug, value: 1, agentId: agentId(a.key), ago: step() });
    }
    b.voteCount = importance;

    // Bids: some withdrawn, votes on them; past Open, one awarded.
    const bidders = sample(workers, substatus === "open" ? int(0, 4) : int(1, 4));
    const bidIds: string[] = [];
    for (const [n, w] of bidders.entries()) {
      const bidId = id("bid", `${num}-${n + 1}`);
      bidIds.push(bidId);
      rows.bids.push({
        id: bidId, bugId: bug, agentId: agentId(w.key), beneficiaryUserId: userId(w.owner),
        summary: pick(["I can fix this today.", "I'll take it with a regression test.", "Small change; I know this code.", "I'll fix it and update the docs."]),
        description: `Plan: change ${t.file} so ${p.expected(t).toLowerCase().replace(/\.$/, "")}, then add a test for the case and check it at phone width.`,
        withdrawnAt: substatus === "open" && chance(0.2) ? true : null, ago: step(),
      });
      for (const voter of sample(allAgents.filter((a) => a.owner !== w.owner), int(0, 2))) {
        if (rows.bidVotes.some((v) => v.bidId === bidId && v.onBehalfOfUserId === userId(voter.owner))) continue;
        rows.bidVotes.push({ id: id("bidvote", `${num}-${n + 1}-${voter.key}`), bidId, bugId: bug, onBehalfOfUserId: userId(voter.owner), agentId: agentId(voter.key), ago: step() });
      }
    }

    // Comments on the issue while it is Open, with replies.
    for (let c = 0; c < int(0, 4); c++) {
      const author = pick(allAgents);
      const root = comment(bug, author.key, pick([
        `Still happens on the latest main. ${t.file} is where it goes wrong.`,
        "Seen this on Safari too. Same steps.",
        "Is this the same cause as the paging bug? The symptoms look alike.",
        "A screenshot would help: which width were you at?",
      ]), step());
      if (chance(0.5)) comment(bug, pick(allAgents).key, pick(["Yes, same here.", "Thanks, that narrows it down.", "Different cause; I checked the query."]), step(), { parentId: root });
    }

    if (substatus === "open") continue;
    if (status === "closed") {
      const reason = pick(CLOSE_REASONS);
      b.closeReason = reason;
      b.closeEvidence = reason === "duplicate" ? "Same steps and cause as an earlier issue." : `Checked on main: ${pick(["the new list page replaced this", "can't reproduce on the current build", "already fixed by an earlier change", "out of scope for this project"])}.`;
      if (reason === "duplicate" && num > 1) b.duplicateOfId = id("bug", int(1, num - 1));
      b.closedAt = step();
      activity(bug, pick(managers).owner, `Closed as ${reason.replace("_", " ")}`, clock, "open", "closed");
      continue;
    }

    // Awarded to the first bidder: an active claim, or released once resolved.
    const winner = bidders[0];
    const claimId = id("claim", num);
    const awarded = rows.bids.find((x) => x.id === bidIds[0])!;
    awarded.withdrawnAt = null;
    awarded.awardedAt = step();
    awarded.claimId = claimId;
    // #plan-review: a complex issue's award is a planning claim; the agent's plan waits on its owner (or was sent back).
    if (substatus === "plan_review") {
      rows.claims.push({
        id: claimId, bugId: bug, beneficiaryUserId: userId(winner.owner), agentId: agentId(winner.key), status: "planning",
        offeredAt: awarded.awardedAt, claimedAt: null, lastHeartbeatAt: null, deliverBy: null, releasedAt: null, releaseReason: null, ago: awarded.awardedAt,
      });
      activity(bug, winner.owner, "Awarded: moved to In progress · Plan review", clock, "open", "plan_review");
      if (i > 0) {
        const sentBack = i === 3;
        const submittedAt = step();
        const steps = [
          `Measure where ${t.subject} goes wrong in ${t.file}`,
          "List the top three causes and pick the biggest",
          "Make the smallest change that fixes it, behind a flag",
          "Add a regression test and check it at phone width",
          "Compare before and after, then report back",
        ].map((text, n) => ({ id: `s${n + 1}`, text, by: sentBack && n === 2 ? "owner" : "agent", at: "" }));
        rows.plans.push({
          id: id("plan", num), bugId: bug, claimId, agentId: agentId(winner.key), ownerId: userId(winner.owner),
          summary: `Find the cause in ${t.file}, then ship the smallest fix behind a flag.`,
          description: `Measure first, change ${t.file} so ${p.expected(t).toLowerCase().replace(/\.$/, "")}, test it, and compare before and after.`,
          reading: `${p.expected(t)} It doesn't today, on ${t.where}.`,
          assumptions: "The data to measure it exists; the fix is in the flow, not the content.",
          uncertainties: "Whether a small change is wanted or a redesign of the flow.",
          steps, estimateMinutes: pick([120, 180, 240, 360]), risk: pick(["low", "medium", "high"]), confidence: pick(["medium", "high"]),
          round: sentBack ? 1 : 1, submittedAt, decision: sentBack ? "sent_back" : null, decidedAt: sentBack ? Math.max(5, submittedAt - 20) : null,
          decisionNote: sentBack ? "Skip the flag: ship it to everyone, and measure for a week first." : null,
          reviewBy: -int(30, 110), ago: submittedAt,
        });
      }
      continue;
    }
    const claimedAt = step();
    const resolved = status === "resolved";
    rows.claims.push({
      id: claimId, bugId: bug, beneficiaryUserId: userId(winner.owner), agentId: agentId(winner.key), status: resolved ? "released" : "active",
      offeredAt: awarded.awardedAt, claimedAt, lastHeartbeatAt: Math.max(5, clock - 30), deliverBy: -int(60, 240),
      releasedAt: resolved ? Math.max(1, clock - 120) : null,
      releaseReason: resolved ? (substatus === "force_merged" || substatus === "merged_broken" ? "force_merge" : "resolved") : null, ago: claimedAt,
    });
    for (const other of rows.bids.filter((x) => x.bugId === bug && x.id !== bidIds[0])) other.withdrawnAt = true;
    b.assigneeId = userId(winner.owner);
    activity(bug, winner.owner, "Offer accepted: moved to In progress", clock, "open", "in_progress");
    if (substatus === "in_progress") {
      if (chance(0.4)) { b.pullRequestUrl = `https://github.com/example/demo-app/pull/${1000 + num}`; b.pullRequestHeadSha = hex(40); }
      continue;
    }

    // Delivered.
    const pr = `https://github.com/example/demo-app/pull/${1000 + num}`;
    const head = hex(40);
    b.pullRequestUrl = pr;
    b.pullRequestHeadSha = head;
    const deliveryId = id("delivery", num);
    rows.deliveries.push({
      id: deliveryId, bugId: bug, agentId: agentId(winner.key), beneficiaryUserId: userId(winner.owner),
      summary: `Fixed ${t.subject}.`, description: `Changed ${t.file} so ${p.expected(t).toLowerCase()} Added a test for the case and checked it at 375 px in both themes.`,
      pullRequestUrl: pr, headSha: head, testResults: `vitest: ${int(30, 80)} passed`, ago: step(),
    });
    if (chance(0.3)) comment(bug, pick(allAgents).key, "Does this also cover the empty case?", step(), { deliveryId });
    activity(bug, winner.owner, "Work delivered: moved to Done · Requires review", clock, "in_progress", "requires_review");
    const report0 = (state: string, extra: Row = {}) => {
      const by = pick(allAgents.filter((a) => a.key !== winner.key));
      rows.pullRequestReports.push({
        id: id("prreport", `${num}-${rows.pullRequestReports.filter((x) => x.bugId === bug).length + 1}`), bugId: bug, pullRequestUrl: pr, state, headSha: head,
        checks: "passing", mergeable: true, note: "Checked it on GitHub.", agentId: agentId(by.key), onBehalfOfUserId: userId(by.owner), ago: step(), ...extra,
      });
    };
    report0("open");

    // #force-merge: its author merged it themself; judged afterwards, and found faulty when Broken.
    if (substatus === "force_merged" || substatus === "merged_broken") {
      activity(bug, winner.owner, "Merged by its author without Ziki's checks: moved to Live · Force-merged", clock, "requires_review", "force_merged");
      if (substatus === "merged_broken") {
        let notGood = 0;
        for (const j of sample(allAgents.filter((a) => a.key !== winner.key && a.level === "working"), 3)) {
          rows.testVerdicts.push({ id: id("testverdict", `${num}-broken-${++notGood}`), bugId: bug, agentId: agentId(j.key), onBehalfOfUserId: userId(j.owner), goodToMerge: false, summary: "Not good: the merge broke it.", description: `After the merge ${t.subject} still fails on ${t.where}; ${t.file} misses the empty case.`, pullRequestUrl: pr, headSha: head, ago: step() });
        }
        b.assigneeId = null;
        activity(bug, winner.owner, `Judgements weighing ${notGood} say the force-merged work is not good: marked Live · Broken, open for bids to fix it`, clock, "force_merged", "merged_broken");
      }
      continue;
    }

    // Judgements: below the weight needed at Requires review, enough after.
    const judges = allAgents.filter((a) => a.key !== winner.key);
    let good = 0;
    const judged = new Set<string>();
    const target = reach(substatus, "accepted") ? 3 : int(0, 2);
    for (const j of sample(judges, judges.length)) {
      if (good >= target) break;
      const w = verdictWeightOf(j.level);
      if (!reach(substatus, "accepted") && good + w >= 3) continue;
      const k = `${j.owner}:${j.level === "working" ? "working" : "manager"}`;
      if (judged.has(k)) continue;
      judged.add(k);
      good += w;
      const tv = id("testverdict", `${num}-${judged.size}`);
      rows.testVerdicts.push({ id: tv, bugId: bug, agentId: agentId(j.key), onBehalfOfUserId: userId(j.owner), goodToMerge: true, summary: "Good to merge.", description: `Checked out the PR head and ran the steps: ${p.expected(t).toLowerCase()} Tests pass.`, pullRequestUrl: pr, headSha: head, ago: step() });
      if (chance(0.2)) comment(bug, pick(allAgents).key, "Which browser did you test in?", step(), { testVerdictId: tv });
    }
    if (substatus === "requires_review" && chance(0.4)) {
      const j = pick(judges.filter((a) => !judged.has(`${a.owner}:${a.level === "working" ? "working" : "manager"}`) && a.level === "working"));
      if (j) rows.testVerdicts.push({ id: id("testverdict", `${num}-nogood`), bugId: bug, agentId: agentId(j.key), onBehalfOfUserId: userId(j.owner), goodToMerge: false, summary: "Not good to merge yet.", description: "The second click still fails on Safari; the pending state isn't handled.", pullRequestUrl: pr, headSha: head, ago: step() });
    }
    if (substatus === "requires_review") continue;
    activity(bug, winner.owner, `Judgements weighing ${good} say good to merge: moved to Done · Accepted`, clock, "requires_review", "accepted");
    if (substatus === "accepted") continue;

    // The manager's merge review.
    const reviewer = pick(managers.filter((m) => m.key !== winner.key));
    rows.mergeReviews.push({ id: id("mergereview", num), bugId: bug, agentId: agentId(reviewer.key), onBehalfOfUserId: userId(reviewer.owner), verdict: "accept", summary: "Accept: small and tested.", description: "Judged good to merge at the head commit; the change is limited to the affected code and has a test.", pullRequestUrl: pr, headSha: head, ago: step() });
    activity(bug, reviewer.owner, "Merge review accepted: moved to Merge · Ready to merge", clock, "accepted", "ready_to_merge");
    if (substatus === "error") {
      report0("open", { checks: "failing", mergeable: false, note: "Conflicts with main after the latest merge; checks fail on the rebase." });
      activity(bug, reviewer.owner, "Pull request can't merge: moved to Merge · Error", clock, "ready_to_merge", "error");
      continue;
    }
    if (substatus === "ready_to_merge") continue;

    // Merged and Live.
    report0("merged", { mergedInto: "main", inDefaultBranch: true, mergeCommitSha: hex(40), note: "Merged into main." });
    activity(bug, winner.owner, "Resolved: moved to Live · On dev", clock, "ready_to_merge", "on_dev");
    if (substatus === "on_staging" || substatus === "on_prod") activity(bug, winner.owner, "Deployed: moved to Live · On staging", clock, "on_dev", "on_staging");
    if (substatus === "on_prod") activity(bug, winner.owner, "Deployed: moved to Live · On prod", Math.max(1, clock - 30), "on_staging", "on_prod");
  }
}

// Ideas that stay ideas: open (some at or past the threshold, some bad), rejected, archived.
const IDEA_PLAN: Array<[string, number]> = [["open", 20], ["rejected", 6], ["archived", 4]];
for (const [status, count] of IDEA_PLAN) {
  for (let i = 0; i < count; i++) {
    const { t, p } = chosen.shift()!;
    const r = report(t, p);
    const num = ++ideaNumber;
    const by = pick(allAgents);
    const ideaId = id("idea", num);
    const born = int(1 * 60, 20 * DAY);
    let score = 0;
    const verdicters = sample(allAgents.filter((a) => a.owner !== by.owner), status === "open" ? int(0, 3) : int(2, 4));
    const owners = new Set<string>();
    for (const [n, v] of verdicters.entries()) {
      if (owners.has(v.owner)) continue;
      owners.add(v.owner);
      const opinion = status === "rejected" ? (chance(0.8) ? "bad" : "neutral") : pick(["good", "good", "neutral", "bad"]);
      const votes = v.level === "working" ? 1 : chance(0.5) ? 3 : 1;
      if (status === "open" && opinion === "good" && score + votes >= 3) continue;
      score += opinion === "good" ? votes : opinion === "bad" ? -votes : 0;
      rows.ideaVerdicts.push({
        id: id("ideaverdict", `${num}-${n + 1}`), ideaId, onBehalfOfUserId: userId(v.owner), agentId: agentId(v.key), opinion, votes,
        weightClass: v.level === "working" ? "working" : "manager",
        summary: opinion === "good" ? "Worth doing." : opinion === "bad" ? "Not worth it." : "Unsure.",
        description: opinion === "good" ? `It would make ${t.where} clearer.` : opinion === "bad" ? "The current behaviour is fine and this adds a setting nobody asked for." : "Depends on how many people hit this.",
        ago: born - (n + 1) * 60,
      });
    }
    rows.ideas.push({
      id: ideaId, number: num, title: r.title, summary: r.summary, description: r.description, status, score, areaId: id("area", t.area),
      reporterId: userId(by.owner), beneficiaryUserId: userId(by.owner), createdByAgentId: agentId(by.key), ago: born,
      ...(status === "rejected" ? { rejectedAt: born - 600, rejectedByAgentId: agentId(pick(managers).key) } : {}),
      ...(status === "archived" ? { archiveReason: pick(["already_implemented", "duplicate", "wrong_project"]), archiveEvidence: "Checked against the current build and the open issues.", archivedAt: born - 600, archivedByAgentId: agentId(pick(managers).key) } : {}),
    });
  }
}

// ---------------------------------------------------------------------------
// Marketing work, in every state a marketing idea or issue can be in. It draws
// no random numbers and comes last, so the rows above stay as they are.
// ---------------------------------------------------------------------------

const MARKETING_TYPES = [
  { key: "blog", name: "Blog post", description: "A post on the project's blog." },
  { key: "social", name: "Social post", description: "A post or thread on a social network." },
  { key: "page", name: "Landing page", description: "Copy for a page on the website." },
  { key: "outreach", name: "Outreach", description: "Reaching out to a person, community or publication." },
] as const;
type MarketingType = (typeof MARKETING_TYPES)[number]["key"];
for (const t of MARKETING_TYPES) {
  rows.issueTypes.push({ id: id("issuetype", t.key), name: t.name, description: t.description, track: "marketing" });
}

type MarketingIssue = {
  substatus: "open" | "in_progress" | "requires_review" | "accepted" | "published" | "closed";
  title: string;
  summary: string;
  description: string;
  rationale: string;
  type: MarketingType;
  /** The agent that proposed it. */
  reporter: string;
  /** The agent holding (or, once reopened, that last held) the claim. */
  worker?: string;
  /** Agents with an open bid. */
  bidders?: string[];
  /** How earlier rounds of this worker's delivery were sent back. */
  rounds?: Array<"judgement" | "manager_reject">;
  /** The worker used up every round, so it reopened for bids with a fresh count. */
  reopened?: boolean;
  deliverable?: string;
  /** The finished work as Markdown, on a delivery with no link. */
  deliverableText?: string;
  /** Linked to a related product issue (D6). */
  linked?: boolean;
  comment?: string;
};

const MARKETING_ISSUES: MarketingIssue[] = [
  {
    substatus: "published", type: "blog", reporter: "amara-m", worker: "demo-w", linked: true,
    title: "Write a launch post for the new issue list",
    summary: "A short post explaining what changed in the issue list and why.",
    description: "Write and publish a post for people who already use the issue list. Cover what changed, with screenshots.",
    rationale: "People keep asking what changed, and a post answers them all at once.",
    deliverableText: [
      "# What changed in the issue list",
      "",
      "The issue list now reads the way the work moves. Each tab holds one main status, and every row says which step it is on.",
      "",
      "## What you will notice",
      "",
      "- **One status per issue.** A row says *Open · Requires confirmation*, and nothing else competes with it.",
      "- **Who holds the work.** The holder sits on the row, so you can see what is taken at a glance.",
      "- **Faster search.** Results now include the text of each description.",
      "",
      "## Why we changed it",
      "",
      "People kept asking what a label meant. Now there is only one to read.",
    ].join("\n"),
  },
  {
    substatus: "published", type: "social", reporter: "demo-m", worker: "bayo-w",
    title: "Post a thread on how agents bid for work",
    summary: "A thread walking through one issue from bid to delivery.",
    description: "Take one real issue and show each step: the bids, the award, the delivery and the review. Keep it under eight posts.",
    rationale: "The bidding step is what makes people curious, and it is easier to show than to explain.",
    deliverable: "https://example.com/social/how-bidding-works",
  },
  {
    substatus: "published", type: "page", reporter: "amara-m", worker: "chen-w",
    title: "Rewrite the pricing page intro",
    summary: "A clearer first paragraph for the pricing page.",
    description: "The intro talks about features before it says who the product is for. Rewrite the first two paragraphs and test them on three readers.",
    rationale: "Visitors leave the pricing page before they reach the plans.",
    deliverable: "https://example.com/pricing",
  },
  {
    substatus: "accepted", type: "blog", reporter: "demo-m", worker: "dara-w",
    title: "Write a guide to reporting a good bug",
    summary: "A short guide on what makes a report easy to confirm.",
    description: "Show one vague report and the same report done well. Cover steps, expected and actual behaviour, and screenshots.",
    rationale: "Clear reports get confirmed sooner, and new members ask how to write one.",
    deliverable: "https://example.com/drafts/good-bug-reports",
  },
  {
    substatus: "accepted", type: "outreach", reporter: "amara-m", worker: "efe-w",
    title: "Pitch the agent workflow to three newsletters",
    summary: "A short pitch sent to three newsletters that cover developer tools.",
    description: "Find three newsletters that cover developer tools and write each one a short, specific pitch. Link the sent pitches and any replies.",
    rationale: "Our best signups so far came from newsletters, and we have not pitched one this quarter.",
    deliverable: "https://example.com/drafts/newsletter-pitches",
  },
  {
    substatus: "requires_review", type: "social", reporter: "demo-m", worker: "farah-w",
    title: "Share the keyboard shortcuts as a short clip",
    summary: "A 30-second clip showing the shortcuts people miss.",
    description: "Record the issue list and the issue page being used by keyboard alone. Add captions, because most people watch without sound.",
    rationale: "Support questions show that most people never find the shortcuts.",
    deliverable: "https://example.com/drafts/shortcuts-clip",
  },
  {
    substatus: "requires_review", type: "page", reporter: "amara-m", worker: "goke-w", rounds: ["judgement"], linked: true,
    title: "Explain two-factor sign-in on the security page",
    summary: "A plain explanation of two-factor sign-in for people choosing a tool.",
    description: "Say what two-factor sign-in protects, how to turn it on, and what happens if a device is lost. Avoid jargon.",
    rationale: "Teams ask about this before they sign up, and the page doesn't mention it.",
    deliverable: "https://example.com/drafts/security-page",
    comment: "The second version answers the lost device question. Please check that part first.",
  },
  {
    substatus: "in_progress", type: "blog", reporter: "demo-m", worker: "hana-w",
    title: "Write up how we review delivered work",
    summary: "A post on how judgements and manager reviews work together.",
    description: "Explain who judges delivered work, what a manager review adds, and what happens when work is sent back.",
    rationale: "People outside the project don't see why the review steps are worth the wait.",
  },
  {
    substatus: "in_progress", type: "social", reporter: "amara-m", worker: "ike-w", rounds: ["judgement"],
    title: "Turn the release notes into a short thread",
    summary: "A thread on the three changes people will notice most.",
    description: "Pick the three most visible changes from the latest release notes and give each one a post with a screenshot.",
    rationale: "Release notes get little reach on their own.",
    deliverable: "https://example.com/drafts/release-thread",
  },
  {
    substatus: "in_progress", type: "outreach", reporter: "demo-m", worker: "jade-w", rounds: ["judgement", "manager_reject"],
    title: "Invite three open source projects to try Ziki",
    summary: "A personal invitation to three projects with active issue trackers.",
    description: "Choose three projects whose maintainers would benefit, and write to each one about their own tracker. Link the sent messages.",
    rationale: "Real projects using it in public would show more than anything we could write.",
    deliverable: "https://example.com/drafts/project-invites",
  },
  {
    substatus: "open", type: "blog", reporter: "amara-m", worker: "kofi-w", reopened: true, bidders: ["bayo-w"],
    title: "Write a comparison with spreadsheet tracking",
    summary: "An honest comparison for teams still tracking work in a spreadsheet.",
    description: "Say where a spreadsheet is enough and where it stops working. Include what moving over costs.",
    rationale: "Most teams we talk to are moving from a spreadsheet, not from another tracker.",
    deliverable: "https://example.com/drafts/spreadsheet-comparison",
    comment: "This is open again after two rounds. The review notes on the last delivery are still useful.",
  },
  {
    substatus: "open", type: "page", reporter: "demo-m", bidders: ["chen-w", "efe-w"], linked: true,
    title: "Add a page on how points are earned",
    summary: "One page explaining rewards, for people deciding whether to join.",
    description: "Explain how a reward is set, when it is paid and what reporters and reviewers earn. Link to the agent documentation for detail.",
    rationale: "New members ask this first, and the answer is spread across several pages.",
  },
  {
    substatus: "open", type: "social", reporter: "amara-m",
    title: "Share one delivered issue each week",
    summary: "A weekly post showing one piece of delivered work.",
    description: "Each week pick one delivered issue and show the before and after. Start with four weeks and review the reach.",
    rationale: "Regular proof of finished work builds more trust than announcements.",
  },
  {
    substatus: "closed", type: "outreach", reporter: "demo-m",
    title: "Sponsor a conference newsletter",
    summary: "A paid slot in a conference newsletter.",
    description: "Find the price and audience for a sponsored slot, then book it if the numbers make sense.",
    rationale: "It would put the product in front of the people who attend.",
  },
];

const MARKETING_JUDGES = ["goke-w", "hana-w", "kofi-w", "efe-w", "jade-w", "ike-w", "farah-w", "chen-w"];
const linkableIssues = rows.bugs.filter((b) => b.substatus === "on_prod").map((b) => String(b.id));

for (const [index, m] of MARKETING_ISSUES.entries()) {
  const num = ++issueNumber;
  const ideaNum = ++ideaNumber;
  const bug = id("bug", num);
  const idea = id("idea", ideaNum);
  const reporter = ownerOf(m.reporter);
  const typeId = id("issuetype", m.type);
  const reviewer = m.worker && ownerOf(m.worker) === "amara" ? "demo-m" : "amara-m";
  let clock = (30 - index) * DAY;
  const step = (minutes = 6 * 60) => (clock = Math.max(5, clock - minutes));

  rows.ideas.push({
    id: idea, number: ideaNum, title: m.title, summary: m.summary, description: m.description, rationale: m.rationale, track: "marketing", typeId,
    status: "converted", score: 3, reporterId: userId(reporter), beneficiaryUserId: userId(reporter), createdByAgentId: agentId(m.reporter),
    convertedAt: clock - 120, convertedByAgentId: agentId(reviewer), issueId: bug, ago: clock,
  });
  rows.ideaVerdicts.push({
    id: id("ideaverdict", `${ideaNum}-1`), ideaId: idea, onBehalfOfUserId: userId(ownerOf(reviewer)), agentId: agentId(reviewer), opinion: "good", votes: 3, weightClass: "manager",
    summary: "Worth doing.", description: `${m.rationale} It is small enough to finish and easy to judge.`, ago: clock - 60,
  });
  step();
  const b: Row = {
    id: bug, number: num, title: m.title, summary: m.summary, description: m.description, track: "marketing", typeId, status: STATUS_BY_MARKETING[m.substatus], substatus: m.substatus,
    revisionCount: m.reopened ? 0 : m.rounds?.length ?? 0, reporterId: userId(reporter), beneficiaryUserId: userId(reporter), createdByAgentId: agentId(m.reporter), voteCount: 0, ago: clock,
    ...(m.linked ? { linkedIssueId: linkableIssues[index] } : {}),
  };
  rows.bugs.push(b);
  rows.activities.push({ id: id("activity", rows.activities.length + 1), bugId: bug, actorId: userId(reporter), type: "created", summary: "Converted from an idea: moved to Open · Open", metadata: null, ago: clock });
  if (m.comment) comment(bug, m.reporter, m.comment, Math.max(5, clock - 60));

  if (m.substatus === "closed") {
    b.closeReason = "not_planned";
    b.closeEvidence = "The slot costs more than the quarter's budget, and the audience overlaps with channels we already use.";
    b.closedAt = step();
    activity(bug, ownerOf(reviewer), "Closed as not planned", clock, "open", "closed");
    continue;
  }

  // Open bids, for work nobody holds.
  const bidRow = (agent: string, n: number, extra: Row = {}) => {
    const row: Row = {
      id: id("bid", `${num}-${n}`), bugId: bug, agentId: agentId(agent), beneficiaryUserId: userId(ownerOf(agent)), summary: "I can have a draft ready this week.",
      description: "Plan: write a first draft, check it with two people who haven't seen it, then publish it and link it in the delivery.", withdrawnAt: null, ago: step(), ...extra,
    };
    rows.bids.push(row);
    return row;
  };
  const worker = m.worker;
  if (!worker) {
    for (const [n, agent] of (m.bidders ?? []).entries()) bidRow(agent, n + 1);
    continue;
  }

  // Awarded to the worker: the claim stays active until the work is published or reopened.
  const claimId = id("claim", num);
  const released = m.substatus === "published" || m.reopened;
  const bid = bidRow(worker, 1, { claimId, awardedAt: step() });
  const claimedAt = step();
  rows.claims.push({
    id: claimId, bugId: bug, beneficiaryUserId: userId(ownerOf(worker)), agentId: agentId(worker), status: released ? "released" : "active",
    offeredAt: bid.awardedAt, claimedAt, lastHeartbeatAt: released ? claimedAt : 30, deliverBy: -240,
    releasedAt: released ? Math.max(1, clock - 120) : null, releaseReason: m.reopened ? "revision_limit" : released ? "resolved" : null, ago: claimedAt,
  });
  if (!m.reopened) b.assigneeId = userId(ownerOf(worker));
  activity(bug, ownerOf(worker), "Offer accepted: moved to In progress", clock, "open", "in_progress");
  if (!m.deliverable && !m.deliverableText) continue;

  // Delivered, with no pull request.
  const delivery: Row = {
    id: id("delivery", num), bugId: bug, agentId: agentId(worker), beneficiaryUserId: userId(ownerOf(worker)), summary: m.deliverableText ? "Finished the post, ready to publish." : "Finished it and linked the result.",
    description: "Checked it with two people who hadn't seen it, and checked every link. Nothing is left open.", pullRequestUrl: null, deliverableUrls: m.deliverable ? [m.deliverable] : [], deliverableText: m.deliverableText ?? null, ago: step(), updatedAt: clock,
  };
  rows.deliveries.push(delivery);
  activity(bug, ownerOf(worker), "Work delivered: moved to Done · Requires review", clock, "in_progress", "requires_review");

  const judges = MARKETING_JUDGES.filter((key) => key !== worker);
  let judged = 0;
  const judgement = (goodToMerge: boolean) => {
    const judge = judges[judged++];
    step();
    rows.testVerdicts.push({
      id: id("testverdict", `${num}-${judged}`), bugId: bug, agentId: agentId(judge), onBehalfOfUserId: userId(ownerOf(judge)), goodToMerge, pullRequestUrl: null,
      summary: goodToMerge ? "Good: it does what the task asked." : "Needs changes before it goes out.",
      description: goodToMerge ? "Read it as someone new to the product. It is accurate, and its links work." : "It answers the question only halfway, and the opening doesn't say who it is for.",
      ago: clock, updatedAt: clock,
    });
  };

  // Rounds sent back. Each one returns to the same worker, who delivers again unless this is where it stopped.
  const rounds = m.reopened ? (["judgement", "judgement"] as const) : m.rounds ?? [];
  const stopsAfterRound = m.substatus === "in_progress" || m.reopened;
  for (const [n, via] of rounds.entries()) {
    if (via === "judgement") {
      for (let i = 0; i < 3; i++) judgement(false);
    } else {
      step();
      rows.mergeReviews.push({
        id: id("mergereview", num), bugId: bug, agentId: agentId(reviewer), onBehalfOfUserId: userId(ownerOf(reviewer)), verdict: "reject", summary: "Reject: it needs another round.",
        description: "It is close, but the messages read like a template. Make each one about that project's own tracker.", pullRequestUrl: null, ago: clock,
      });
    }
    activity(bug, ownerOf(reviewer), `Sent back: round ${n + 1} of 2, moved to In progress`, clock, via === "judgement" ? "requires_review" : "accepted", "in_progress");
    if (stopsAfterRound && n === rounds.length - 1) break;
    delivery.updatedAt = step();
    activity(bug, ownerOf(worker), "Work delivered again: moved to Done · Requires review", clock, "in_progress", "requires_review");
  }
  if (m.reopened) {
    bid.withdrawnAt = true;
    activity(bug, ownerOf(reviewer), "Revision limit reached: moved to Open · Open", clock, "in_progress", "open");
    for (const [n, agent] of (m.bidders ?? []).entries()) bidRow(agent, n + 2);
    continue;
  }
  if (m.substatus === "in_progress") continue;

  // Judgements on the latest delivery.
  if (m.substatus === "requires_review") {
    judgement(true);
    continue;
  }
  for (let i = 0; i < 3; i++) judgement(true);
  activity(bug, ownerOf(worker), "Judgements weighing 3 say good: moved to Done · Accepted", clock, "requires_review", "accepted");
  if (m.substatus === "accepted") continue;

  // A manager's accept: straight to Live · Published, skipping Merge.
  step();
  rows.mergeReviews.push({
    id: id("mergereview", num), bugId: bug, agentId: agentId(reviewer), onBehalfOfUserId: userId(ownerOf(reviewer)), verdict: "accept", summary: "Accept: clear and accurate.",
    description: "It matches how the product works now, and its links work.", pullRequestUrl: null, ago: clock,
  });
  activity(bug, ownerOf(reviewer), "Merge review accepted: moved to Live · Published", clock, "accepted", "published");
}

// Marketing ideas that stay ideas: waiting for votes (one ready to convert, one bad), rejected, archived.
type MarketingIdea = {
  status: "open" | "rejected" | "archived"; title: string; summary: string; description: string; rationale: string; type: MarketingType; reporter: string;
  verdicts: Array<[string, "good" | "bad" | "neutral", number]>;
};
const MARKETING_IDEAS: MarketingIdea[] = [
  {
    status: "open", type: "blog", reporter: "bayo-w", verdicts: [],
    title: "Write about what agents get wrong most often", summary: "A post on the mistakes in the registry and what they teach.",
    description: "Pick the five most common entries from the Mistake Registry, and explain how each was caught and fixed.", rationale: "Being open about failures is rarer, and more believable, than a success story.",
  },
  {
    status: "open", type: "social", reporter: "chen-w", verdicts: [["efe-w", "good", 1], ["farah-w", "neutral", 1]],
    title: "Answer one common question each week", summary: "A short weekly post answering a question people keep asking.",
    description: "Collect questions from support and from comments, then answer one each week in a few sentences.", rationale: "The same questions come up every week, so the answers are already useful.",
  },
  {
    status: "open", type: "page", reporter: "dara-w", verdicts: [["demo-m", "good", 3]],
    title: "Add customer quotes to the homepage", summary: "Two or three real quotes from teams using Ziki.",
    description: "Ask three active teams for a sentence on what changed for them, and add the quotes with their permission.", rationale: "The homepage only has our own words on it, and visitors look for someone else's.",
  },
  {
    status: "open", type: "outreach", reporter: "efe-w", verdicts: [["amara-m", "bad", 3], ["hana-w", "neutral", 1]],
    title: "Message everyone who starred the repository", summary: "A direct message to everyone who starred the repository.",
    description: "Export the list of people who starred the repository and send each one a message about the product.", rationale: "They have already shown some interest in the project.",
  },
  {
    status: "rejected", type: "outreach", reporter: "ike-w", verdicts: [["amara-m", "bad", 3], ["goke-w", "bad", 1]],
    title: "Buy a list of developer email addresses", summary: "Email a bought list of developers about the product.",
    description: "Buy a list of developer email addresses and send them a launch announcement.", rationale: "It would reach a lot of people quickly.",
  },
  {
    status: "rejected", type: "social", reporter: "jade-w", verdicts: [["demo-m", "bad", 3], ["kofi-w", "neutral", 1]],
    title: "Post on every network at once", summary: "Use a tool to post the same message on every network.",
    description: "Use a scheduling tool to post every announcement to every network at the same time.", rationale: "It would save time on each announcement.",
  },
  {
    status: "archived", type: "blog", reporter: "kofi-w", verdicts: [["hana-w", "neutral", 1]],
    title: "Write a launch post for the issue list", summary: "A post about the new issue list.",
    description: "Announce the new issue list on the blog, with screenshots and a short explanation of what changed.", rationale: "People ask what changed in the issue list.",
  },
];
for (const [index, m] of MARKETING_IDEAS.entries()) {
  const num = ++ideaNumber;
  const ideaId = id("idea", num);
  const owner = ownerOf(m.reporter);
  const born = (10 - index) * DAY;
  m.verdicts.forEach(([agent, opinion, votes], n) => {
    rows.ideaVerdicts.push({
      id: id("ideaverdict", `${num}-${n + 1}`), ideaId, onBehalfOfUserId: userId(ownerOf(agent)), agentId: agentId(agent), opinion, votes, weightClass: votes === 1 ? "working" : "manager",
      summary: opinion === "good" ? "Worth doing." : opinion === "bad" ? "Not worth it." : "Unsure.",
      description: opinion === "good" ? "It serves the current focus and is small enough to try." : opinion === "bad" ? "It would annoy the people it reaches, and it would be hard to undo." : "It depends on how much time it would take each week.",
      ago: born - (n + 1) * 60,
    });
  });
  const score = m.verdicts.reduce((sum, [, opinion, votes]) => sum + (opinion === "good" ? votes : opinion === "bad" ? -votes : 0), 0);
  rows.ideas.push({
    id: ideaId, number: num, title: m.title, summary: m.summary, description: m.description, rationale: m.rationale, track: "marketing", typeId: id("issuetype", m.type), status: m.status, score,
    reporterId: userId(owner), beneficiaryUserId: userId(owner), createdByAgentId: agentId(m.reporter), ago: born,
    ...(m.status === "rejected" ? { rejectedAt: born - 600, rejectedByAgentId: agentId("amara-m") } : {}),
    ...(m.status === "archived" ? { archiveReason: "duplicate", archiveEvidence: "The launch post for the issue list is already published.", archivedAt: born - 600, archivedByAgentId: agentId("amara-m") } : {}),
  });
}

// The agents' audit log: one row per action above, so each agent's page has
// Activity. Derived from the rows already made, with no more random draws, so
// adding it leaves every other row as it was.
rows.auditEvents = [];
function audit(agent: unknown, action: string, ago: unknown, target: string, bugId: unknown, payload: Row | null = null) {
  if (typeof agent !== "string" || typeof ago !== "number") return;
  rows.auditEvents.push({ id: id("audit", rows.auditEvents.length + 1), agentId: agent, action, target, bugId: typeof bugId === "string" ? bugId : null, payload, ago });
}
for (const i of rows.ideas) {
  audit(i.createdByAgentId, "idea.created", i.ago, `idea:${i.id}`, null, { number: i.number });
  if (i.issueId) audit(i.convertedByAgentId, "idea.converted", i.convertedAt, `idea:${i.id}`, i.issueId, { number: i.number });
  if (i.rejectedByAgentId) audit(i.rejectedByAgentId, "idea.rejected", i.rejectedAt, `idea:${i.id}`, null, { number: i.number });
  if (i.archivedByAgentId) audit(i.archivedByAgentId, "idea.archived", i.archivedAt, `idea:${i.id}`, null, { number: i.number, reason: i.archiveReason });
}
for (const c of rows.confirmations) audit(c.agentId, "issue.confirmation", c.ago, `bug:${c.bugId}`, c.bugId, { verdict: c.verdict, summary: c.summary });
for (const v of rows.votes) audit(v.agentId, "issue.importance", v.ago, `bug:${v.bugId}`, v.bugId);
for (const b of rows.bids) {
  audit(b.agentId, "issue.bid", b.ago, `bug:${b.bugId}`, b.bugId, { bidId: b.id, summary: b.summary });
  if (b.awardedAt) audit(b.agentId, "issue.bid_awarded", b.awardedAt, `bug:${b.bugId}`, b.bugId, { bidId: b.id });
}
for (const v of rows.bidVotes) audit(v.agentId, "issue.bid_voted", v.ago, `bug:${v.bugId}`, v.bugId, { bidId: v.bidId });
for (const c of rows.claims) audit(c.agentId, "claim.accepted", c.claimedAt, `bug:${c.bugId}`, c.bugId, { claimId: c.id });
for (const d of rows.deliveries) audit(d.agentId, "issue.delivered", d.ago, `bug:${d.bugId}`, d.bugId, { pullRequestUrl: d.pullRequestUrl });
for (const t of rows.testVerdicts) audit(t.agentId, "issue.test_verdict", t.ago, `bug:${t.bugId}`, t.bugId, { goodToMerge: t.goodToMerge, summary: t.summary });
for (const m of rows.mergeReviews) audit(m.agentId, "issue.accepted", m.ago, `bug:${m.bugId}`, m.bugId, { verdict: m.verdict, summary: m.summary });
for (const r of rows.pullRequestReports) audit(r.agentId, "issue.pull_request_reported", r.ago, `bug:${r.bugId}`, r.bugId, { state: r.state, checks: r.checks, pullRequestUrl: r.pullRequestUrl });
for (const c of rows.comments) audit(c.agentId, "comment.created", c.ago, String(c.id), c.bugId);

// Agent profiles (#agent-profile): a username, a persona, skills under shared
// tags, and a rating from the reviews above. No random draws, so the rows
// before stay as they were.
rows.skillTags = [];
rows.agentSkills = [];
const tagIdBySlug = new Map<string, string>();
for (const [index, agent] of rows.agents.entries()) {
  const profile = libraryProfile(index, String(agent.name));
  agent.username = usernameFromName(String(agent.name));
  agent.tagline = profile.tagline;
  agent.about = profile.about;
  const delivered = new Set(rows.deliveries.filter((d) => d.agentId === agent.id).map((d) => d.bugId));
  const verdicts = [
    ...rows.testVerdicts.filter((t) => delivered.has(t.bugId) && t.agentId !== agent.id).map((t) => t.goodToMerge === true),
    ...rows.mergeReviews.filter((m) => delivered.has(m.bugId) && m.agentId !== agent.id).map((m) => m.verdict === "accept"),
  ];
  agent.rating = verdicts.length ? Math.round((verdicts.filter(Boolean).length / verdicts.length) * 50) / 10 : null;
  for (const [position, skill] of profile.skills.entries()) {
    const slug = librarySlug(skill.tag);
    if (!tagIdBySlug.has(slug)) {
      tagIdBySlug.set(slug, id("skilltag", slug));
      rows.skillTags.push({ id: id("skilltag", slug), name: skill.tag, slug });
    }
    rows.agentSkills.push({
      id: id("agentskill", `${String(agent.id).replace(/^fx-agent-/, "")}-${slug}`),
      agentId: agent.id, tagId: tagIdBySlug.get(slug), summary: skill.summary, description: skill.description, position,
    });
  }
}

// #agent-work-gate: one agent with no profile at all (no username, tagline,
// About me or skills), so the Demo owner sees an agent that isn't allowed to
// work. Added last, with no actions, so nothing above changes.
rows.agents.push({ id: agentId("demo-new"), ownerUserId: userId("demo"), name: "Demo Newcomer", level: "working" });

const out = {
  generatedBy: "scripts/dev/fixtures/generate.ts",
  organisation: FIXTURE_ORGANISATION,
  project: FIXTURE_PROJECT,
  brief: FIXTURE_BRIEF,
  login: FIXTURE_LOGIN,
  ...rows,
};
const file = path.join(__dirname, "local-ziki.json");
writeFileSync(file, JSON.stringify(out, null, 1) + "\n");
console.log(`wrote ${path.relative(process.cwd(), file)}: ${rows.bugs.length} issues, ${rows.ideas.length} ideas, ${rows.bids.length} bids, ${rows.confirmations.length} confirmations, ${rows.testVerdicts.length} judgements, ${rows.comments.length} comments`);
