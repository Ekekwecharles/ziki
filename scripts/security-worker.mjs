#!/usr/bin/env node
/**
 * security-worker: your own agent does security-check parts from your laptop.
 *
 *   node scripts/security-worker.mjs setup     (once: checks Claude Code, links your agent, starts at sign-in)
 *   node scripts/security-worker.mjs run       (works while it runs; setup turns this on for you)
 *   node scripts/security-worker.mjs status    (is it set up, and what is it saying)
 *
 * Ziki can't reach into a laptop, so the laptop asks Ziki for work every few
 * seconds (the same call an always-on server makes). A part arrives, your own
 * Claude Code does it (headless, look only), and the findings go back. It uses
 * your Claude Code sign-in, so there is no API key and no hosting. When the
 * laptop sleeps or shuts down it stops; when it wakes or you sign in again, it
 * carries on (with `install`, with nothing for you to type).
 *
 * Needs the agent to belong to a person who is on call and cleared for security
 * checks (/superadmin/on-call). Results stay on your machine and in Ziki: the
 * logs never say what was found, only ids and counts. See docs/security-checks.md.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path, { posix as nodePath_posix, win32 as nodePath_win32 } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ApiError, DEFAULT_URL, api, configPath, loadConfig, makeContext, pair } from "./ziki-agent.mjs";

const SEVERITIES = new Set(["critical", "high", "medium", "low"]);

/** Ask Ziki for work this often (seconds). Asking is free; each call also keeps the agent showing online. */
export const POLL_SECONDS = 10;
/** A part not reported in this long is given back (Ziki takes it back itself after 60 minutes). */
export const JOB_TIMEOUT_MS = 25 * 60 * 1000;
/** Look only: read pages, headers, shallow clones and files. Nothing else. */
export const ALLOWED_TOOLS = ["WebFetch", "Bash(curl -sI:*)", "Bash(git clone --depth 1:*)", "Read", "Grep", "Glob"].join(",");

export const RULES = `You are a Ziki security agent. Rules you must follow:
- LOOK ONLY. Never exploit anything, never log in, never submit forms, never send anything but GET or HEAD requests, never try passwords, never load-test.
- Only look at the target you are given and pages it links to on the same site.
- Never print or repeat secrets you come across; describe them ("an API key is visible in /app.js") instead.
- Write for a non-technical owner: plain words, short.`;

/** What the agent is asked for one part. */
export function checkPrompt(job) {
  return `${RULES}

Target (${job.check.target.kind}): ${job.check.target.value}
Part to check: ${job.title}
${job.instructions || ""}

Check only this part. Report real problems you can see evidence for. If you find nothing, return an empty list.
Severity: critical (anyone can take over accounts, read others' data or run code), high (a signed-in user reaches what they shouldn't, or secrets exposed), medium (a real weakness needing extra conditions), low (hardening, like a missing header).

Reply with ONLY this JSON, nothing else:
{"results":[{"severity":"high","title":"short title","description":"what is wrong and where, in plain words","howToFix":"what to change"}]}`;
}

/** The first JSON object in a reply. */
export function extractJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON in the reply");
  return JSON.parse(text.slice(start, end + 1));
}

const clip = (value, max) => String(value ?? "").trim().slice(0, max);

/** The findings Ziki will accept: a known severity, a title, and a description and fix of some substance. */
export function cleanResults(reply) {
  return (reply.results || [])
    .map((r) => ({
      severity: String(r.severity || "").toLowerCase(),
      title: clip(r.title, 200),
      description: clip(r.description, 10_000),
      howToFix: clip(r.howToFix, 10_000),
    }))
    .filter((r) => SEVERITIES.has(r.severity) && r.title.length >= 3 && r.description.length >= 10 && r.howToFix.length >= 10)
    .slice(0, 20);
}

const MINUTE = 60_000;

/**
 * How long to rest after Claude Code failed on this many parts in a row, so a
 * signed-out or out-of-usage Claude doesn't take parts and give them straight back
 * in a loop: 30 s, 1 m, 2 m ... never more than 10 minutes. A usage limit waits longer.
 */
export function restAfterFailures(failures, message = "") {
  if (failures <= 0) return 0;
  if (/limit|quota|usage|credit|overloaded/i.test(message)) return 30 * MINUTE;
  return Math.min(10 * MINUTE, 30_000 * 2 ** (failures - 1));
}

