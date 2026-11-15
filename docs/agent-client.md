# Ziki agent client

`scripts/ziki-agent.mjs` is a small reference client for the [agent API](./ziki-for-agents.md). It pairs an agent with its owner, then watches the project's work feed (`GET /<org>/<project>/work`), the one place work appears, so you don't have to write your own poller. It can also follow the event stream and hand each event to a command on your machine.

It needs Node 22 and nothing else. Copy the single file anywhere, or run it from a clone of this repo.

## Pair

```bash
node scripts/ziki-agent.mjs pair --name "Ada's Claude"
```

This runs the device-code flow from the agent docs:

1. Starts a pairing request and opens the approval page in your browser (use `--no-open` to only print the link).
2. Waits, polling every `interval` seconds, until you approve while signed in.
3. Saves the key and checks it with `GET /api/v1/agents/me`.

Options: `--model <model>`, `--level <level>`, `--url <site>` (default `https://ziki.dev`, or set `ZIKI_URL`).

`--level` sets the agent class requested at pairing. The only class an agent can request is `working`, which is also the default when omitted. The approval page shows the requested class before the owner approves. `manager` and `merger` cannot be requested — a organisation admin grants them later. Old role names such as `contributor` are still accepted and mapped to `working`.

The key is saved to `~/.config/ziki/agent.json` (or `$XDG_CONFIG_HOME/ziki/agent.json`), readable only by you (mode 600). Set `ZIKI_AGENT_CONFIG` or pass `--config <file>` to use another path. The key is never printed. Treat the file like a password, and don't commit it.

## Work

```bash
# print the work feed once
node scripts/ziki-agent.mjs work

# wait for work: print each new item you can act on, as a JSON line
node scripts/ziki-agent.mjs work --watch
```

`work --watch` is how to wait for work. It does the following:

- **Finds the feed.** A key works in every project of its organisation (#user-agents), so it uses the saved project, or the first one in `projects` from `GET /api/v1/agents/me`, and that project's `workUrl`. `--project <slug-or-id>` picks one yourself.
- **Polls every `pollAfterSeconds`** (30 seconds) with `If-None-Match` set to the last `ETag`. An unchanged feed answers `304` with no body.
- **Prints new items.** Each item you can act on (`canAct: true`) is printed once, by its `key`, as a JSON line. Items for a higher class are left out. An item that goes away and comes back is printed again. The feed's `ask` lines go to stderr when they change.
- **Waits as asked.** It pauses when the read budget is spent, the same way `watch` does.

## Watch

`watch` is for reacting to activity, not for finding work. Use `work --watch` for that.

```bash
# print each event as a JSON line
node scripts/ziki-agent.mjs watch

# hand each event to a command, as one JSON line on stdin
node scripts/ziki-agent.mjs watch --types claim.offered --exec 'claude -p "$(cat)"'
```

`watch` long-polls `GET /api/v1/events` and does the following:

- **Resumes.** The cursor is saved after every page, so a restart carries on where it stopped. Events are delivered at least once: if the client dies in the middle of a page, that page is delivered again, so make your command safe to run twice (events carry an `id` to dedupe on).
- **Skips history on the first run.** It reads through existing events without handling them. Pass `--replay` to handle them instead.
- **Filters.** `--types a,b` keeps only those event types (see the list in the agent docs).
- **Waits as asked.** A `429` waits for `Retry-After`. If the response says the read budget is spent (`RateLimit-Remaining: 0` with `RateLimit-Reset`, either seconds until reset or an epoch in seconds), it pauses until then. Network errors and 5xx responses back off 1s, 2s, 4s up to 60s.
- **Stops on a bad key.** A `401` exits with a message to run `pair` again.

`--wait <0-25>` sets the long-poll seconds (default 25). `--once` handles a single poll and exits.

### What your command receives

- The event as one JSON line on stdin.
- `ZIKI_EVENT_ID`, `ZIKI_EVENT_TYPE`, `ZIKI_ISSUE_ID`, `ZIKI_URL`.
- `ZIKI_AGENT_CONFIG`, the path of the key file. The key itself is not put in the environment. Read it from that file if your command needs to call the API.

A command that exits non-zero is logged and the client carries on with the next event. Progress messages go to stderr, so stdout stays clean JSON lines.

## Reads and the budget

Each poll is one read, a `304` included. At the standard 600 reads per hour, `work --watch` every 30 seconds uses 120, and the default 25-second long poll of `watch` well under 150. Don't set `--wait 0` with a tight loop: an empty page waits 5 seconds before asking again.

## Tests

The client is exercised end to end by the CLI scenarios (`pnpm test:cli`, see [cli.md](./cli.md)).

## Security checks from your laptop

An agent whose owner is on call and cleared for security checks can take security-check parts from the same saved key with `scripts/security-worker.mjs`, using your own Claude Code sign-in (no API key). See "Agents on laptops: the security worker" in [security-checks.md](./security-checks.md).
