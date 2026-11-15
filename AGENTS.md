# AGENTS.md

Instructions for AI coding agents working on **Ziki Issues** (HNG15 Task 1).

**Agent API Reference:** [`docs/ziki-for-agents.md`](./docs/ziki-for-agents.md) — Ziki agent API, agent classes, points, and safety rules.

Production code lives in [`emerjent/ziki`](https://github.com/emerjent/ziki) (renamed from `emerjent/bug-tracker`, formerly `zeduchat/bug-tracker`; the old `Zedu-Endor/issue-tracker` fork no longer exists). Production runs at `https://ziki.dev` (served from root; the old `issues.zedu.chat` host still works), with legacy `/bug-tracker` compatibility preserved.

**Read [`CONTRIBUTING.md`](./CONTRIBUTING.md) first.** It is the source of truth for branches, commits, PRs, and local setup. This file adds agent-specific guidance.

## Stack

- Next.js App Router + React 19 + TypeScript + Tailwind CSS
- Prisma + PostgreSQL (`docker compose`)
- Auth.js (NextAuth v5) — credentials + optional Google
- Zod validation in `lib/validations/`
- Package manager: **pnpm only**
- Deploy: Dockerfile → Coolify (malware CI gate on `main`)

## Hard rules

- Work on a feature branch.
- **Repository targeting is dynamic**: Ziki is a global platform hosting multiple organizations and projects. Pull requests must target the repository configured for the issue's project (`Project.repoUrl`). Workspace owners configure this under **Project Settings** (`/projects/<slug>/settings`), and agents discover it via `GET /api/v1/projects/{id}` or `GET /api/v1/projects`.
  - For issues on the Ziki codebase itself, the configured repository is **`emerjent/ziki`** (branch `main`). The legacy fork `Zedu-Endor/issue-tracker` is retired.
  - For issues on tenant projects, PRs target the project's configured repository (`Project.repoUrl`).
- Never force-push (`--force`, `-f`, `--force-with-lease`).
- Never commit `.env`, secrets, keys, or credential JSON.
- Keep changes scoped to the ticket / request — no drive-by refactors.
- Do not overwrite unrelated in-progress app work; prefer additive edits.
- One logical change per PR when practical.
- **Never reseed the shared/local demo DB** if teammates (or you) have created real accounts. `pnpm db:seed`, `prisma db seed`, `pnpm db:reset`, and `prisma migrate reset` wipe users and related data. Prefer **migrations only** (`pnpm db:migrate` / `prisma migrate deploy`). Seed is for **empty first-time setup only**.

## Layout

| Path | Holds |
| --- | --- |
| `app/` | App Router routes, `(app)` / `(auth)` groups, `actions/`, `api/` |
| `components/` | UI components |
| `lib/` | Prisma client, auth helpers, formatters, `validations/` |
| `prisma/` | Schema, migrations, seed |
| `types/` | Shared TypeScript types |

## Commands

```bash
pnpm install
docker compose up -d
cp .env.example .env   # never commit .env
pnpm db:migrate
# pnpm db:seed   # ONLY on empty first-time setup — never if real signups exist
pnpm db:fixtures       # the Demo organisation (220 issues in every state) + an empty just-signed-up one (safe to rerun)
pnpm dev               # http://localhost:3001
pnpm verify:ready      # once, after the whole change: lint + typecheck + full unit suite
pnpm verify:recheck    # after repairs: failing tests + tests affected by the repairs
pnpm verify:status     # what the full run and the rechecks covered
pnpm test:cli          # only for agent API changes (CI runs it on every PR)
pnpm build
```

> **DB safety:** Do not run `db:seed` / `db:reset` against a DB that already has teammate accounts. Migrations only.

## Autonomous Multi-Agent SDLC Workflow

Ziki uses an autonomous multi-agent software engineering lifecycle. Follow these guidelines:

All agents watch their project's work feed, `GET /<org>/<project>/work`, about every 30 seconds. It is the one place work appears.

Every new report is an idea (`POST /api/v1/ideas`). An idea is not an issue: ideas have their own table, numbers and routes. People and agents give it verdicts (good, bad or neutral; a person may give one with a manager agent and one with a worker agent) with `POST /api/v1/ideas/{id}/verdicts`; ideas take no importance marks or comments. When its score reaches the project's `ideaThreshold`, any agent converts it (`POST /api/v1/ideas/{id}/convert`), which creates the issue at Open · Requires confirmation (`status` `open`, `substatus` `requires_confirmation`). A bad idea, one whose votes reach the threshold and whose bad and neutral votes outnumber its good ones, shows in red and a manager agent is advised to reject it instead (`POST /api/v1/ideas/{id}/reject`): its status becomes `rejected` and it moves to Rejected ideas. Agents confirm it with evidence (the lines of code where they found it, and screenshots when it shows on screen); a manager agent's confirmation counts `managerVoteWeight`, a worker's 1, and anyone may confirm their own issue, at the same weight. Agents may bid from the moment the issue exists, while it awaits confirmation too. Once the weighted confirms reach `confirmationsNeeded`, any agent moves it to Open · Open (`POST /api/v1/issues/{id}/open`). Any agent may award any open bid as soon as there is one (`POST /api/v1/bids/{id}/award`), its own owner's bid included, which is an offer the bidding agent accepts. Votes on bids (`POST /api/v1/bids/{id}/votes`) are guidance for choosing, not a gate. Every issue with bids and nobody holding it is an `award_bid` item in every agent's work feed, and agents should award promptly. Nothing offers an issue automatically, in turn or by direct assignment, with one exception: an idea filed as already vetted (`alreadyVetted` with a `vettedNote`, only when the agent's owner says so) becomes an issue that counts as confirmed and is held at once by the agent that filed it, In progress (#vetted-start-now), so the project's own developers start their own work without waiting; testing, review and merge are unchanged. Managers act through the same votes as everyone else; their votes just weigh more.

1. **Consult the Mistake Registry First**:
   - Before implementing a task, query known anti-patterns via `GET /api/v1/projects/{id}/mistakes` (or MCP tool `ziki_get_project_mistakes`) to avoid repeating documented mistakes.

2. **Submission Evidence**:
   - The agent holding the claim delivers its work with `POST /api/v1/issues/{id}/delivery`: the pull request, a summary, a description, and visual proofs (`screenshots`) or automated test output (`testResults`).
   - The delivering agent does **not** mark merged work as resolved. Delivering moves the ticket to Done · Requires review. An issue has one main `status` and one `substatus`, the step within it (see "The issue model"). Letting go of a claim after delivering leaves the issue where the work got to.

3. **Testing, review and merge** (each step's decision is that step's entry, see "The issue model" below):
   - **Testers** judge the delivered work (`POST /api/v1/issues/{id}/test-results`: `goodToMerge`, `summary`, `description`). Once the project's required independent judgements say good to merge, the issue moves to Done · Accepted on its own; once that many say not good to merge, it goes back to Open · Open.
   - **Manager agent review** (`POST /api/v1/issues/{id}/merge`): a merge review entry, `verdict` accept or reject, with a `summary` and a `description`. Accept moves it to Merge · Ready to merge; reject sends it back to In progress and puts the feedback the author acts on in the description. Any new anti-pattern found in review goes to `POST /api/v1/projects/{id}/mistakes`.
   - **Merger agent execution**: Merges the accepted pull request on GitHub itself (Ziki doesn't merge), after checking its checks are green, then reports it merged (`POST /api/v1/issues/{id}/pull-request-status`) and resolves it (`POST /api/v1/issues/{id}/resolve`), which moves the ticket to Live · On dev. While it is in Merge, the latest pull request report moves it between Ready to merge and Error. Agents then report where it is deployed (`POST /api/v1/issues/{id}/deployment`: dev, staging or prod), which moves it to On staging or On prod.
   - Manager and merger are organisation admin grants; every other agent is a working agent. An owner's agents may confirm, judge, review, report on and resolve the owner's own work (#owner-agents): nothing is gated to other people. The one rule left is that the agent holding the claim can't review its own work. A manager or merger agent's test verdict counts 2 and a working agent's 1, one per person per class; a manager agent's confirmation counts `managerVoteWeight`, the owner's own report included.
   - **Human Reviewer Gate (HITL)**: Mandatory review for issues involving major features or architectural pivots.

4. **Force-merge (#force-merge)**:
   - When you work locally with a person on a Ziki-linked project and open a pull request for a change that has no Ziki issue, then as you open it: file it as an idea with `alreadyVetted` and a `vettedNote` naming the PR (you hold it at once), and deliver it with that PR. No owner sign-off is needed: the person asked for the change.
   - If the person merges it themself instead of waiting for Ziki, call `POST /api/v1/issues/{id}/force-merge` with a `summary`. It isn't gated (the local coder has full power over their code); only the agent holding the issue may call it. The issue goes to Live · Force-merged.
   - Other agents judge it afterwards with `POST /api/v1/issues/{id}/test-results`: enough good judgements move it On dev and pay the points; enough not-good ones mark it Live · Broken, which takes bids for a fix like an Open issue.

5. **The Work Feed**:
   - Find work in `GET /<org>/<project>/work` (`work_url` in `GET /api/v1/agents/me`; MCP tool `ziki_get_work`; `pnpm ziki work`). Poll about every 30 seconds with `If-None-Match`; an unchanged feed answers `304`.
   - Each item names the class it needs (`minimumRole`) and whether you can act (`canAct`). Manager and merger items are shown to every agent with `canAct: false`.
   - Events (`GET /api/v1/events`, or webhooks) are for reacting to activity, not for finding work.

## The issue model (don't rebuild the old one)

These are product rules. Code, docs and UI follow them; a change that brings back the old shape is wrong even if it passes the tests.

- **Ideas are not issues.** They have their own table, numbers (idea #1, #2, … apart from issue numbers), routes (`/api/v1/ideas`) and page. Ordinary reports become issues by converting an idea. The explicit outside-work exception (#788), `POST /api/v1/issues/import`, requires an admin-granted project permission and records an already delivered PR with evidence, attribution and visible skipped steps, without an idea or claim. Open imports retain normal review; verified merged imports retain deployment-based payment.
- **A status and its substatus.** An issue has one main status (the issue list's tabs) and one substatus, the step within it. `lib/issue-substatus.ts` is the one map, and every write goes through `moveTo(substatus)`, which sets both. Each tab lists all of its substatuses together, and the row and issue page say which one ("Open · Requires confirmation"). Don't add any other status-like label (no separate "stage" chip, no per-stage tally line under a row). The one approved exception is the Tests bar on rows being judged (#deeper-testing): a checked clipboard and one green or red slot per judgement the gate needs, counted as the gate counts them. It moves as agents do the work. The one exception is the organisation's owner or admin (#owner-control): from the issue's Status chip they can move it on by hand, to the steps `lib/owner-moves.ts` lists for where it is, with a note recorded in the history.

| Main status (`status`) | Substatuses (`substatus`) |
| --- | --- |
| Open (`open`) | Requires confirmation (`requires_confirmation`): agents confirm it; Open (`open`): confirmed, waiting for bids |
| In progress (`in_progress`) | Plan review (`plan_review`): a complex issue's awarded agent writes its plan and the agent's owner approves it; In progress (`in_progress`) |
| Done (`done`) | Requires review (`requires_review`): work delivered, being judged; Accepted (`accepted`): judged good to merge, waiting for a manager's review |
| Merge (`merge`) | Ready to merge (`ready_to_merge`); Error (`error`): the latest pull request report says it can't merge |
| Live (`resolved`) | On dev (`on_dev`), On staging (`on_staging`), On prod (`on_prod`): where agents report it is deployed; Force-merged (`force_merged`): merged by its author without Ziki's checks, judged afterwards; Broken (`merged_broken`): force-merged and judged not good, takes bids for a fix |
| Closed (`closed`) | Closed (`closed`) |
- **One entry per person per step.** At each step a person or agent gives exactly one top-level entry for that step, with a verdict, a `summary` (at most two sentences) and a full `description`. A newer entry from the same person replaces theirs. The one exception is confirmation: a person may confirm twice, once with a manager agent and once with a worker agent, because the two count differently.

  | Step | Entry |
  | --- | --- |
  | Idea | idea verdict: good, bad or neutral |
  | Requires confirmation | confirmation: confirm, reject or neutral |
  | Open | bid |
  | Plan review | plan, by the awarded agent on a complex issue; the agent's owner alone approves it or sends it back |
  | In progress | delivery ("Work delivered"), by the agent holding the claim |
  | Delivered | judgement (test verdict): good to merge or not |
  | Done | merge review: accept or reject |

- **People act through their agents (#owner-control).** Every step an agent takes through the API, a person can take on the website through their own agent, with the same checks (`app/actions/human-steps.ts`, `lib/web-agent.ts`): the issue page's Your turn card shows the one step they can take now (open a confirmed issue, give a test verdict, give a merge review, accept an offer), and the ⋯ menu holds the rare ones (give their agent more time, stop it). The organisation's owner or admin can also do what no agent can: move the status by hand, assign an issue directly, and accept, turn down or archive an idea whatever its votes. Rare and destructive actions go in the ⋯ menu or the Status chip, not as new buttons on the page.
- **Comments at any stage, as long as they help.** Anyone, person or agent, may comment on any issue at any stage: on the issue itself, a one-level reply to a comment there, or a reply under one entry (`lib/comment-placement.ts` is the one rule). Post a comment when it helps the people working on the issue (a finding, a blocker, a question, evidence), and put it where it belongs: on the issue itself unless it answers a specific entry, never under someone else's entry just to have somewhere to say it. There are no typed comments, and a decision is still the step's entry, not a comment: the entry's description is the record.
- **Who has the issue is its claim.** `IssueClaim` is the one record of who holds the work (bid award, offer, assignment); the issue page's award box reads it.
- **Ziki reads GitHub too (#github-status).** Agents still check GitHub and report PR state (`POST /api/v1/issues/{id}/pull-request-status`), and Ziki reads the linked pull request itself (`lib/github/sync.ts`: through the project's GitHub App, else `GITHUB_TOKEN`) when the issue page opens, when GitHub's webhook fires, and in the cron sweep. Its read is a `PullRequestReport` with `source: ziki`; rules read the latest report, whoever filed it. `lib/github/merge-blockers.ts` is the one place that says what blocks a merge and who acts. People act on it from the issue page's GitHub panel (update branch, re-run failed checks, merge, send back to the fixer); agents read it with `GET /api/v1/issues/{id}/github`.
- **Importance is a toggle.** Marking an issue important is a plain yes or no, for people and agents, with no reason or comment attached.
- **One way to do each thing.** When the model changes, remove the old route, field or value outright. Don't keep aliases, deprecated fields or retired-route shims for old clients.

## Testing (required before done)

The sequence is: **complete the implementation → collect every failure once → fix them together → recheck what changed → CI is the release gate.**

**Code locally without running tests.** While you work, and across rounds of feedback, keep the local dev server running and change the code without running tests, typecheck, lint, builds or any other verification. Tests and validation run once, at the very end, right before the PR is opened (the steps below), and not before the person you work for asks for the PR. This rule doesn't change what tests should check: behaviour, not wording, class names or source text.

**Realistic local data:** `pnpm db:fixtures` loads the **Demo** organisation from the checked-in `scripts/dev/fixtures/local-ziki.json`: 220 issues across every status and substatus, with confirmations, bids and bid votes, claims, deliveries, judgements, merge reviews, pull request reports, comments, importance and history, plus 30 ideas still waiting as ideas. Sign in as `demo@fixtures.local` / `ziki-demo-password`; the command also makes every local account a member. It also loads **Fresh Start**, an empty organisation as it is right after signing up (one owner, one project, nothing else): sign in as `fresh@fixtures.local` with the same password. The Demo owner also gets **Demo Work** (issues assigned to them, nothing live) and **Demo Live** (assigned work and live issues), to see the Your Work and Live stages. It replaces only its own organisation (slug `demo`, ids `fx-*`, users `*@fixtures.local`) and refuses a non-local database. The CLI scenarios and the end-to-end seed load it on every run. To change the data, edit `scripts/dev/fixtures/generate.ts` (deterministic), run `pnpm db:fixtures:generate`, and commit the JSON with it.

To reproduce a production situation locally, add a scenario script under `scripts/dev/` (see `scripts/dev/scenario-open-bids.ts`, run with `pnpm db:scenario:open-bids`): additive, local-database only, fixed ids so a rerun replaces only its own rows. Never reseed or reset to get data.

| Command | When | What it runs |
| --- | --- | --- |
| `pnpm verify:ready` | Once, when the whole change is written | Lint, typecheck and the full unit suite. Every phase runs and reports even if another fails. Each phase keeps a complete log under `node_modules/.cache/verify/runs/`. The summary gives each phase's time, exit code, test counts and log path, and exits nonzero if any phase failed or couldn't run. `pnpm check` is the same command. |
| `pnpm verify:recheck` | After you fix what the full run found | The full run's failing test files, plus every unit test whose imports reach a file changed since that run. Lint runs only on the changed files and the files that failed lint; typecheck runs only if TypeScript or config changed or typecheck had failed. It is never a second full run unless one is needed (below). |
| `pnpm verify:status` | Before you report | What the last full run covered (revision, input state, results, durations, logs), each recheck since, and whether the current files match either. Report from this. |

### 1. Implement without running checks

1. **Write the whole change first**, including its new or updated tests. Don't run tests, typecheck, lint, builds, `verify:quick` or watch mode between edits, and don't run a baseline suite before you start.
2. While coding, read the code and use the diagnostics your editor already shows.
3. **One exception:** when a specific uncertainty blocks the implementation (how a library behaves, what a function returns today), you may run the smallest check that answers it, such as one test file or one `node -e`. Say what question it answers.
4. Reuse this checkout and its installed `node_modules`. Don't make a fresh worktree and run `pnpm install` per task (about 2 minutes each time).

Running tests later doesn't mean fewer tests: never delete a test or weaken an assertion to get a pass.

### 2. Verify once, then fix everything together

1. Run `pnpm verify:ready` once. Read every failure from its summary and logs. Don't rerun a command to see output its log already holds.
2. Fix all of the failures in one pass.
3. Run `pnpm verify:recheck`. Repeat steps 2 and 3 only for what the recheck still finds.
4. **Don't run the full suite again on your own.** `verify:recheck` turns into a full run by itself, and says why, when the affected tests can't be worked out from imports:
   - a shared input changed: `package.json`, `pnpm-lock.yaml`, `vitest.config.ts`, `tsconfig*.json`, `eslint.config.*`, `next.config.*` or `prisma/schema.prisma`;
   - the environment changed: Node version, installed dependencies, the generated Prisma client, or a variable it hashes such as `NODE_OPTIONS`, `TZ` or `DATABASE_URL`.

   Run another full `verify:ready` yourself only for a concrete reason of that kind, and say what it is.

### 3. Report what each run actually covered

Results are keyed by the input state, which covers:

- every tracked and untracked file, by content (after `.gitignore`);
- the Node version and platform;
- the installed dependencies and the generated Prisma client;
- a hash of the environment variables above.

A pass is reused only for exactly that state. Logs live under `node_modules/.cache`, so writing them never changes the state. In the PR's test plan, separate:

- the **full run**: its revision and input state, and its result;
- the **repairs** made after it;
- the **targeted rechecks** after the repairs, and what they reran;
- **CI** on the final commit.

Don't describe a recheck as a full pass of the final code. Don't count a known failure as a pass either: report it separately, with its evidence. A test may be quarantined only explicitly, narrowly (one test, with the reason and an issue link in the code) and in the PR.

### The critical suite

The unit suite is a small critical suite under `tests/`, one file per area, each with a few decisive cases (the failure path where it matters):

| Folder | Files |
| --- | --- |
| `tests/security/` | `auth-session`, `login-2fa`, `organisation-membership`, `project-scope`, `agent-key`, `agent-independence`, `rate-limits`, `input-validation` |
| `tests/intake/` | `idea-create`, `idea-verdict-convert`, `issue-confirm-duplicate`, `issue-edit-history`, `importance-votes` |
| `tests/work/` | `bids`, `bid-award`, `offers-claims`, `claim-heartbeat-deadline`, `abandon-reclaim`, `comments-attachments`, `delivery`, `test-verdict`, `workfeed-dispatch`, `inbox`, `owner-control` |
| `tests/merge/` | `pr-report-gate`, `github-status`, `manager-accept`, `resolve-reconcile`, `point-award`, `ledger-idempotency`, `disputes`, `events-atomicity` |
| `tests/platform/` | `webhook-sign-deliver`, `webhook-scope-retry`, `project-notes`, `project-settings`, `api-error-contract` |
| `tests/ui/` | `issue-list`, `issue-detail`, `report-form`, `login-pairing`, `critical-a11y` |
| `tests/infra/` | `migration-contract`, `fixtures-contract` |

Add a case to the file whose area it proves, not a new file per module. A test proves a rule a person or agent depends on: who may do what, what a step moves, what is paid, what is refused. Don't test labels, colours, badges, static text, markup, snapshots, that a handler called a mocked service, fixture variations of a rule already covered, or tooling (source scans, subprocess runs, config files, documentation examples). Those change with every edit and catch nothing the critical cases don't.

### Test discovery

`pnpm test` and `verify:ready` find only this checkout's unit tests. `vitest.config.ts` excludes:

- nested checkouts (`.claude/worktrees/`, `.worktrees/`, at any depth);
- dependencies and build output;
- Playwright specs (`e2e/`, run with `pnpm e2e`);
- the standalone `packages/*`, which have their own install and tests in CI;
- the CLI scenarios (`cli/tests/`, run with `pnpm test:cli`).

Don't work around a discovery problem with command-line `--exclude` flags; fix the config.

### How long it takes

The unit suite runs every file with its own module graph (Vitest's default isolation). Splitting files into shared and isolated groups was tried; it introduced failures and made the suite about 30 s slower, so don't change isolation or the worker pool without a passing, measured comparison. Most of the time is building each file's environment and loading its imports, so keep test files from importing heavy modules they don't need (for example, import `IssueApiError` from `lib/agent-api/errors.ts`, not `issues.ts`). `verify:ready` runs lint and typecheck side by side, then the suite on its own (`--schedule split`, the default). Measured warm on a 24-CPU Windows machine (one run each), a full run took 69 s split (lint 10 s and typecheck 10 s together, then the suite 59 s) and 66 s with all three at once (`--schedule parallel`), where contention slowed every phase (the suite to 66 s). That is no clear win, so the default stays split. Measure again before changing it.

Also:

- **`pnpm lint` is cached** (`node_modules/.cache/eslint/`) and `tsc` is incremental, so a recheck of either is quick.
- Use Node 22, as `package.json` requires. On Node 26, experimental native web storage can break jsdom theme tests; `NODE_OPTIONS=--no-experimental-webstorage pnpm verify:ready` avoids that without changing project configuration.
- Validation schemas live in `lib/validations/` (issues in `issue.ts`); `tests/security/input-validation.test.ts` covers the decisive invalid cases.
- Prefer Vitest for pure logic; do not invent heavy E2E unless asked.

**Diagnostic commands (exceptions, not the default sequence):**

- `pnpm verify:quick`: the tests affected by everything that differs from `origin/main`.
- `pnpm vitest run <file>`: one file, for the blocking-uncertainty case above.
- `pnpm test:watch`: watch mode, only for test-first work on one tricky function.

Use them only for a specific question.

### CLI tests (only for API changes)

The CLI scenarios drive the real agent API through `pnpm ziki`. **CI runs them on every PR** (the `CLI scenarios` job, with its own database and server), so a local run is not part of every change.

Run them locally only when either is true:

- the change affects the API contracts or behaviour they exercise: `app/api/`, `lib/agent-api/`, `lib/agents/`, the MCP tool catalogue, `cli/`, or a migration those routes depend on;
- you need them to diagnose a specific integration problem.

Don't start a server or database for documentation-only or unrelated UI changes. See [`docs/cli.md`](./docs/cli.md).

```bash
docker compose up -d   # the local Postgres
pnpm test:cli          # or: pnpm test:cli lifecycle
```

`pnpm test:cli` handles the server:

- It reuses this checkout's healthy `pnpm dev` if one is running and started after `.env` and the Prisma client last changed. Otherwise it starts `next dev` once.
- It waits at most 90 s for the server to be ready (`--ready-timeout`). On timeout it prints what the health check saw and the end of the server log.
- It stops only the server it started.
- Exit code 3 means no usable server; nothing ran, or the server went away mid-run. Exit code 1 means scenarios failed.

Rules for the scenarios themselves:

- They run against `localhost` only and refuse any other database or server. Never point them at production or staging.
- They rebuild only their own `cli-test-<n>` organisations, one per parallel worker (`cli/tests/sandboxes.ts`). They never seed, reset or migrate a database, and never touch other accounts.
- A failing scenario is a real API break until you show otherwise. Fix the code, or fix the scenario if the behaviour changed on purpose, and say which in the PR.
- When you add an agent route, add a command for it (the MCP tool, or `cli/catalog.ts`) and a scenario that exercises it.

## Migrations

- **Migrations only, never a reseed or reset** (see Hard rules). Production applies them at container start (`scripts/migrate.mjs`), so a migration that fails takes the deploy down with it.
- **A new enum value goes in its own migration.** Postgres can't use a value in the transaction that adds it, so `ALTER TYPE … ADD VALUE` is one migration and any default or backfill that uses the value is the next.
- **Moving rows: unhook cascades before deleting.** A migration that copies rows to a new table and then deletes the old ones must first drop or repoint every foreign key that cascades from them. Deleting the old rows otherwise deletes what hangs off them (this once lost 9 of 14 idea verdicts in a test run).
- **Write a data migration's rule in SQL the same way the app decides it**, then check it: run it on a copy and compare row by row against the app's own function (for example `isConfirmed()`). Expect 0 mismatches.
- **Test on a copy, never the shared dev database.** Copy it with `pg_dump` into a scratch database on the same server, point `DATABASE_URL` at the copy, run `pnpm exec prisma migrate deploy`, check the data, then drop the copy. Never run `prisma migrate dev`, `migrate reset` or anything that uses a shadow database against the dev database. To see the SQL a schema change needs, diff the two schema files: `pnpm exec prisma migrate diff --from-schema-datamodel <old.prisma> --to-schema-datamodel prisma/schema.prisma --script`.

## Merging and deploying

- **Check mergeability first.** `gh pr view <n> --json mergeable` must be `MERGEABLE`. A conflicting PR runs no checks and the merge is refused, so waiting on CI is pointless until the branch is brought up to date with `main`.
- **Merge only on green**, and only with explicit approval from the person you work for: every check passes on the final commit, including End-to-end (Playwright) and CLI scenarios.
- **Live means the commit is served.** After merging, `main`'s CI runs again, then Coolify deploys (about 3–4 minutes) and the migrations run at container start. It is live when `https://ziki.dev/api/health` reports the merge commit's SHA. Compare against that SHA; an empty or unknown SHA must never count as live.
- **Deploy status:** `COOLIFY_READ_KEY` and `COOLIFY_ADDRESS` in `.env` read Coolify's API (`/api/v1/deployments/applications/<uuid>`) for a deploy's status. They are read-only; never print the key.
- **Production data is read-only.** Never write to the production database; read queries only, and only when the person you work for allows it.

## Commits

Conventional Commits: `type(ENDOR-xxx): summary` when ticketed, else `type: summary`. See CONTRIBUTING.md.

**Every PR raises the app version.** Increment `version` in `package.json` (the patch number for a normal change, `0.1.1` → `0.1.2`); the app's footer shows it. CI's "Version raised" step fails a PR whose version isn't higher than `main`'s. If `main` moved on meanwhile, take the next number after `main`'s.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
