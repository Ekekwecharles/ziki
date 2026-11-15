import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Creating an idea (#441, #idea-table): one create per idempotency key, a
 * similar report is flagged until acknowledged, and an idea is only visible
 * inside its own project.
 */
const db = vi.hoisted(() => ({
  idempotencyKey: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
  issueType: { findUnique: vi.fn() },
  bug: { findMany: vi.fn(), count: vi.fn(), groupBy: vi.fn(), findFirst: vi.fn() },
  idea: { create: vi.fn(), findMany: vi.fn(), count: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), groupBy: vi.fn() },
  user: { upsert: vi.fn() },
  featurePlan: { upsert: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  featurePlanItem: { findMany: vi.fn(), create: vi.fn() },
  // #security-findings: no idea in these tests is a private finding.
  securityFinding: { findUnique: vi.fn(async () => null) },
  ideaVerdict: { groupBy: vi.fn(async () => []) },
  category: { findMany: vi.fn() },
  projectArea: { findMany: vi.fn() },
  project: { findFirst: vi.fn() },
  projectWorkflow: { findUnique: vi.fn() },
  agentAuditEvent: { count: vi.fn() },
  $queryRaw: vi.fn(),
  $transaction: vi.fn(),
}));
const indexedSearch = vi.hoisted(() => vi.fn());
const featurePublish = vi.hoisted(() => vi.fn());
const featureMembership = vi.hoisted(() => vi.fn());
vi.mock("@/lib/agent-api/events", () => ({ publish: featurePublish }));
vi.mock("@/lib/project-permissions", () => ({ canContributeToProject: featureMembership }));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/search-index", () => ({ searchWorkItems: indexedSearch }));

const sessionUser = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("@/lib/session-user", () => ({ resolveSessionUserId: sessionUser.resolve }));
const currentOrganisation = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/organisation-context", () => ({
  currentOrganisationIdFor: currentOrganisation.get,
  bugInOrganisation: (organisationId: string) => ({ organisationId }),
}));
const activeProject = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/project-context", () => ({ activeProjectIdFor: activeProject.get }));
const rateLimit = vi.hoisted(() => ({ consume: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  consumeRateLimit: rateLimit.consume,
  consumeRateLimits: rateLimit.consume,
  clientRateLimitKey: () => "ip:203.0.113.7",
  RATE_LIMIT_MESSAGE: "Please wait before searching again.",
}));