/** One argument as a Windows command line needs it, for a `.cmd` launcher (which only runs through the shell). */
export function quoteForCmd(arg) {
  return /[\s()&|<>^%"]/.test(arg) ? `"${arg.replaceAll('"', '\\"')}"` : arg;
}

/**
 * The settings a Claude app or Claude Code session leaves in the environment (so a
 * program it starts is treated as its child, with its login and proxy). A worker that
 * was started from one of those sessions would then fail to sign in, so the Claude Code
 * the worker starts gets a clean environment. A person's own ANTHROPIC_API_KEY stays.
 */
export function cleanClaudeEnv(env = process.env) {
  const clean = { ...env };
  for (const key of Object.keys(clean)) {
    if (
      key === "CLAUDECODE" ||
      key === "CLAUDE_PID" ||
      /^CLAUDE_(CODE|AGENT_SDK|PREVIEW)_/.test(key) ||
      key === "USE_LOCAL_OAUTH" ||
      key === "USE_STAGING_OAUTH" ||
      key === "ANTHROPIC_BASE_URL"
    ) {
      delete clean[key];
    }
  }
  return clean;
}

/** What went wrong with Claude Code, from its own words: signed out, out of usage, or something else. */
export function claudeProblem(text) {
  if (/failed to authenticate|oauth session expired|not logged in|please run \/login|invalid api key|authentication/i.test(text)) return "not_signed_in";
  if (/limit|quota|usage|credit|overloaded/i.test(text)) return "usage_limit";
  return "other";
}

/** Claude Code's failure in plain words (what to do, not the raw error). */
export function friendlyClaudeFailure(raw) {
  const text = String(raw ?? "");
  const problem = claudeProblem(text);
  if (problem === "not_signed_in") return "Claude Code isn't signed in on this computer. Run: node scripts/security-worker.mjs setup";
  if (problem === "usage_limit") return `Claude Code says you're out of usage for now (${text.slice(0, 120)})`;
  return `Claude Code failed: ${text.slice(0, 200)}`;
}

/** The message in Claude Code's JSON output when it reports an error, else the text as it is. */
function claudeMessage(out, err) {
  try {
    const parsed = JSON.parse(out);
    if (parsed && parsed.is_error) return String(parsed.result ?? "");
  } catch {
    /* not JSON: use the text */
  }
  return (err || out || "").trim();
}

/** Starts Claude Code with a clean environment. An npm-installed `claude.cmd` on Windows only runs through the shell. */
export function spawnClaude(args, { command = process.env.ZIKI_WORKER_CLAUDE || "claude", cwd, stdio = ["pipe", "pipe", "pipe"] } = {}) {
  const viaShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
  const env = cleanClaudeEnv();
  // Through the shell it is one quoted command line (Node warns about passing separate arguments with a shell).
  return viaShell
    ? spawn([command, ...args].map(quoteForCmd).join(" "), { cwd, env, stdio, shell: true })
    : spawn(command, args, { cwd, env, stdio });
}

/** Runs Claude Code headless in a scratch folder (the prompt on stdin) and returns its final text. */
export async function runClaude(prompt, { command = process.env.ZIKI_WORKER_CLAUDE || "claude", model = process.env.ZIKI_WORKER_MODEL || "sonnet", maxTurns = "25", timeoutMs = JOB_TIMEOUT_MS } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ziki-job-"));
  try {
    return await new Promise((resolve, reject) => {
      const args = ["-p", "--output-format", "json", "--model", model, "--max-turns", maxTurns, "--allowedTools", ALLOWED_TOOLS];
      const child = spawnClaude(args, { command, cwd: dir });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.on("error", (error) =>
        reject(new Error(error.code === "ENOENT" ? "Claude Code isn't installed or isn't on your PATH (set ZIKI_WORKER_CLAUDE to its full path)" : error.message)),
      );
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error(friendlyClaudeFailure(claudeMessage(out, err))));
        try {
          const parsed = JSON.parse(out);
          if (parsed.is_error) return reject(new Error(friendlyClaudeFailure(String(parsed.result))));
          resolve({ text: String(parsed.result ?? ""), cost: parsed.total_cost_usd });
        } catch {
          reject(new Error("Claude Code's output was not JSON"));
        }
      });
      child.stdin.on("error", () => {});
      child.stdin.end(prompt);
    });
  } finally {
    // On Windows the folder can stay locked for a moment after Claude Code exits. Clearing it up must never lose the
    // result (or turn a finished part into a failed one), so try a few times and then leave it to the system's temp cleanup.
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => {});
  }
}

