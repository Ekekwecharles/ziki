/**
 * Local scenario: four security checks in the Demo workspace, so the check
 * page (progress, report, unpaid teaser) can be worked on before the engine
 * that fills them in lands (#security-checks, part 4).
 *
 *   pnpm db:scenario:security-checks
 *
 * - a website still waiting for its owner to prove it is theirs
 * - a website mid-check and unpaid: some parts done, problems found so far
 * - a repo finished and paid: the full report, with two problems already moved
 *   to the client's app (one Live and checked again, one In progress)
 * - a server finished and unpaid with no critical problem: the teaser shows
 *   the worst one found instead
 *
 * Additive only: it never resets or reseeds. Its rows have fixed ids
 * (`scn-sc-*`), and a rerun deletes and recreates just these targets, their
 * checks and their findings. It refuses to run against anything but a local
 * database.
 * Sign in as a member of the Demo workspace (`pnpm db:fixtures`). The script
 * prints each check's address.
 */
import { PrismaClient, type SecurityCheckItemStatus, type SecurityCheckStatus, type SecuritySeverity, type SecurityTargetKind } from "@prisma/client";
import { SEVERITY_PRICE } from "../../lib/security-checks";
import type { PreviewSummary } from "../../lib/security-checks/preview-summary";

const ORGANISATION_SLUG = "demo";
const OWNER_EMAIL = "demo@fixtures.local";
const P = "scn-sc";

const MIN = 60_000;
const HOUR = 60 * MIN;

function assertLocalDatabase(url: string | undefined): void {
  if (!url) throw new Error("DATABASE_URL is not set.");
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error(`Refusing to write a scenario to a non-local database (${host}).`);
  }
}

type Problem = { severity: SecuritySeverity; title: string; description: string; howToFix: string };
type Part = { title: string; status: SecurityCheckItemStatus; problems?: Problem[] };
type Scenario = {
  key: string;
  label: string;
  kind: SecurityTargetKind;
  input: string;
  value: string;
  verified: boolean;
  status: SecurityCheckStatus;
  paid: boolean;
  /** Ziki's summary; a done check is posted with it. The page shows one line, the PDF all of it. */
  summary?: string;
  /** How many of its first parts' problems the client has unlocked (12 Nov plan: per-finding unlocks). */
  unlockParts?: number;
  /** The quick scan saved when the asset was added (14 Nov plan): shown on the report until it is posted. */
  quickScan?: PreviewSummary;
  parts: Part[];
};

/** A website's quick scan: two short titles, as any browser could see them. */
function websiteQuickScan(target: string): PreviewSummary {
  return {
    kind: "website",
    target,
    checkedAt: "2026-11-14T09:00:00.000Z",
    total: 2,
    counts: { critical: 0, high: 0, medium: 1, low: 1 },
    risk: "medium",
    areas: [
      { area: "https", label: "HTTPS", problems: 0 },
      { area: "certificate", label: "Certificate", problems: 0 },
      { area: "headers", label: "Security headers", problems: 1 },
      { area: "cookies", label: "Cookies", problems: 1 },
    ],
    rows: [
      { severity: "medium", area: "cookies", price: SEVERITY_PRICE.medium, label: "Cookies", title: "Session cookie can be read by scripts" },
      { severity: "low", area: "headers", price: SEVERITY_PRICE.low, label: "Security headers", title: "No Strict-Transport-Security header" },
    ],
  };
}

