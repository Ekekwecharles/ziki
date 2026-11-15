import { z } from "zod";
import type { Prisma, PrismaClient, TestRowKind, TestRowProof, TestRowRoute, TestRowSource } from "@prisma/client";
import { storedReceipt } from "@/lib/delivery-receipt";
import { sameCommit } from "@/lib/github/commit-sha";

/**
 * Deeper testing (#deeper-testing): what a judgement must prove, and the
 * issue's test card.
 *
 * - An organisation's owners set checks for every issue and per issue type;
 *   a project's owners and admins add checks per area (`ProofRule`). With no
 *   rules at all the organisation works exactly as before: every judgement
 *   counts and there is no card.
 * - A good-to-merge counts only with proof (an attachment) for every required
 *   check, on the delivered commit. A not-good-to-merge counts toward sending
 *   the work back only with proof of what fails, and one proven fail holds the
 *   issue from acceptance (lib/agent-api/tested-status.ts).
 * - The card is the checks, the receipt's gaps and the rows testers wrote,
 *   scenarios down, environments across. Every square needs a tester's proof
 *   (two on a risky row) before the issue is accepted. It is sized to the
 *   issue's priority; wild rows past the size wait on the bench, and rows no
 *   tester can prove are routed to the deliverer's CI test or the owners, so
 *   no square holds the issue forever.
 */

type Db = PrismaClient | Prisma.TransactionClient;

/** What a file must be to prove something: a picture of what you saw, or a test's or a log's output. */
export type ProofKind = TestRowProof;

/** Checks every organisation can use. Builds and tests aren't here: the pull request report already gates a yes on them. */
export const BUILT_IN_CHECKS: Record<string, { name: string; proof: string; kind?: ProofKind }> = {
  repro: { name: "Saw the bug", proof: "A screenshot or recording of the bug on the code before the fix." },
  fixed: { name: "Works on the PR", proof: "A screenshot or recording of it working on the delivered commit." },
  regression: { name: "Regression test", proof: "Test-run output: the new test fails without the fix and passes with it.", kind: "test" },
  phone: { name: "On a phone", proof: "A screenshot or recording at phone width (375px)." },
  theme: { name: "Light & dark", proof: "Screenshots in both themes." },
  staging: { name: "On staging", proof: "A recording of it working on staging." },
};

/** The ways a wild row leaves the normal use case, in plain words, and what Ziki suggests when a card has none of a kind. */
export const ROW_KINDS: Record<TestRowKind, { label: string; tip: string; suggestion: string }> = {
  limits: { label: "Limits", tip: "The smallest, largest, emptiest or longest case", suggestion: "Try the emptiest and the longest input it accepts" },
  bad_input: { label: "Bad input", tip: "Something the user wasn't meant to enter", suggestion: "Enter something it shouldn't accept" },
  failure: { label: "When things fail", tip: "The network drops, a service is down, a save fails", suggestion: "Drop the connection halfway through" },
  mid_change: { label: "Mid-change", tip: "Something changes while you're in the middle of it", suggestion: "Change something else while it's in progress" },
  reload: { label: "After a reload", tip: "Does it survive a reload, a sign-out or going back?", suggestion: "Reload, or go back and forward, right after doing it" },
  two_at_once: { label: "Two at once", tip: "Two tabs, two people or two requests at the same time", suggestion: "Do it in two tabs at the same time" },
  permissions: { label: "Who's allowed", tip: "Someone tries what they shouldn't be able to", suggestion: "Try it as someone who shouldn't be allowed" },
  still_works: { label: "Still works", tip: "Something that worked before this change", suggestion: "Check the nearest feature this change touched still works" },
  devices: { label: "Other devices", tip: "Another device, browser, setting or way of using it", suggestion: "Try it on another browser, or with the keyboard only" },
};

export const KIND_VALUES = Object.keys(ROW_KINDS) as [TestRowKind, ...TestRowKind[]];

const rowSchema = z
  .object({
    text: z.string().trim().min(3).max(200),
    /** For a wild row: what the acceptance criteria missed. */
    why: z.string().trim().min(3).max(300).optional(),
    /** `criteria`: from the acceptance criteria; `beyond`: a case they don't cover. */
    source: z.enum(["criteria", "beyond"]),
    kind: z.enum(KIND_VALUES).optional(),
    proof: z.enum(["screen", "test", "log"]).optional(),
    /** Where to try it, e.g. ["Phone 375px", "Desktop"]: one square each. None: one square. */
    envs: z.array(z.string().trim().min(1).max(40)).max(4).optional(),
    needsTwo: z.boolean().optional(),
  })
  .strict()
  .refine((row) => row.source !== "beyond" || Boolean(row.kind), { message: "A beyond row says which kind it is (kind).", path: ["kind"] });

