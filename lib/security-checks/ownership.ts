import "server-only";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { promises as dns, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import type { SecurityTargetKind } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { FINISHED_CHECK_STATUSES } from "@/lib/security-checks";

/**
 * Proving a target is yours (#security-checks, part 2). Until a target is
 * proven, no agent is given a job on it and nothing probes it. Each kind has
 * its ways to prove it, both built on the target's secret `ownershipToken`:
 *
 * - Website: a DNS TXT record on the domain, or a tag on the homepage.
 * - Server: a small file at a fixed address on the server. Only one way,
 *   because a domain that points at a server proves nothing: anyone can point
 *   their own domain at someone else's server.
 * - Repo: the workspace's own GitHub App can see the repo, or a file in the
 *   repo holds the token.
 *
 * Ziki only reads here: a DNS answer, one page, one file. Every connection
 * looks the name up once, refuses it unless every address is public, and
 * connects to exactly the address it checked, so a name that answers
 * differently the second time (DNS rebinding) can't steer Ziki at its own
 * network or anyone's private one. It follows at most a few redirects on the
 * same site, gives up after a few seconds, and reads at most a small amount.
 */

export type OwnershipMethod = "dns_txt" | "html_tag" | "server_file" | "github" | "repo_file";

/** The ways to prove each kind, the recommended one first. */
export const OWNERSHIP_METHODS: Record<SecurityTargetKind, readonly OwnershipMethod[]> = {
  website: ["dns_txt", "html_tag"],
  server: ["server_file"],
  repo: ["github", "repo_file"],
};

export function isOwnershipMethodFor(kind: SecurityTargetKind, value: unknown): value is OwnershipMethod {
  return typeof value === "string" && (OWNERSHIP_METHODS[kind] as readonly string[]).includes(value);
}

/** The homepage tag's name. */
export const TAG_NAME = "ziki-verification";
/** Where the file goes on a server. */
export const SERVER_FILE_PATH = "/.well-known/ziki-verification.txt";
/** The file's name at the top of a repo. */
export const REPO_FILE_PATH = ".ziki-verification";

export function homepageTag(token: string): string {
  return `<meta name="${TAG_NAME}" content="${token}">`;
}

export type ProofResult = { ok: true } | { ok: false; reason: string };

const NOT_PUBLIC = "That address points inside a private network, so Ziki won't look at it.";

/** A connection was refused because the name pointed at a private or internal address. */
export class PrivateAddressError extends Error {
  constructor(host: string) {
    super(`${host} points inside a private network.`);
    this.name = "PrivateAddressError";
  }
}
const TIMEOUT_MS = 5_000;
const MAX_BYTES = 512 * 1024;
const MAX_REDIRECTS = 3;

/* ------------------------------------------------------------------ */
/* Plain checks, no network                                            */
/* ------------------------------------------------------------------ */

const PRIVATE = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) PRIVATE.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["2001:db8::", 32], ["64:ff9b::", 96],
] as const) PRIVATE.addSubnet(net, prefix, "ipv6");

/** Whether an IP address is on the public internet (an IPv4 address wrapped in IPv6 is judged as itself). */
export function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return !PRIVATE.check(address, "ipv4");
  if (version !== 6) return false;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped) return isPublicAddress(mapped[1]);
  return !PRIVATE.check(address, "ipv6");
}

/** Whether any TXT record (its pieces joined, as DNS splits long ones) is the token. */
export function txtHasToken(records: readonly (readonly string[])[], token: string): boolean {
  return records.some((pieces) => pieces.join("").trim() === token);
}

