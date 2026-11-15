import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/agents/audit";
import type { AgentContext } from "@/lib/agents/require-agent";
import { deliveredClaim } from "@/lib/agent-api/merge-verdicts";
import { IssueApiError } from "@/lib/agent-api/errors";
import { refreshJudgedStatus } from "@/lib/agent-api/tested-status";
import { linkAttachments } from "@/lib/attachment-link";
import { attachmentKind } from "@/lib/attachments";
import { issueIdFor } from "@/lib/issue-ref";
import { notifyLater } from "@/lib/notify";
import { addRowsSchema, cardBugSelect, checkInfo, KIND_VALUES, loadCard, loadProofRules, ROW_KINDS, rowActionSchema, type TestCard } from "@/lib/proof";

/**
 * The test card's agent API (#deeper-testing). Testers draw up the card's rows
 * (`POST /api/v1/issues/{id}/test-card`), mark a row nobody can prove with a
 * screenshot (`needs_test`: the deliverer adds an automated test; or
 * `cant_prove`: the project's owners decide), and the deliverer attaches that
 * test (`test`). Squares are proven in the judgement itself
 * (`proof.squares` on POST /test-results). Rules and squares: lib/proof.ts.
 */

type Db = PrismaClient | Prisma.TransactionClient;

/** A refusal with its code and its sentence, as the other agent routes answer. */
const fail = (status: number, error: string, message: string) => new IssueApiError(status, message, { error, message });

const bugSelect = {
  ...cardBugSelect,
  title: true,
  status: true,
  track: true,
  claims: { select: { status: true, claimedAt: true, releasedAt: true, agentId: true, agent: { select: { ownerUserId: true } } } },
} satisfies Prisma.BugSelect;

async function issueFor(agent: AgentContext, issueRef: string) {
  const id = await issueIdFor(prisma, issueRef, agent.organisationId);
  const bug = id ? await prisma.bug.findFirst({ where: { id, organisationId: agent.organisationId, isDeleted: false }, select: bugSelect }) : null;
  if (!bug) throw fail(404, "not_found", "No such issue in this agent's organisation.");
  return bug;
}

/** The card as an agent reads it: every row, each square's key and who proved it, and what each check asks for. */
export async function testCardView(card: TestCard, db: Db, organisationId: string) {
  const rules = await loadProofRules(db, organisationId);
  return {
    ...card,
    checks: [...card.checks.required, ...card.checks.guidance].map((id) => ({ id, ...checkInfo(id, rules)! })),
    kinds: ROW_KINDS,
  };
}

/** GET /issues/{id}/test-card. */
export async function getTestCard(agent: AgentContext, issueRef: string) {
  const bug = await issueFor(agent, issueRef);
  return testCardView(await loadCard(prisma, bug), prisma, bug.organisationId);
}

/** Rows are written on delivered product work, by anyone but the agent that delivered it, while the organisation has checks. */
async function writableCard(bug: Prisma.BugGetPayload<{ select: typeof bugSelect }>) {
  if (bug.track === "marketing" || bug.status !== "done" || !bug.pullRequestUrl) {
    throw fail(409, "not_delivered", "A test card is drawn up on delivered work: the issue must be Done · Requires review or Accepted.");
  }
  const card = await loadCard(prisma, bug);
  if (!card.on) throw fail(409, "checks_off", "This organisation has no checks set, so its issues have no test card.");
  return card;
}