const LOGIN_RATE_LIMIT: Problem = {
  severity: "critical",
  title: "Admin login has no limit on password guesses",
  description: "The `/admin/login` form accepts unlimited attempts from one address, so a password can be guessed by trying many in a row.",
  howToFix: "Limit attempts per account and per address (for example 5 a minute), and lock the account for a while after repeated failures.",
};
const MISSING_HSTS: Problem = {
  severity: "low",
  title: "No Strict-Transport-Security header",
  description: "Browsers are not told to always use HTTPS for this site, so a first visit over plain HTTP can be intercepted. Every HTTPS response was checked and none sends a `Strict-Transport-Security` header. Someone on the same Wi-Fi as a visitor could catch that first plain request and send them to a fake copy of the site before the redirect to HTTPS happens.",
  howToFix: "Send `Strict-Transport-Security: max-age=31536000; includeSubDomains` on every HTTPS response. Start with a short `max-age` (for example one day), check nothing breaks, then raise it to a year. Once it has run for a while, you can add the site to the browsers' preload list.",
};
const VERBOSE_ERRORS: Problem = {
  severity: "medium",
  title: "Error pages show stack traces",
  description: "A malformed request returns the full stack trace, which reveals file paths and library versions. Sending `/api/plans?id=abc` returns a 500 page listing the server's folders, the framework version and the database driver. An attacker can use those versions to look up known weaknesses that match them exactly.",
  howToFix: "Show a plain error page in production and log the details on the server only. Turn off debug output in the production settings, and return a short message such as \"Something went wrong\" with an error id the client can quote to support.",
};

const SCENARIOS: Scenario[] = [
  {
    key: "awaiting",
    label: "Waiting for ownership",
    kind: "website",
    input: "https://shop.example.test",
    value: "shop.example.test",
    verified: false,
    status: "awaiting_ownership",
    paid: false,
    quickScan: websiteQuickScan("shop.example.test"),
    parts: [],
  },
  {
    key: "checking",
    label: "Mid-check",
    kind: "website",
    input: "blog.example.test",
    value: "blog.example.test",
    verified: true,
    status: "checking",
    paid: false,
    quickScan: websiteQuickScan("blog.example.test"),
    parts: [
      { title: "Login form: rate limits", status: "done", problems: [LOGIN_RATE_LIMIT] },
      { title: "Security headers", status: "done", problems: [MISSING_HSTS] },
      { title: "Error pages", status: "done", problems: [VERBOSE_ERRORS] },
      {
        title: "Cookies: Secure and HttpOnly flags",
        status: "done",
        problems: [{
          severity: "high",
          title: "Session cookie readable from JavaScript",
          description: "The session cookie is set without `HttpOnly`, so any injected script can read it and take over the session.",
          howToFix: "Set the session cookie with `HttpOnly`, `Secure` and `SameSite=Lax`.",
        }],
      },
      { title: "TLS certificate and protocols", status: "skipped" },
      { title: "Open redirects", status: "checking" },
      { title: "Directory listing", status: "checking" },
      { title: "Exposed admin paths", status: "waiting" },
      { title: "Outdated JavaScript libraries", status: "waiting" },
      { title: "CORS settings", status: "waiting" },
    ],
  },
  {
    key: "paid",
    label: "Finished, 2 moved to the app",
    kind: "repo",
    input: "https://github.com/acme/web-app",
    value: "acme/web-app",
    verified: true,
    status: "done",
    paid: true,
    summary:
      "We checked 6 parts of acme/web-app and found 4 problems: 1 critical, 1 high, 1 medium and 1 low. Start with the critical one: a live payment key is in the code, so anyone with the repository can use it. The medium and low ones are quick to fix and can follow this week.",
    unlockParts: 2,
    parts: [
      {
        title: "Secrets committed to the repository",
        status: "done",
        problems: [{
          severity: "critical",
          title: "Live payment key committed in config",
          description: "`config/payments.ts` holds a live payment API key in plain text, readable by anyone with access to the repository. The key starts with `sk_live_`, so it works against real payments, not a test account. It has been in the code since the first commit, so everyone who ever cloned the repository has a copy, and anyone with it can issue refunds or read customers' payment history.",
          howToFix: "Revoke the key now in the payment provider's dashboard and issue a new one. Load the new key from an environment variable (for example `PAYMENTS_SECRET_KEY`) and never commit it. Then remove the old key from the git history, and add a secret scanner to CI so it can't happen again.",
        }],
      },
      {
        title: "SQL built from user input",
        status: "done",
        problems: [{
          severity: "high",
          title: "Search query built by joining strings",
          description: "`lib/search.ts` puts the search text straight into a SQL string, so crafted input can change the query. Searching for `' OR '1'='1` returned every row in the products table, including hidden ones. The same pattern could be used to read other tables, such as users and their password hashes.",
          howToFix: "Use parameterised queries (placeholders) instead of joining the user's text into the SQL. In `lib/search.ts`, pass the search text as a parameter to the query rather than adding it to the string, and check the other queries in `lib/` for the same pattern.",
        }],
      },
      { title: "Dependency versions", status: "done", problems: [VERBOSE_ERRORS] },
      { title: "Security headers", status: "done", problems: [MISSING_HSTS] },
      { title: "Authentication checks on API routes", status: "done" },
      { title: "File upload handling", status: "skipped" },
    ],
  },
  {
    key: "no-critical",
    label: "Finished, none moved yet",
    kind: "server",
    input: "203.0.113.10",
    value: "203.0.113.10",
    verified: true,
    status: "done",
    paid: false,
    summary:
      "We checked 4 parts of 203.0.113.10 and found 3 problems: 1 high, 1 medium and 1 low. Start with the high one.",
    parts: [
      {
        title: "Open ports",
        status: "done",
        problems: [{
          severity: "high",
          title: "Database port open to the internet",
          description: "Port 5432 (PostgreSQL) answers from any address, so anyone can try to log in to the database.",
          howToFix: "Close the port in the firewall and allow only the app servers' addresses.",
        }],
      },
      { title: "SSH settings", status: "done", problems: [VERBOSE_ERRORS] },
      { title: "Security headers", status: "done", problems: [MISSING_HSTS] },
      { title: "Software versions", status: "done" },
    ],
  },
];