export const addRowsSchema = z
  .object({
    rows: z.array(rowSchema).min(1).max(12),
    /** When the card has no row beyond the normal use case: why there are none. */
    noWildReason: z.string().trim().min(10).max(300).optional(),
  })
  .strict();

export const rowActionSchema = z
  .object({
    action: z.enum(["needs_test", "cant_prove", "test"]),
    /** With `test`: the deliverer's test run, uploaded with POST /api/v1/attachments. */
    attachmentId: z.string().trim().min(1).max(191).optional(),
  })
  .strict();

/** How big a card may be, by the issue's priority. */
const CARD_SIZE: Record<string, number> = { low: 6, medium: 9, high: 12, urgent: 12 };

const proofEntry = z
  .object({
    result: z.enum(["pass", "fail", "na"]),
    /** Upload the proof with `POST /api/v1/attachments` first. */
    attachmentId: z.string().trim().min(1).max(191).optional(),
    /** What the file shows, in one sentence, so a reader can check it (with `pass` or `fail`). */
    shows: z.string().trim().min(10).max(300).optional(),
    /** For a test: its file in the pull request, e.g. "tests/composer.test.ts". */
    test: z.string().trim().min(3).max(300).optional(),
    /** Why it doesn't apply (with `na`). */
    reason: z.string().trim().min(1).max(300).optional(),
  })
  .strict()
  .refine((entry) => (entry.result === "na" ? Boolean(entry.reason) : Boolean(entry.attachmentId && entry.shows)), {
    message: "A pass or fail needs attachmentId (upload the proof first) and shows (what the file shows); not applicable needs a reason.",
  });

/** What a judgement proved: per check, per test-card square, and the second tester's rating of the card. */
export const proofSchema = z
  .object({
    checks: z.record(z.string().max(191), proofEntry).optional(),
    squares: z.record(z.string().max(250), proofEntry).optional(),
    rating: z.enum(["thorough", "too_easy"]).optional(),
  })
  .strict()
  // A card holds at most 12 squares and a handful of checks: anything far past that isn't proof.
  .refine((p) => Object.keys(p.checks ?? {}).length <= 30 && Object.keys(p.squares ?? {}).length <= 60, { message: "At most 30 checks and 60 squares in one judgement." });

export type VerdictProof = z.infer<typeof proofSchema>;
type ProofEntry = z.infer<typeof proofEntry>;

export function storedProof(value: unknown): VerdictProof {
  const parsed = proofSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : {};
}

/** Every attachment a judgement names, to check they belong to the issue. */
export function proofAttachmentIds(proof: VerdictProof): string[] {
  return [...Object.values(proof.checks ?? {}), ...Object.values(proof.squares ?? {})].flatMap((e) => (e.attachmentId ? [e.attachmentId] : []));
}

/** A screenshot this small is blank: real ones are tens of kilobytes. */
const MIN_IMAGE_BYTES = 2048;

/**
 * Why a judgement's proof can't count, or null. Each file must suit what it
 * proves: a picture (image or PDF) for what you can see, a text file of the
 * run or the logs for a test or a log; no blank image. A test names its file,
 * which must be one of the changed files the judgement lists.
 */
export function proofProblem(
  proof: VerdictProof,
  lookup: { file: (id: string) => { contentType: string; size: number } | undefined; rowProof: (rowId: string) => TestRowProof | undefined; changed: string[] },
): string | null {
  const entries: [string, ProofEntry, TestRowProof | null][] = [
    ...Object.entries(proof.checks ?? {}).map(([id, e]): [string, ProofEntry, TestRowProof | null] => [`checks.${id}`, e, BUILT_IN_CHECKS[id] ? (BUILT_IN_CHECKS[id].kind ?? "screen") : null]),
    ...Object.entries(proof.squares ?? {}).map(([key, e]): [string, ProofEntry, TestRowProof | null] => [`squares.${key}`, e, key.startsWith("check:") || key.startsWith("receipt:") ? "screen" : (lookup.rowProof(key.split("@")[0]) ?? "screen")]),
  ];
  for (const [where, entry, kind] of entries) {
    if (entry.result === "na" || !entry.attachmentId) continue;
    const file = lookup.file(entry.attachmentId);
    if (!file) return `proof.${where}: no such file on this issue.`;
    const picture = file.contentType.startsWith("image/") || file.contentType === "application/pdf";
    if (file.contentType.startsWith("image/") && file.size < MIN_IMAGE_BYTES) return `proof.${where}: the image is too small to show anything; attach a real screenshot.`;
    if (kind === "screen" && !picture) return `proof.${where}: attach a screenshot (an image or PDF) of what you saw.`;
    if ((kind === "test" || kind === "log") && picture) return `proof.${where}: a picture can't prove a ${kind}; attach the ${kind === "test" ? "test run's output" : "logs"} as a text file.`;
    if (kind === "test" && entry.result === "pass" && (!entry.test || !lookup.changed.includes(entry.test))) {
      return `proof.${where}: name the test in test, as one of the changed files you list in files.`;
    }
  }
  return null;
}

