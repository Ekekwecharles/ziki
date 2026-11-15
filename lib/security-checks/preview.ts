import "server-only";
import { isIP } from "node:net";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { getDomain } from "tldts";
import type { SecuritySeverity, SecurityTargetKind } from "@prisma/client";
import { GitHubError, githubApiUrl, githubClientFor, installationIdForRepo } from "@/lib/github/client";
import { logger } from "@/lib/logger";
import { consumeRateLimit } from "@/lib/rate-limit";
import { PREVIEW_SCANS_PER_VISITOR_PER_HOUR, scanLimitsEnabled } from "@/lib/security-checks";
import { isPublicAddress, PrivateAddressError, publicOnlyLookup, realNetwork } from "@/lib/security-checks/ownership";
import { parseSecurityTarget } from "@/lib/security-checks/target";

/**
 * The quick preview scan on the public security page (#security-checks, 12 Nov
 * plan, part D3). Code only: no agents and no AI, so it costs almost nothing.
 *
 * It reads only what any visitor's browser already gets from a site: the
 * homepage's response headers and cookies, its HTTPS certificate, and the
 * domain's public SPF and DMARC records. It never probes: no login forms, no
 * guessed paths, no port scans. Every connection goes through the same
 * public-only lookup as the ownership check, so a link can't point Ziki at a
 * private network, by name, by number or by DNS rebinding.
 *
 * The result is shown blurred until the site is proven to be the client's.
 * It is rate-limited per visitor and cached per link for a short while.
 */

/** How long one link's result is reused. */
export const PREVIEW_CACHE_MS = 10 * 60 * 1000;

const TIMEOUT_MS = 5_000;
/** Same-site HTTPS redirects followed before the homepage is called unreadable (browsers allow about 20). */
export const MAX_REDIRECTS = 10;
const EXPIRING_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

export type PreviewArea = "https" | "certificate" | "headers" | "cookies" | "email" | "secrets" | "policy" | "updates";

export type PreviewFinding = {
  /** Stable for each kind of problem, so a page can key and count them. */
  id: string;
  severity: SecuritySeverity;
  area: PreviewArea;
  title: string;
  detail: string;
};

export type PreviewResult =
  | {
      ok: true;
      kind: SecurityTargetKind;
      target: string;
      checkedAt: string;
      /** Which areas were looked at, so "no problems" is honest about what it covers. */
      checked: PreviewArea[];
      counts: Record<SecuritySeverity, number>;
      /** Worst first. */
      findings: PreviewFinding[];
    }
  | { ok: false; reason: string; retryAfterSeconds?: number };

/* ------------------------------------------------------------------ */
/* The network, behind one seam so the rules can be tested             */
/* ------------------------------------------------------------------ */

export type PageAnswer = { status: number; location: string | null; headers: Record<string, string | string[] | undefined> };

export type CertificateAnswer = {
  /** Whether the certificate chain is trusted for this name. */
  authorized: boolean;
  authorizationError: string | null;
  validTo: Date | null;
  /** The TLS version agreed, for example "TLSv1.3". */
  protocol: string | null;
};

export type PreviewNetwork = {
  /** One GET that reads the headers only, never following redirects itself. */
  page(url: string): Promise<PageAnswer>;
  /** The HTTPS certificate on port 443, or null when nothing answers there. */
  certificate(host: string): Promise<CertificateAnswer | null>;
  /** TXT records for a name; empty when there are none. */
  txt(host: string): Promise<string[][]>;
  /** The file and folder names a public repo shows at its top level, in `.github` and in `docs`. */
  repo(owner: string, name: string): Promise<RepoAnswer>;
};

/** What a visitor to github.com sees of a repo: names only, never a file's contents. */
export type RepoAnswer =
  | { status: "ok"; root: string[]; github: string[]; docs: string[] }
  | { status: "not_found" }
  | { status: "unavailable"; /** Why GitHub couldn't be read, in a few words, for the person and the logs. */ detail?: string };

/* ------------------------------------------------------------------ */
/* The scan                                                            */
/* ------------------------------------------------------------------ */