async function main() {
  assertLocalDatabase(process.env.DATABASE_URL);
  const db = new PrismaClient();
  try {
    const organisation = await db.organisation.findUnique({ where: { slug: ORGANISATION_SLUG }, select: { id: true } });
    if (!organisation) throw new Error(`No "${ORGANISATION_SLUG}" workspace. Run pnpm db:fixtures first.`);
    const owner = await db.user.findUnique({ where: { email: OWNER_EMAIL }, select: { id: true } });
    if (!owner) throw new Error(`No ${OWNER_EMAIL} user. Run pnpm db:fixtures first.`);
    // A few of the workspace's agents, so each part shows who checked it.
    const agentIds = (
      await db.agentActivation.findMany({
        where: { organisationId: organisation.id, deactivatedAt: null },
        orderBy: { agentId: "asc" },
        take: 4,
        select: { agentId: true },
      })
    ).map((row) => row.agentId);
    const agentFor = (index: number) => (agentIds.length ? agentIds[index % agentIds.length] : null);

    // Deleting the targets removes their checks, parts and results with them;
    // the findings made from those results go first (their re-checks with them).
    await db.securityFinding.deleteMany({ where: { id: { startsWith: `${P}-` } } });
    await db.securityTarget.deleteMany({ where: { id: { startsWith: `${P}-` } } });

    const now = Date.now();
    for (const scenario of SCENARIOS) {
      const targetId = `${P}-target-${scenario.key}`;
      const checkId = `${P}-check-${scenario.key}`;
      const started = new Date(now - 2 * HOUR);
      await db.securityTarget.create({
        data: {
          id: targetId,
          organisationId: organisation.id,
          kind: scenario.kind,
          value: scenario.value,
          input: scenario.input,
          addedById: owner.id,
          ownershipToken: `${P}-token-${scenario.key}`,
          ownershipMethod: scenario.verified ? "dns_txt" : null,
          verifiedAt: scenario.verified ? new Date(now - 3 * HOUR) : null,
          previewSummary: scenario.quickScan ?? undefined,
        },
      });
      await db.securityCheck.create({
        data: {
          id: checkId,
          organisationId: organisation.id,
          targetId,
          requestedById: owner.id,
          status: scenario.status,
          priceCoins: 50,
          free: true,
          paidAt: scenario.paid ? new Date(now - 90 * MIN) : null,
          startedAt: scenario.verified ? started : null,
          finishedAt: scenario.status === "done" ? new Date(now - 30 * MIN) : null,
          // Done means the collated report is posted (#648): only then does the client see results.
          postedAt: scenario.status === "done" ? new Date(now - 30 * MIN) : null,
          summary: scenario.status === "done" ? (scenario.summary ?? null) : null,
          createdAt: new Date(now - 3 * HOUR),
        },
      });
      if (scenario.parts.length) {
        await db.securityCheckItem.create({
          data: {
            id: `${P}-item-${scenario.key}-split`,
            checkId,
            kind: "split",
            title: `Plan the checks for ${scenario.value}`,
            status: "done",
            agentId: agentFor(0),
            assignedAt: started,
            reportedAt: new Date(now - 110 * MIN),
            createdAt: started,
          },
        });
      }
      for (const [index, part] of scenario.parts.entries()) {
        const itemId = `${P}-item-${scenario.key}-${index + 1}`;
        const createdAt = new Date(now - 100 * MIN + index * 1000);
        await db.securityCheckItem.create({
          data: {
            id: itemId,
            checkId,
            kind: "check",
            title: part.title,
            status: part.status,
            agentId: part.status === "waiting" ? null : agentFor(index),
            assignedAt: part.status === "waiting" ? null : createdAt,
            reportedAt: part.status === "done" ? new Date(createdAt.getTime() + 20 * MIN) : null,
            createdAt,
          },
        });
        for (const [n, problem] of (part.problems ?? []).entries()) {
          await db.securityCheckResult.create({
            data: {
              id: `${itemId}-result-${n + 1}`,
              checkId,
              itemId,
              ...problem,
              priceCoins: SEVERITY_PRICE[problem.severity],
              unlockedAt: index < (scenario.unlockParts ?? 0) ? new Date(now - 20 * MIN) : null,
              createdAt: new Date(createdAt.getTime() + 20 * MIN),
            },
          });
        }
      }
      console.log(`${scenario.label.padEnd(32)} http://localhost:3001/security/checks/${checkId}`);
    }

    await sendPaidProblemsToZiki(db, organisation.id, owner.id, now);
  } finally {
    await db.$disconnect();
  }
}