// Claude, for structuring an idea as it is submitted (#idea-intake). No network in tests.
const claude = vi.hoisted(() => ({ parse: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => {
  class APIError extends Error {
    status = 500;
  }
  class AuthenticationError extends APIError {}
  class RateLimitError extends APIError {}
  class Anthropic {
    static APIError = APIError;
    static AuthenticationError = AuthenticationError;
    static RateLimitError = RateLimitError;
    messages = { parse: claude.parse };
  }
  return { default: Anthropic };
});
vi.mock("@anthropic-ai/sdk/helpers/zod", () => ({ zodOutputFormat: (schema: unknown) => schema }));

import { createIdeaWithPolicy, encodeCursor, type CreatePolicyInput } from "@/lib/agent-api/create-policy";
import { assertVettedFields, createIdeaSchema, listAgentIdeas, readAgentIdea } from "@/lib/agent-api/ideas";
import { countAgentIssues, issueProject, listAgentIssues } from "@/lib/agent-api/issues";
import { GET as suggestIssues } from "@/app/api/issues/suggest/route";
import { NextRequest } from "next/server";
import { structureIdea } from "@/lib/idea-structuring";
import { parseIdeaTrack } from "@/lib/marketing/idea-track";
import { createPublicIdea, findPublicIdeaMatches, publicIdeaSchema } from "@/lib/public-idea-intake";
import { POST as submitPublicIdea } from "@/app/api/public/projects/[org]/[project]/ideas/route";
import { createFeaturePlan, featureProject, featureWorkState, findFeatureWork, publishFeaturePlan, saveFeaturePlan } from "@/lib/feature-plans";
import { generateFeatureDraft } from "@/lib/feature-plan-generation";
import { featureDraftSchema, type FeatureDraft } from "@/lib/validations/feature-plan";

const NOW = new Date("2026-10-19T12:00:00Z");
const agent = { agentId: "agent1", organisationId: "organisation_zedu" };
const scope = { organisationId: "t1", projectId: "p1" };
const insert = vi.fn();
const input = (overrides: Partial<CreatePolicyInput> = {}): CreatePolicyInput => ({
  agent,
  projectId: "project_zedu",
  idempotencyKey: "3f1c-key",
  requestHash: "request-hash",
  title: "Login button does nothing on Safari",
  insert,
  now: NOW,
  ...overrides,
});
const similarRow = { id: "b1", number: 12, title: "Login button does nothing in Safari", status: "open", voteCount: 3, score: 0.8 };
const publicProject = { id: "public-project", name: "Ziki", organisationId: "organisation_zedu" };
const publicHeaders = new Headers({ "x-forwarded-for": "203.0.113.7", "user-agent": "test-browser" });
const publicInput = (overrides: Record<string, unknown> = {}) => ({
  title: "Public issue intake drops the report",
  summary: "A signed-out report disappears after submission.",
  description: "Submitting the public form does not create an idea for review.",
  stepsToReproduce: "Open the public project page and submit the report form.",
  expectedBehavior: "The report is saved as an idea.",
  actualBehavior: "The report disappears.",
  website: "",
  acknowledgeSimilar: false,
  trackingToken: "a".repeat(32),
  ...overrides,
});
const idea = {
  id: "i1", number: 12, title: "Export activity as CSV", summary: "People want a CSV.", description: "People want their data.",
  source: "internal", track: "product" as const, rationale: null as string | null, status: "open" as const, score: 3, typeId: null, areaId: null, proofLinks: [], projectId: "p1",
  reporterId: "ada", beneficiaryUserId: "ada", createdByAgentId: null, convertedAt: null, archiveReason: null,
  archiveEvidence: null, archiveDuplicateOf: null, archivedAt: null, archivedByAgentId: null,
  createdAt: new Date("2026-10-20T10:00:00Z"), updatedAt: new Date("2026-10-20T10:00:00Z"), area: null, issue: null,
};

const listedIssues = [
  {
    id: "product-local", number: 10, title: "Product search marker", summary: "Product summary.", description: "Search phrase.",
    status: "open", substatus: "open", track: "product", organisationId: "t1", projectId: "p1", isDeleted: false,
    voteCount: 1, category: null, reward: 1, rewardEstimateCount: 0, rewardFixedAt: null,
    createdAt: new Date("2026-10-20T10:00:00Z"), updatedAt: new Date("2026-10-20T10:00:00Z"),
  },
  {
    id: "marketing-local", number: 11, title: "Marketing campaign", summary: "Marketing summary.", description: "Search phrase.",
    status: "resolved", substatus: "published", track: "marketing", organisationId: "t1", projectId: "p1", isDeleted: false,
    voteCount: 2, category: null, reward: 2, rewardEstimateCount: 0, rewardFixedAt: null,
    createdAt: new Date("2026-10-20T09:00:00Z"), updatedAt: new Date("2026-10-20T09:00:00Z"),
  },
  {
    id: "other-project", number: 12, title: "Product other project", summary: "Other project.", description: "Search phrase.",
    status: "open", substatus: "open", track: "product", organisationId: "t1", projectId: "p2", isDeleted: false,
    voteCount: 3, category: null, reward: 3, rewardEstimateCount: 0, rewardFixedAt: null,
    createdAt: new Date("2026-10-20T08:00:00Z"), updatedAt: new Date("2026-10-20T08:00:00Z"),
  },
  {
    id: "other-organisation", number: 13, title: "Marketing other organisation", summary: "Other organisation.", description: "Search phrase.",
    status: "open", substatus: "open", track: "marketing", organisationId: "t2", projectId: "p1", isDeleted: false,
    voteCount: 4, category: null, reward: 4, rewardEstimateCount: 0, rewardFixedAt: null,
    createdAt: new Date("2026-10-20T07:00:00Z"), updatedAt: new Date("2026-10-20T07:00:00Z"),
  },
] as const;

const countedBugs = [
  { organisationId: "t1", projectId: "p1", track: "product", isDeleted: false, status: "open", substatus: "open" },
  { organisationId: "t1", projectId: "p1", track: "marketing", isDeleted: false, status: "resolved", substatus: "published" },
] as const;
const countedIdeas = [
  { organisationId: "t1", projectId: "p1", track: "product", isDeleted: false, status: "open" },
  { organisationId: "t1", projectId: "p1", track: "marketing", isDeleted: false, status: "rejected" },
] as const;

function filterIssueRows(where: Record<string, unknown>) {
  const and = Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : [];
  const textSearch = and.find((condition) => typeof condition === "object" && condition !== null && "OR" in condition) as
    | { OR?: Array<{ title?: { contains?: string }; description?: { contains?: string } }> }
    | undefined;
  return listedIssues.filter((row) => {
    if (row.organisationId !== where.organisationId || row.projectId !== where.projectId || row.track !== where.track) return false;
    return !textSearch?.OR || textSearch.OR.some((condition) =>
      (condition.title?.contains && row.title.toLowerCase().includes(condition.title.contains.toLowerCase()))
      || (condition.description?.contains && row.description.toLowerCase().includes(condition.description.contains.toLowerCase())),
    );
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  db.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(db));
  db.idempotencyKey.findUnique.mockResolvedValue(null);
  db.idempotencyKey.create.mockResolvedValue({ id: "ik1" });
  db.$queryRaw.mockResolvedValue([]);
  db.projectWorkflow.findUnique.mockResolvedValue(null);
  db.category.findMany.mockResolvedValue([]);
  db.projectArea.findMany.mockResolvedValue([]);
  sessionUser.resolve.mockResolvedValue({ userId: "user-1" });
  currentOrganisation.get.mockResolvedValue("t1");
  activeProject.get.mockResolvedValue("p1");
  rateLimit.consume.mockResolvedValue({ allowed: true });
  db.idea.findMany.mockResolvedValue([idea]);
  db.idea.count.mockResolvedValue(1);
  db.idea.findFirst.mockResolvedValue({ id: "i1" });
  db.idea.findUnique.mockResolvedValue(null);
  db.idea.create.mockResolvedValue({ id: "public-idea", number: 77 });
  db.idea.findUniqueOrThrow.mockResolvedValue({ ...idea, attachments: [] });
  db.user.upsert.mockResolvedValue({ id: "public-reporter" });
  db.bug.count.mockResolvedValue(1);
  indexedSearch.mockRejectedValue(new Error("Typesense is unavailable in this test."));
  insert.mockResolvedValue({ id: "new-idea" });
});

describe("signed-out public idea intake (#3464)", () => {
  const ref = { orgSlug: "zedu", projectSlug: "web" };
  const emit = vi.fn().mockResolvedValue({ id: "event-1" });

  beforeEach(() => {
    db.project.findFirst.mockResolvedValue(publicProject);
    rateLimit.consume.mockResolvedValue({ allowed: true, retryAfterMs: 0 });
    emit.mockClear();
  });

  it("is unavailable unless the project is public and explicitly opted in", async () => {
    db.project.findFirst.mockResolvedValue(null);

    await expect(createPublicIdea(ref, publicInput(), publicHeaders, {
      db: db as never,
      consume: rateLimit.consume,
      emit,
    })).resolves.toMatchObject({ status: 404, error: "not_found" });
    expect(db.idea.create).not.toHaveBeenCalled();
  });

  it("bounds duplicate searches before querying the project", async () => {
    await expect(findPublicIdeaMatches(ref, "x".repeat(201), publicHeaders, {
      db: db as never,
      consume: rateLimit.consume,
    })).resolves.toMatchObject({ status: 400, error: "invalid_request" });
    expect(db.project.findFirst).not.toHaveBeenCalled();
  });

  it("shows scoped duplicate candidates before it creates anything", async () => {
    db.$queryRaw.mockResolvedValue([{ ...similarRow, kind: "issue" }]);

    await expect(createPublicIdea(ref, publicInput(), publicHeaders, {
      db: db as never,
      consume: rateLimit.consume,
      emit,
    })).resolves.toMatchObject({
      status: 409,
      error: "similar_ideas",
      matches: [{ kind: "issue", number: 12, title: similarRow.title, status: "open" }],
    });
    expect(db.idea.create).not.toHaveBeenCalled();
  });

  it("creates an ordinary public-source idea with a synthetic reporter and hashed tracking token", async () => {
    const result = await createPublicIdea(ref, publicInput({ acknowledgeSimilar: true }), publicHeaders, {
      db: db as never,
      consume: rateLimit.consume,
      emit,
    });

    expect(result).toEqual({
      status: 201,
      ideaId: "public-idea",
      ideaNumber: 77,
      trackingPath: `/zedu/web/track/${"a".repeat(32)}`,
      replayed: false,
    });
    expect(db.user.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        email: expect.stringMatching(/@system\.ziki\.invalid$/),
        passwordHash: null,
        emailNotifications: false,
      }),
    }));
    const created = db.idea.create.mock.calls[0][0].data;
    expect(created).toMatchObject({
      source: "public",
      reporterId: "public-reporter",
      beneficiaryUserId: "public-reporter",
      organisationId: "organisation_zedu",
      projectId: "public-project",
      track: "product",
    });
    expect(created.publicTrackingTokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(created.publicTrackingTokenHash).not.toContain("a".repeat(32));
    expect(emit).toHaveBeenCalledWith(db, expect.objectContaining({
      type: "idea.created",
      payload: expect.objectContaining({ source: "public", ideaId: "public-idea" }),
    }));
  });

  it("replays the same tracking token without consuming another limit or creating another idea", async () => {
    db.idea.findUnique.mockResolvedValue({ id: "existing", number: 76, projectId: publicProject.id });

    await expect(createPublicIdea(ref, publicInput(), publicHeaders, {
      db: db as never,
      consume: rateLimit.consume,
      emit,
    })).resolves.toMatchObject({ status: 200, ideaId: "existing", replayed: true });
    expect(rateLimit.consume).not.toHaveBeenCalled();
    expect(db.idea.create).not.toHaveBeenCalled();
  });

  it("rejects honeypot submissions and rate-limited clients", async () => {
    await expect(createPublicIdea(ref, publicInput({ website: "https://spam.test" }), publicHeaders, {
      db: db as never,
      consume: rateLimit.consume,
      emit,
    })).resolves.toMatchObject({ status: 400, error: "bot_detected" });
    expect(db.project.findFirst).not.toHaveBeenCalled();

    rateLimit.consume.mockResolvedValue({ allowed: false, retryAfterMs: 2_500 });
    await expect(createPublicIdea(ref, publicInput(), publicHeaders, {
      db: db as never,
      consume: rateLimit.consume,
      emit,
    })).resolves.toMatchObject({ status: 429, error: "rate_limited", retryAfterSeconds: 3 });
    expect(db.idea.create).not.toHaveBeenCalled();
  });

  it("sanitizes markup while allowing reports to describe URL schemes as text", () => {
    const sanitized = publicIdeaSchema.parse(publicInput({
      summary: "<b>A public report is not stored after submission.</b>",
      description: "<!-- template -->The report is not stored after submission.",
    }));
    expect(sanitized.summary).toBe("A public report is not stored after submission.");
    expect(sanitized.description).not.toContain("template");
    expect(publicIdeaSchema.safeParse(publicInput({ description: "Open javascript:alert(1) after submitting; expected data: 5." })).success).toBe(true);
  });

  it("rejects cross-origin and oversized API submissions before database work", async () => {
    const context = { params: Promise.resolve({ org: "zedu", project: "web" }) };
    const crossOrigin = new NextRequest("https://ziki.dev/api/public/projects/zedu/web/ideas", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://attacker.test" },
      body: JSON.stringify(publicInput()),
    });
    expect((await submitPublicIdea(crossOrigin, context)).status).toBe(403);

    const oversized = new NextRequest("https://ziki.dev/api/public/projects/zedu/web/ideas", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(25 * 1024), origin: "https://ziki.dev", host: "ziki.dev" },
      body: "{}",
    });
    expect((await submitPublicIdea(oversized, context)).status).toBe(413);
    expect(db.project.findFirst).not.toHaveBeenCalled();
  });

  it("accepts the public forwarded host when the server request URL uses its bind address", async () => {
    const context = { params: Promise.resolve({ org: "zedu", project: "web" }) };
    const proxied = new NextRequest("http://0.0.0.0:3000/api/public/projects/zedu/web/ideas", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://ziki.dev",
        host: "0.0.0.0:3000",
        "x-forwarded-host": "ziki.dev",
      },
      body: JSON.stringify(publicInput({ acknowledgeSimilar: true })),
    });

    expect((await submitPublicIdea(proxied, context)).status).toBe(201);
    expect(db.idea.create).toHaveBeenCalled();
  });
});