/** The agent that drew up the card: whoever wrote its first row. */
async function cardAuthor(db: Db, bugId: string) {
  return (await db.testCardRow.findFirst({ where: { bugId, agentId: { not: null } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { agentId: true } }))?.agentId ?? null;
}

/** Rows one agent may write on a card: the author draws it up, every other tester adds a few wild rows. */
const ROWS_PER_AUTHOR = 12;
const ROWS_PER_TESTER = 3;

/**
 * POST /issues/{id}/test-card: add rows. The card needs at least one row beyond
 * the normal use case, or a reason there is none. Once a card has an author,
 * other testers add only wild rows (source beyond), a few each, so nobody can
 * bury an issue in squares.
 */
export async function addTestCardRows(agent: AgentContext, issueRef: string, raw: unknown) {
  const parsed = addRowsSchema.safeParse(raw ?? {});
  if (!parsed.success) throw fail(400, "invalid_request", parsed.error.issues[0]?.message ?? "Invalid rows.");
  const bug = await issueFor(agent, issueRef);
  if (deliveredClaim(bug)?.agentId === agent.agentId) {
    throw fail(403, "fixer_cannot_test", "The agent that delivered the work doesn't draw up its test card.");
  }
  const card = await writableCard(bug);
  const author = await cardAuthor(prisma, bug.id);
  const isAuthor = !author || author === agent.agentId;
  if (!isAuthor && parsed.data.rows.some((r) => r.source !== "beyond")) {
    throw fail(403, "not_card_author", "The card's author writes its criteria rows; you can add rows beyond the normal use case (source beyond).");
  }
  const limit = isAuthor ? ROWS_PER_AUTHOR : ROWS_PER_TESTER;
  const mine = await prisma.testCardRow.count({ where: { bugId: bug.id, agentId: agent.agentId } });
  if (mine + parsed.data.rows.length > limit) {
    throw fail(409, "too_many_rows", `An agent adds at most ${limit} rows to this card; you have ${mine}.`);
  }
  const wild = card.rows.some((r) => r.source === "beyond" || r.source === "suggested") || parsed.data.rows.some((r) => r.source === "beyond");
  if (!wild && !parsed.data.noWildReason) {
    throw fail(400, "invalid_request", "Add at least one row that isn't a normal use case (source beyond, with its kind), or say why there is none in noWildReason.");
  }
  await prisma.testCardRow.createMany({
    data: parsed.data.rows.map((row) => ({
      bugId: bug.id,
      agentId: agent.agentId,
      text: row.text,
      why: row.why ?? null,
      source: row.source,
      kind: row.kind ?? null,
      proof: row.proof ?? "screen",
      envs: [...new Set(row.envs ?? [])],
      needsTwo: row.needsTwo ?? false,
    })),
  });
  await audit(agent, "issue.test_card_rows", `bug:${bug.id}`, { count: parsed.data.rows.length, noWildReason: parsed.data.noWildReason ?? null }, { bugId: bug.id });
  // A new square nobody has proven takes an Accepted issue back to Requires review.
  await refreshJudgedStatus(prisma, bug.id, agent.ownerId);
  return getTestCard(agent, bug.id);
}

/** POST /issues/{id}/test-card/{rowId}: route a row nobody can prove with a screenshot, or attach the deliverer's test. */
export async function actOnTestCardRow(agent: AgentContext, issueRef: string, rowId: string, raw: unknown) {
  const parsed = rowActionSchema.safeParse(raw ?? {});
  if (!parsed.success) throw fail(400, "invalid_request", parsed.error.issues[0]?.message ?? "Invalid action.");
  const bug = await issueFor(agent, issueRef);
  await writableCard(bug);
  const row = await prisma.testCardRow.findFirst({ where: { id: rowId, bugId: bug.id }, select: { id: true, text: true, route: true, agentId: true } });
  if (!row) throw fail(404, "not_found", "No such row on this issue's test card.");
  const deliverer = deliveredClaim(bug)?.agentId === agent.agentId;
  const { action, attachmentId } = parsed.data;

  if (action === "test") {
    if (!deliverer || row.route !== "ci") {
      throw fail(409, "not_needs_test", "Only the agent that delivered the work attaches a test, on a row marked needs_test.");
    }
    if (!attachmentId) throw fail(400, "invalid_request", "Attach the test run: attachmentId.");
    await linkAttachments(prisma, { ids: [attachmentId], uploaderId: agent.ownerId, bugId: bug.id });
    const linked = await prisma.attachment.findFirst({ where: { id: attachmentId, bugId: bug.id, uploaderId: agent.ownerId }, select: { contentType: true } });
    if (!linked) throw fail(400, "invalid_request", "attachmentId must be your own upload (POST /api/v1/attachments).");
    if (attachmentKind(linked.contentType) !== "text") throw fail(400, "invalid_request", "Attach the test run's output as a text file, not a picture.");
    await prisma.testCardRow.update({ where: { id: row.id }, data: { proofAttachmentId: attachmentId } });
  } else {
    if (deliverer) throw fail(403, "fixer_cannot_test", "The agent that delivered the work doesn't route its own test card.");
    if (row.route) throw fail(409, "already_routed", "This row is already waiting on someone.");
    // Only whoever wrote a row says it can't be proven (the card's author for Ziki's suggestions), so no tester routes away a square it would rather not prove.
    const writer = row.agentId ?? (await cardAuthor(prisma, bug.id));
    if (writer !== agent.agentId) throw fail(403, "not_row_author", "Only the agent that added this row can route it.");
    const route = action === "needs_test" ? "ci" : "env";
    await prisma.testCardRow.update({ where: { id: row.id }, data: { route, routedAt: new Date() } });
    if (route === "env") await askOwnersToDecide(prisma, bug, row.text);
  }
  await audit(agent, `issue.test_card_${action}`, `bug:${bug.id}`, { rowId: row.id }, { bugId: bug.id });
  return getTestCard(agent, bug.id);
}

/** Tell the project's owners and admins a row needs their decision. Once per row. */
export async function askOwnersToDecide(db: Db, bug: { id: string; title: string; organisationId: string }, text: string) {
  const owners = await db.membership.findMany({ where: { organisationId: bug.organisationId, role: { in: ["owner", "admin"] } }, select: { userId: true } });
  notifyLater(
    ...owners.map((o) => ({
      kind: "testing" as const,
      actorId: null,
      actorName: "Ziki",
      recipientId: o.userId,
      organisationId: bug.organisationId,
      bugId: bug.id,
      bugTitle: bug.title,
      subject: `A test-card row on “${bug.title}” needs your decision`,
      message: `Testers can't prove “${text}” with what the project gives them. It doesn't hold the issue. Waive it, or file it as an idea.`,
    })),
  );
}

/** A person settles a row nobody can prove: waived, or filed as an idea. Owners and admins only; the caller checks that. */
export async function decideTestCardRow(bugId: string, rowId: string, decision: "waived" | "idea") {
  await prisma.testCardRow.updateMany({ where: { id: rowId, bugId, route: "env", decision: null }, data: { decision, decidedAt: new Date() } });
}

/** A card rated too easy gets a suggested row of a kind it doesn't have yet. */
export async function suggestRowAfterRating(db: Db, bugId: string) {
  const rows = await db.testCardRow.findMany({ where: { bugId }, select: { kind: true, source: true } });
  if (rows.some((r) => r.source === "suggested")) return;
  const missing = KIND_VALUES.find((kind) => !rows.some((r) => r.kind === kind));
  if (!missing) return;
  await db.testCardRow.create({ data: { bugId, text: ROW_KINDS[missing].suggestion, source: "suggested", kind: missing } });
}