const REPO_NOT_FOUND = "We couldn't see that repo on GitHub. It may be private or the name may be wrong. You can still show it's yours and agents will check it properly.";
const REPO_UNAVAILABLE = "We couldn't read that repo from GitHub just now. Try again in a little while.";
const unavailableReason = (detail?: string) => (detail ? `We couldn't read that repo from GitHub just now (${detail}). Try again in a little while.` : REPO_UNAVAILABLE);
const LIMIT_REASON = "You've run a few previews already. Try again in a little while, or sign up to check your site properly.";
const NOT_PUBLIC = "That address points inside a private network, so Ziki won't look at it.";

const cache = new Map<string, { at: number; result: Extract<PreviewResult, { ok: true }> }>();

/**
 * Preview a pasted link. `visitor` is the visitor's IP (or another stable key)
 * for the rate limit. Never throws: a problem comes back as a plain reason.
 */
export async function previewScan(
  link: string,
  {
    visitor,
    network = realPreviewNetwork,
    now = Date.now(),
    limited = scanLimitsEnabled(),
  }: { visitor: string; network?: PreviewNetwork; now?: number; limited?: boolean },
): Promise<PreviewResult> {
  const parsed = parseSecurityTarget(link);
  if (!parsed.ok) return { ok: false, reason: parsed.error };
  const { kind, value } = parsed.target;

  const cacheKey = `${kind}:${value}`;
  const cached = cache.get(cacheKey);
  if (cached && now - cached.at < PREVIEW_CACHE_MS) return cached.result;

  // The per-visitor limit counts only while scan limits are on (14 Nov plan: off for now, not removed).
  if (limited) {
    const limit = await consumeRateLimit(`security-preview:${visitor}`, { max: PREVIEW_SCANS_PER_VISITOR_PER_HOUR, windowMs: 60 * 60 * 1000 }, now);
    if (!limit.allowed) return { ok: false, reason: LIMIT_REASON, retryAfterSeconds: Math.ceil(limit.retryAfterMs / 1000) };
  }

  try {
    const result = kind === "repo" ? await scanRepo(value, network, now) : await scan(kind, value, network, now);
    if (result.ok) {
      cache.set(cacheKey, { at: now, result });
      for (const [key, entry] of cache) if (now - entry.at >= PREVIEW_CACHE_MS) cache.delete(key);
    }
    return result;
  } catch (error) {
    if (error instanceof PrivateAddressError) return { ok: false, reason: NOT_PUBLIC };
    return { ok: false, reason: `We couldn't reach ${value} just now. Check it opens in a browser, then try again.` };
  }
}

/** Forget cached results (tests). */
export function clearPreviewCache(): void {
  cache.clear();
}

async function scan(
  kind: Exclude<SecurityTargetKind, "repo">,
  value: string,
  network: PreviewNetwork,
  now: number,
): Promise<PreviewResult> {
  const host = isIP(value) === 6 ? `[${value}]` : value;
  // Mail records live on the registrable domain (app.example.co.uk -> example.co.uk), not on each subdomain.
  const mailDomain = kind === "website" ? emailDomainFor(value) : null;
  const [home, plain, certificate, spf, dmarc] = await Promise.all([
    homepage(network, `https://${host}/`, value).catch(rethrowPrivate),
    network.page(`http://${host}/`).catch(rethrowPrivate),
    network.certificate(value).catch(rethrowPrivate),
    mailDomain ? readTxt(network, mailDomain) : Promise.resolve(null),
    mailDomain ? readDmarc(network, value, mailDomain) : Promise.resolve(null),
  ]);
  // Too many redirects says nothing about HTTPS either way: don't call it missing.
  const tooManyRedirects = home === TOO_MANY_REDIRECTS;
  const secure = tooManyRedirects ? null : home;

  if (!secure && !plain && !tooManyRedirects) {
    return { ok: false, reason: `${value} didn't answer on the web (ports 80 and 443). Check it opens in a browser, then try again.` };
  }

  const findings: PreviewFinding[] = [];
  const checked: PreviewArea[] = tooManyRedirects ? [] : ["https"];

  if (tooManyRedirects) {
    // Couldn't check: the homepage kept redirecting on its own site, so HTTPS isn't judged.
  } else if (!secure) {
    findings.push({
      id: "no-https",
      severity: "high",
      area: "https",
      title: "The site doesn't work over HTTPS",
      detail: `${value} answers on plain HTTP but not on HTTPS, so what visitors send and receive can be read or changed on the way.`,
    });
  } else if (plain && !redirectsToHttps(plain, value)) {
    findings.push({
      id: "no-https-redirect",
      severity: "medium",
      area: "https",
      title: "Plain HTTP doesn't send visitors to HTTPS",
      detail: `http://${value} doesn't redirect to https://, so anyone who types the address without https stays on an unprotected connection.`,
    });
  }

  if (certificate) {
    checked.push("certificate");
    findings.push(...certificateFindings(certificate, kind, value, now));
  }

  // Headers and cookies are read from the site's own page, not from a redirect that sends visitors elsewhere.
  const page = secure && (secure.status < 300 || secure.status >= 400) ? secure : null;
  if (page) {
    checked.push("headers", "cookies");
    findings.push(...headerFindings(page.headers));
    findings.push(...cookieFindings(page.headers));
  }

  // A record is only called missing when the lookup really answered: a lookup that failed says nothing.
  if (mailDomain && (spf !== null || dmarc !== null)) {
    checked.push("email");
    findings.push(...emailFindings(spf, dmarc, mailDomain));
  }

  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const counts: Record<SecuritySeverity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return { ok: true, kind, target: value, checkedAt: new Date(now).toISOString(), checked, counts, findings };
}