describe("creating an idea", () => {
  it("needs an idempotency key, and writes nothing without one", async () => {
    expect(await createIdeaWithPolicy(input({ idempotencyKey: "" }))).toMatchObject({ status: 400, error: "missing_idempotency_key" });
    expect(insert).not.toHaveBeenCalled();
  });

  it("creates once per key, and refuses the same key with a different body", async () => {
    expect(await createIdeaWithPolicy(input())).toEqual({ status: 201, ideaId: "new-idea", replayed: false });
    db.idempotencyKey.findUnique.mockResolvedValue({ ideaId: "new-idea", requestHash: "request-hash", createdAt: NOW });
    expect(await createIdeaWithPolicy(input({ requestHash: "different-hash" }))).toMatchObject({ status: 409, error: "idempotency_conflict" });
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("replays the winner when a concurrent retry takes the key first", async () => {
    db.idempotencyKey.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "6" }));
    db.idempotencyKey.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ ideaId: "winner", requestHash: "request-hash", createdAt: NOW });
    expect(await createIdeaWithPolicy(input())).toEqual({ status: 200, ideaId: "winner", replayed: true });
    expect(insert).not.toHaveBeenCalled();
  });

  it("flags a similar report in this organisation and project until it is acknowledged", async () => {
    db.$queryRaw.mockResolvedValue([similarRow]);
    expect(await createIdeaWithPolicy(input())).toMatchObject({ status: 409, error: "similar_issues" });
    const values = (db.$queryRaw.mock.calls[0] as unknown[]).slice(1);
    expect(values).toEqual(expect.arrayContaining(["organisation_zedu", "project_zedu"]));
    expect(await createIdeaWithPolicy(input({ acknowledgeSimilar: true }))).toMatchObject({ status: 201 });
  });
});