/**
 * As if the client had used Fix on Ziki on the paid check (part 5 isn't built
 * yet): its critical problem becomes a finding whose issue is Live and was
 * checked again, and its high one a finding whose issue is In progress. The
 * findings borrow two of the Demo workspace's existing issues, so the check
 * page can show the fix line, the tabs and "Checked again by".
 */
async function sendPaidProblemsToZiki(db: PrismaClient, organisationId: string, ownerId: string, now: number) {
  const issueWith = (status: "resolved" | "in_progress") =>
    db.bug.findFirst({
      where: { organisationId, isDeleted: false, status, securityFinding: null },
      orderBy: { number: "asc" },
      select: { id: true, projectId: true },
    });
  const sends = [
    { resultId: `${P}-item-paid-1-result-1`, issue: await issueWith("resolved"), recheck: true },
    { resultId: `${P}-item-paid-2-result-1`, issue: await issueWith("in_progress"), recheck: false },
  ];
  for (const [index, send] of sends.entries()) {
    if (!send.issue) {
      console.log("No Demo issue to link a finding to; run pnpm db:fixtures for the fix line to show.");
      continue;
    }
    const result = await db.securityCheckResult.findUnique({ where: { id: send.resultId }, select: { severity: true, title: true, description: true } });
    if (!result) continue;
    const findingId = `${P}-finding-${index + 1}`;
    await db.securityFinding.create({
      data: {
        id: findingId,
        organisationId,
        projectId: send.issue.projectId,
        bugId: send.issue.id,
        reporterId: ownerId,
        severity: result.severity,
        title: result.title,
        description: result.description,
      },
    });
    await db.securityCheckResult.update({ where: { id: send.resultId }, data: { findingId } });
    if (send.recheck) {
      await db.securityVerification.create({
        data: { findingId, reviewerId: ownerId, passed: true, notes: "Checked again on the live site: fixed.", createdAt: new Date(now - 10 * MIN) },
      });
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