/* ------------------------------------------------------------------ */
/* A public repo                                                       */
/* ------------------------------------------------------------------ */

/** Files that usually hold real secrets: the repo should never publish them. Examples and templates are fine. */
const SECRET_FILE = /^(\.env(\.(local|production|prod|development|staging))?|id_(rsa|dsa|ecdsa|ed25519)|credentials\.json|service-?account[\w-]*\.json|\.htpasswd|\.netrc|.+\.(pem|key|p12|pfx|jks|keystore))$/i;
/** A file at the top of a repo that says it depends on packages from somewhere. */
const DEPENDENCY_FILE = /^(package\.json|requirements[\w.-]*\.txt|pyproject\.toml|pipfile|gemfile|go\.mod|cargo\.toml|composer\.json|pom\.xml|build\.gradle(\.kts)?|pubspec\.yaml)$/i;
const SECURITY_POLICY_FILE = /^security\.(md|markdown|txt)$/i;
const UPDATE_BOT_FILE = /^(dependabot\.ya?ml|renovate\.json5?|\.renovaterc(\.json5?)?)$/i;

/**
 * A quick, code-only look at a public repo (13 Nov): the same promise as for a
 * site. It reads only the names of the files and folders any visitor to
 * github.com sees, never a file's contents and never anything it would have to
 * log in for. A private or missing repo says so and still goes on to "Show
 * it's yours".
 */
async function scanRepo(value: string, network: PreviewNetwork, now: number): Promise<PreviewResult> {
  const [owner, name] = value.split("/");
  const answer = await network.repo(owner, name);
  if (answer.status === "not_found") return { ok: false, reason: REPO_NOT_FOUND };
  if (answer.status === "unavailable") return { ok: false, reason: unavailableReason(answer.detail) };

  const findings: PreviewFinding[] = [];
  const checked: PreviewArea[] = ["secrets", "policy"];

  for (const file of answer.root.filter((entry) => SECRET_FILE.test(entry))) {
    findings.push({
      id: `secret-file:${file.toLowerCase()}`,
      severity: "high",
      area: "secrets",
      title: "A file that usually holds secrets is in the repo",
      detail: `${value} publishes a file named ${file}. If it holds real keys or passwords, anyone can read them, so they should be removed from the repo and changed.`,
    });
  }

  const hasPolicy = [...answer.root, ...answer.github, ...answer.docs].some((entry) => SECURITY_POLICY_FILE.test(entry));
  if (!hasPolicy) {
    findings.push({
      id: "no-security-policy",
      severity: "low",
      area: "policy",
      title: "The repo has no security policy",
      detail: `${value} has no SECURITY.md, so a person who finds a problem doesn't know how to report it privately.`,
    });
  }

  // Only judged when the repo says it depends on packages: a repo with no dependencies has nothing to keep up to date.
  if (answer.root.some((entry) => DEPENDENCY_FILE.test(entry))) {
    checked.push("updates");
    if (![...answer.root, ...answer.github].some((entry) => UPDATE_BOT_FILE.test(entry))) {
      findings.push({
        id: "no-dependency-updates",
        severity: "low",
        area: "updates",
        title: "Nothing keeps the repo's dependencies up to date",
        detail: `${value} has no Dependabot or Renovate setup, so known problems in its packages can sit there unnoticed.`,
      });
    }
  }

  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const counts: Record<SecuritySeverity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return { ok: true, kind: "repo", target: value, checkedAt: new Date(now).toISOString(), checked, counts, findings };
}