/**
 * One part: do it with Claude Code and report it, or give it back if that fails.
 * Never logs what was found.
 * @returns {Promise<{ ok: boolean, message?: string }>}
 */
export async function doJob(ctx, config, job, deps = {}) {
  const run = deps.runClaude ?? runClaude;
  try {
    const { text, cost } = await run(checkPrompt(job));
    const results = cleanResults(extractJson(text));
    const res = await api(ctx, config.url, `/api/v1/security-checks/jobs/${job.id}/report`, { method: "POST", body: { results }, key: config.apiKey, retries: 6 });
    ctx.log(`part ${job.id}: ${results.length} findings reported (HTTP ${res.status})${cost != null ? `, $${Number(cost).toFixed(3)}` : ""}`);
    return { ok: true };
  } catch (error) {
    const message = /** @type {Error} */ (error).message;
    ctx.log(`part ${job.id} failed (${message.slice(0, 160)}); giving it back`);
    try {
      await api(ctx, config.url, `/api/v1/security-checks/jobs/${job.id}/release`, { method: "POST", key: config.apiKey, retries: 3 });
    } catch (releaseError) {
      ctx.log(`couldn't give ${job.id} back (${/** @type {Error} */ (releaseError).message}); Ziki takes it back by itself after 60 minutes`);
    }
    return { ok: false, message };
  }
}

/**
 * One round: ask for work and do what comes. Returns how long to wait before the
 * next round.
 * @param {import("./ziki-agent.mjs").Context} ctx
 * @param {{ url: string, apiKey: string }} config
 * @param {{ failures: number, lastNote: string }} state kept between rounds
 */
export async function tick(ctx, config, state, deps = {}) {
  const pollMs = (deps.pollSeconds ?? POLL_SECONDS) * 1000;
  let response;
  try {
    // Some laptops' connections to the server drop now and then ("fetch failed": a connection reset, or one kept open
    // between two polls that the proxy closed). Another try uses a new connection, so retry a few times, quietly.
    const quiet = { ...ctx, log: () => {} };
    response = await api(quiet, config.url, "/api/v1/security-checks/jobs", { key: config.apiKey, retries: 4 });
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 0;
    const code = error instanceof ApiError ? error.body?.error : undefined;
    if (status === 403 && ["not_security_cleared", "not_on_call", "not_always_on"].includes(code)) {
      note(ctx, state, "online, but this agent's owner isn't on call and cleared for security checks yet (ask staff at /superadmin/on-call)");
      return 60_000;
    }
    if (status === 403 && code === "profile_incomplete") {
      note(ctx, state, "this agent's profile is incomplete (tagline, About me and a skill); finish it on Ziki");
      return 60_000;
    }
    if (status === 401) throw error;
    note(ctx, state, `couldn't ask Ziki for work (${/** @type {Error} */ (error).message.slice(0, 120)})`);
    return Math.max(pollMs, 30_000);
  }

  const jobs = response.data?.jobs ?? [];
  if (jobs.length === 0) {
    note(ctx, state, "online; no parts right now");
    return pollMs;
  }
  ctx.log(`${jobs.length} part(s) to check`);
  for (const job of jobs) {
    const done = await doJob(ctx, config, job, deps);
    if (done.ok) {
      state.failures = 0;
    } else {
      state.failures += 1;
      // Claude Code isn't working right now (signed out, out of usage): rest rather than keep taking parts.
      return restAfterFailures(state.failures, done.message);
    }
  }
  return 1000;
}

/** Say something once an hour at most, so a quiet worker's log stays readable. */
function note(ctx, state, message) {
  const at = ctx.now();
  if (state.lastNote !== message || at - (state.lastNoteAt ?? 0) > 60 * MINUTE) {
    ctx.log(message);
    state.lastNote = message;
    state.lastNoteAt = at;
  }
}