export type ProofRules = {
  rules: { id: string; projectId: string | null; issueTypeId: string | null; projectAreaId: string | null; checks: string[] }[];
  custom: { id: string; name: string; instructions: string; required: boolean }[];
};

export async function loadProofRules(db: Db, organisationId: string): Promise<ProofRules> {
  const [rules, custom] = await Promise.all([
    db.proofRule.findMany({ where: { organisationId }, orderBy: { createdAt: "asc" }, select: { id: true, projectId: true, issueTypeId: true, projectAreaId: true, checks: true } }),
    db.proofCheck.findMany({ where: { organisationId }, orderBy: { createdAt: "asc" }, select: { id: true, name: true, instructions: true, required: true } }),
  ]);
  return { rules, custom };
}

/** A check's name and what to attach, built-in or written by the owners; null once deleted. */
export function checkInfo(id: string, rules: ProofRules): { name: string; proof: string; required: boolean } | null {
  const builtIn = BUILT_IN_CHECKS[id];
  if (builtIn) return { ...builtIn, required: true };
  const custom = rules.custom.find((c) => c.id === id);
  return custom ? { name: custom.name, proof: custom.instructions, required: custom.required } : null;
}

/** Every check an organisation can put in a rule: the built-in ones, then its owners'. */
export function checkOptions(rules: ProofRules): { id: string; name: string; proof: string; required: boolean; custom: boolean }[] {
  return [
    ...Object.entries(BUILT_IN_CHECKS).map(([id, c]) => ({ id, ...c, required: true, custom: false })),
    ...rules.custom.map((c) => ({ id: c.id, name: c.name, proof: c.instructions, required: c.required, custom: true })),
  ];
}

export type IssueChecks = { on: boolean; required: string[]; guidance: string[] };

/** No checks: every judgement counts, as before (marketing work, and organisations with no rules). */
export const NO_CHECKS: IssueChecks = { on: false, required: [], guidance: [] };

/** The checks an issue needs: the organisation's for every issue and for its type, and its project's for its area. */
export function checksFor(rules: ProofRules, bug: { projectId: string; typeId: string | null; areaId: string | null }): IssueChecks {
  const ids = new Set<string>();
  for (const rule of rules.rules) {
    const applies = rule.projectId
      ? rule.projectId === bug.projectId && rule.projectAreaId !== null && rule.projectAreaId === bug.areaId
      : rule.issueTypeId === null || rule.issueTypeId === bug.typeId;
    if (applies) rule.checks.forEach((id) => ids.add(id));
  }
  const known = [...ids].flatMap((id) => {
    const info = checkInfo(id, rules);
    return info ? [{ id, required: info.required }] : [];
  });
  return { on: rules.rules.length > 0, required: known.filter((c) => c.required).map((c) => c.id), guidance: known.filter((c) => !c.required).map((c) => c.id) };
}

export type JudgementProofState = "counts" | "no_proof" | "earlier_code" | "contradicts" | "proved_fail" | "no_fail_proof";

const isProvenFail = (entry: ProofEntry) => entry.result === "fail" && Boolean(entry.attachmentId);

/**
 * Whether a judgement counts: a good-to-merge with proof for every required
 * check on the delivered commit, or a not-good-to-merge with proof of a fail.
 */
export function judgementProof(
  verdict: { goodToMerge: boolean; headSha: string | null; proof: unknown },
  required: readonly string[],
  deliveredSha: string | null,
): { state: JudgementProofState; missing: string[] } {
  const proof = storedProof(verdict.proof);
  if (deliveredSha && verdict.headSha && !sameCommit(verdict.headSha, deliveredSha)) return { state: "earlier_code", missing: [] };
  const fails = [...Object.values(proof.checks ?? {}), ...Object.values(proof.squares ?? {})].some(isProvenFail);
  if (!verdict.goodToMerge) return { state: fails ? "proved_fail" : "no_fail_proof", missing: [] };
  if (fails) return { state: "contradicts", missing: [] };
  const missing = required.filter((id) => {
    const entry = proof.checks?.[id];
    return !entry || entry.result === "fail";
  });
  return { state: missing.length ? "no_proof" : "counts", missing };
}