/** Whether the page has `<meta name="ziki-verification" content="TOKEN">`, in any attribute order or quoting. */
export function pageHasTag(html: string, token: string): boolean {
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = new Map<string, string>();
    for (const attribute of match[0].matchAll(/([a-z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
      attributes.set(attribute[1].toLowerCase(), (attribute[2] ?? attribute[3] ?? attribute[4] ?? "").trim());
    }
    if (attributes.get("name")?.toLowerCase() === TAG_NAME && attributes.get("content") === token) return true;
  }
  return false;
}

/** Whether a file holds just the token (blank lines and spaces around it are fine). */
export function fileHasToken(text: string, token: string): boolean {
  return text.trim() === token;
}

/* ------------------------------------------------------------------ */
/* The network, behind one seam so the rules can be tested             */
/* ------------------------------------------------------------------ */

export type OwnershipNetwork = {
  /** TXT records for a name; empty when there are none. */
  txt(host: string): Promise<string[][]>;
  /** Every address a name points to; empty when it points nowhere. */
  addresses(host: string): Promise<string[]>;
  /** One GET, never following redirects itself. `location` is set on a redirect. */
  get(url: string): Promise<{ status: number; location: string | null; body: string }>;
  /** Whether this workspace's own GitHub App can see the repo. */
  workspaceAppSeesRepo(organisationId: string, repo: string): Promise<boolean>;
  /** A file at the top of the repo's default branch, or null when it isn't there. */
  repoFile(organisationId: string, repo: string, path: string): Promise<string | null>;
};

/** Prove a target is yours by one method. Never throws: a problem comes back as a plain reason. */
export async function proveOwnership(
  target: { organisationId: string; kind: SecurityTargetKind; value: string; ownershipToken: string },
  method: OwnershipMethod,
  network: OwnershipNetwork = realNetwork,
): Promise<ProofResult> {
  if (!isOwnershipMethodFor(target.kind, method)) return { ok: false, reason: "That way of showing it's yours doesn't fit this target." };
  const token = target.ownershipToken;
  try {
    switch (method) {
      case "dns_txt":
        return (await findTxt(network, target.value, token))
          ? { ok: true }
          : { ok: false, reason: `We can't see the TXT record on ${target.value} yet. New records can take up to an hour to show, so try again a little later.` };

      case "html_tag": {
        const page = await fetchOnSite(network, `https://${target.value}/`, target.value)
          .catch(() => fetchOnSite(network, `http://${target.value}/`, target.value));
        if (!page.ok) return page;
        return pageHasTag(page.body, token)
          ? { ok: true }
          : { ok: false, reason: `We opened ${target.value} but couldn't find the tag. Put it inside the <head> of your homepage, save, and try again.` };
      }

      case "server_file": {
        const host = isIP(target.value) === 6 ? `[${target.value}]` : target.value;
        const file = await fetchOnSite(network, `http://${host}${SERVER_FILE_PATH}`, target.value);
        if (!file.ok) return file;
        return fileHasToken(file.body, token)
          ? { ok: true }
          : { ok: false, reason: `We found ${SERVER_FILE_PATH} on ${target.value}, but it doesn't hold your code. Put only the code in the file and try again.` };
      }


      case "github":
        return (await network.workspaceAppSeesRepo(target.organisationId, target.value))
          ? { ok: true }
          : { ok: false, reason: `Ziki's GitHub App in this workspace can't see ${target.value} yet. Add the repo to the app on GitHub, then try again.` };

      case "repo_file": {
        const text = await network.repoFile(target.organisationId, target.value, REPO_FILE_PATH);
        if (text === null) return { ok: false, reason: `We can't find ${REPO_FILE_PATH} at the top of ${target.value}. Add it to the main branch, or connect the GitHub App if the repo is private.` };
        return fileHasToken(text, token)
          ? { ok: true }
          : { ok: false, reason: `${REPO_FILE_PATH} is there, but it doesn't hold your code. Put only the code in the file and try again.` };
      }
    }
  } catch (error) {
    if (error instanceof PrivateAddressError) return { ok: false, reason: NOT_PUBLIC };
    return { ok: false, reason: UNREACHABLE[method] };
  }
}

/** When the network itself fails, what to tell the client for each way. */
const UNREACHABLE: Record<OwnershipMethod, string> = {
  dns_txt: "We couldn't look up the DNS records just now. Try again in a minute.",
  html_tag: "We couldn't open the homepage just now. Check the site is online and try again.",
  server_file: "We couldn't reach the server just now. Check it's online and answers on port 80, then try again.",
  github: "We couldn't reach GitHub just now. Try again in a minute.",
  repo_file: "We couldn't reach GitHub just now. Try again in a minute.",
};

async function findTxt(network: OwnershipNetwork, host: string, token: string): Promise<boolean> {
  return txtHasToken(await network.txt(host), token);
}

/**
 * GET a page on the target's own site: every hop must point to public
 * addresses and stay on the same site (with or without `www.`), and a page
 * that keeps redirecting is refused.
 */
async function fetchOnSite(network: OwnershipNetwork, start: string, site: string): Promise<({ ok: true; body: string }) | { ok: false; reason: string }> {
  const sameSite = (host: string) => host.replace(/^www\./, "").replace(/^\[|\]$/g, "") === site.replace(/^www\./, "");
  let url = new URL(start);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(host) ? [host] : await network.addresses(host);
    if (addresses.length === 0) return { ok: false, reason: `${host} doesn't point anywhere we can reach.` };
    if (!addresses.every(isPublicAddress)) return { ok: false, reason: NOT_PUBLIC };

    const answer = await network.get(url.toString());
    if (answer.status >= 300 && answer.status < 400 && answer.location) {
      const next = new URL(answer.location, url);
      if ((next.protocol !== "https:" && next.protocol !== "http:") || !sameSite(next.hostname)) {
        return { ok: false, reason: `${site} sends visitors to another site, so we can't check it there. Put it on ${site} itself.` };
      }
      url = next;
      continue;
    }
    // No status code in the reason: it would tell the client what answered, and nothing more is needed.
    if (answer.status < 200 || answer.status >= 300) return { ok: false, reason: `We couldn't open that page on ${site}. Check it opens in a browser, then try again.` };
    return { ok: true, body: answer.body };
  }
  return { ok: false, reason: `${site} keeps redirecting, so we couldn't read it.` };
}

/* ------------------------------------------------------------------ */
/* The real network                                                    */
/* ------------------------------------------------------------------ */

export const realNetwork: OwnershipNetwork = {
  async txt(host) {
    try {
      return await dns.resolveTxt(host);
    } catch (error) {
      if (isNoRecord(error)) return [];
      if (!isResolverDown(error)) throw error;
    }
    // The machine's own DNS wouldn't answer (some hosts and Windows set-ups refuse
    // these lookups): ask public DNS instead, which also sees new records sooner.
    try {
      return await publicDns.resolveTxt(host);
    } catch (error) {
      if (isNoRecord(error)) return [];
      throw error;
    }
  },
  async addresses(host) {
    try {
      return (await dns.lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);
    } catch (error) {
      if (isNoRecord(error)) return [];
      throw error;
    }
  },
  async get(url) {
    const target = new URL(url);
    const host = target.hostname.replace(/^\[|\]$/g, "");
    // An address typed as a number skips the lookup below, so check it here.
    if (isIP(host) && !isPublicAddress(host)) throw new PrivateAddressError(host);
    const client = target.protocol === "https:" ? https : http;
    return new Promise((resolve, reject) => {
      const request = client.request(
        target,
        {
          method: "GET",
          // No shared connection pool: every request makes its own checked connection.
          agent: false,
          lookup: publicOnlyLookup(),
          signal: AbortSignal.timeout(TIMEOUT_MS),
          headers: { "User-Agent": "ZikiOwnershipCheck/1.0 (+https://ziki.dev)", Accept: "text/html,text/plain;q=0.9,*/*;q=0.1" },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          const finish = () =>
            resolve({
              status: response.statusCode ?? 0,
              location: typeof response.headers.location === "string" ? response.headers.location : null,
              body: Buffer.concat(chunks).subarray(0, MAX_BYTES).toString("utf8"),
            });
          response.on("data", (chunk: Buffer) => {
            chunks.push(chunk);
            size += chunk.length;
            if (size >= MAX_BYTES) response.destroy();
          });
          response.on("end", finish);
          response.on("close", finish);
          response.on("error", reject);
        },
      );
      request.on("error", reject);
      request.end();
    });
  },
  async workspaceAppSeesRepo(organisationId, repo) {
    const { githubClientFor } = await import("@/lib/github/client");
    for (const project of await workspaceInstallations(organisationId)) {
      const client = await githubClientFor(project);
      // Only the workspace's own app counts: Ziki's shared token can see repos that aren't theirs.
      if (client.auth !== "app") continue;
      if (await client.getOrNull(`/repos/${repo}`)) return true;
    }
    return false;
  },
  async repoFile(organisationId, repo, path) {
    const { githubClientFor } = await import("@/lib/github/client");
    // The file itself is the proof, so any way of reading it will do: the workspace's app first, for a private repo.
    const installations = await workspaceInstallations(organisationId);
    for (const project of [...installations, { githubInstallationId: null }]) {
      const client = await githubClientFor(project);
      const file = await client.getOrNull<{ content?: string; encoding?: string }>(`/repos/${repo}/contents/${encodeURIComponent(path)}`);
      if (file?.content && file.encoding === "base64") return Buffer.from(file.content, "base64").toString("utf8").slice(0, MAX_BYTES);
    }
    return null;
  },
};

/** Public DNS, asked when the machine's own DNS won't answer a TXT lookup. */
const publicDns = new dns.Resolver({ timeout: 3000, tries: 2 });
publicDns.setServers(["1.1.1.1", "8.8.8.8"]);

/** The lookup never got an answer, as opposed to "there is no such record". */
function isResolverDown(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "ECONNREFUSED" || code === "ETIMEOUT" || code === "ECONNRESET" || code === "EREFUSED";
}

function isNoRecord(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "ENODATA" || code === "ENOTFOUND" || code === "NXDOMAIN" || code === "ESERVFAIL";
}

type Resolve = (host: string) => Promise<LookupAddress[]>;

const systemResolve: Resolve = (host) => dns.lookup(host, { all: true, verbatim: true });

/**
 * The lookup a connection itself uses: it resolves the name once and refuses
 * unless every address is public, and the socket then opens to the very
 * address returned here. There is no second lookup for a name to answer
 * differently (DNS rebinding).
 */
export function publicOnlyLookup(resolve: Resolve = systemResolve): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname).then(
      (found) => {
        const wanted = options.family === 4 || options.family === 6 ? found.filter((entry) => entry.family === options.family) : found;
        if (wanted.length === 0) {
          callback(Object.assign(new Error(`${hostname} doesn't point anywhere.`), { code: "ENOTFOUND" }), "", 0);
          return;
        }
        if (!found.every((entry) => isPublicAddress(entry.address))) {
          callback(Object.assign(new PrivateAddressError(hostname), { code: "EPRIVATE" }), "", 0);
          return;
        }
        if (options.all) callback(null, wanted);
        else callback(null, wanted[0]!.address, wanted[0]!.family);
      },
      (error: NodeJS.ErrnoException) => callback(error, "", 0),
    );
  };
}

