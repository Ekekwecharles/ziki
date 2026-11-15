import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ALLOWED_TOOLS,
  acquireLock,
  checkPrompt,
  claudeProblem,
  cleanClaudeEnv,
  cleanResults,
  extractJson,
  friendlyClaudeFailure,
  installPlan,
  looksLikeApiBilling,
  quoteForCmd,
  readinessFromLog,
  restAfterFailures,
  setup,
  tick,
} from "../../scripts/security-worker.mjs";

/** A fake context for the worker: a canned fetch and a log to read. */
function fakeCtx(replies: Array<{ status: number; body: unknown }>) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const logs: string[] = [];
  let at = 1_000_000;
  const queue = [...replies];
  const ctx = {
    fetch: vi.fn(async (url: URL, init: RequestInit) => {
      calls.push({ url: url.pathname, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : undefined });
      const next = queue.shift() ?? { status: 200, body: {} };
      return new Response(JSON.stringify(next.body), { status: next.status, headers: { "Content-Type": "application/json" } });
    }),
    sleep: vi.fn(async () => {}),
    now: () => (at += 1000),
    log: (line: string) => logs.push(line),
  };
  return { ctx: ctx as never, calls, logs };
}

const config = { url: "https://ziki.test", apiKey: "k", name: "ada" };
const job = { id: "j1", title: "Cookie flags", instructions: "Look at Set-Cookie.", check: { target: { kind: "website", value: "settle.ng" } } };
const reply = (results: unknown[]) => async () => ({ text: JSON.stringify({ results }) });
const good = { severity: "medium", title: "Cookie has no Secure flag", description: "The session cookie can travel over plain HTTP.", howToFix: "Set the Secure flag on the cookie." };