/** Whether a judgement counts toward the gate or a send-back. Organisations without checks count every judgement, as before. */
export function countsWithProof(
  verdict: { goodToMerge: boolean; headSha: string | null; proof: unknown },
  checks: IssueChecks,
  deliveredSha: string | null,
): boolean {
  if (!checks.on) return true;
  const { state } = judgementProof(verdict, checks.required, deliveredSha);
  return verdict.goodToMerge ? state === "counts" : state === "proved_fail";
}

export type CardSquare = { key: string; env: string | null; needed: number; provers: string[]; failers: string[]; state: "passed" | "failed" | "half" | "open" };

export type CardRow = {
  key: string;
  /** The stored row's id; null for rows from the checks and the receipt. */
  id: string | null;
  text: string;
  why: string | null;
  source: TestRowSource | "check" | "receipt";
  checkId: string | null;
  kind: TestRowKind | null;
  proof: TestRowProof;
  route: TestRowRoute | null;
  /** A `ci` row: the deliverer attached its automated test. */
  testAttached: boolean;
  decision: string | null;
  by: string | null;
  bench: boolean;
  squares: CardSquare[];
};

export type TestCard = {
  on: boolean;
  checks: IssueChecks;
  size: number;
  envs: string[];
  rows: CardRow[];
  /** Squares still waiting on a tester; while any are, the issue isn't accepted. */
  holes: number;
  failed: number;
  stamped: number;
  total: number;
  rating: { by: string; value: "thorough" | "too_easy" } | null;
  waitingOnCi: number;
  waitingOnOwners: number;
  /** Each judgement's standing by its id, so the list can say which count. */
  judgements: Record<string, { state: JudgementProofState; missing: string[] }>;
};

type CardVerdict = { id: string; agent: { name: string }; goodToMerge: boolean; headSha: string | null; proof: unknown };
type StoredRow = {
  id: string;
  text: string;
  why: string | null;
  source: TestRowSource;
  kind: TestRowKind | null;
  proof: TestRowProof;
  envs: string[];
  needsTwo: boolean;
  route: TestRowRoute | null;
  proofAttachmentId: string | null;
  decision: string | null;
  agent: { name: string } | null;
};

