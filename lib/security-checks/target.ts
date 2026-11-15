import type { SecurityTargetKind } from "@prisma/client";

/**
 * Reading what a client pastes into the Security box (#security-checks, part 1):
 * a website, a server address or a GitHub repo, in one tidy form that is
 * stored once per workspace as `SecurityTarget.value`.
 *
 * Plain functions with no server imports, so the box can show the kind live
 * while the client types and the server action parses it again on submit.
 *
 * Addresses that only make sense inside someone's own network (localhost,
 * private and reserved IP ranges, `.local`, `.internal`) are refused: agents
 * must never be pointed at Ziki's own network or anyone's private one.
 */

export type ParsedTarget = { kind: SecurityTargetKind; value: string; input: string };
export type TargetParseResult = { ok: true; target: ParsedTarget } | { ok: false; error: string };

/**
 * The address to hand to anything that reads a link again (the quick scan, Show
 * it's yours): a repo's value is just "owner/name", which the parser does not
 * accept on its own, so it goes with its GitHub address. Websites and servers
 * are already their own address.
 */
export function targetAddress(target: Pick<ParsedTarget, "kind" | "value">): string {
  return target.kind === "repo" ? `github.com/${target.value}` : target.value;
}

export const TARGET_INPUT_MAX = 300;

const EMPTY = "Paste a website, a server address or a GitHub repo.";
const UNREADABLE = "That doesn't look like a website, server address or GitHub repo.";
export const PRIVATE_TARGET_ERROR = "That address is private to a network. Paste one that's reachable from the internet.";

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const GITHUB_NAME = /^[a-z0-9](?:[a-z0-9-]{0,38})$/;
const REPO_NAME = /^[a-z0-9._-]{1,100}$/;
const BLOCKED_SUFFIXES = [".local", ".localhost", ".internal", ".lan", ".home", ".corp", ".test", ".invalid", ".example", ".onion"];

/** Parse what the client typed. Never throws. */
export function parseSecurityTarget(raw: unknown): TargetParseResult {
  if (typeof raw !== "string") return { ok: false, error: EMPTY };
  const input = raw.trim();
  if (!input) return { ok: false, error: EMPTY };
  if (input.length > TARGET_INPUT_MAX || /\s/.test(input)) return { ok: false, error: UNREADABLE };

  const repo = parseRepo(input);
  if (repo) return repo === "bad" ? { ok: false, error: UNREADABLE } : { ok: true, target: { kind: "repo", value: repo, input } };

  const server = parseServer(input);
  if (server) {
    if (server === "private") return { ok: false, error: PRIVATE_TARGET_ERROR };
    if (server === "bad") return { ok: false, error: UNREADABLE };
    return { ok: true, target: { kind: "server", value: server, input } };
  }

  const site = parseWebsite(input);
  if (site === "private") return { ok: false, error: PRIVATE_TARGET_ERROR };
  if (!site || site === "bad") return { ok: false, error: UNREADABLE };
  return { ok: true, target: { kind: "website", value: site, input } };
}

/** The kind to show while the client is still typing, or null if it can't be read yet. */
export function detectSecurityTargetKind(raw: string): SecurityTargetKind | null {
  const parsed = parseSecurityTarget(raw);
  return parsed.ok ? parsed.target.kind : null;
}

/** `github.com/owner/name` in any usual form → `owner/name`; "bad" for a GitHub link that isn't a repo. */
function parseRepo(input: string): string | "bad" | null {
  const lower = input.toLowerCase();
  let path: string | null = null;
  const ssh = /^git@github\.com:(.+)$/.exec(lower);
  if (ssh) path = ssh[1];
  else {
    const web = /^(?:(?:https?|git|ssh):\/\/)?(?:[^@/]+@)?(?:www\.)?github\.com(?::\d+)?\/(.*)$/.exec(lower);
    if (web) path = web[1];
  }
  if (path === null) return null;
  const [owner, rawName] = path.split(/[?#]/)[0].split("/").filter(Boolean);
  const name = rawName?.replace(/\.git$/, "");
  if (!owner || !name || !GITHUB_NAME.test(owner) || !REPO_NAME.test(name) || name === "." || name === "..") return "bad";
  return `${owner}/${name}`;
}

/** An IP address, or an `ssh://` address, is a server. The value is the IP or host. */
function parseServer(input: string): string | "private" | "bad" | null {
  let host = input;
  const ssh = /^ssh:\/\/(?:[^@/]+@)?([^/]+?)\/?$/i.exec(input);
  if (ssh) host = ssh[1];
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    // A web URL whose host is an IP is still a server.
    try {
      host = new URL(input).hostname;
    } catch {
      return null;
    }
  }

  const bracketed = /^\[([0-9a-f:.]+)\](?::\d{1,5})?$/i.exec(host);
  const bareV6 = !bracketed && host.split(":").length > 2 ? host : null;
  const v6 = bracketed?.[1] ?? bareV6;
  if (v6) {
    const normal = normaliseIPv6(v6);
    if (!normal) return "bad";
    return isPrivateIPv6(normal) ? "private" : normal;
  }

  const v4 = /^(\d{1,3}(?:\.\d{1,3}){3})(?::\d{1,5})?$/.exec(host);
  if (v4) {
    const parts = v4[1].split(".").map(Number);
    if (parts.some((n, i) => n > 255 || String(n) !== v4[1].split(".")[i])) return "bad";
    return isPrivateIPv4(parts) ? "private" : parts.join(".");
  }

  if (ssh) {
    const name = hostName(host.replace(/:\d{1,5}$/, ""));
    if (name === "private") return "private";
    return name ?? "bad";
  }
  return null;
}

/** A domain or web URL → its host, lower case, without `www.` and without a trailing dot. */
function parseWebsite(input: string): string | "private" | "bad" | null {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "bad";
  if (url.username || url.password) return "bad";
  return hostName(url.hostname);
}

function hostName(rawHost: string): string | "private" | null {
  const host = rawHost.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  if (!host || host.length > 253) return null;
  if (host === "localhost" || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) return "private";
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label)) || !TLD.test(labels[labels.length - 1])) return null;
  return host;
}

function isPrivateIPv4([a, b, c]: number[]): boolean {
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

/** Full eight-group lower-case form, or null if it isn't an IPv6 address. */
function normaliseIPv6(raw: string): string | null {
  let text = raw.toLowerCase();
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (dotted) {
    const parts = dotted[1].split(".").map(Number);
    if (parts.some((n) => n > 255)) return null;
    text = text.slice(0, -dotted[1].length) + `${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => g.replace(/^0+(?=.)/, "")).join(":");
}

function isPrivateIPv6(full: string): boolean {
  const groups = full.split(":").map((g) => parseInt(g, 16));
  if (groups.every((g) => g === 0)) return true; // ::
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true; // ::1
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    // IPv4-mapped: judge the IPv4 inside.
    return isPrivateIPv4([groups[6] >> 8, groups[6] & 255, groups[7] >> 8]);
  }
  const first = groups[0];
  return (
    (first & 0xfe00) === 0xfc00 || // unique local fc00::/7
    (first & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (first & 0xff00) === 0xff00 || // multicast
    (first === 0x2001 && groups[1] === 0x0db8) // documentation
  );
}
