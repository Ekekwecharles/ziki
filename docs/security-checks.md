# Security checks

A client adds a website, server or code repository, proves it's theirs, and agents check it for weaknesses and report what they find. Agents look; they never exploit. This is separate from, and feeds into, the private findings already on the Security page (`SecurityFinding`, #security-findings).

This page is the shared contract for the parts being built in parallel under the **14 Nov plan** (after the 13 Nov call with Mark; it replaces the 12 Nov plan). The shared data and rules landed first (#security-checks foundation), so each part builds on them without editing another part's files. Steps marked *(coming)* are being built now; the rest is live.

## What changed on 14 Nov

Mark found the flow too hard to use on the 13 Nov call. For this test version:

- **No ownership proof, and no KYC.** A scan starts as soon as an asset is added. The proof is switched off, not removed: set `SECURITY_OWNERSHIP_PROOF_REQUIRED=true` to bring it back (`ownershipProofRequired()`, `isTargetProven()`, `provenTargetWhere()` in `lib/security-checks.ts`; the proof pages and checks are untouched). KYC comes later.
- **No scan limits.** The free-scan limits are switched off the same way: set `SECURITY_SCAN_LIMITS_ENABLED=true` to bring back "1 free scan per target, 3 per workspace a month" (`scanLimitsEnabled()`, `freeScanAllowed()`). The chat's hourly message limit is separate and stays.
- **Servers get public checks only.** Agents never probe a server or hit an address.
- **One Security page, no wizard.** An empty page with one box, then the scan on the same page, then the list of past scans. Reports never go away.
- **Paying unlocks the details and the move to your app, both.**
- **On-call is people, not agents.** Staff invite a person by email; the person's agents all work as guests in a new workspace, at working-level rights, and stay.

See `security-checks-plan-14nov.md` (kept with the team's plans) for who builds what. Where this page still describes the proof, the limits or agent-based on-call below, it describes how those work when switched on, or how they work until the next change lands.

## The flow

1. **Find Ziki** *(coming)*. A public page at `ziki.dev/security` with one box, "Paste your site". There's no AI chat here; code works out the kind of link.
2. **Quick preview scan, blurred** *(coming)*. **Code only, with no agents and no AI.** It reads only what any visitor's browser already sees: security headers, TLS certificate, cookie flags on the home page, DNS basics. It never probes: no login forms, no guessed paths, no port scans. It's rate-limited per visitor (`PREVIEW_SCANS_PER_VISITOR_PER_HOUR`), and its result stays **blurred** until the site is proven the client's.
3. **Sign up, new workspace** *(coming)*. A new workspace gets up to `ON_CALL_GUESTS_PER_NEW_WORKSPACE` free **on-call guests** (below).
4. **Say what to check.** Signed in: Ziki's AI chat *(coming)* or the box works out website, server or repo (`SecurityTargetKind`), and it's stored once per workspace as a `SecurityTarget`. **The first scan is free** (`SecurityCheck.free`), within `FREE_SCANS_PER_TARGET` and `FREE_SCANS_PER_WORKSPACE_PER_MONTH` (`freeScanAllowed()`).
5. **Show it's yours** *(switched off; see "What changed on 14 Nov")*. When proof is required, the client proves ownership once per target:
   - **Website:** a DNS TXT record or a homepage tag with `SecurityTarget.ownershipToken`.
   - **Repo:** the workspace's Ziki GitHub App, or a `.ziki-verification` file.
   - **Server:** a file at `/.well-known/ziki-verification.txt`. Only the file counts: a domain pointed at a server proves nothing, since anyone can point a domain anywhere.

   `verifiedAt` is set when proven, and `ownershipMethod` records how. **No agent or AI touches the target before this.**
6. **The full check, free the first time.** It starts the moment ownership is proven. **Ziki's own AI** splits the target into parts. Each part goes to a **security-cleared** agent, which reports zero or more `SecurityCheckResult`s: severity, title, description, how to fix. Each result is priced by its severity (`SEVERITY_PRICE`, stored as `priceCoins`).
7. **The report is posted.** When every part is in, the findings are collated into one plain summary (`SecurityCheck.summary`). Posting it sets `postedAt`, and only then does the client see anything (`isReportPosted()`).
8. **See what's wrong, free.** Findings are worst first. **Locked** findings show only their severity, a vague title and their price, and the lock is obvious. The vague report is free to download as a PDF.
9. **Unlock fixes.** The client unlocks **all** findings or **picks** some, paying the sum of their prices (`unlockTotal()`; payment is simulated). Each chosen result gets `unlockedAt` (`isResultUnlocked()`), and its details and fix show.
10. **Fix on Ziki.** Unlocked findings of a posted report become a private `SecurityFinding` plus an issue in a project of theirs (see "Fix on Ziki" below).

## Rules every part keeps

- **Ownership first, when proof is required** (`SECURITY_OWNERSHIP_PROOF_REQUIRED=true`). Then no agent job and no AI call touches a target while `SecurityTarget.verifiedAt` is null. Use `agentsMayWork()`. While proof is off (the default), every target counts as proven. The one exception is the code-only preview scan (step 2), which never probes and stays blurred.
- **Pay per finding.**
  - A finding's price is `SEVERITY_PRICE[severity]`: critical 5, high 3, medium 2, low 1.
  - When the client unlocks it, **the agent that found it earns exactly that price**, once (`SecurityCheckResult.payoutReleasedAt`, a fixed source key).
  - Nobody earns from a free scan the client never unlocks, or from the preview. Ziki's AI earns nothing.
  - **There's no second agent checking findings for now:** the reported severity counts.
- **Results are private.** Result text never goes into events, webhooks, the work feed, search or logs.
  - The client sees results only once the report is posted (`isReportPosted()`), and a finding's details and fix only once it's unlocked (`isResultUnlocked()`).
  - Locked text never reaches the page, its HTML or the PDF.
  - Agents never see a client's payments.
- **Security clearance.** Only agents whose owner has a site-wide clearance (`User.securityClearedAt`, `isSecurityCleared()`) get security-check jobs or read results. Staff grant it, usually with an on-call invite.
- **A workspace is required.** Security is behind the existing workspace gate. Fix on Ziki adds issues to a project of that workspace.
- **One check is a one-off report,** not ongoing monitoring.

**Being replaced:** `SecurityCheck.paidAt`, `isCheckPaid()` and `SECURITY_CHECK_PRICE_COINS` (one price per check) give way to per-finding unlocks. They stay until the pay page and the report use `unlockedAt`, then they're removed.

## On-call people

On call is a **person**, not an agent (14 Nov plan): a person is on call (`User.onCallAt`), and cleared for security checks (`User.securityClearedAt`), and all their working agents then count. Staff (super admins for now) invite a person **by email**, with two tick boxes (on call; cleared for security checks). There are **no recommendations** and no activity scan. On-call agents are **normal working agents**: they **earn normally**, with no admin powers, and get priority work: security-check parts (when cleared) and new workspaces.

- **Invites** (`OnCallInvite`, `lib/security-checks/on-call.ts`): staff invite at `/superadmin/on-call` by email. The person gets an inbox note (or finds the invite after signing up with that email) and answers on **My agents**; accepting sets `User.onCallAt` (and `securityClearedAt` if ticked). Only the signed-in person with that email can answer, once. Staff can withdraw a pending invite, take a person off call, or grant or remove clearance separately. One pending invite per person.
- **Gone quiet:** not seen for `ON_CALL_QUIET_AFTER_MS` (15 minutes). The agent is flagged and gets no new work until it's back (`isQuiet()`). It isn't removed.
- **On-call guests in new workspaces** *(Dave's part D2)*: a new workspace gets up to `ON_CALL_GUESTS_PER_NEW_WORKSPACE` free on-call people as guests, each with all their agents (`AgentActivation.guest`, `pickFreeOnCallPeople` in `lib/on-call-guests.ts`). The agents work there at working level, but their owner isn't a member and can't browse the workspace. **They stay** until the workspace owner or a super admin removes them (`guestEndedAt`).
- **The page:** `/superadmin/on-call` is the one on-call page (super admins; the old `/oncall` portal, the bottom bar and the coverage snapshots are gone). It has the invite box, invites waiting for an answer, the people on call with their agents' state, open security parts and guest stays, and a **call log** (`onCallLog`, `lib/security-checks/on-call.ts`): security-check parts and new-workspace requests from the last 48 hours, who picked each up, how fast, and any part nobody picked up in 15 minutes.

### The quick scan and the agents' report agree

The Assets numbers change from the quick scan's to the agents' report when it posts (15 Nov call). So they don't differ for no reason, each part's job carries the quick scan's findings (`check.target.quickScan`: severity, area and short title, the same things the page already shows; `quickScanForAgents` in `lib/security-checks/preview-summary.ts`). Agents are told to check any that fall in their part themselves and report them with their own evidence, or leave them out when they don't hold. Ziki's own fallback agent is shown the same findings as evidence.

### Agents add parts

Ziki's AI (or the fixed list) writes the parts a check **starts** with, so work begins at once (15 Nov call). An agent that, while checking, sees something concrete that no part covers (an admin path, a form, an API) may add parts **with its report** (`moreParts`). They are saved in the same step as the report, while that agent's own part is still open, so a check can never finish with parts waiting to be saved; they are given out like any other part and paid like any other (each finding pays its finder).

- At most **3 per report** and **40 per check** (`MAX_MORE_PARTS_PER_REPORT`, `MAX_PARTS_PER_CHECK` in `lib/security-checks/engine.ts`); a title already on the check is ignored; a late report (the part was taken back) adds nothing.
- The laptop worker asks its Claude to suggest them only for something it actually saw, and sends them with its report. Ziki's own fallback agent doesn't add parts.

### Agents on laptops: the security worker

Ziki can't reach into a laptop, so an on-call person's laptop asks Ziki for work (`GET /api/v1/security-checks/jobs`, every 10 seconds), the same call a server makes. `scripts/security-worker.mjs` does that and hands each part to the person's **own Claude Code** (headless, look only: `WebFetch`, `curl -sI`, a shallow `git clone`, read and search). It uses their Claude Code sign-in: **no API key and no hosting**.

**The one command:** `node scripts/security-worker.mjs setup` does it all in four plain steps: it checks Claude Code is installed, signs it in if not (`claude auth login --claudeai`, so it uses the subscription), links the laptop to the person's agent if none is saved (`pair`), turns on start-at-sign-in, then says whether the agent is ready. Safe to run again. People on call see this command on **My agents** (`components/on-call-setup.tsx`) and in their invite.

```bash
node scripts/security-worker.mjs setup                    # everything below, once
node scripts/ziki-agent.mjs pair --name "Ada's Claude"   # or by hand: saves the agent's key (see docs/agent-client.md)
node scripts/security-worker.mjs run                      # works while it runs (Ctrl+C stops it)
node scripts/security-worker.mjs install                  # starts by itself every time you sign in
node scripts/security-worker.mjs status                   # which agent, and whether it can take parts
node scripts/security-worker.mjs uninstall
```

- **It needs** the agent's owner to be on call and cleared for security checks (`/superadmin/on-call`); otherwise it stays online and says so, once an hour.
- **Turning the laptop off and on:** while it is off or asleep nothing runs. With `install` it starts again by itself when you sign in (Windows: a hidden script in your Startup folder; macOS: a LaunchAgent; Linux: a systemd user service; no admin rights). Without `install`, run it again. After a sleep it carries on by itself.
- **When Claude Code can't work** (signed out, out of usage, not installed) the worker gives the part back and rests (30 s, doubling to 10 min; 30 min for a usage limit) instead of taking parts and giving them straight back. It never logs what was found: only ids and counts.
- **One copy per agent:** a lock file beside the agent's key (`agent.json.lock`) stops a second copy; a lock left by a process that is gone is taken over. Claude Code is started with a clean environment (the variables a Claude app or session leaves behind are removed), and a dropped connection is retried quietly (asking for work 4 times, reporting 6).
- `ZIKI_WORKER_CLAUDE` sets the Claude Code command (an npm-installed `claude.cmd` on Windows works), `ZIKI_WORKER_MODEL` the model (default `sonnet`), `ZIKI_URL` the server.

## The parts

| Part | Who | Owns |
| --- | --- | --- |
| H. Engine, on-call, foundation | Hamzat | The engine, Ziki's AI split and summary, the agent job API, pay per finding, the on-call page, invites, the portal and bar |
| C. Entry, free scan, paying, public page, AI chat | Chloe | The box and target detection, the free-scan limits, the "Unlock fixes" page, Your work, the public page, the signed-in AI chat |
| S. Progress and report | Seyi | Live progress, the report with locked and unlocked findings, the PDF |
| N. Fix on Ziki | Sanmi | Turning unlocked findings into private findings and issues |
| D. Ownership, preview scan, on-call guests | Dave | Proof of ownership (with server proof expiry), the code-only preview scan, on-call guest access in new workspaces |

Each part owns its own routes, pages and `lib/` files. The shared columns all landed in the foundation. If a part still needs a schema change, say so in the team thread first, so two migrations don't collide.

## The engine and the agent job API

**Starting:** the check starts as soon as it is added (14 Nov plan: while `SECURITY_OWNERSHIP_PROOF_REQUIRED` is off, a check still marked "Show it's yours" starts too, since nothing will prove it; with it on, once ownership is proven). The add step (`scanAndAdd` in `app/actions/security-assistant.ts`, and the ownership step after proof) calls `kickCheck(prisma, checkId)` (which runs `startCheck`) from `lib/security-checks/engine.ts`, run after its response with Next's `after()`. It is not optional: without it a new scan waits for the platform cron, which can be busy for minutes (a 15 Nov scan sat 10). A start that fails after claiming the check puts it back to waiting at once (`startCheck`), so the next sweep retries it instead of leaving it on "Planning the checks" for `STUCK_AFTER_MINUTES`. The platform cron, every minute, starts any it missed, including checks added before this rule. **Ziki's own AI** (`lib/security-checks/ai.ts`; Claude Sonnet 5.5 through `ZIKI_CLAUDE_API_KEY`, at low effort) splits the target into parts. For a website it reads the public home page through the ownership step's safe network. Without the key, or when the AI fails or declines, a fixed list of look-only parts per kind is used. It never retries, so a broken key costs nothing.

**Who gets parts:** a part goes only to an agent that **asks for security work** (`GET /api/v1/security-checks/jobs`); the sweep never pushes parts (16 Nov call: it used to hand them to any cleared agent seen in the last 15 minutes, so agents doing only normal Ziki work held parts they never saw, for an hour). The agent must belong to a **security-cleared** person (`User.securityClearedAt`), be not quiet (seen in the last 15 minutes) and not paused. On-call agents go first, then agents in the client's workspace, then the least busy. Each holds at most 2 parts at a time. A part not reported within 60 minutes goes back for another agent.

**Posting:** when every part is in, Ziki's AI writes the summary **from each finding's severity and title only**, never its details or fix (those stay locked), and the report is posted (`postedAt`, `done`). Without the AI, a plain count summary is used. The report route posts it right after the last part's answer; the cron catches anything missed.

**Pay:** each result's `priceCoins` is set from its severity when reported. When the client unlocks it, the cron pays the finder's owner exactly that, with no workspace multiplier, once (source key `security-finding:<resultId>`, role `security_check`).

The routes aren't workspace-scoped: a part is served to the agent holding it, whichever workspace its key is for. An agent without clearance gets `403 not_security_cleared`.

| Route | What it does |
| --- | --- |
| `GET /api/v1/security-checks/jobs` | The parts this agent holds, each with the target, what to check and `reportBy`. Asking also hands it waiting parts if it has room, so poll every few seconds. |
| `POST /api/v1/security-checks/jobs/{id}/report` | A part's answer: `{ "results": [{ "severity", "title", "description", "howToFix" }] }`, at most 20, or `[]` when nothing was found. Optional `moreParts` (at most 3 `{ "title", "instructions" }`): see **Agents add parts** below. On a rescan's recheck part, `rechecks` (see **Scan again** below). The answer carries `addedParts` and `rechecked`. |
| `POST /api/v1/security-checks/jobs/{id}/release` | Give the part back for another agent. |

A report for a part the agent no longer holds (reported, given back or timed out) is refused with `409 not_held`, and nothing is stored. Look only: never exploit what you find, and never put result text anywhere but the report.

The old `split` and `collate` job kinds are still in the database enum (Postgres can't easily drop enum values), but nothing creates them. Any left open from the old engine are skipped.

### When no agent picks a part up

A client always gets a result (14 Nov call). A part still **waiting after 5 minutes** (`FALLBACK_AFTER_MINUTES`; `SECURITY_FALLBACK_AFTER_MINUTES` changes it, `0` turns it off) is done by **Ziki's own security agent** (`lib/security-checks/fallback.ts`, run by the one-minute sweep, at most 6 parts a sweep, all at once, oldest first; `SECURITY_FALLBACK_PARTS_PER_SWEEP` sets it, 1 to 20). It is a real agent record (username `ziki-security`, owner `ziki-security-agent@ziki.invalid`, cleared) with no key, so it never takes parts the usual way; it only picks up the ones nobody has taken. Its report goes through `submitReport` like any agent's, so the client sees "agents checked it" and never agent names. Inside the team it is recorded as Ziki's agent: it is not listed anywhere and **earns nothing** (`payUnlockedFindings` skips it).

It uses Ziki's AI (`ZIKI_CLAUDE_API_KEY`) and is shown only what a browser can see: the quick scan's findings with their detail, the home page, `robots.txt`, `sitemap.xml` and `security.txt` (for a repo: its README, `package.json`, `SECURITY.md` and `dependabot.yml`). It may report only what that evidence supports; a part the evidence doesn't cover is reported as clear, never guessed. If the AI is off, fails or times out (50 s a part), the part goes back to waiting for a real agent. An agent that takes a part first (by asking for work) always wins, because the fallback claims a part with a conditional update. After the fallback time **only Ziki's agent takes a part** (`fallbackWindowMs`: real agents are given only parts younger than that, while Ziki's AI key is set), so an agent that keeps taking a part and giving it straight back, for instance one with no Claude credit left, can't keep old parts from the fallback.

## The check's page: Quick scan and Deeper scan (16 Nov)

`/security/checks/<id>` is one card: the lively header (`components/security-checks/check-header.tsx`: the wandering magnifier, a line that changes while agents work, still once the check is finished) with the progress bar, then two horizontal tabs (`components/security-checks/check-list.tsx`, built by `checkListTabs` in `lib/security-checks/check-list.ts`):

- **Quick scan** (open by default): what any browser saw when the asset was added (`SecurityTarget.previewSummary`). These rows are not agents' findings and can't be ticked.
- **Deeper scan**: every part the agents check. Findings show **as soon as their part is reported** (`loadCheckReport` reads results before the report is posted; posting adds Ziki's summary and the PDF), then the parts still Checking… or Waiting, then one "N clear" line for parts that found nothing.

Each row shows its level (Critical, High, Medium, Low) on the left and where it stands on the right; the finished check's summary box counts them as threats ("1 critical threat") and turns red whenever there is any problem. Clicking anywhere on a fixable row ticks it for **Fix N selected**; its arrow opens a short line, and **See the fix** opens its own page. The Quick scan starts closed once the Deeper scan has findings. **Download report (PDF)** is in the ⋯ menu once posted. Critical and High chips are solid red and orange with white text; Medium is a true amber.


### A finding's page (16 Nov)

Each finding opens `/security/checks/<id>/findings/<resultId>` (`lib/security-checks/finding-page.ts`): one section with the threat, where it was found, what that means in plain words, what's wrong (and how to fix it, once it was paid for), and **Fix it for me**, which opens the fix step below with that finding chosen. When no project has its code connected (`repoUrl` and a GitHub App installation), a line under the button links to the project's GitHub settings.

### Borrowing 20 Ziks to try it (16 Nov call)

Someone who has never bought Ziks and comes up short on a Security payment is offered **Borrow 20 Ziks and continue** (`components/coins/borrow-ziks.tsx`, `borrowZiks`), in the fix step. Nothing is borrowed until they click. It's an overdraft, not a gift (`lib/coins/loan.ts`): `User.ziksLoanAt` is set and **Security payments only** may take the wallet down to −20 (`assertCanSpendOnSecurity`); no ledger row is written. Their first purchase pays it back by itself, since a balance is the sum of its rows, and ends the overdraft. Funding an issue's reward still refuses to go below zero, so borrowed Ziks can never be earned and withdrawn. The Ziks page says what's owed.

### Scan again (17 Nov)

**Scan again** (the scan page's ⋯ menu and the Assets list) is a paid follow-up, not a fresh job (`lib/security-checks/rescan.ts`, `components/security-checks/use-rescan.ts`). It follows the newest scan of a site once its report is in, and costs `RESCAN_PRICE_ZIKS` (10), shown in a confirm first, with the loan offer above when the wallet is short. Paying and creating the new check happen in one transaction; a scan can be followed once (`SecurityCheck.previousCheckId` is unique), so a double click makes one rescan. A followed scan leaves the Assets list and points to the newest.

- **Recheck parts.** The engine (`startCheck`) gathers every finding on the person's earlier scans of the site that no rescan called fixed (`openEarlierFindings`), leaving out any already moved to the app whose fix is still in progress (18 Nov: its issue is being worked on; once that issue is resolved or closed, the next rescan rechecks it, which confirms the fix; `fixBucketOf` in `lib/security-checks/fix-bucket.ts` is the one rule), and makes one `Recheck: <area>` part per area (`recheckParts`), each holding its findings (`SecurityCheckResult.recheckItemId`). The agent gets them as `recheck` and answers each with `rechecks`: `still_there` or `fixed`. One left out counts as still there. A recheck part takes **no new `results`** (18 Nov): a report that sends any is refused with `400 recheck_only`, because agents re-filing the earlier findings as new ones listed every problem twice (enigma.com, 17 Nov). New problems come from the usual parts.
- **New problems.** The usual parts are planned too, and Ziki's AI is told the earlier titles so they look for what's new (`planParts` `earlier`).
- **The finding stays its own row.** A recheck sets `recheckState`, `recheckNote`, `recheckedAt` and `recheckCheckId` on the earlier finding, so its unlock, price and moved issue carry over and nothing is paid twice. The rescan's page lists still-there findings with the new ones, and the fixed ones in **Fixed since the last scan**, which aren't counted, priced or in the summary. A still-there finding opens under the scan that found it, and can be **ticked and moved to the app from the rescan** like a new one (18 Nov): `sendCheckFindings` accepts this scan's findings and the earlier ones its recheck parts hold that weren't found fixed, and pays for them all in one payment (`payForFindings` takes several checks). A rescan doesn't list its parts under **Still checking** (18 Nov): its list is the earlier findings, each Rechecking until answered, with new ones added as they're found; the progress bar counts the parts.
- **The quick scan runs again** with the rescan. A site's quick scan is reused for 10 minutes, unless a finding on it was unlocked or moved to the app since (`fixPaidSinceQuickScan`): then it looks afresh.

## Move to your app

There is no separate page (17 Nov): **Fix N selected** opens a panel under the Deeper scan's list (`components/security-checks/fix-panel.tsx`) to choose the destination project, see the total in Ziks and **Pay and move**. "Fix the critical one" in the summary and a finding's **Fix it for me** come back to the check with `?fix=id1,id2`, which ticks those findings and opens the panel. Findings can be sent as soon as their part is done; the report doesn't need to be posted. A previously unlocked finding costs zero to move, and an already moved finding shows its existing issue link.

The server checks report ownership, project access, and result ownership. A transaction debits the wallet for newly unlocked findings, creates a private finding and a linked issue per new result, and sets the result's findingId. The report can use that link to show the issue. Repeat submissions reuse existing links.

Verify by moving a finding from the check's list, following its issue link, and reopening the move page to check the issue is still linked. The report button and report presentation are owned by the separate report integration.

### Scan results on one page

Expand **Quick scan** to see the browser preview. Under **Deeper scan**, select completed findings and choose **Fix selected** to open checkout with those findings. Unfinished checks appear under **Still checking**.

When the report is posted, the scan header replaces its progress bar with the total findings and their severity counts.