/** The card, from the checks, the latest receipt, the stored rows and the judgements on the delivered commit. Pure. */
export function buildCard(input: {
  rules: ProofRules;
  checks: IssueChecks;
  priority: string;
  deliveredSha: string | null;
  receipt: unknown;
  rows: StoredRow[];
  verdicts: CardVerdict[];
}): TestCard {
  const { rules, checks, deliveredSha } = input;
  const current = input.verdicts.filter((v) => !deliveredSha || !v.headSha || sameCommit(v.headSha, deliveredSha));
  const proofs = current.map((v) => ({ name: v.agent.name, proof: storedProof(v.proof) }));
  const square = (key: string, env: string | null, needed: number, read: (p: VerdictProof) => ProofEntry | undefined): CardSquare => {
    const provers = proofs.filter((p) => read(p.proof)?.result === "pass" && read(p.proof)?.attachmentId).map((p) => p.name);
    const failers = proofs.filter((p) => {
      const entry = read(p.proof);
      return entry ? isProvenFail(entry) : false;
    }).map((p) => p.name);
    const state = failers.length ? "failed" : provers.length >= needed ? "passed" : provers.length ? "half" : "open";
    return { key, env, needed, provers, failers, state };
  };
  const base = { why: null, kind: null, proof: "screen" as const, route: null, testAttached: false, decision: null, by: null, bench: false };
  const checkRows: CardRow[] = checks.required.map((id) => ({
    ...base,
    key: `check:${id}`,
    id: null,
    text: checkInfo(id, rules)?.name ?? id,
    source: "check",
    checkId: id,
    squares: [square(`check:${id}`, null, 1, (p) => p.checks?.[id])],
  }));
  const receipt = storedReceipt(input.receipt);
  const receiptRows: CardRow[] = [...(receipt?.notVerified.map((r) => r.check) ?? []), ...(receipt?.reviewerShould ?? [])].map((text, i) => ({
    ...base,
    key: `receipt:${i}`,
    id: null,
    text,
    source: "receipt",
    checkId: null,
    squares: [square(`receipt:${i}`, null, 1, (p) => p.squares?.[`receipt:${i}`])],
  }));
  const order: Record<TestRowSource, number> = { criteria: 0, beyond: 1, suggested: 2 };
  const stored: CardRow[] = [...input.rows]
    .sort((a, b) => order[a.source] - order[b.source])
    .map((row) => {
      const needed = row.needsTwo ? 2 : 1;
      const keys = row.envs.length ? row.envs.map((env) => ({ key: `${row.id}@${env}`, env })) : [{ key: row.id, env: null }];
      return {
        key: row.id,
        id: row.id,
        text: row.text,
        why: row.why,
        source: row.source,
        checkId: null,
        kind: row.kind,
        proof: row.proof,
        route: row.route,
        testAttached: Boolean(row.proofAttachmentId),
        decision: row.decision,
        by: row.agent?.name ?? null,
        bench: false,
        squares: keys.map(({ key, env }) => square(key, env, needed, (p) => p.squares?.[key])),
      };
    });
  const crit = stored.filter((r) => r.source === "criteria");
  const wild = stored.filter((r) => r.source !== "criteria");
  const rows = [...checkRows, ...crit, ...receiptRows, ...wild];

  // Size the card: the last rows testers wrote (wild, then criteria) wait on the bench until it fits,
  // so no tester can hold an issue with more squares than its priority allows. Routed rows take no squares.
  const size = CARD_SIZE[input.priority] ?? CARD_SIZE.medium;
  let used = rows.filter((r) => !r.route).reduce((n, r) => n + r.squares.length, 0);
  for (const row of [...crit, ...wild].reverse().filter((r) => !r.route)) {
    if (used <= size) break;
    row.bench = true;
    used -= row.squares.length;
  }

  const live = rows.filter((r) => !r.bench && !r.route);
  const squares = live.flatMap((r) => r.squares);
  // The first rating holds.
  const ratingVerdict = proofs.find((p) => p.proof.rating);
  return {
    on: checks.on,
    checks,
    size,
    envs: [...new Set(stored.flatMap((r) => r.squares.map((s) => s.env).filter((e): e is string => Boolean(e))))],
    rows,
    holes: squares.filter((s) => s.state === "open" || s.state === "half").length,
    failed: squares.filter((s) => s.state === "failed").length,
    stamped: squares.filter((s) => s.state === "passed").length,
    total: squares.length,
    rating: ratingVerdict ? { by: ratingVerdict.name, value: ratingVerdict.proof.rating! } : null,
    waitingOnCi: rows.filter((r) => r.route === "ci" && !r.testAttached && !r.bench).length,
    waitingOnOwners: rows.filter((r) => r.route === "env" && !r.decision && !r.bench).length,
    judgements: Object.fromEntries(
      input.verdicts.map((v) => {
        const { state, missing } = judgementProof(v, checks.required, deliveredSha);
        return [v.id, { state, missing: missing.map((id) => checkInfo(id, rules)?.name ?? id) }];
      }),
    ),
  };
}

/** Everything the card needs about an issue. */
export const cardBugSelect = {
  id: true,
  organisationId: true,
  projectId: true,
  typeId: true,
  areaId: true,
  priority: true,
  pullRequestUrl: true,
  pullRequestHeadSha: true,
} satisfies Prisma.BugSelect;

/** The issue's card and checks, read from the database. */
export async function loadCard(db: Db, bug: Prisma.BugGetPayload<{ select: typeof cardBugSelect }>): Promise<TestCard> {
  const rules = await loadProofRules(db, bug.organisationId);
  const checks = checksFor(rules, bug);
  if (!checks.on) return buildCard({ rules, checks, priority: bug.priority, deliveredSha: null, receipt: null, rows: [], verdicts: [] });
  const [delivery, rows, verdicts] = await Promise.all([
    db.delivery.findFirst({ where: { bugId: bug.id }, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], select: { receipt: true } }),
    db.testCardRow.findMany({
      where: { bugId: bug.id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, text: true, why: true, source: true, kind: true, proof: true, envs: true, needsTwo: true, route: true, proofAttachmentId: true, decision: true, agent: { select: { name: true } } },
    }),
    bug.pullRequestUrl
      ? db.testVerdict.findMany({ where: { bugId: bug.id, pullRequestUrl: bug.pullRequestUrl }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, goodToMerge: true, headSha: true, proof: true, agent: { select: { name: true } } } })
      : Promise.resolve([]),
  ]);
  return buildCard({ rules, checks, priority: bug.priority, deliveredSha: bug.pullRequestHeadSha, receipt: delivery?.receipt ?? null, rows, verdicts });
}