/**
 * Only one worker per agent runs at a time (running `setup` or `install` again must not
 * start a second copy). The lock file holds the running copy's process id; a lock left by a
 * process that is gone is taken over. Returns false when another copy is running.
 */
export function acquireLock(file, { pid = process.pid, alive = (other) => { try { process.kill(other, 0); return true; } catch { return false; } } } = {}) {
  if (existsSync(file)) {
    const other = Number(readFileSync(file, "utf8").trim());
    if (Number.isInteger(other) && other > 0 && other !== pid && alive(other)) return false;
  }
  writeFileSync(file, String(pid));
  return true;
}

/** Runs until stopped. */
export async function runWorker(ctx, config, options = {}) {
  if (options.lockFile) {
    if (!acquireLock(options.lockFile)) {
      ctx.log(`Another copy of the worker is already running for "${config.name ?? "this agent"}", so this one stops.`);
      return;
    }
    process.on("exit", () => {
      try {
        unlinkSync(options.lockFile);
      } catch {
        /* already gone */
      }
    });
  }
  const state = { failures: 0, lastNote: "", lastNoteAt: 0 };
  let stopping = false;
  const stop = () => {
    stopping = true;
    ctx.log("stopping after the current part");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  ctx.log(`security worker running as "${config.name ?? "your agent"}" on ${config.url}; asking for work every ${options.pollSeconds ?? POLL_SECONDS}s`);
  while (!stopping) {
    let wait;
    try {
      wait = await tick(ctx, config, state, options);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        ctx.log(error.message);
        return;
      }
      ctx.log(`round failed: ${/** @type {Error} */ (error).message}`);
      wait = 30_000;
    }
    if (!stopping) await ctx.sleep(wait);
  }
  ctx.log("stopped");
}

// ---------------------------------------------------------------------------
// Starting by itself when you sign in

const SERVICE_ID = "dev.ziki.security-worker";

/**
 * What it takes to start the worker at sign-in on each system, as data: the files
 * to write and the commands to run (and the same to undo it). Nothing needs admin
 * rights: Windows uses your Startup folder, macOS a LaunchAgent, Linux a systemd user service.
 * @param {{ platform?: string, nodePath?: string, scriptPath: string, home?: string, appData?: string, logFile?: string }} options
 */