describe("proposing a marketing task", () => {
  it("is product work by default; a marketing idea needs a rationale and a product idea takes none", () => {
    expect(parseIdeaTrack({})).toEqual({ ok: true, value: { track: "product", rationale: null } });
    expect(parseIdeaTrack({ track: "marketing", rationale: "  People keep asking what changed.  " })).toEqual({
      ok: true,
      value: { track: "marketing", rationale: "People keep asking what changed." },
    });
    expect(parseIdeaTrack({ track: "marketing" })).toMatchObject({ ok: false, field: "rationale" });
    expect(parseIdeaTrack({ track: "marketing", rationale: "x".repeat(2001) })).toMatchObject({ ok: false, field: "rationale" });
    expect(parseIdeaTrack({ rationale: "Why not." })).toMatchObject({ ok: false, field: "rationale" });
    expect(parseIdeaTrack({ track: "sales" })).toMatchObject({ ok: false, field: "track" });
  });

  it("takes only a type on its own track, and writes nothing otherwise", async () => {
    db.issueType.findUnique.mockResolvedValue({ isActive: true, track: "product" });
    expect(await createIdeaWithPolicy(input({ track: "marketing", typeId: "type_bug" }))).toMatchObject({ status: 422, error: "wrong_track" });
    db.issueType.findUnique.mockResolvedValue({ isActive: true, track: "marketing" });
    expect(await createIdeaWithPolicy(input({ typeId: "type_blog" }))).toMatchObject({ status: 422, error: "wrong_track" });
    expect(insert).not.toHaveBeenCalled();
    expect(await createIdeaWithPolicy(input({ track: "marketing", typeId: "type_blog" }))).toMatchObject({ status: 201 });
    expect(insert).toHaveBeenCalledWith(db, { typeId: "type_blog" });
  });

  it("compares a marketing idea only with marketing work when looking for duplicates", async () => {
    await createIdeaWithPolicy(input({ track: "marketing" }));
    expect((db.$queryRaw.mock.calls[0] as unknown[]).slice(1)).toContain("marketing");
  });

  it("shows a marketing idea's rationale, and no rationale on a product idea", async () => {
    db.idea.findUniqueOrThrow.mockResolvedValue({ ...idea, track: "marketing", rationale: "A post answers everyone at once.", attachments: [] });
    expect(await readAgentIdea(scope, "12")).toMatchObject({ track: "marketing", rationale: "A post answers everyone at once." });
    db.idea.findUniqueOrThrow.mockResolvedValue({ ...idea, attachments: [] });
    const product = await readAgentIdea(scope, "12");
    expect(product).toMatchObject({ track: "product" });
    expect(product).not.toHaveProperty("rationale");
  });
});

