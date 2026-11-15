import { createServer } from "node:http";
import { isTargetProven } from "@/lib/security-checks";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { isPublicAddress, OWNERSHIP_METHODS, type OwnershipMethod, pageHasTag, PrivateAddressError, proveOwnership, publicOnlyLookup, realNetwork, type OwnershipNetwork } from "./ownership";

const TOKEN = "ziki-verify-0123456789abcdef0123456789abcdef";
const site = { organisationId: "org1", kind: "website" as const, value: "settle.ng", ownershipToken: TOKEN };
const server = { organisationId: "org1", kind: "server" as const, value: "8.8.4.4", ownershipToken: TOKEN };
const repo = { organisationId: "org1", kind: "repo" as const, value: "settle/app", ownershipToken: TOKEN };

/** A network that answers from tables; anything not listed isn't there. */
function network(answers: {
  txt?: Record<string, string[][]>;
  addresses?: Record<string, string[]>;
  pages?: Record<string, { status: number; location?: string; body?: string }>;
  appSees?: string[];
  files?: Record<string, string>;
}): OwnershipNetwork & { get: ReturnType<typeof vi.fn> } {
  return {
    txt: async (host) => answers.txt?.[host] ?? [],
    addresses: async (host) => answers.addresses?.[host] ?? [],
    get: vi.fn(async (url: string) => {
      const page = answers.pages?.[url];
      if (!page) throw new Error(`not reachable: ${url}`);
      return { status: page.status, location: page.location ?? null, body: page.body ?? "" };
    }),
    workspaceAppSeesRepo: async (_org, name) => answers.appSees?.includes(name) ?? false,
    repoFile: async (_org, name, path) => answers.files?.[`${name}/${path}`] ?? null,
  };
}

const tag = `<html><head><meta content="${TOKEN}" name='ziki-verification'></head></html>`;