const SEVERITY_ORDER: Record<SecuritySeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** A private address stops the whole preview; any other failure just means "didn't answer". */
function rethrowPrivate(error: unknown): null {
  if (error instanceof PrivateAddressError || (error as { code?: string } | null)?.code === "EPRIVATE") {
    throw error instanceof PrivateAddressError ? error : new PrivateAddressError("private");
  }
  return null;
}

/** TXT records, asked twice before giving up; null when no answer came (not the same as "no records"). */
async function readTxt(network: PreviewNetwork, host: string): Promise<string[][] | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await network.txt(host);
    } catch {
      // Try once more: a busy resolver often answers the second time.
    }
  }
  return null;
}

/** The registrable domain whose SPF and DMARC records cover `host`; the host itself when it has none (an IP, localhost). */
export function emailDomainFor(host: string): string {
  return getDomain(host, { allowPrivateDomains: false }) ?? host;
}

/**
 * The DMARC records that apply to `host`: its own `_dmarc` record, else the
 * registrable domain's (RFC 7489 section 6.6.3). Null when a lookup didn't answer.
 */
async function readDmarc(network: PreviewNetwork, host: string, mailDomain: string): Promise<string[][] | null> {
  const own = await readTxt(network, `_dmarc.${host}`);
  if (host === mailDomain || own === null) return own;
  const hasPolicy = own.some((parts) => parts.join("").trim().toLowerCase().startsWith("v=dmarc1"));
  return hasPolicy ? own : readTxt(network, `_dmarc.${mailDomain}`);
}

const TOO_MANY_REDIRECTS = "too_many_redirects" as const;

/**
 * The homepage's headers, following same-site HTTPS redirects. Null when it
 * doesn't answer; TOO_MANY_REDIRECTS when it still redirects after MAX_REDIRECTS.
 */
async function homepage(network: PreviewNetwork, start: string, site: string): Promise<PageAnswer | typeof TOO_MANY_REDIRECTS | null> {
  let url = new URL(start);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const answer = await network.page(url.toString());
    if (answer.status >= 300 && answer.status < 400 && answer.location) {
      const next = new URL(answer.location, url);
      // Stay on the same site over HTTPS: the preview is about this site, not wherever it points.
      if (next.protocol !== "https:" || !sameSite(next.hostname, site)) return answer;
      url = next;
      continue;
    }
    return answer;
  }
  return TOO_MANY_REDIRECTS;
}

function sameSite(host: string, site: string): boolean {
  return host.replace(/^\[|\]$/g, "").replace(/^www\./, "") === site.replace(/^www\./, "");
}

