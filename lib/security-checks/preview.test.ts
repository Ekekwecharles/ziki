import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
const github = vi.hoisted(() => ({ getOrNull: vi.fn(), auth: "token" }));
vi.mock("@/lib/github/client", () => ({
  githubClientFor: vi.fn(async () => github),
  installationIdForRepo: vi.fn(async () => null),
  githubApiUrl: () => "https://api.github.test",
  GitHubError: class GitHubError extends Error {
    constructor(readonly status: number, message: string) {
      super(message);
    }
  },
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { setRateLimitStore } from "@/lib/rate-limit";
import { PREVIEW_SCANS_PER_VISITOR_PER_HOUR } from "@/lib/security-checks";
import {
  certificateFindings,
  clearPreviewCache,
  cookieFindings,
  emailFindings,
  headerFindings,
  MAX_REDIRECTS,
  previewScan,
  realPreviewNetwork,
  type CertificateAnswer,
  type PageAnswer,
  type PreviewNetwork,
  type RepoAnswer,
} from "./preview";
import { GitHubError } from "@/lib/github/client";
import { PrivateAddressError } from "./ownership";

const NOW = Date.parse("2026-11-12T20:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

const SAFE_HEADERS: PageAnswer["headers"] = {
  "strict-transport-security": "max-age=31536000",
  "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  server: "cloudflare",
};
const GOOD_CERT: CertificateAnswer = { authorized: true, authorizationError: null, validTo: new Date(NOW + 60 * DAY), protocol: "TLSv1.3" };

/** A network that answers from tables; anything not listed doesn't answer. */
function network(answers: {
  pages?: Record<string, Partial<PageAnswer>>;
  certificate?: CertificateAnswer | null;
  txt?: Record<string, string[][]>;
  repo?: RepoAnswer;
}): PreviewNetwork & { page: ReturnType<typeof vi.fn> } {
  return {
    page: vi.fn(async (url: string) => {
      const page = answers.pages?.[url];
      if (!page) throw Object.assign(new Error(`not reachable: ${url}`), { code: "ECONNREFUSED" });
      return { status: page.status ?? 200, location: page.location ?? null, headers: page.headers ?? {} };
    }),
    certificate: async () => answers.certificate ?? null,
    txt: async (host) => answers.txt?.[host] ?? [],
    repo: async () => answers.repo ?? { status: "not_found" },
  };
}

/** A well-kept site: HTTPS, a redirect from HTTP, good headers, SPF and an enforced DMARC. */
const WELL_KEPT = {
  pages: {
    "https://settle.ng/": { headers: SAFE_HEADERS },
    "http://settle.ng/": { status: 301, location: "https://settle.ng/" },
  },
  certificate: GOOD_CERT,
  txt: { "settle.ng": [["v=spf1 include:_spf.google.com -all"]], "_dmarc.settle.ng": [["v=DMARC1; p=reject"]] },
};

let visitor = 0;
const scan = (link: string, net: PreviewNetwork, now = NOW) => previewScan(link, { visitor: `v${++visitor}`, network: net, now });

beforeEach(() => {
  clearPreviewCache();
  setRateLimitStore(null);
});
afterEach(() => setRateLimitStore(null));

describe("preview scan (#security-checks, 12 Nov plan D3)", () => {
  it("finds nothing on a well-kept site and says what it looked at", async () => {
    const result = await scan("https://settle.ng", network(WELL_KEPT));
    expect(result).toMatchObject({ ok: true, kind: "website", target: "settle.ng", findings: [], counts: { critical: 0, high: 0, medium: 0, low: 0 } });
    expect(result.ok && result.checked).toEqual(["https", "certificate", "headers", "cookies", "email"]);
  });

  it("reports what a browser can see is missing, worst first, with counts", async () => {
    const result = await scan("settle.ng", network({
      pages: { "https://settle.ng/": { headers: { "set-cookie": ["sid=1; Path=/"], "x-powered-by": "Express" } }, "http://settle.ng/": { status: 200 } },
      certificate: { ...GOOD_CERT, validTo: new Date(NOW + 5 * DAY) },
      txt: { "_dmarc.settle.ng": [["v=DMARC1; p=none"]] },
    }));
    if (!result.ok) throw new Error(result.reason);
    expect(result.findings.map((f) => f.id)).toEqual([
      "no-https-redirect", "certificate-expiring", "missing-hsts", "missing-csp", "missing-frame-protection", "cookie-not-secure", "missing-spf",
      "missing-nosniff", "missing-referrer-policy", "version-disclosure", "cookie-not-httponly", "cookie-no-samesite", "dmarc-not-enforced",
    ]);
    expect(result.counts).toEqual({ critical: 0, high: 0, medium: 7, low: 6 });
  });

  it("flags a site that only answers over plain HTTP", async () => {
    const result = await scan("settle.ng", network({ pages: { "http://settle.ng/": { status: 200 } } }));
    expect(result.ok && result.findings.map((f) => f.id)).toContain("no-https");
    expect(result.ok && result.checked).not.toContain("headers");
  });

  it("never calls a DNS record missing when the lookup itself failed", async () => {
    let calls = 0;
    const flaky: PreviewNetwork = {
      ...network(WELL_KEPT),
      txt: async () => {
        calls += 1;
        throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
      },
    };
    const result = await scan("settle.ng", flaky);
    if (!result.ok) throw new Error(result.reason);
    expect(result.findings.map((f) => f.id)).not.toContain("missing-spf");
    expect(result.findings.map((f) => f.id)).not.toContain("missing-dmarc");
    expect(result.checked).not.toContain("email");
    expect(calls).toBe(4); // SPF and DMARC, each asked twice
  });

  it("says so plainly when nothing answers on the web", async () => {
    const result = await scan("settle.ng", network({}));
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("didn't answer on the web") });
  });

  it("refuses private or unreadable links before touching the network", async () => {
    const net = network(WELL_KEPT);
    expect(await scan("http://192.168.1.10", net)).toMatchObject({ ok: false });
    expect(await scan("localhost", net)).toMatchObject({ ok: false });
    expect(await scan("not a link", net)).toMatchObject({ ok: false });
    expect(net.page).not.toHaveBeenCalled();
  });

  it("stops at once when a name turns out to point at a private address", async () => {
    const net: PreviewNetwork = {
      page: async () => { throw new PrivateAddressError("settle.ng"); },
      certificate: async () => null,
      txt: async () => [],
      repo: async () => ({ status: "not_found" }),
    };
    expect(await scan("settle.ng", net)).toEqual({ ok: false, reason: expect.stringContaining("private network") });
  });

  it("follows redirects on the same site only, and reads headers from the site's own page", async () => {
    const elsewhere = network({
      ...WELL_KEPT,
      pages: { ...WELL_KEPT.pages, "https://settle.ng/": { status: 302, location: "https://other.example.com/" } },
    });
    const result = await scan("settle.ng", elsewhere);
    // Redirected away: the other site's headers are never fetched or judged.
    expect(elsewhere.page).not.toHaveBeenCalledWith("https://other.example.com/");
    expect(result.ok && result.checked).not.toContain("headers");

    const www = network({ ...WELL_KEPT, pages: { ...WELL_KEPT.pages, "https://settle.ng/": { status: 301, location: "https://www.settle.ng/" }, "https://www.settle.ng/": { headers: SAFE_HEADERS } } });
    expect(await scan("settle.ng", www)).toMatchObject({ ok: true, findings: [] });
  });

  it("follows more than 3 same-site redirects, and never calls a redirect loop 'no HTTPS'", async () => {
    // Five hops on the site before the page: followed to the end, headers read, nothing wrong.
    const hops: Record<string, Partial<PageAnswer>> = {};
    for (let i = 0; i < 5; i++) hops[i === 0 ? "https://settle.ng/" : `https://settle.ng/${i}`] = { status: 302, location: `https://settle.ng/${i + 1}` };
    hops["https://settle.ng/5"] = { headers: SAFE_HEADERS };
    const long = await scan("settle.ng", network({ ...WELL_KEPT, pages: { ...WELL_KEPT.pages, ...hops } }));
    expect(long).toMatchObject({ ok: true, findings: [] });
    expect(long.ok && long.checked).toContain("headers");

    clearPreviewCache();
    // A loop that never ends: HTTPS couldn't be checked, so it isn't judged at all.
    const loop = network({ ...WELL_KEPT, pages: { ...WELL_KEPT.pages, "https://settle.ng/": { status: 302, location: "https://settle.ng/" } } });
    const looped = await scan("settle.ng", loop);
    if (!looped.ok) throw new Error(looped.reason);
    expect(looped.findings.map((f) => f.id)).not.toContain("no-https");
    expect(looped.findings.map((f) => f.id)).not.toContain("no-https-redirect");
    expect(looped.checked).not.toContain("https");
    expect(looped.checked).not.toContain("headers");
    expect(loop.page.mock.calls.length).toBeLessThanOrEqual(MAX_REDIRECTS + 2); // the hops, plus the plain-HTTP read
  });

  it("reads SPF and DMARC from the registrable domain when the link is a subdomain", async () => {
    const app = {
      pages: { "https://app.settle.ng/": { headers: SAFE_HEADERS }, "http://app.settle.ng/": { status: 301, location: "https://app.settle.ng/" } },
      certificate: GOOD_CERT,
    };
    // Records only on settle.ng: the subdomain is covered, nothing is missing.
    const covered = await scan("app.settle.ng", network({ ...app, txt: WELL_KEPT.txt }));
    expect(covered).toMatchObject({ ok: true, findings: [] });
    expect(covered.ok && covered.checked).toContain("email");

    // Public suffixes with two labels resolve the same way.
    const uk = await scan("shop.example.co.uk", network({
      pages: { "https://shop.example.co.uk/": { headers: SAFE_HEADERS }, "http://shop.example.co.uk/": { status: 301, location: "https://shop.example.co.uk/" } },
      certificate: GOOD_CERT,
      txt: { "example.co.uk": [["v=spf1 -all"]], "_dmarc.example.co.uk": [["v=DMARC1; p=reject"]] },
    }));
    expect(uk).toMatchObject({ ok: true, findings: [] });

    clearPreviewCache();
    // A subdomain's own DMARC record wins over the parent's.
    const own = await scan("app.settle.ng", network({ ...app, txt: { ...WELL_KEPT.txt, "_dmarc.app.settle.ng": [["v=DMARC1; p=none"]] } }));
    expect(own.ok && own.findings.map((f) => f.id)).toEqual(["dmarc-not-enforced"]);

    clearPreviewCache();
    // And a missing record names the domain that was checked.
    const bare = await scan("app.settle.ng", network({ ...app, txt: {} }));
    expect(bare.ok && bare.findings.find((f) => f.id === "missing-spf")?.detail).toContain("settle.ng has no SPF record");
  });

  it("with scan limits on, limits each visitor to a few previews an hour, and reuses a recent result without counting it", async () => {
    const net = network(WELL_KEPT);
    const sites = Array.from({ length: PREVIEW_SCANS_PER_VISITOR_PER_HOUR + 1 }, (_, i) => `site${i}.ng`);
    const results = [];
    for (const site of sites) {
      results.push(await previewScan(site, { visitor: "same-ip", network: network({ ...WELL_KEPT, pages: { [`https://${site}/`]: { headers: SAFE_HEADERS } } }), now: NOW, limited: true }));
    }
    expect(results.slice(0, -1).every((r) => r.ok)).toBe(true);
    expect(results.at(-1)).toMatchObject({ ok: false, retryAfterSeconds: expect.any(Number) });

    // A link scanned a moment ago comes from the cache, even for a visitor at the limit.
    const cached = await previewScan("site0.ng", { visitor: "same-ip", network: net, now: NOW + 60_000, limited: true });
    expect(cached).toMatchObject({ ok: true, target: "site0.ng" });
    expect(net.page).not.toHaveBeenCalled();
  });

  it("with scan limits off (14 Nov plan), never stops a visitor", async () => {
    const sites = Array.from({ length: PREVIEW_SCANS_PER_VISITOR_PER_HOUR + 3 }, (_, i) => `open${i}.ng`);
    for (const site of sites) {
      const result = await previewScan(site, { visitor: "busy-ip", network: network({ ...WELL_KEPT, pages: { [`https://${site}/`]: { headers: SAFE_HEADERS } } }), now: NOW, limited: false });
      expect(result).toMatchObject({ ok: true, target: site });
    }
  });

  it("reads the scan-limits setting: off unless SECURITY_SCAN_LIMITS_ENABLED is true", async () => {
    const before = process.env.SECURITY_SCAN_LIMITS_ENABLED;
    try {
      delete process.env.SECURITY_SCAN_LIMITS_ENABLED;
      for (let i = 0; i < PREVIEW_SCANS_PER_VISITOR_PER_HOUR + 1; i++) {
        const site = `env${i}.ng`;
        expect(await previewScan(site, { visitor: "env-ip", network: network({ ...WELL_KEPT, pages: { [`https://${site}/`]: { headers: SAFE_HEADERS } } }), now: NOW })).toMatchObject({ ok: true });
      }
    } finally {
      if (before === undefined) delete process.env.SECURITY_SCAN_LIMITS_ENABLED;
      else process.env.SECURITY_SCAN_LIMITS_ENABLED = before;
    }
  });

  it("doesn't hold an IP-reached server to a name on its certificate", () => {
    const mismatch = { ...GOOD_CERT, authorized: false, authorizationError: "ERR_TLS_CERT_ALTNAME_INVALID" };
    expect(certificateFindings(mismatch, "server", "8.8.4.4", NOW)).toEqual([]);
    expect(certificateFindings(mismatch, "website", "settle.ng", NOW).map((f) => f.id)).toEqual(["certificate-untrusted"]);
    expect(certificateFindings({ ...GOOD_CERT, validTo: new Date(NOW - DAY), authorized: false }, "website", "settle.ng", NOW).map((f) => f.id)).toEqual(["certificate-expired"]);
    expect(certificateFindings({ ...GOOD_CERT, protocol: "TLSv1.1" }, "website", "settle.ng", NOW).map((f) => f.id)).toEqual(["old-tls"]);
  });

  it("reads headers, cookies and email records the way a browser and a mail server would", () => {
    expect(headerFindings(SAFE_HEADERS)).toEqual([]);
    expect(headerFindings({ ...SAFE_HEADERS, "content-security-policy": "default-src 'self'", "x-frame-options": "DENY" })).toEqual([]);
    expect(headerFindings({ ...SAFE_HEADERS, server: "nginx/1.18.0" }).map((f) => f.id)).toEqual(["version-disclosure"]);

    expect(cookieFindings({ "set-cookie": ["sid=1; Secure; HttpOnly; SameSite=Lax"] })).toEqual([]);
    expect(cookieFindings({ "set-cookie": ["a=1; HttpOnly; SameSite=Lax", "b=2; Secure; SameSite=Lax"] }).map((f) => [f.id, f.detail.slice(0, 8)])).toEqual([
      ["cookie-not-secure", "1 cookie"],
      ["cookie-not-httponly", "1 cookie"],
    ]);

    // TXT records can be split into pieces; they're joined before reading.
    expect(emailFindings([["v=spf1 ", "-all"]], [["v=DMARC1; ", "p=quarantine"]], "settle.ng")).toEqual([]);
    expect(emailFindings([["google-site-verification=x"]], [], "settle.ng").map((f) => f.id)).toEqual(["missing-spf", "missing-dmarc"]);
  });

  it("never opens a connection to a private address, by name or by number", async () => {
    let hits = 0;
    const local = createServer((_req, res) => {
      hits += 1;
      res.end("secret");
    });
    await new Promise<void>((resolve) => local.listen(0, "127.0.0.1", resolve));
    const { port } = local.address() as AddressInfo;
    try {
      await expect(realPreviewNetwork.page(`http://127.0.0.1:${port}/`)).rejects.toBeInstanceOf(PrivateAddressError);
      await expect(realPreviewNetwork.page(`http://localhost:${port}/`)).rejects.toMatchObject({ code: "EPRIVATE" });
      await expect(realPreviewNetwork.certificate("127.0.0.1")).rejects.toBeInstanceOf(PrivateAddressError);
      expect(hits).toBe(0);
    } finally {
      local.close();
    }
  });
});

describe("preview scan of a public repo (13 Nov)", () => {
  const KEPT_REPO: RepoAnswer = { status: "ok", root: ["README.md", "package.json", ".gitignore", ".env.example", "src"], github: ["dependabot.yml", "workflows"], docs: ["SECURITY.md"] };

  it("finds nothing in a repo with a policy, an update bot and no secrets files, and says what it looked at", async () => {
    const result = await scan("https://github.com/settle/app", network({ repo: KEPT_REPO }));
    expect(result).toMatchObject({ ok: true, kind: "repo", target: "settle/app", findings: [], checked: ["secrets", "policy", "updates"], counts: { critical: 0, high: 0, medium: 0, low: 0 } });
  });

  it("reads the GitHub address the chat builds from a repo's owner/name, though not the bare owner/name", async () => {
    const net = network({ repo: KEPT_REPO });
    expect(await scan("github.com/settle/app", net)).toMatchObject({ ok: true, kind: "repo", target: "settle/app" });
    expect(await scan("settle/app", net)).toMatchObject({ ok: false });
  });

  it("flags files that usually hold secrets as high, but not examples", async () => {
    const result = await scan("github.com/settle/app", network({ repo: { status: "ok", root: ["SECURITY.md", ".env", ".env.example", "deploy.pem", "id_rsa", "README.md"], github: [], docs: [] } }));
    expect(result).toMatchObject({ ok: true, counts: { high: 3, low: 0 } });
    expect(result.ok && result.findings.map((finding) => finding.id).sort()).toEqual(["secret-file:.env", "secret-file:deploy.pem", "secret-file:id_rsa"]);
  });

  it("flags a missing security policy and a missing update bot, only when the repo has dependencies", async () => {
    const withDeps = await scan("github.com/settle/a", network({ repo: { status: "ok", root: ["package.json", "src"], github: ["workflows"], docs: [] } }));
    expect(withDeps).toMatchObject({ ok: true, checked: ["secrets", "policy", "updates"], counts: { low: 2 } });
    const noDeps = await scan("github.com/settle/b", network({ repo: { status: "ok", root: ["index.html"], github: [], docs: [] } }));
    expect(noDeps).toMatchObject({ ok: true, checked: ["secrets", "policy"], counts: { low: 1 } });
  });

  it("finds a policy or an update bot wherever they are allowed to live", async () => {
    const result = await scan("github.com/settle/c", network({ repo: { status: "ok", root: ["package.json", "renovate.json", ".github"], github: ["SECURITY.md"], docs: [] } }));
    expect(result).toMatchObject({ ok: true, findings: [] });
  });

  it("says a repo it can't see is private or misspelt, and one GitHub won't answer for is unavailable, and never throws", async () => {
    expect(await scan("github.com/settle/private", network({ repo: { status: "not_found" } }))).toEqual({ ok: false, reason: expect.stringContaining("private") });
    expect(await scan("github.com/settle/busy", network({ repo: { status: "unavailable" } }))).toEqual({ ok: false, reason: expect.stringContaining("just now") });
  });

  it("counts repo scans against the same hourly limit, and reuses a result for a while", async () => {
    const net = network({ repo: KEPT_REPO });
    const repo = vi.spyOn(net, "repo");
    await previewScan("github.com/settle/app", { visitor: "same", network: net, now: NOW });
    await previewScan("github.com/settle/app", { visitor: "same", network: net, now: NOW + 60_000 });
    expect(repo).toHaveBeenCalledTimes(1);
  });
});

describe("reading a public repo through Ziki's GitHub client (13 Nov)", () => {
  // A block body: returning the mock would make Vitest call it again as the test's cleanup.
  beforeEach(() => {
    github.getOrNull.mockReset();
    github.auth = "token";
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the names at the top level, in .github and in docs, and nothing else", async () => {
    github.getOrNull.mockImplementation(async (path: string) => ({
      "/repos/settle/app": { private: false },
      "/repos/settle/app/contents": [{ name: "README.md", type: "file" }, { name: ".github", type: "dir" }, { name: "docs", type: "dir" }],
      "/repos/settle/app/contents/.github": [{ name: "dependabot.yml" }],
      "/repos/settle/app/contents/docs": [{ name: "SECURITY.md" }],
    })[path] ?? null);
    expect(await realPreviewNetwork.repo("settle", "app")).toEqual({ status: "ok", root: ["README.md", ".github", "docs"], github: ["dependabot.yml"], docs: ["SECURITY.md"] });
    expect(github.getOrNull).toHaveBeenCalledTimes(4);
  });

  it("only looks inside .github and docs when the top level has them", async () => {
    github.getOrNull.mockImplementation(async (path: string) => (path === "/repos/settle/app" ? { private: false } : [{ name: "README.md" }]));
    expect(await realPreviewNetwork.repo("settle", "app")).toEqual({ status: "ok", root: ["README.md"], github: [], docs: [] });
    expect(github.getOrNull).toHaveBeenCalledTimes(2);
  });

  it("never looks into a repo GitHub says is private, even though Ziki's token could read it", async () => {
    github.getOrNull.mockImplementation(async (path: string) => (path === "/repos/settle/secret" ? { private: true } : [{ name: ".env" }]));
    expect(await realPreviewNetwork.repo("settle", "secret")).toEqual({ status: "not_found" });
    expect(github.getOrNull).toHaveBeenCalledTimes(1);
    expect(github.getOrNull).toHaveBeenCalledWith("/repos/settle/secret");
    // A record that doesn't plainly say public is treated the same way.
    github.getOrNull.mockReset();
    github.getOrNull.mockResolvedValue({});
    expect(await realPreviewNetwork.repo("settle", "unclear")).toEqual({ status: "not_found" });
  });

  it("says not found for a private or missing repo", async () => {
    github.getOrNull.mockResolvedValue(null);
    expect(await realPreviewNetwork.repo("settle", "private")).toEqual({ status: "not_found" });
  });

  it("says unavailable, with why, and never throws, when GitHub can't be read at all", async () => {
    github.getOrNull.mockImplementation(async () => {
      throw new GitHubError(403, "Ziki has used up its GitHub rate limit for now.");
    });
    const answer = await realPreviewNetwork.repo("settle", "busy").catch((error: unknown) => ({ threw: String(error) }));
    expect(answer).toEqual({ status: "unavailable", detail: expect.stringContaining("403") });
  });

  it("asks once with no token when the one Ziki has is rejected, so a public repo can still be read", async () => {
    github.getOrNull.mockImplementation(async () => {
      throw new GitHubError(401, "Bad credentials");
    });
    const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/contents") ? [{ name: "README.md" }, { name: "SECURITY.md" }] : { private: false }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await realPreviewNetwork.repo("settle", "app")).toEqual({ status: "ok", root: ["README.md", "SECURITY.md"], github: [], docs: [] });
    expect(fetchMock).toHaveBeenCalledWith("https://api.github.test/repos/settle/app/contents", expect.not.objectContaining({ headers: expect.objectContaining({ Authorization: expect.anything() }) }));
  });

  it("doesn't ask again without a token when Ziki had none to begin with", async () => {
    github.auth = "none";
    github.getOrNull.mockImplementation(async () => {
      throw new GitHubError(403, "Ziki has used up its GitHub rate limit for now.");
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await realPreviewNetwork.repo("settle", "busy")).toEqual({ status: "unavailable", detail: expect.stringContaining("403") });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("puts why GitHub couldn't be read into what the person is told", async () => {
    const net = network({ repo: { status: "unavailable", detail: "GitHub answered 403" } });
    expect(await scan("github.com/settle/busy", net)).toEqual({ ok: false, reason: expect.stringContaining("(GitHub answered 403)") });
  });
});