describe("the laptop security worker (#security-checks)", () => {
  it("asks for one part only, looking only, and names the target and the part", () => {
    const prompt = checkPrompt(job);
    expect(prompt).toContain("LOOK ONLY");
    expect(prompt).toContain("Target (website): settle.ng");
    expect(prompt).toContain("Part to check: Cookie flags");
    // Read-only tools only: no way to write, post or run anything else.
    expect(ALLOWED_TOOLS.split(",")).toEqual(["WebFetch", "Bash(curl -sI:*)", "Bash(git clone --depth 1:*)", "Read", "Grep", "Glob"]);
  });

  it("keeps only findings Ziki would accept, and finds the JSON in a chatty reply", () => {
    expect(extractJson('Sure! {"results": []} Done.')).toEqual({ results: [] });
    expect(() => extractJson("nothing here")).toThrow("no JSON");
    const cleaned = cleanResults({
      results: [
        good,
        { ...good, severity: "urgent" },
        { ...good, title: "x" },
        { ...good, howToFix: "short" },
        { ...good, severity: "HIGH", title: "  Spaced title  " },
      ],
    });
    expect(cleaned.map((r: { severity: string; title: string }) => [r.severity, r.title])).toEqual([
      ["medium", "Cookie has no Secure flag"],
      ["high", "Spaced title"],
    ]);
  });

  it("rests longer after each failure, never more than ten minutes, and longest for a usage limit", () => {
    expect(restAfterFailures(0)).toBe(0);
    expect(restAfterFailures(1)).toBe(30_000);
    expect(restAfterFailures(2)).toBe(60_000);
    expect(restAfterFailures(3)).toBe(120_000);
    expect(restAfterFailures(20)).toBe(10 * 60_000);
    expect(restAfterFailures(1, "You've reached your usage limit")).toBe(30 * 60_000);
  });

  it("does a part with Claude Code and reports its findings, never logging what was found", async () => {
    const { ctx, calls, logs } = fakeCtx([{ status: 200, body: { jobs: [job] } }, { status: 201, body: { ok: true } }]);
    const state = { failures: 3, lastNote: "" };
    const wait = await tick(ctx, config, state, { runClaude: reply([good]) });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["GET /api/v1/security-checks/jobs", "POST /api/v1/security-checks/jobs/j1/report"]);
    expect((calls[1]!.body as { results: unknown[] }).results).toHaveLength(1);
    expect(state.failures).toBe(0);
    expect(wait).toBe(1000);
    expect(logs.join(" ")).toContain("1 findings reported");
    expect(logs.join(" ")).not.toContain("Secure flag");
  });

  it("gives a part back and rests when Claude Code fails, instead of taking more", async () => {
    const { ctx, calls } = fakeCtx([{ status: 200, body: { jobs: [job, { ...job, id: "j2" }] } }, { status: 200, body: {} }]);
    const state = { failures: 0, lastNote: "" };
    const wait = await tick(ctx, config, state, {
      runClaude: async () => {
        throw new Error("Claude Code exited 1: please sign in");
      },
    });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["GET /api/v1/security-checks/jobs", "POST /api/v1/security-checks/jobs/j1/release"]);
    expect(state.failures).toBe(1);
    expect(wait).toBe(30_000);
  });

  it("does nothing, and says so once, when the agent's owner isn't on call and cleared", async () => {
    const run = vi.fn();
    const { ctx, logs } = fakeCtx([{ status: 403, body: { error: "not_security_cleared", message: "no" } }, { status: 403, body: { error: "not_security_cleared" } }]);
    const state = { failures: 0, lastNote: "" };
    expect(await tick(ctx, config, state, { runClaude: run })).toBe(60_000);
    await tick(ctx, config, state, { runClaude: run });
    expect(run).not.toHaveBeenCalled();
    expect(logs.filter((line) => line.includes("cleared for security checks"))).toHaveLength(1);
  });

  it("stops (instead of retrying for ever) when Ziki rejects the key", async () => {
    const { ctx } = fakeCtx([{ status: 401, body: { error: "unauthorized" } }]);
    await expect(tick(ctx, config, { failures: 0, lastNote: "" }, { runClaude: vi.fn() })).rejects.toMatchObject({ status: 401 });
  });

  it("quotes only what a Windows .cmd launcher needs quoted", () => {
    expect(quoteForCmd("--model")).toBe("--model");
    expect(quoteForCmd("Bash(curl -sI:*)")).toBe('"Bash(curl -sI:*)"');
    expect(quoteForCmd("C:\\Program Files\\claude.cmd")).toBe('"C:\\Program Files\\claude.cmd"');
  });

  it("starts at sign-in on each system, with no admin rights and the same command everywhere", () => {
    const script = "/opt/ziki/scripts/security-worker.mjs";
    const win = installPlan({ platform: "win32", nodePath: "C:\\node\\node.exe", scriptPath: "C:\\ziki\\scripts\\security-worker.mjs", home: "C:\\Users\\a", appData: "C:\\Users\\a\\AppData\\Roaming" });
    expect(win.files[0]!.path).toContain("Startup");
    expect(win.files[0]!.content).toContain("security-worker.mjs");
    expect(win.files[0]!.content).toContain(" run ");
    expect(win.files[0]!.content).toContain(", 0, False");

    const mac = installPlan({ platform: "darwin", nodePath: "/usr/bin/node", scriptPath: script, home: "/Users/a" });
    expect(mac.files[0]!.path).toBe("/Users/a/Library/LaunchAgents/dev.ziki.security-worker.plist");
    expect(mac.files[0]!.content).toContain("<key>RunAtLoad</key><true/>");
    expect(mac.files[0]!.content).toContain("<string>run</string>");
    expect(mac.stop).toEqual([["launchctl", ["unload", "-w", mac.files[0]!.path]]]);

    const linux = installPlan({ platform: "linux", nodePath: "/usr/bin/node", scriptPath: script, home: "/home/a" });
    expect(linux.files[0]!.path).toBe("/home/a/.config/systemd/user/ziki-security-worker.service");
    expect(linux.files[0]!.content).toContain(`ExecStart="/usr/bin/node" "${script}" run`);
    expect(linux.files[0]!.content).toContain("WantedBy=default.target");
    expect(linux.undoFiles).toEqual([linux.files[0]!.path]);
  });

  it("starts Claude Code without the settings a Claude session leaves behind, but keeps the person's own API key", () => {
    const clean = cleanClaudeEnv({ CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "x", CLAUDE_AGENT_SDK_VERSION: "1", ANTHROPIC_BASE_URL: "http://proxy", ANTHROPIC_API_KEY: "sk-own", PATH: "/bin" } as never);
    expect(clean).toEqual({ ANTHROPIC_API_KEY: "sk-own", PATH: "/bin" } as never);
  });

  it("tells a signed-out Claude Code from a usage limit, and says what to do", () => {
    expect(claudeProblem("OAuth session expired")).toBe("not_signed_in");
    expect(claudeProblem("You've hit your usage limit")).toBe("usage_limit");
    expect(claudeProblem("boom")).toBe("other");
    expect(friendlyClaudeFailure("Failed to authenticate")).toContain("security-worker.mjs setup");
  });

  it("runs only one copy per agent, and takes over a lock left by a process that is gone", () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "ziki-lock-")), "agent.json.lock");
    expect(acquireLock(file, { pid: 11 })).toBe(true);
    expect(acquireLock(file, { pid: 22, alive: () => true })).toBe(false);
    expect(acquireLock(file, { pid: 22, alive: () => false })).toBe(true);
  });

  it("reads the worker's last log line in plain words", () => {
    expect(readinessFromLog([])).toBeNull();
    expect(readinessFromLog(["online; no parts right now"])).toContain("online");
    expect(readinessFromLog(["online", "owner isn't on call and cleared"])).toContain("aren't on call");
    expect(readinessFromLog(["Claude Code isn't signed in"])).toContain("run setup again");
    expect(looksLikeApiBilling("console")).toBe(true);
    expect(looksLikeApiBilling("claude.ai")).toBe(false);
  });

  describe("setup", () => {
    const base = () => {
      const out: string[] = [];
      const ctx = { out: (line: string) => out.push(line), sleep: vi.fn(async () => {}), log: () => {} } as never;
      const dir = mkdtempSync(path.join(os.tmpdir(), "ziki-setup-"));
      const configFile = path.join(dir, "agent.json");
      const deps = {
        claudeVersion: vi.fn(async () => true),
        claudeAuth: vi.fn(async () => ({ loggedIn: true, authMethod: "claude.ai" })),
        claudeLogin: vi.fn(async () => {}),
        pair: vi.fn(async (_c: unknown, o: { configFile: string }) => {
          writeFileSync(o.configFile, JSON.stringify({ url: "https://ziki.test", apiKey: "k", name: "Ada" }));
          return { url: "https://ziki.test", apiKey: "k", name: "Ada" };
        }),
        install: vi.fn(async () => {}),
        readLog: vi.fn(async () => ["online; no parts right now"]),
      };
      return { out, ctx, configFile, deps };
    };

    it("does everything for a fresh laptop: pairs, installs, and says it is ready", async () => {
      const { ctx, deps, configFile, out } = base();
      const result = await setup(ctx, { deps: deps as never, configFile, name: "Ada" } as never);
      expect(result).toMatchObject({ ok: true, step: "done" });
      expect(deps.pair).toHaveBeenCalledOnce();
      expect(deps.install).toHaveBeenCalledOnce();
      expect(out.join("\n")).toContain("online and waiting");
    });

    it("does not pair again when an agent is already saved", async () => {
      const { ctx, deps, configFile } = base();
      writeFileSync(configFile, JSON.stringify({ url: "https://ziki.test", apiKey: "k", name: "Ada" }));
      await setup(ctx, { deps: deps as never, configFile });
      expect(deps.pair).not.toHaveBeenCalled();
      expect(existsSync(configFile)).toBe(true);
    });

    it("stops with a plain message when Claude Code is missing", async () => {
      const { ctx, deps, configFile, out } = base();
      deps.claudeVersion.mockResolvedValue(false);
      expect(await setup(ctx, { deps: deps as never, configFile })).toMatchObject({ ok: false, step: "claude_install" });
      expect(deps.install).not.toHaveBeenCalled();
      expect(out.join("\n")).toContain("isn't installed");
    });

    it("opens the sign-in when signed out, and stops if it did not finish", async () => {
      const { ctx, deps, configFile } = base();
      deps.claudeAuth.mockResolvedValue({ loggedIn: false, authMethod: "" });
      expect(await setup(ctx, { deps: deps as never, configFile })).toMatchObject({ ok: false, step: "claude_signin" });
      expect(deps.claudeLogin).toHaveBeenCalledOnce();
      expect(deps.pair).not.toHaveBeenCalled();
    });
  });

  it("retries a dropped connection quietly when asking for work", async () => {
    let calls = 0;
    const logs: string[] = [];
    const ctx = {
      fetch: vi.fn(async () => {
        if (++calls < 3) throw new TypeError("fetch failed");
        return new Response(JSON.stringify({ jobs: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }),
      sleep: vi.fn(async () => {}),
      now: () => 1,
      log: (line: string) => logs.push(line),
    };
    await tick(ctx as never, config, { failures: 0, lastNote: "" }, { runClaude: vi.fn() });
    expect(calls).toBe(3);
    expect(logs.join(" ")).not.toContain("Network error");
  });
});

describe("the setup card on My agents (#security-checks)", () => {
  it("shows the one setup command only to someone who is on call and cleared", async () => {
    vi.resetModules();
    const findUnique = vi.fn();
    vi.doMock("@/lib/prisma", () => ({ prisma: { user: { findUnique } } }));
    const { OnCallSetup, WORKER_SETUP_COMMAND } = await import("../../components/on-call-setup");
    const text = (node: unknown) => JSON.stringify(node);
    findUnique.mockResolvedValueOnce({ onCallAt: new Date(), securityClearedAt: new Date() });
    expect(text(await OnCallSetup({ userId: "u1" }))).toContain(WORKER_SETUP_COMMAND);
    findUnique.mockResolvedValueOnce({ onCallAt: new Date(), securityClearedAt: null });
    expect(await OnCallSetup({ userId: "u1" })).toBeNull();
    findUnique.mockResolvedValueOnce({ onCallAt: null, securityClearedAt: null });
    expect(await OnCallSetup({ userId: "u1" })).toBeNull();
    expect(WORKER_SETUP_COMMAND).toBe("node scripts/security-worker.mjs setup");
  });
});