describe("seeing an idea", () => {
  it("reads it only inside its own project, and is a 404 elsewhere", async () => {
    await readAgentIdea(scope, "12");
    expect(db.idea.findFirst).toHaveBeenLastCalledWith(expect.objectContaining({ where: { ...scope, isDeleted: false, number: 12 } }));
    db.idea.findFirst.mockResolvedValue(null);
    await expect(readAgentIdea(scope, "12")).rejects.toMatchObject({ status: 404 });
  });

  it("lists the project's ideas and names a bad filter", async () => {
    const page = await listAgentIdeas(scope, new URLSearchParams("status=open"));
    expect(db.idea.findMany.mock.calls[0][0].where).toMatchObject({ organisationId: "t1", projectId: "p1", track: "product", isDeleted: false, status: "open" });
    expect(page.items[0]).toMatchObject({ id: "i1", convertible: true });
    await expect(listAgentIdeas(scope, new URLSearchParams("status=idea"))).rejects.toMatchObject({ status: 400 });
  });

  it("lists rejected marketing ideas with their track and rationale, scoped to the project", async () => {
    db.idea.findMany.mockResolvedValue([{ ...idea, track: "marketing", rationale: "Supports the launch focus.", status: "rejected" }]);

    const page = await listAgentIdeas(scope, new URLSearchParams("track=marketing&status=rejected"));

    expect(db.idea.findMany.mock.calls.at(-1)?.[0].where).toMatchObject({
      organisationId: "t1",
      projectId: "p1",
      track: "marketing",
      status: "rejected",
      isDeleted: false,
    });
    expect(page.items[0]).toMatchObject({ track: "marketing", rationale: "Supports the launch focus.", status: "rejected" });
    await expect(listAgentIdeas(scope, new URLSearchParams("track=web"))).rejects.toMatchObject({ status: 400, body: { field: "track" } });
  });

  it("uses the Typesense match set, then applies the authenticated project scope and cursor order in PostgreSQL", async () => {
    indexedSearch.mockResolvedValue({ found: 1, hits: [{ id: "i1", kind: "idea", score: 10 }] });
    const result = await listAgentIdeas(scope, new URLSearchParams("q=Export%20activity%20as%20CSV&limit=1"));
    expect(result.items).toHaveLength(1);
    const query = db.idea.findMany.mock.calls.at(-1)![0];
    expect(query.where.id).toEqual({ in: ["i1"] });
    expect(query.where).toMatchObject({ organisationId: "t1", projectId: "p1", track: "product", isDeleted: false });
    expect(query.where).not.toHaveProperty("AND");
    expect(query.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
    expect(indexedSearch).toHaveBeenCalledWith(expect.objectContaining({
      kind: "idea", organisationId: "t1", projectId: "p1", track: "product",
      sortBy: "createdAt:desc,sourceId:desc", perPage: 2,
    }));
  });

  it("falls back to the track and project scoped PostgreSQL idea search when Typesense is unavailable", async () => {
    const page = await listAgentIdeas(scope, new URLSearchParams("track=marketing&q=Export%20activity%20as%20CSV"));
    expect(page.items).toHaveLength(1);
    expect(indexedSearch).toHaveBeenCalledWith(expect.objectContaining({ kind: "idea", track: "marketing" }));
    expect(db.idea.findMany.mock.calls.at(-1)![0].where).toMatchObject({
      organisationId: "t1", projectId: "p1", track: "marketing", isDeleted: false,
    });
    expect(db.idea.findMany.mock.calls.at(-1)![0].where).toHaveProperty("AND");
  });

  it("uses only the numeric timestamp in Typesense cursor filters, then keeps the full cursor predicate in PostgreSQL", async () => {
    indexedSearch.mockResolvedValue({ found: 1, hits: [{ id: "i1", kind: "idea", score: 10 }] });
    const cursor = encodeCursor({ createdAt: idea.createdAt, id: "idea-cursor" });
    await listAgentIdeas(scope, new URLSearchParams(`q=Export&limit=1&cursor=${cursor}`));
    expect(indexedSearch).toHaveBeenCalledWith(expect.objectContaining({
      extraFilters: expect.arrayContaining([`createdAt:<=${idea.createdAt.getTime()}`]),
    }));
    expect(db.idea.findMany.mock.calls.at(-1)![0].where).toHaveProperty("OR");
  });
});

describe("listing issues by track", () => {
  beforeEach(() => {
    db.bug.findMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => filterIssueRows(where));
  });

  it("defaults to product, preserving the existing list while excluding other projects and organisations", async () => {
    const page = await listAgentIssues(scope, new URLSearchParams());
    const blankTrack = await listAgentIssues(scope, new URLSearchParams("track="));

    expect(db.bug.findMany.mock.calls[0][0].where).toMatchObject({
      organisationId: "t1",
      projectId: "p1",
      track: "product",
    });
    expect(page.items.map(({ id, track }) => ({ id, track }))).toEqual([{ id: "product-local", track: "product" }]);
    expect(blankTrack.items.map(({ id, track }) => ({ id, track }))).toEqual([{ id: "product-local", track: "product" }]);
  });

  it("returns only marketing issues and includes track on each item", async () => {
    const page = await listAgentIssues(scope, new URLSearchParams("track=marketing"));

    expect(db.bug.findMany.mock.calls[0][0].where).toMatchObject({
      organisationId: "t1",
      projectId: "p1",
      track: "marketing",
    });
    expect(page.items.map(({ id, track }) => ({ id, track }))).toEqual([{ id: "marketing-local", track: "marketing" }]);
  });

  it("combines q with track without returning matching product issues", async () => {
    const page = await listAgentIssues(scope, new URLSearchParams("track=marketing&q=search%20phrase"));

    expect(db.bug.findMany.mock.calls[0][0].where).toMatchObject({
      organisationId: "t1",
      projectId: "p1",
      track: "marketing",
    });
    expect(page.items.map(({ id, track }) => ({ id, track }))).toEqual([{ id: "marketing-local", track: "marketing" }]);
    expect(indexedSearch).toHaveBeenCalledWith(expect.objectContaining({ kind: "bug", track: "marketing" }));
  });

  it("rejects an invalid track with the ideas endpoint's 400 contract", async () => {
    await expect(listAgentIssues(scope, new URLSearchParams("track=sales"))).rejects.toMatchObject({
      status: 400,
      body: { error: "invalid_request", field: "track" },
    });
    expect(db.bug.findMany).not.toHaveBeenCalled();
  });

  it("lets a key work in every project of its organisation, and in no other organisation's (#user-agents)", async () => {
    const agent = {
      agentId: "agent-1",
      name: "Agent",
      ownerId: "owner-1",
      organisationId: "t1",
      level: "working",
      burst: false,
      keyId: "key-1",
    } as const;
    db.project.findFirst.mockResolvedValue({ id: "p2" });
    await expect(issueProject(agent, new URLSearchParams("projectId=p2"))).resolves.toEqual({ organisationId: "t1", projectId: "p2" });

    db.project.findFirst.mockResolvedValue(null);
    await expect(issueProject(agent, new URLSearchParams("projectId=another-organisation-project"))).rejects.toMatchObject({ status: 404 });
    expect(db.project.findFirst.mock.calls.map(([args]) => args.where)).toEqual([
      { id: "p2", organisationId: "t1" },
      { id: "another-organisation-project", organisationId: "t1" },
    ]);
    expect(db.bug.findMany).not.toHaveBeenCalled();
  });
});

describe("counting issues by track", () => {
  const groupedCounts = <T extends { organisationId: string; projectId: string; track: string; isDeleted: boolean }>(
    rows: readonly T[],
    key: string,
    where: Record<string, unknown>,
  ) => {
    const values = new Map<string, number>();
    for (const row of rows) {
      if (row.organisationId !== where.organisationId || row.projectId !== where.projectId || row.track !== where.track || row.isDeleted) continue;
      const value = String((row as T & Record<string, unknown>)[key]);
      values.set(value, (values.get(value) ?? 0) + 1);
    }
    return [...values].map(([value, count]) => ({ [key]: value, _count: { _all: count } }));
  };

  it("defaults to product and counts only the selected track's issues and ideas", async () => {
    db.bug.groupBy.mockImplementation(async ({ by, where }: { by: string[]; where: Record<string, unknown> }) =>
      groupedCounts(countedBugs, by[0], where));
    db.idea.groupBy.mockImplementation(async ({ by, where }: { by: string[]; where: Record<string, unknown> }) =>
      groupedCounts(countedIdeas, by[0], where));

    const product = await countAgentIssues(scope, new URLSearchParams());
    const marketing = await countAgentIssues(scope, new URLSearchParams("track=marketing"));

    expect(product.issues).toMatchObject({ open: 1, all: 1 });
    expect(product.ideas).toMatchObject({ open: 1, rejected: 0 });
    expect(marketing.issues).toMatchObject({ resolved: 1, all: 1 });
    expect(marketing.substatuses.published).toBe(1);
    expect(marketing.ideas).toMatchObject({ open: 0, rejected: 1 });
    expect(db.bug.groupBy.mock.calls.map(([args]) => args.where.track)).toEqual(["product", "product", "marketing", "marketing"]);
    expect(db.idea.groupBy.mock.calls.map(([args]) => args.where.track)).toEqual(["product", "marketing"]);
  });

  it("rejects an invalid track before counting", async () => {
    await expect(countAgentIssues(scope, new URLSearchParams("track=sales"))).rejects.toMatchObject({
      status: 400,
      body: { error: "invalid_request", field: "track" },
    });
    expect(db.bug.groupBy).not.toHaveBeenCalled();
    expect(db.idea.groupBy).not.toHaveBeenCalled();
  });
});

