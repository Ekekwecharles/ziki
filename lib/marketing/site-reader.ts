import "server-only";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { checkSsrf, isPublicAddress } from "@/lib/webhooks/ssrf";

/**
 * Reads one page of a project's own website for the Marketing assistant
 * (#marketing-assistant), as text: title, description, headings, main text and
 * the site's own links. Only the project's site: HTTPS, the same host (with or
 * without www), public addresses only with the DNS answer pinned, redirects
 * checked the same way, a size and time limit. What it returns is the page's
 * content, never instructions.
 */

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 1_000_000;
const MAX_REDIRECTS = 3;
const TEXT_MAX = 6000;
const LINKS_MAX = 40;

export type SitePage = {
  url: string;
  status: number;
  title: string | null;
  description: string | null;
  headings: string[];
  text: string;
  links: { path: string; text: string }[];
};

export type SitePageResult = { ok: true; page: SitePage } | { ok: false; error: string };

const bareHost = (host: string) => host.toLowerCase().replace(/^www\./, "");

/** The page at `path` on the site, if it is the site's own address. */
export function sitePageUrl(siteUrl: string, path: string): URL | null {
  let site: URL;
  let page: URL;
  try {
    site = new URL(siteUrl);
    page = new URL(path || "/", site);
  } catch {
    return null;
  }
  if (page.protocol !== "https:" || page.username || page.password || page.port) return null;
  if (bareHost(page.hostname) !== bareHost(site.hostname)) return null;
  page.hash = "";
  return page;
}

type RawResponse = { status: number; location: string | null; contentType: string; body: string };

function get(url: URL, address: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, {
      method: "GET",
      agent: false,
      lookup: (_host, options, callback) => {
        const family = isIP(address);
        if (options.all) callback(null, [{ address, family }]);
        else callback(null, address, family);
      },
      headers: { "User-Agent": "ZikiMarketingAssistant/1.0 (+https://ziki.dev)", Accept: "text/html,application/xhtml+xml" },
    }, (response) => {
      const status = response.statusCode ?? 0;
      const location = typeof response.headers.location === "string" ? response.headers.location : null;
      const contentType = String(response.headers["content-type"] ?? "");
      if (status >= 300 && status < 400) {
        response.destroy();
        resolve({ status, location, contentType, body: "" });
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BYTES) {
          // Keep what fits: the top of a page carries what matters for marketing.
          chunks.push(chunk.subarray(0, chunk.length - (size - MAX_BYTES)));
          response.destroy();
          resolve({ status, location, contentType, body: Buffer.concat(chunks).toString("utf8") });
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({ status, location, contentType, body: Buffer.concat(chunks).toString("utf8") }));
      response.on("error", reject);
    });
    request.on("error", reject);
    request.setTimeout(TIMEOUT_MS, () => request.destroy(new Error("timeout")));
    request.end();
  });
}

/** Read `path` on the project's site. */
export async function readSitePage(siteUrl: string, path: string): Promise<SitePageResult> {
  const first = sitePageUrl(siteUrl, path);
  if (!first) return { ok: false, error: "That address isn't on the project's website. Give a path on the site, such as /pricing." };

  let url: URL = first;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const check = await checkSsrf(url.toString());
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (!check.ok || !isPublicAddress(check.address) || (isIP(host) && host !== check.address)) {
      return { ok: false, error: "The website's address can't be reached safely." };
    }
    let response: RawResponse;
    try {
      response = await get(url, check.address);
    } catch (error) {
      return { ok: false, error: error instanceof Error && error.message === "timeout" ? "The page took too long to load." : "The page couldn't be loaded." };
    }
    if (response.status >= 300 && response.status < 400) {
      const next: URL | null = response.location ? sitePageUrl(siteUrl, new URL(response.location, url).toString()) : null;
      if (!next) return { ok: false, error: "The page redirects off the project's website." };
      url = next;
      continue;
    }
    if (response.status >= 400) return { ok: false, error: `The page answered ${response.status}.` };
    if (!/text\/html|application\/xhtml/i.test(response.contentType)) return { ok: false, error: "That address isn't a web page." };
    return { ok: true, page: { url: url.toString(), status: response.status, ...readHtml(response.body, url) } };
  }
  return { ok: false, error: "The page redirects too many times." };
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (entity, code: string) => {
    if (code[0] === "#") {
      const point = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(point) && point > 0 && point < 0x110000 ? String.fromCodePoint(point) : "";
    }
    return ENTITIES[code.toLowerCase()] ?? entity;
  });
}

const clean = (html: string) => decode(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

function attribute(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match ? decode(match[2] ?? match[3] ?? match[4] ?? "").trim() : null;
}

/** The parts of a page that say what it markets. */
function readHtml(html: string, base: URL): Omit<SitePage, "url" | "status"> {
  const page = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1>/gi, " ");
  const title = clean(page.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "") || null;

  let description: string | null = null;
  for (const tag of page.match(/<meta\b[^>]*>/gi) ?? []) {
    const name = (attribute(tag, "name") ?? attribute(tag, "property") ?? "").toLowerCase();
    if (name === "description" || (name === "og:description" && !description)) description = attribute(tag, "content") || description;
  }

  const headings = [...page.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi)]
    .map((match) => `h${match[1]}: ${clean(match[2])}`)
    .filter((heading) => heading.length > 4)
    .slice(0, 40);

  const links: SitePage["links"] = [];
  const seen = new Set<string>();
  for (const match of page.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = attribute(match[1], "href");
    if (!href) continue;
    let target: URL;
    try { target = new URL(href, base); } catch { continue; }
    if (bareHost(target.hostname) !== bareHost(base.hostname) || !/^https?:$/.test(target.protocol)) continue;
    const path = target.pathname + target.search;
    const text = clean(match[2]).slice(0, 80);
    if (seen.has(path) || !text) continue;
    seen.add(path);
    links.push({ path, text });
    if (links.length >= LINKS_MAX) break;
  }

  const body = page.match(/<body\b[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? page;
  const text = clean(body.replace(/<\/(p|div|li|h[1-6]|section|article|br|tr)>/gi, "$& \n ")).slice(0, TEXT_MAX);
  return { title, description, headings, text, links };
}