async function workspaceInstallations(organisationId: string): Promise<{ githubInstallationId: string }[]> {
  const projects = await prisma.project.findMany({
    where: { organisationId, archivedAt: null, githubInstallationId: { not: null } },
    select: { githubInstallationId: true },
  });
  return [...new Set(projects.map((project) => project.githubInstallationId!))].map((githubInstallationId) => ({ githubInstallationId }));
}

/* ------------------------------------------------------------------ */
/* Recording the proof                                                 */
/* ------------------------------------------------------------------ */

/**
 * Mark a target proven and let its checks start: `verifiedAt` and
 * `ownershipMethod` are set once (a target already proven keeps its first
 * proof), and its checks waiting for proof move to `queued`, where part 3
 * picks them up. Returns the check the client goes on to, and every check
 * now queued for the target, so the caller can start them at once.
 */
export async function recordOwnership(
  targetId: string,
  organisationId: string,
  userId: string,
  method: OwnershipMethod,
): Promise<{ checkId: string | null; queued: string[] }> {
  return prisma.$transaction(async (tx) => {
    await tx.securityTarget.updateMany({
      where: { id: targetId, organisationId, verifiedAt: null },
      data: { ownershipMethod: method, verifiedAt: new Date() },
    });
    await tx.securityCheck.updateMany({
      where: { targetId, organisationId, status: "awaiting_ownership" },
      data: { status: "queued" },
    });
    const open = await tx.securityCheck.findFirst({
      // Checks are per person: go on with this person's own check.
      where: { targetId, organisationId, requestedById: userId, status: { notIn: [...FINISHED_CHECK_STATUSES] } },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    const queued = await tx.securityCheck.findMany({
      where: { targetId, organisationId, status: "queued" },
      select: { id: true },
    });
    return { checkId: open?.id ?? null, queued: queued.map((check) => check.id) };
  });
}