describe("ownership proof (#security-checks part 2)", () => {
  it("never looks at a private or internal address", async () => {
    expect(isPublicAddress("10.0.0.5")).toBe(false);
    expect(isPublicAddress("169.254.169.254")).toBe(false);
    expect(isPublicAddress("::ffff:127.0.0.1")).toBe(false);
    expect(isPublicAddress("fd12::1")).toBe(false);
    expect(isPublicAddress("8.8.8.8")).toBe(true);

    // A public-looking name that points inside a private network is refused before anything is fetched.
    const net = network({ addresses: { "settle.ng": ["10.1.2.3"] }, pages: { "https://settle.ng/": { status: 200, body: tag } } });
    const result = await proveOwnership(site, "html_tag", net);
    expect(result.ok).toBe(false);
    expect(net.get).not.toHaveBeenCalled();
  });

  it("accepts the homepage tag only when it carries the target's own code", async () => {
    expect(pageHasTag(tag, TOKEN)).toBe(true);
    expect(pageHasTag(tag, "ziki-verify-someone-else")).toBe(false);

    const found = network({ addresses: { "settle.ng": ["8.8.8.8"] }, pages: { "https://settle.ng/": { status: 200, body: tag } } });
    expect(await proveOwnership(site, "html_tag", found)).toEqual({ ok: true });

    const missing = network({ addresses: { "settle.ng": ["8.8.8.8"] }, pages: { "https://settle.ng/": { status: 200, body: "<html></html>" } } });
    expect((await proveOwnership(site, "html_tag", missing)).ok).toBe(false);
  });

  it("follows a redirect on the same site but not to another one", async () => {
    const www = network({
      addresses: { "settle.ng": ["8.8.8.8"], "www.settle.ng": ["8.8.8.8"] },
      pages: {
        "https://settle.ng/": { status: 301, location: "https://www.settle.ng/" },
        "https://www.settle.ng/": { status: 200, body: tag },
      },
    });
    expect(await proveOwnership(site, "html_tag", www)).toEqual({ ok: true });

    // Someone else's page can't prove settle.ng is yours.
    const away = network({
      addresses: { "settle.ng": ["8.8.8.8"], "other.example.org": ["8.8.8.8"] },
      pages: {
        "https://settle.ng/": { status: 302, location: "https://other.example.org/" },
        "https://other.example.org/": { status: 200, body: tag },
      },
    });
    expect((await proveOwnership(site, "html_tag", away)).ok).toBe(false);
  });

  it("finds the DNS record, even when DNS splits it into pieces", async () => {
    const split = network({ txt: { "settle.ng": [["v=spf1 -all"], [TOKEN.slice(0, 20), TOKEN.slice(20)]] } });
    expect(await proveOwnership(site, "dns_txt", split)).toEqual({ ok: true });
    expect((await proveOwnership(site, "dns_txt", network({}))).ok).toBe(false);
  });

  it("proves a server only by a file on the server itself", async () => {
    const file = network({ pages: { "http://8.8.4.4/.well-known/ziki-verification.txt": { status: 200, body: `
${TOKEN}
` } } });
    expect(await proveOwnership(server, "server_file", file)).toEqual({ ok: true });
    expect((await proveOwnership(server, "server_file", network({}))).ok).toBe(false);
  });

  it("never proves a server through a domain that points at it", async () => {
    // Anyone can point their own domain at someone else's server and add the
    // TXT record, so that must not count as proof the server is theirs.
    const pointing = network({ txt: { "settle.ng": [[TOKEN]] }, addresses: { "settle.ng": ["8.8.4.4"] } });
    expect(OWNERSHIP_METHODS.server).toEqual(["server_file"]);
    expect((await proveOwnership(server, "dns_txt", pointing)).ok).toBe(false);
    expect((await proveOwnership(server, "server_dns" as OwnershipMethod, pointing)).ok).toBe(false);
  });

  it("proves a repo through the workspace's own GitHub App or a file in the repo", async () => {
    expect(await proveOwnership(repo, "github", network({ appSees: ["settle/app"] }))).toEqual({ ok: true });
    expect((await proveOwnership(repo, "github", network({}))).ok).toBe(false);
    expect(await proveOwnership(repo, "repo_file", network({ files: { "settle/app/.ziki-verification": `${TOKEN}\n` } }))).toEqual({ ok: true });
    expect((await proveOwnership(repo, "repo_file", network({ files: { "settle/app/.ziki-verification": "wrong" } }))).ok).toBe(false);
  });

  it("says what failed when the network itself is down", async () => {
    const down = { ...network({}), txt: async () => { throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" }); } };
    const result = await proveOwnership(site, "dns_txt", down);
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("DNS") });
  });

  it("refuses a way that doesn't fit the target", async () => {
    expect((await proveOwnership(site, "github", network({ appSees: ["settle.ng"] }))).ok).toBe(false);
  });

  it("connects only to the address it checked, so DNS rebinding can't reach a private one", async () => {
    // The connection's own lookup: any private answer refuses it, and the socket opens to the public address returned.
    const lookup = (answers: string[], options: { all?: boolean; family?: number } = {}) =>
      new Promise<{ error: Error | null; address: unknown }>((done) =>
        publicOnlyLookup(async () => answers.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })))(
          "settle.ng",
          options,
          (error, address) => done({ error, address }),
        ),
      );
    expect(await lookup(["8.8.8.8"])).toEqual({ error: null, address: "8.8.8.8" });
    expect((await lookup(["127.0.0.1"])).error).toBeInstanceOf(PrivateAddressError);
    expect((await lookup(["8.8.8.8", "10.0.0.5"])).error).toBeInstanceOf(PrivateAddressError);
    expect((await lookup(["8.8.8.8"], { all: true })).address).toEqual([{ address: "8.8.8.8", family: 4 }]);

    // The first lookup said public, but the connection would go private: refused with the private-network reason.
    const rebinding = { ...network({ addresses: { "settle.ng": ["8.8.8.8"] } }), get: vi.fn(async () => { throw new PrivateAddressError("settle.ng"); }) };
    expect(await proveOwnership(site, "html_tag", rebinding)).toEqual({ ok: false, reason: expect.stringContaining("private network") });
  });

  it("never opens a connection to an internal server, by name or by number", async () => {
    let hits = 0;
    const internal = createServer((_request, response) => {
      hits += 1;
      response.end(TOKEN);
    });
    await new Promise<void>((done) => internal.listen(0, "127.0.0.1", done));
    const { port } = internal.address() as AddressInfo;
    try {
      await expect(realNetwork.get(`http://localhost:${port}/`)).rejects.toBeInstanceOf(PrivateAddressError);
      await expect(realNetwork.get(`http://127.0.0.1:${port}/`)).rejects.toBeInstanceOf(PrivateAddressError);
      expect(hits).toBe(0);
    } finally {
      await new Promise((done) => internal.close(done));
    }
  });

  it("doesn't tell the client what status a page answered", async () => {
    const forbidden = network({ addresses: { "settle.ng": ["8.8.8.8"] }, pages: { "https://settle.ng/": { status: 403 } } });
    const result = await proveOwnership(site, "html_tag", forbidden);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("403");
  });
});

describe("ownership proof switched off (14 Nov plan, D1)", () => {
  const unproven = { verifiedAt: null };
  const proven = { verifiedAt: new Date("2026-11-12T10:00:00Z") };

  it("counts every target as proven while proof is off", () => {
    expect(isTargetProven(unproven, false)).toBe(true);
    expect(isTargetProven(proven, false)).toBe(true);
  });

  it("needs a real proof again once the setting is on", () => {
    expect(isTargetProven(unproven, true)).toBe(false);
    expect(isTargetProven(proven, true)).toBe(true);
  });

  it("is off unless SECURITY_OWNERSHIP_PROOF_REQUIRED is exactly \"true\"", () => {
    const before = process.env.SECURITY_OWNERSHIP_PROOF_REQUIRED;
    try {
      delete process.env.SECURITY_OWNERSHIP_PROOF_REQUIRED;
      expect(isTargetProven(unproven)).toBe(true);
      process.env.SECURITY_OWNERSHIP_PROOF_REQUIRED = "true";
      expect(isTargetProven(unproven)).toBe(false);
    } finally {
      if (before === undefined) delete process.env.SECURITY_OWNERSHIP_PROOF_REQUIRED;
      else process.env.SECURITY_OWNERSHIP_PROOF_REQUIRED = before;
    }
  });
});