describe("issue suggestions by track", () => {
  const suggestionIssues = [
    { id: "product-42", number: 42, title: "Product issue 42", status: "open", track: "product", organisationId: "t1", projectId: "p1", isDeleted: false, project: { slug: "acme", organisation: { slug: "acme" } } },
    { id: "marketing-43", number: 43, title: "Marketing issue 43", status: "open", track: "marketing", organisationId: "t1", projectId: "p1", isDeleted: false, project: { slug: "acme", organisation: { slug: "acme" } } },
  ];

  beforeEach(() => {
    db.bug.findMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
      const matches = (where.OR as Array<{ number?: number; title?: { contains?: string } }> | undefined) ?? [];
      const ids = typeof where.id === "object" && where.id && "in" in where.id ? (where.id as { in: string[] }).in : null;
      return suggestionIssues.filter((row) =>
        row.organisationId === where.organisationId
        && row.projectId === where.projectId
        && row.track === where.track
        && !row.isDeleted
        && (!ids || ids.includes(row.id))
        && (!matches.length || matches.some((match) => match.number === row.number
          || Boolean(match.title?.contains && row.title.toLowerCase().includes(match.title.contains.toLowerCase())))),
      );
    });
  });

  it("defaults to product, filters numeric lookup by track, and returns each item's track", async () => {
    const product = await suggestIssues(new NextRequest("https://ziki.test/api/issues/suggest?q=42"));
    const marketing = await suggestIssues(new NextRequest("https://ziki.test/api/issues/suggest?q=43&track=marketing"));
    const noProductLeak = await suggestIssues(new NextRequest("https://ziki.test/api/issues/suggest?q=42&track=marketing"));
    const marketingText = await suggestIssues(new NextRequest("https://ziki.test/api/issues/suggest?q=Marketing&track=marketing"));

    expect(product.status).toBe(200);
    await expect(product.json()).resolves.toMatchObject({ issues: [{ id: "product-42", number: 42, track: "product" }] });
    expect(marketing.status).toBe(200);
    await expect(marketing.json()).resolves.toMatchObject({ issues: [{ id: "marketing-43", number: 43, track: "marketing" }] });
    await expect(noProductLeak.json()).resolves.toEqual({ issues: [] });
    await expect(marketingText.json()).resolves.toMatchObject({ issues: [{ id: "marketing-43", track: "marketing" }] });
    const requestedTracks = db.bug.findMany.mock.calls.map(([args]) => args.where.track);
    expect(requestedTracks).toContain("product");
    expect(requestedTracks).toContain("marketing");
    expect(indexedSearch).toHaveBeenCalledWith(expect.objectContaining({ kind: "bug", track: "marketing" }));
  });

  it("rejects an invalid track", async () => {
    const response = await suggestIssues(new NextRequest("https://ziki.test/api/issues/suggest?q=42&track=sales"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_request", field: "track" });
    expect(db.bug.findMany).not.toHaveBeenCalled();
  });
});

describe("structuring an idea as it is submitted", () => {
  const extraction = {
    title: "Export activity as CSV",
    summary: "People want to download their activity.",
    problem: "There is no way to get activity out of Ziki.",
    proposedSolution: "Add a CSV export to the activity page.",
    acceptanceCriteria: ["The activity page has an Export button", "The file opens in a spreadsheet"],
  };

  beforeEach(() => {
    vi.stubEnv("ZIKI_CLAUDE_API_KEY", "sk-ant-test");
    claude.parse.mockResolvedValue({ stop_reason: "end_turn", parsed_output: extraction });
  });

  it("writes what the person typed up as a titled idea with the standard headings, keeping their words", async () => {
    const typed = "would be nice to get my activity out as csv";
    const result = await structureIdea({ title: typed, description: typed });
    expect(result?.title).toBe("Export activity as CSV");
    expect(result?.description).toContain("## Summary");
    expect(result?.description).toContain("## Acceptance Criteria\n- [ ] The activity page has an Export button");
    expect(result?.description).toContain(`## Original request\n${typed}`);
  });

  it("structures a short idea too", async () => {
    const result = await structureIdea({ title: "random idea for testing", description: "random idea for testing" });
    expect(result?.title).toBe("Export activity as CSV");
  });

  it("leaves an idea already in the standard headings as it is, without calling Claude", async () => {
    const written = "## Summary\nExport.\n\n## Problem\nNo export.\n\n## Acceptance Criteria\n- [ ] Works";
    expect(await structureIdea({ title: "Export", description: written })).toBeNull();
    expect(claude.parse).not.toHaveBeenCalled();
  });

  it("saves the idea as typed when there is no key, the call fails, or Claude declines", async () => {
    const typed = { title: "csv export", description: "would be nice to get my activity out as csv" };
    vi.stubEnv("ZIKI_CLAUDE_API_KEY", "");
    expect(await structureIdea(typed)).toBeNull();

    vi.stubEnv("ZIKI_CLAUDE_API_KEY", "sk-ant-test");
    claude.parse.mockRejectedValueOnce(new Error("network down"));
    expect(await structureIdea(typed)).toBeNull();

    claude.parse.mockResolvedValueOnce({ stop_reason: "refusal", parsed_output: null });
    expect(await structureIdea(typed)).toBeNull();
  });
});