export function installPlan({ platform = process.platform, nodePath = process.execPath, scriptPath, home = os.homedir(), appData = process.env.APPDATA, logFile }) {
  // Paths are written the way the target system writes them, whatever system this runs on.
  const path = platform === "win32" ? nodePath_win32 : nodePath_posix;
  const log = logFile ?? path.join(home, ".config", "ziki", "security-worker.log");
  if (platform === "win32") {
    const startup = path.join(appData ?? path.join(home, "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "ziki-security-worker.vbs");
    // A hidden window: no console to close by mistake.
    const command = `cmd /c ""${nodePath}" "${scriptPath}" run >> "${log}" 2>&1"`;
    const content = `CreateObject("WScript.Shell").Run "${command.replaceAll('"', '""')}", 0, False\r\n`;
    return { log, files: [{ path: startup, content }], start: [["wscript.exe", [startup]]], undoFiles: [startup], stop: [] };
  }
  if (platform === "darwin") {
    const plist = path.join(home, "Library", "LaunchAgents", `${SERVICE_ID}.plist`);
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_ID}</string>
  <key>ProgramArguments</key><array><string>${nodePath}</string><string>${scriptPath}</string><string>run</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`;
    return { log, files: [{ path: plist, content }], start: [["launchctl", ["load", "-w", plist]]], undoFiles: [plist], stop: [["launchctl", ["unload", "-w", plist]]] };
  }
  const unit = path.join(home, ".config", "systemd", "user", "ziki-security-worker.service");
  const content = `[Unit]
Description=Ziki security worker

[Service]
ExecStart="${nodePath}" "${scriptPath}" run
Restart=on-failure
RestartSec=30
StandardOutput=append:${log}
StandardError=append:${log}

[Install]
WantedBy=default.target
`;
  return {
    log,
    files: [{ path: unit, content }],
    start: [["systemctl", ["--user", "daemon-reload"]], ["systemctl", ["--user", "enable", "--now", "ziki-security-worker.service"]]],
    undoFiles: [unit],
    stop: [["systemctl", ["--user", "disable", "--now", "ziki-security-worker.service"]]],
  };
}

function runQuietly(command, args) {
  return new Promise((resolve) => {
    const detached = command === "wscript.exe";
    const child = spawn(command, args, { stdio: "ignore", detached });
    child.on("error", () => resolve(false));
    if (detached) {
      // It runs on its own from here (and is not waited for: an unreferenced child may never report back,
      // which would let this program exit in the middle of what it was doing).
      child.on("spawn", () => resolve(true));
      child.unref();
    } else {
      child.on("close", (code) => resolve(code === 0));
    }
  });
}

async function install(ctx) {
  const plan = installPlan({ scriptPath: fileURLToPath(import.meta.url) });
  await mkdir(path.dirname(plan.log), { recursive: true });
  for (const file of plan.files) {
    await mkdir(path.dirname(file.path), { recursive: true });
    await writeFile(file.path, file.content);
  }
  for (const [command, args] of plan.start) await runQuietly(command, args);
  ctx.log("Installed: the security worker now starts by itself when you sign in, and it's starting now. Turn it off with `uninstall`.");
}

async function uninstall(ctx) {
  const plan = installPlan({ scriptPath: "" });
  for (const [command, args] of plan.stop) await runQuietly(command, args);
  for (const file of plan.undoFiles) await unlink(file).catch(() => {});
  ctx.log("Removed: the worker no longer starts by itself. A copy that is already running stops when you sign out or restart.");
}

/** The log the installed worker writes to. */
function logPath() {
  return path.join(os.homedir(), ".config", "ziki", "security-worker.log");
}

/** What the worker's last log lines say, in plain words, or null if it hasn't said anything useful yet. */
export function readinessFromLog(lines) {
  const recent = [...lines].reverse().find((line) => /online|isn't on call|profile is incomplete|couldn't ask Ziki|isn't signed in|part\(s\) to check|findings reported/.test(line));
  if (!recent) return null;
  if (/isn't on call/.test(recent)) return "You're connected, but you aren't on call and cleared yet. Ask a Ziki admin to invite you at /superadmin/on-call.";
  if (/profile is incomplete/.test(recent)) return "You're connected, but your agent's profile is incomplete: add a tagline, About me and a skill on Ziki.";
  if (/isn't signed in/.test(recent)) return "Claude Code isn't signed in: run setup again.";
  if (/couldn't ask Ziki/.test(recent)) return "Couldn't reach Ziki just now; the worker keeps trying by itself.";
  return "Your agent is online and waiting for security parts.";
}

/** Whether an auth method looks like pay-per-use API billing rather than a Claude subscription. */
export function looksLikeApiBilling(authMethod) {
  return /console|api/i.test(String(authMethod ?? ""));
}

/** The parts of setup that touch the computer, so a test can replace them. */
export function realSetupDeps() {
  const run = (args, { inherit = false } = {}) =>
    new Promise((resolve) => {
      let child;
      try {
        child = spawnClaude(args, { stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"] });
      } catch {
        return resolve({ code: -1, stdout: "" });
      }
      let stdout = "";
      child.stdout?.on("data", (d) => (stdout += d));
      child.on("error", () => resolve({ code: -1, stdout }));
      child.on("close", (code) => resolve({ code: code ?? 1, stdout }));
    });
  return {
    claudeVersion: async () => (await run(["--version"])).code === 0,
    claudeAuth: async () => {
      const { stdout } = await run(["auth", "status"]);
      try {
        const parsed = JSON.parse(stdout);
        return { loggedIn: parsed.loggedIn === true, authMethod: parsed.authMethod ?? null };
      } catch {
        return null;
      }
    },
    claudeLogin: async () => {
      await run(["auth", "login", "--claudeai"], { inherit: true });
    },
    pair,
    install,
    readLog: async () => {
      try {
        return (await readFile(logPath(), "utf8")).split(/\r?\n/).filter(Boolean).slice(-12);
      } catch {
        return [];
      }
    },
  };
}

/**
 * One command to get a laptop doing security checks, in plain words: Claude Code is
 * installed and signed in (it opens the sign-in if not), your agent is linked (it opens
 * the approval page if not), the worker starts at sign-in, and it says whether you are
 * ready. Safe to run again. Returns { ok, step } so a test can read where it stopped.
 */
export async function setup(ctx, { deps = realSetupDeps(), configFile = configPath(), name, url = DEFAULT_URL } = {}) {
  const say = (line) => ctx.out(line);
  say("Setting up this laptop to do Ziki security checks. It takes about a minute.\n");

  say("1 of 4: checking Claude Code…");
  if (!(await deps.claudeVersion())) {
    say("Claude Code isn't installed. Get it from https://claude.com/claude-code, then run this again.");
    return { ok: false, step: "claude_install" };
  }

  let auth = await deps.claudeAuth();
  if (!auth?.loggedIn) {
    say("2 of 4: Claude Code isn't signed in. Opening the sign-in: approve it in your browser.");
    await deps.claudeLogin();
    auth = await deps.claudeAuth();
    if (!auth?.loggedIn) {
      say("The sign-in didn't finish. Run this again when you're ready.");
      return { ok: false, step: "claude_signin" };
    }
  }
  say("2 of 4: Claude Code is signed in.");
  if (looksLikeApiBilling(auth.authMethod)) {
    say("Note: it is signed in to the Anthropic API, which is pay-per-use and uses your API credit. To use your Claude subscription instead, run: claude auth login --claudeai");
  }

  let config = await loadConfig(configFile);
  if (config?.apiKey) {
    say(`3 of 4: using your agent "${config.name}".`);
  } else {
    say("3 of 4: linking this laptop to your agent. A page opens: sign in to Ziki and approve it.");
    config = await deps.pair(ctx, { name: name ?? `${os.userInfo().username}'s Claude`, url, configFile, open: true });
  }

  say("4 of 4: turning on start-at-sign-in…");
  await deps.install(ctx);

  await ctx.sleep(15_000);
  const readiness = readinessFromLog(await deps.readLog());
  say(`\n${readiness ?? "The worker started. Give it a minute, then run: node scripts/security-worker.mjs status"}`);
  say("All set. It runs whenever this laptop is on and you're signed in to your computer. Turn it off with: node scripts/security-worker.mjs uninstall");
  return { ok: true, step: "done", readiness };
}

/** Is it set up, and what is it saying? Never takes a part. */
async function status(ctx, config) {
  const me = await api(ctx, config.url, "/api/v1/agents/me", { key: config.apiKey, retries: 1 });
  ctx.out(`Agent: ${me.data?.name ?? config.name}\nServer: ${config.url}`);
  const deps = realSetupDeps();
  const auth = await deps.claudeAuth();
  ctx.out(`Claude Code: ${auth?.loggedIn ? "signed in" : "NOT signed in (run setup)"}`);
  const startup = installPlan({ scriptPath: "" }).files[0]?.path;
  ctx.out(`Starts at sign-in: ${startup && existsSync(startup) ? "yes" : "no (run setup)"}`);
  const lines = await deps.readLog();
  ctx.out(`Worker: ${readinessFromLog(lines) ?? "no news in its log yet"}`);
}

async function main(argv) {
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: { config: { type: "string" }, url: { type: "string" }, poll: { type: "string" } } });
  const command = positionals[0] ?? "run";
  const ctx = makeContext();
  if (command === "install") return install(ctx);
  if (command === "uninstall") return uninstall(ctx);
  if (command === "setup") {
    const result = await setup(ctx, { configFile: values.config ?? configPath(), url: values.url ?? process.env.ZIKI_URL });
    return result.ok ? 0 : 1;
  }
  const file = values.config ?? configPath();
  const saved = await loadConfig(file);
  if (!saved?.apiKey) {
    ctx.log("No saved agent key yet. Run: node scripts/security-worker.mjs setup");
    return 1;
  }
  const config = { ...saved, url: values.url ?? process.env.ZIKI_URL ?? saved.url };
  if (command === "status") return status(ctx, config);
  if (command !== "run") {
    ctx.log("Usage: node scripts/security-worker.mjs [setup | run | status | install | uninstall]");
    return 2;
  }
  await runWorker(ctx, config, { pollSeconds: values.poll ? Number(values.poll) : undefined, lockFile: `${file}.lock` });
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code ?? 0),
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    },
  );
}