function redirectsToHttps(answer: PageAnswer, site: string): boolean {
  if (answer.status < 300 || answer.status >= 400 || !answer.location) return false;
  try {
    const next = new URL(answer.location, `http://${site}/`);
    return next.protocol === "https:" && sameSite(next.hostname, site);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* What each answer says (pure, so each rule is tested on its own)     */
/* ------------------------------------------------------------------ */

export function certificateFindings(
  certificate: CertificateAnswer,
  kind: Exclude<SecurityTargetKind, "repo">,
  value: string,
  now: number,
): PreviewFinding[] {
  const findings: PreviewFinding[] = [];
  const expired = certificate.validTo !== null && certificate.validTo.getTime() <= now;
  if (expired) {
    findings.push({
      id: "certificate-expired",
      severity: "high",
      area: "certificate",
      title: "The HTTPS certificate has expired",
      detail: `The certificate on ${value} expired on ${certificate.validTo!.toISOString().slice(0, 10)}. Browsers warn visitors away from the site.`,
    });
  } else if (certificate.validTo !== null && certificate.validTo.getTime() - now < EXPIRING_DAYS * DAY_MS) {
    findings.push({
      id: "certificate-expiring",
      severity: "medium",
      area: "certificate",
      title: "The HTTPS certificate expires soon",
      detail: `The certificate on ${value} expires on ${certificate.validTo.toISOString().slice(0, 10)}. If it isn't renewed, browsers will warn visitors away.`,
    });
  }
  // A server reached by its IP rarely has a certificate for that IP, so only a website's name is held to it.
  const nameMismatchOnIp = kind === "server" && certificate.authorizationError === "ERR_TLS_CERT_ALTNAME_INVALID";
  if (!certificate.authorized && !expired && !nameMismatchOnIp) {
    findings.push({
      id: "certificate-untrusted",
      severity: "high",
      area: "certificate",
      title: "Browsers don't trust the HTTPS certificate",
      detail: `The certificate on ${value} isn't trusted (${certificate.authorizationError ?? "unknown reason"}), so visitors see a security warning.`,
    });
  }
  if (certificate.protocol === "TLSv1" || certificate.protocol === "TLSv1.1") {
    findings.push({
      id: "old-tls",
      severity: "medium",
      area: "certificate",
      title: "The site still uses an old version of TLS",
      detail: `${value} agreed to ${certificate.protocol}, which browsers no longer consider safe. TLS 1.2 or 1.3 should be the minimum.`,
    });
  }
  return findings;
}

function header(headers: PageAnswer["headers"], name: string): string | null {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value.join(", ");
  return typeof value === "string" ? value : null;
}

export function headerFindings(headers: PageAnswer["headers"]): PreviewFinding[] {
  const findings: PreviewFinding[] = [];
  const csp = header(headers, "content-security-policy");
  if (!header(headers, "strict-transport-security")) {
    findings.push({
      id: "missing-hsts",
      severity: "medium",
      area: "headers",
      title: "Browsers aren't told to always use HTTPS",
      detail: "There is no Strict-Transport-Security header, so a visitor's first visit can be pushed onto plain HTTP.",
    });
  }
  if (!csp) {
    findings.push({
      id: "missing-csp",
      severity: "medium",
      area: "headers",
      title: "No Content Security Policy",
      detail: "There is no Content-Security-Policy header limiting where scripts may load from, which makes injected scripts (XSS) more harmful.",
    });
  }
  if (!header(headers, "x-frame-options") && !/frame-ancestors/i.test(csp ?? "")) {
    findings.push({
      id: "missing-frame-protection",
      severity: "medium",
      area: "headers",
      title: "Other sites can show this one inside a frame",
      detail: "Neither X-Frame-Options nor a frame-ancestors rule is set, so another site can load this one in a hidden frame and trick visitors into clicking (clickjacking).",
    });
  }
  if ((header(headers, "x-content-type-options") ?? "").toLowerCase() !== "nosniff") {
    findings.push({
      id: "missing-nosniff",
      severity: "low",
      area: "headers",
      title: "Browsers may guess file types",
      detail: "X-Content-Type-Options: nosniff is not set, so a browser may treat an uploaded file as a script.",
    });
  }
  if (!header(headers, "referrer-policy")) {
    findings.push({
      id: "missing-referrer-policy",
      severity: "low",
      area: "headers",
      title: "Full page addresses may leak to other sites",
      detail: "There is no Referrer-Policy header, so links to other sites may pass on the full address of the page the visitor came from.",
    });
  }
  const server = header(headers, "server");
  const poweredBy = header(headers, "x-powered-by");
  if ((server && /\d/.test(server)) || poweredBy) {
    findings.push({
      id: "version-disclosure",
      severity: "low",
      area: "headers",
      title: "The site says what software it runs",
      detail: "The response headers name the server software or framework (sometimes with its version), which helps an attacker look up known holes.",
    });
  }
  return findings;
}

export function cookieFindings(headers: PageAnswer["headers"]): PreviewFinding[] {
  const raw = headers["set-cookie"];
  const cookies = (Array.isArray(raw) ? raw : raw ? [raw] : []).map((cookie) => cookie.toLowerCase());
  if (cookies.length === 0) return [];
  const attributes = (cookie: string) => cookie.split(";").slice(1).map((part) => part.trim().split("=")[0]);
  const count = (missing: (attrs: string[]) => boolean) => cookies.filter((cookie) => missing(attributes(cookie))).length;
  const plural = (n: number) => (n === 1 ? "1 cookie" : `${n} cookies`);

  const findings: PreviewFinding[] = [];
  const insecure = count((attrs) => !attrs.includes("secure"));
  if (insecure) {
    findings.push({
      id: "cookie-not-secure",
      severity: "medium",
      area: "cookies",
      title: "Cookies can be sent without HTTPS",
      detail: `${plural(insecure)} set on the homepage lack the Secure flag, so they can travel over plain HTTP where they can be read.`,
    });
  }
  const scriptReadable = count((attrs) => !attrs.includes("httponly"));
  if (scriptReadable) {
    findings.push({
      id: "cookie-not-httponly",
      severity: "low",
      area: "cookies",
      title: "Scripts on the page can read cookies",
      detail: `${plural(scriptReadable)} set on the homepage lack the HttpOnly flag. If any of them keeps someone signed in, an injected script could steal it.`,
    });
  }
  const noSameSite = count((attrs) => !attrs.includes("samesite"));
  if (noSameSite) {
    findings.push({
      id: "cookie-no-samesite",
      severity: "low",
      area: "cookies",
      title: "Cookies don't say when other sites may send them",
      detail: `${plural(noSameSite)} set on the homepage have no SameSite setting, which leaves more room for cross-site request forgery.`,
    });
  }
  return findings;
}

/** `null` for either means its lookup didn't answer, so nothing is said about it. */
export function emailFindings(spf: readonly (readonly string[])[] | null, dmarc: readonly (readonly string[])[] | null, domain: string): PreviewFinding[] {
  const join = (records: readonly (readonly string[])[]) => records.map((parts) => parts.join("").trim().toLowerCase());
  const findings: PreviewFinding[] = [];
  if (spf !== null && !join(spf).some((record) => record.startsWith("v=spf1"))) {
    findings.push({
      id: "missing-spf",
      severity: "medium",
      area: "email",
      title: "Anyone can send email that claims to be from this domain",
      detail: `${domain} has no SPF record saying which servers may send its email, so spoofed mail is easier to pass off.`,
    });
  }
  if (dmarc === null) return findings;
  const policy = join(dmarc).find((record) => record.startsWith("v=dmarc1"));
  if (!policy) {
    findings.push({
      id: "missing-dmarc",
      severity: "medium",
      area: "email",
      title: "No DMARC policy for the domain's email",
      detail: `${domain} has no DMARC record, so receiving mail servers aren't told to reject mail that fakes the domain.`,
    });
  } else if (/(?:^|;)\s*p\s*=\s*none\b/.test(policy)) {
    findings.push({
      id: "dmarc-not-enforced",
      severity: "low",
      area: "email",
      title: "The DMARC policy only watches, it doesn't block",
      detail: `${domain}'s DMARC policy is p=none, so mail faking the domain is reported but still delivered.`,
    });
  }
  return findings;
}

/* ------------------------------------------------------------------ */
/* The real network                                                    */
/* ------------------------------------------------------------------ */

const USER_AGENT = "ZikiSecurityPreview/1.0 (+https://ziki.dev/security)";

export const realPreviewNetwork: PreviewNetwork = {
  async repo(owner, name) {
    // Public data only. Ziki's GitHub App is used when it covers the repo (its limit is the highest), else Ziki's token, else none.
    // Those can see private repos too, so a repo is only looked into once GitHub says it is public: what the quick look reads
    // is what any visitor to github.com sees, never more.
    const installationId = await installationIdForRepo(owner, name).catch(() => null);
    const github = await githubClientFor({ githubInstallationId: installationId });
    const base = `/repos/${owner}/${name}`;
    let detail = "";
    const viaClient = async (suffix: string): Promise<unknown | "not_found" | "unavailable"> => {
      try {
        const body = await github.getOrNull<unknown>(`${base}${suffix}`);
        return body === null ? "not_found" : body;
      } catch (error) {
        detail = error instanceof GitHubError && error.status ? `GitHub answered ${error.status}` : "Ziki couldn't reach GitHub";
        logger.warn(`[security-preview] couldn't read ${owner}/${name}${suffix} from GitHub (${github.auth}): ${detail}`, error instanceof Error ? error.message : error);
        return "unavailable";
      }
    };
    // A token GitHub rejects, or a spent limit on it, shouldn't stop a look at a public repo: ask once with no token at all.
    const anonymously = async (suffix: string): Promise<unknown | "not_found" | "unavailable"> => {
      try {
        const response = await fetch(`${githubApiUrl()}${base}${suffix}`, {
          headers: { Accept: "application/vnd.github+json", "User-Agent": USER_AGENT },
          signal: AbortSignal.timeout(TIMEOUT_MS),
          cache: "no-store",
        });
        if (response.status === 404) return "not_found";
        if (!response.ok) {
          detail ||= `GitHub answered ${response.status}`;
          return "unavailable";
        }
        return await response.json();
      } catch {
        detail ||= "Ziki couldn't reach GitHub";
        return "unavailable";
      }
    };
    const read = async (suffix: string): Promise<unknown | "not_found" | "unavailable"> => {
      const first = await viaClient(suffix);
      return first === "unavailable" && github.auth !== "none" ? anonymously(suffix) : first;
    };
    const namesIn = (body: unknown): string[] =>
      Array.isArray(body) ? body.flatMap((entry) => (typeof (entry as { name?: unknown })?.name === "string" ? [(entry as { name: string }).name] : [])) : [];

    const repo = await read("");
    if (repo === "not_found") return { status: "not_found" };
    if (repo === "unavailable") return { status: "unavailable", detail };
    // Private, or not clearly public: treated as not seen, so nothing about it is read.
    if ((repo as { private?: unknown } | null)?.private !== false) return { status: "not_found" };

    const root = await read("/contents");
    if (root === "not_found") return { status: "not_found" };
    if (root === "unavailable") return { status: "unavailable", detail };
    const rootNames = namesIn(root);
    // A policy can sit in .github or docs; the update bot's setup sits in .github. A folder that can't be read counts as empty.
    const folder = async (suffix: string) => {
      const body = await read(suffix);
      return body === "not_found" || body === "unavailable" ? [] : namesIn(body);
    };
    const [dotGithub, docs] = await Promise.all([
      rootNames.includes(".github") ? folder("/contents/.github") : Promise.resolve([] as string[]),
      rootNames.includes("docs") ? folder("/contents/docs") : Promise.resolve([] as string[]),
    ]);
    return { status: "ok", root: rootNames, github: dotGithub, docs };
  },
  async page(url) {
    const target = new URL(url);
    const host = target.hostname.replace(/^\[|\]$/g, "");
    // An address typed as a number skips the lookup, so check it here.
    if (isIP(host) && !isPublicAddress(host)) throw new PrivateAddressError(host);
    const client = target.protocol === "https:" ? https : http;
    return new Promise((resolve, reject) => {
      const request = client.request(
        target,
        {
          method: "GET",
          agent: false,
          lookup: publicOnlyLookup(),
          signal: AbortSignal.timeout(TIMEOUT_MS),
          // A certificate problem is reported by certificate(); here only the headers matter.
          rejectUnauthorized: false,
          headers: { "User-Agent": USER_AGENT, Accept: "text/html,*/*;q=0.1" },
        },
        (response) => {
          // Only the headers are needed: stop before reading the page itself.
          resolve({
            status: response.statusCode ?? 0,
            location: typeof response.headers.location === "string" ? response.headers.location : null,
            headers: response.headers,
          });
          response.destroy();
        },
      );
      request.on("error", reject);
      request.end();
    });
  },
  async certificate(host) {
    if (isIP(host) && !isPublicAddress(host)) throw new PrivateAddressError(host);
    return new Promise((resolve, reject) => {
      const socket = tls.connect({
        host,
        port: 443,
        // A name is checked against the certificate; an IP can't be sent as SNI.
        servername: isIP(host) ? undefined : host,
        lookup: publicOnlyLookup(),
        rejectUnauthorized: false,
        timeout: TIMEOUT_MS,
      });
      const done = (answer: CertificateAnswer | null) => {
        socket.destroy();
        resolve(answer);
      };
      socket.once("secureConnect", () => {
        const peer = socket.getPeerCertificate();
        const authorizationError = socket.authorizationError ? String((socket.authorizationError as NodeJS.ErrnoException).code ?? socket.authorizationError) : null;
        done({
          authorized: socket.authorized,
          authorizationError,
          validTo: peer?.valid_to ? new Date(peer.valid_to) : null,
          protocol: socket.getProtocol(),
        });
      });
      socket.once("timeout", () => done(null));
      socket.once("error", (error: NodeJS.ErrnoException) => {
        if (error instanceof PrivateAddressError || error.code === "EPRIVATE") reject(new PrivateAddressError(host));
        else done(null);
      });
    });
  },
  txt: (host) => realNetwork.txt(host),
};