/** Already vetted: an idea the owner says was approved elsewhere skips the verdicts, with a note and a daily limit. */
describe("feature plans feed the existing idea lifecycle", () => {
  const user = { id: "owner", role: "user" as const, name: "Owner" };
  const project = { id: "p1", name: "Appointments", slug: "web", goal: null, organisationId: "t1", organisation: { slug: "team" } };
  const request = { title: "Appointment booking", request: "Customers can book an available appointment and receive confirmation." };
  const makeDraft = (): FeatureDraft => ({
    outcome: "A customer can book an available appointment and see confirmation.",
    definitionOfDone: ["A booking reserves the selected time and shows confirmation."],
    tasks: [
      { title: "Book an available appointment", description: "Let customers choose an available time and reserve it.", acceptanceCriteria: ["A booked time is no longer available."], scope: "first", existing: null },
      { title: "Reschedule a booking", description: "Let customers move an existing booking to another available time.", acceptanceCriteria: ["Rescheduling releases the old time."], scope: "later", existing: null },
    ],
  });
  let plan: { id: string; projectId: string; creatorId: string; title: string; request: string; draft: FeatureDraft; version: number; publishedAt: Date | null };
  let receipts: Array<{ position: number; ideaId?: string | null; bugId?: string | null }>;
  beforeEach(() => {
    plan = { id: "plan1", projectId: "p1", creatorId: user.id, ...request, draft: makeDraft(), version: 1, publishedAt: null };
    receipts = [];
    featureMembership.mockResolvedValue(true);
    db.project.findFirst.mockResolvedValue(project);
    db.featurePlan.findFirst.mockImplementation(async ({ where }) => where.creatorId === plan.creatorId && where.projectId === plan.projectId ? plan : null);
    db.featurePlan.update.mockImplementation(async ({ data }) => { plan = { ...plan, ...data, version: data.version ? plan.version + 1 : plan.version }; return { id: plan.id, version: plan.version }; });
    db.featurePlanItem.findMany.mockImplementation(async () => receipts);
    db.featurePlanItem.create.mockImplementation(async ({ data }) => { receipts.push(data); return data; });
    db.idea.create.mockImplementation(async () => ({ id: `idea-${receipts.length}`, number: receipts.length + 1 }));
    featurePublish.mockResolvedValue(undefined);
  });

  it("refuses non-members before searching, drafting or writing in a public project", async () => {
    featureMembership.mockResolvedValue(false);
    await expect(featureProject(user, "p1")).rejects.toThrow(/membership/);
    await expect(findFeatureWork(user, "p1", "appointment")).rejects.toThrow(/membership/);
    await expect(createFeaturePlan(user, "p1", "new", request, makeDraft())).rejects.toThrow(/membership/);
    await expect(publishFeaturePlan(user, "p1", plan.id, 1, "first")).rejects.toThrow(/membership/);
    expect(db.idea.create).not.toHaveBeenCalled();
    expect(db.featurePlan.upsert).not.toHaveBeenCalled();
  });

  it("keeps a saved draft out of the idea/work queues", async () => {
    db.featurePlan.upsert.mockResolvedValue({ id: "new", version: 1, ...request, draft: makeDraft() });
    await expect(createFeaturePlan(user, "p1", "new", request, makeDraft())).resolves.toEqual({ id: "new", version: 1 });
    expect(db.idea.create).not.toHaveBeenCalled();
    expect(featurePublish).not.toHaveBeenCalled();
  });

  it("refuses to silently discard changed content when a draft creation is retried", async () => {
    db.featurePlan.upsert.mockResolvedValue({ id: "new", version: 1, ...request, draft: makeDraft() });
    const edited = makeDraft(); edited.outcome = "A changed outcome that must not be silently discarded.";
    await expect(createFeaturePlan(user, "p1", "new", request, edited)).rejects.toThrow(/already saved/);
    expect(db.idea.create).not.toHaveBeenCalled();
  });

  it("prevents another creator, stale editors and changes to published scope", async () => {
    await expect(saveFeaturePlan({ ...user, id: "other" }, "p1", plan.id, 1, request, makeDraft())).rejects.toThrow(/not found/);
    await saveFeaturePlan(user, "p1", plan.id, 1, request, makeDraft());
    await expect(saveFeaturePlan(user, "p1", plan.id, 1, request, makeDraft())).rejects.toThrow(/another tab/);
    await expect(publishFeaturePlan(user, "p1", plan.id, 1, "first")).rejects.toThrow(/another tab/);
    plan.publishedAt = NOW;
    await expect(saveFeaturePlan(user, "p1", plan.id, 2, request, makeDraft())).rejects.toThrow(/Published plans/);
  });

  it("publishes only the first version as ordinary ideas and makes response-loss retries idempotent", async () => {
    await expect(publishFeaturePlan(user, "p1", plan.id, 1, "first")).resolves.toEqual({ created: 1, linked: 0, replayed: false });
    expect(db.idea.create).toHaveBeenCalledOnce();
    const created = db.idea.create.mock.calls[0][0].data;
    expect(created).toMatchObject({ projectId: "p1", organisationId: "t1", reporterId: user.id, beneficiaryUserId: user.id });
    expect(created.status).toBeUndefined(); // The normal open idea default; no conversion or approval bypass.
    expect(created.description).toContain(plan.draft.outcome);
    expect(created.description).toContain(plan.draft.definitionOfDone[0]);
    expect(created.description).toContain("/team/web/features/plan1");
    expect(featurePublish).toHaveBeenCalledWith(db, expect.objectContaining({ type: "idea.created", projectId: "p1" }));
    await expect(publishFeaturePlan(user, "p1", plan.id, 1, "first")).resolves.toEqual({ created: 0, linked: 0, replayed: true });
    expect(db.idea.create).toHaveBeenCalledOnce();
    await expect(publishFeaturePlan(user, "p1", plan.id, 1, "later")).resolves.toEqual({ created: 1, linked: 0, replayed: false });
    await publishFeaturePlan(user, "p1", plan.id, 1, "later");
    expect(db.idea.create).toHaveBeenCalledTimes(2);
  });

  it("refuses later publication before first-version review", async () => {
    await expect(publishFeaturePlan(user, "p1", plan.id, 1, "later")).rejects.toThrow(/first version/);
    expect(db.idea.create).not.toHaveBeenCalled();
  });

  it("links existing project work without rewriting it or filing another idea", async () => {
    plan.draft.tasks[0].existing = "issue:existing";
    db.bug.findFirst.mockResolvedValue({ id: "existing" });
    await expect(publishFeaturePlan(user, "p1", plan.id, 1, "first")).resolves.toEqual({ created: 0, linked: 1, replayed: false });
    expect(db.bug.findFirst).toHaveBeenCalledWith({ where: expect.objectContaining({ id: "existing", projectId: "p1", organisationId: "t1", isDeleted: false, track: "product" }), select: { id: true } });
    expect(receipts[0]).toMatchObject({ position: 0, bugId: "existing", ideaId: null });
    expect(db.idea.create).not.toHaveBeenCalled();
    expect(featurePublish).not.toHaveBeenCalled();
  });

  it("rejects deleted, foreign-project or invented links before creating any new ideas", async () => {
    plan.draft.tasks[1] = { ...plan.draft.tasks[1], scope: "first", existing: "idea:foreign" };
    db.idea.findFirst.mockResolvedValue(null);
    await expect(publishFeaturePlan(user, "p1", plan.id, 1, "first")).rejects.toThrow(/no longer available/);
    expect(db.idea.findFirst).toHaveBeenCalledWith({ where: expect.objectContaining({ id: "foreign", projectId: "p1", organisationId: "t1", isDeleted: false }), select: { id: true } });
    expect(db.idea.create).not.toHaveBeenCalled();
    expect(db.featurePlanItem.create).not.toHaveBeenCalled();
  });

  it("does not finish publication when event delivery recording fails", async () => {
    featurePublish.mockRejectedValueOnce(new Error("event storage unavailable"));
    await expect(publishFeaturePlan(user, "p1", plan.id, 1, "first")).rejects.toThrow(/event storage/);
    expect(db.featurePlanItem.create).not.toHaveBeenCalled();
    expect(plan.publishedAt).toBeNull();
  });

  it("requires a first version, bounded criteria and unique existing references", () => {
    const laterOnly = makeDraft(); laterOnly.tasks.forEach((task) => { task.scope = "later"; });
    expect(featureDraftSchema.safeParse(laterOnly).success).toBe(false);
    const repeated = makeDraft(); repeated.tasks.forEach((task) => { task.existing = "idea:same"; });
    expect(featureDraftSchema.safeParse(repeated).success).toBe(false);
    expect(featureDraftSchema.safeParse({ ...makeDraft(), definitionOfDone: [] }).success).toBe(false);
  });

  it("keeps idea verdicts, issue delivery and actual deployment distinct, including unavailable work", () => {
    const issue = { isDeleted: false, status: "done", substatus: "accepted" };
    expect(featureWorkState({ idea: null, bug: issue })).toEqual({ kind: "issue", status: "done", substatus: "accepted" });
    expect(featureWorkState({ idea: { isDeleted: false, status: "converted", issue: { ...issue, status: "resolved", substatus: "on_prod" } }, bug: null })).toMatchObject({ kind: "issue", substatus: "on_prod" });
    expect(featureWorkState({ idea: { isDeleted: false, status: "rejected", issue: null }, bug: null })).toMatchObject({ kind: "idea", status: "rejected" });
    expect(featureWorkState({ idea: null, bug: { ...issue, isDeleted: true } })).toMatchObject({ kind: "unavailable" });
    expect(featureWorkState({ idea: { isDeleted: true, status: "open", issue: null }, bug: null })).toMatchObject({ kind: "unavailable" });
  });

  it("never trusts generated references and returns no proposal when AI is unavailable", async () => {
    vi.stubEnv("ZIKI_CLAUDE_API_KEY", "");
    const context = { project: project.name, goal: null, brief: null, notes: null, work: [] };
    expect(await generateFeatureDraft(request, context)).toBeNull();
    vi.stubEnv("ZIKI_CLAUDE_API_KEY", "test");
    const proposed = makeDraft(); proposed.tasks[0].existing = "issue:invented";
    claude.parse.mockResolvedValueOnce({ stop_reason: "end_turn", parsed_output: proposed });
    const constrained = { ...request, request: `${request.request}\n\nConstraints:\nNo payments in the first version.` };
    const result = await generateFeatureDraft(constrained, context);
    expect(JSON.parse(claude.parse.mock.calls.at(-1)![0].messages[0].content).request.request).toContain("No payments in the first version.");
    expect(result?.tasks[0].existing).toBeNull();
    claude.parse.mockRejectedValueOnce(new Error("offline"));
    expect(await generateFeatureDraft(request, context)).toBeNull();
  });
});

describe("already vetted ideas", () => {
  it("takes alreadyVetted only with a note saying where it was approved, and a note only with alreadyVetted", () => {
    expect(() => assertVettedFields({})).not.toThrow();
    expect(() => assertVettedFields({ alreadyVetted: true, vettedNote: "Approved by Mark, sheet row 42" })).not.toThrow();
    expect(() => assertVettedFields({ alreadyVetted: true })).toThrowError(/vettedNote/);
    expect(() => assertVettedFields({ vettedNote: "Approved by Mark" })).toThrowError(/alreadyVetted/);
    const idea = { title: "Add a CSV export", summary: "People want a CSV of the activity.", description: "People want their data as a CSV." };
    expect(createIdeaSchema.safeParse({ ...idea, alreadyVetted: "yes" }).success).toBe(false);
    expect(createIdeaSchema.safeParse({ ...idea, alreadyVetted: true, vettedNote: "ok" }).success).toBe(false);
  });
});
