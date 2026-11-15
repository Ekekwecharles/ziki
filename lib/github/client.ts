import "server-only";
import { createSign } from "node:crypto";

/**
 * Ziki's own calls to GitHub (#github-status).
 *
 * Ziki reads an issue's linked pull request on GitHub itself, so the people
 * and agents working the issue see why it can't merge without leaving Ziki,
 * and can act on it from the issue page (update the branch, re-run failed
 * checks, merge, or send the fix back).
 *
 * How Ziki authenticates, best first:
 * 1. The project's GitHub App installation (`Project.githubInstallationId`,
 *    connected in project settings), when `GITHUB_APP_ID` and
 *    `GITHUB_APP_PRIVATE_KEY` are set. Ziki mints a short-lived installation
 *    token and keeps it in memory only; no token is stored.
 * 2. `GITHUB_TOKEN`: one token for every project (a fine-grained token with
 *    pull requests, contents, checks and actions access to the repositories).
 * 3. Nothing: public repositories can still be read, at GitHub's anonymous
 *    rate limit, but nothing can be changed.
 *
 * `GITHUB_API_URL` points Ziki at another API host (GitHub Enterprise, or a
 * local stand-in during development).
 */

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly documentation?: string,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

export type GitHubAuth = { kind: "app" | "token"; token: string } | { kind: "none" };

const API_VERSION = "2022-11-28";
const USER_AGENT = "ziki-github-status";
/** Every call gives up after this long, so a slow GitHub never holds a page. */
const TIMEOUT_MS = 10_000;

export function githubApiUrl(): string {
  return (process.env.GITHUB_API_URL?.trim() || "https://api.github.com").replace(/\/+$/, "");
}

function appCredentials(): { appId: string; privateKey: string } | null {
  const appId = process.env.GITHUB_APP_ID?.trim();
  const raw = process.env.GITHUB_APP_PRIVATE_KEY?.trim();
  if (!appId || !raw) return null;
  // Env files often hold the PEM on one line with literal "\n".
  return { appId, privateKey: raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw };
}

/** The app's own JWT (RS256, ten minutes at most), used only to mint installation tokens. */
function appJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: appId })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKey).toString("base64url");
  return `${unsigned}.${signature}`;
}

const installationTokens = new Map<string, { token: string; expiresAt: number }>();

async function installationToken(installationId: string): Promise<string | null> {
  const credentials = appCredentials();
  if (!credentials) return null;
  const cached = installationTokens.get(installationId);
  if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
  const response = await fetchWithTimeout(`${githubApiUrl()}/app/installations/${encodeURIComponent(installationId)}/access_tokens`, {
    method: "POST",
    headers: baseHeaders(appJwt(credentials.appId, credentials.privateKey)),
  });
  if (!response.ok) throw await errorFrom(response);
  const body = (await response.json()) as { token: string; expires_at: string };
  installationTokens.set(installationId, { token: body.token, expiresAt: Date.parse(body.expires_at) });
  return body.token;
}

const repoInstallations = new Map<string, { id: string | null; at: number }>();
const REPO_INSTALLATION_TTL_MS = 10 * 60_000;

/**
 * The installation of Ziki's GitHub App that covers `owner/repo`, asked of
 * GitHub as the app itself, or null when the app isn't set up or isn't
 * installed there. Used for Ziki's own repositories, such as the preview
 * builder, so no installation ID has to be configured.
 */
export async function installationIdForRepo(owner: string, repo: string): Promise<string | null> {
  const credentials = appCredentials();
  if (!credentials) return null;
  const key = `${owner}/${repo}`.toLowerCase();
  const cached = repoInstallations.get(key);
  if (cached && Date.now() - cached.at < REPO_INSTALLATION_TTL_MS) return cached.id;
  const response = await fetchWithTimeout(`${githubApiUrl()}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`, {
    method: "GET",
    headers: baseHeaders(appJwt(credentials.appId, credentials.privateKey)),
  });
  if (response.status === 404) {
    repoInstallations.set(key, { id: null, at: Date.now() });
    return null;
  }
  if (!response.ok) throw await errorFrom(response);
  const body = (await response.json()) as { id: number };
  const id = String(body.id);
  repoInstallations.set(key, { id, at: Date.now() });
  return id;
}

/** How Ziki talks to GitHub for a project. */
export async function githubAuthFor(project: { githubInstallationId: string | null }): Promise<GitHubAuth> {
  if (project.githubInstallationId) {
    const token = await installationToken(project.githubInstallationId);
    if (token) return { kind: "app", token };
  }
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token) return { kind: "token", token };
  return { kind: "none" };
}

function baseHeaders(token?: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": API_VERSION,
    "User-Agent": USER_AGENT,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new GitHubError(0, timedOut ? "GitHub took too long to answer." : "Ziki couldn't reach GitHub.");
  }
}

async function errorFrom(response: Response): Promise<GitHubError> {
  let message = `GitHub answered ${response.status}.`;
  let documentation: string | undefined;
  try {
    const body = (await response.json()) as { message?: string; documentation_url?: string };
    if (body.message) message = body.message;
    documentation = body.documentation_url;
  } catch {
    // Not JSON: keep the status line.
  }
  if (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") {
    message = "Ziki has used up its GitHub rate limit for now. Connect the GitHub App or set GITHUB_TOKEN for a higher one.";
  }
  return new GitHubError(response.status, message, documentation);
}

export type GitHubClient = {
  auth: GitHubAuth["kind"];
  /** True when Ziki can change things on GitHub (update a branch, re-run checks, merge). */
  canWrite: boolean;
  get<T>(path: string): Promise<T>;
  /** Like `get`, but a 404 is null instead of an error. */
  getOrNull<T>(path: string): Promise<T | null>;
  send<T>(method: "POST" | "PUT" | "PATCH", path: string, body?: unknown): Promise<T>;
};

/** A client for one project's repository calls. */
export async function githubClientFor(project: { githubInstallationId: string | null }): Promise<GitHubClient> {
  const auth = await githubAuthFor(project);
  const token = auth.kind === "none" ? undefined : auth.token;
  const request = async (method: string, path: string, body?: unknown): Promise<Response> =>
    fetchWithTimeout(`${githubApiUrl()}${path}`, {
      method,
      headers: { ...baseHeaders(token), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const json = async <T>(response: Response): Promise<T> => {
    if (response.status === 204 || response.headers.get("content-length") === "0") return undefined as T;
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  };

  return {
    auth: auth.kind,
    canWrite: auth.kind !== "none",
    async get<T>(path: string) {
      const response = await request("GET", path);
      if (!response.ok) throw await errorFrom(response);
      return json<T>(response);
    },
    async getOrNull<T>(path: string) {
      const response = await request("GET", path);
      if (response.status === 404) return null;
      if (!response.ok) throw await errorFrom(response);
      return json<T>(response);
    },
    async send<T>(method: "POST" | "PUT" | "PATCH", path: string, body?: unknown) {
      if (!token) throw new GitHubError(401, "Ziki has no GitHub access that can change this repository. Connect the project's GitHub App, or set GITHUB_TOKEN.");
      const response = await request(method, path, body);
      if (!response.ok) throw await errorFrom(response);
      return json<T>(response);
    },
  };
}
