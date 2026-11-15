import "server-only";
import type { Bug, Idea } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { documentId, ensureWorkItemsCollection, epoch, getTypesenseClient, typesenseConfig, WORK_ITEMS_COLLECTION, type WorkItemDocument } from "@/lib/typesense";

const SUBSTATUS_ORDER = ["requires_confirmation", "open", "in_progress", "requires_review", "accepted", "ready_to_merge", "error", "on_dev", "on_staging", "on_prod", "published", "force_merged", "merged_broken", "closed"];

export function searchOutboxPolicy(env: NodeJS.ProcessEnv = process.env) {
  const positiveInteger = (name: string, fallback: number, maximum: number) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new Error(`${name} must be an integer from 1 to ${maximum}.`);
    }
    return value;
  };
  return {
    maxAttempts: positiveInteger("SEARCH_OUTBOX_MAX_ATTEMPTS", 10, 100),
    retentionDays: positiveInteger("SEARCH_OUTBOX_RETENTION_DAYS", 30, 3650),
    cleanupBatchSize: positiveInteger("SEARCH_OUTBOX_CLEANUP_BATCH_SIZE", 500, 1000),
  };
}

export function bugSearchDocument(row: Bug): WorkItemDocument {
  return {
    id: documentId("bug", row.id), sourceId: row.id, kind: "bug", organisationId: row.organisationId,
    projectId: row.projectId, track: row.track, number: row.number, numberText: String(row.number), title: row.title,
    description: row.description, status: row.status, substatus: row.substatus,
    substatusOrder: SUBSTATUS_ORDER.indexOf(row.substatus),
    typeId: row.typeId ?? undefined,
    areaId: row.areaId ?? undefined, milestoneId: row.milestoneId ?? undefined,
    reporterId: row.reporterId ?? undefined, assigneeId: row.assigneeId ?? undefined,
    createdByAgentId: row.createdByAgentId ?? undefined,
    duplicateOfId: row.duplicateOfId ?? undefined,
    hasType: row.typeId !== null, hasArea: row.areaId !== null,
    hasMilestone: row.milestoneId !== null, hasAssignee: row.assigneeId !== null,
    hasAgentCreator: row.createdByAgentId !== null, hasDuplicateOf: row.duplicateOfId !== null,
    hasBoostedAt: row.boostedAt !== null, isDeleted: row.isDeleted,
    isBoosted: row.isBoosted, boostedAt: epoch(row.boostedAt), voteCount: row.voteCount,
    score: 0, reward: row.reward.toNumber(), createdAt: epoch(row.createdAt)!, updatedAt: epoch(row.updatedAt)!,
  };
}

export function ideaSearchDocument(row: Idea): WorkItemDocument {
  return {
    id: documentId("idea", row.id), sourceId: row.id, kind: "idea", organisationId: row.organisationId,
    projectId: row.projectId, track: row.track, number: row.number, numberText: String(row.number), title: row.title,
    description: row.description, status: row.status, typeId: row.typeId ?? undefined,
    areaId: row.areaId ?? undefined, substatusOrder: 0,
    reporterId: row.reporterId ?? undefined, createdByAgentId: row.createdByAgentId ?? undefined,
    hasType: row.typeId !== null, hasArea: row.areaId !== null,
    hasMilestone: false, hasAssignee: false, hasAgentCreator: row.createdByAgentId !== null,
    hasDuplicateOf: false, hasBoostedAt: false, isDeleted: row.isDeleted, isBoosted: false,
    voteCount: 0, score: row.score, reward: 0, createdAt: epoch(row.createdAt)!, updatedAt: epoch(row.updatedAt)!,
  };
}

export function bugSearchSort(sort: string, boostFirst = true): string {
  const sorts: Record<string, string> = {
    newest: "createdAt:desc,sourceId:desc",
    recently_updated: "updatedAt:desc,sourceId:desc",
    importance: "voteCount:desc,updatedAt:desc,createdAt:desc",
    least_important: "voteCount:asc,updatedAt:desc,createdAt:desc",
    title: "title:asc,sourceId:asc",
    title_desc: "title:desc,sourceId:desc",
    status: "substatusOrder:asc,updatedAt:desc,sourceId:desc",
    status_desc: "substatusOrder:desc,updatedAt:desc,sourceId:desc",
    reward: "reward:desc,voteCount:desc,sourceId:desc",
    reward_low: "reward:asc,voteCount:desc,sourceId:desc",
  };
  const selectedSort = sorts[sort] ?? sorts.importance;
  // Typesense allows at most three sort fields. Preserve the app's boost
  // ordering and the selected primary sort, dropping only secondary tie-breaks.
  return boostFirst ? `isBoosted:desc,boostedAt:desc,${selectedSort.split(",")[0]}` : selectedSort;
}

export function ideaSearchSort(sort: string): string {
  const sorts: Record<string, string> = {
    score: "score:desc,createdAt:desc,sourceId:desc",
    score_asc: "score:asc,createdAt:desc,sourceId:desc",
    title: "title:asc,sourceId:asc",
    title_desc: "title:desc,sourceId:desc",
    updated: "updatedAt:desc,sourceId:desc",
    updated_asc: "updatedAt:asc,sourceId:asc",
  };
  return sorts[sort] ?? sorts.score;
}

export function typesenseFilter(field: string, value: unknown): string | null {
  if (value === undefined) return null;
  const presenceFields: Record<string, string> = {
    typeId: "hasType", areaId: "hasArea", milestoneId: "hasMilestone",
    assigneeId: "hasAssignee", createdByAgentId: "hasAgentCreator", duplicateOfId: "hasDuplicateOf", boostedAt: "hasBoostedAt",
  };
  const literal = (item: string | number | boolean) => typeof item === "string" && !/^[\w-]+$/.test(item)
    ? `\`${item.replaceAll("\\", "\\\\").replaceAll("`", "\\`")}\``
    : String(item);
  if (value === null) return presenceFields[field] ? `${presenceFields[field]}:=false` : null;
  if (Array.isArray(value)) return value.length ? `${field}:[${value.map((item) => literal(item as string | number | boolean)).join(",")}]` : null;
  if (typeof value === "object") {
    const filter = value as { in?: unknown[]; notIn?: unknown[]; not?: unknown };
    if (Array.isArray(filter.in)) return filter.in.length ? `${field}:[${filter.in.map((v) => literal(v as string | number | boolean)).join(",")}]` : null;
    if (Array.isArray(filter.notIn)) return filter.notIn.length ? `${field}:!=[${filter.notIn.map((v) => literal(v as string | number | boolean)).join(",")}]` : null;
    if (filter.not === null) return presenceFields[field] ? `${presenceFields[field]}:=true` : null;
    if (typeof filter.not === "string" || typeof filter.not === "number" || typeof filter.not === "boolean") return `${field}:!=${literal(filter.not)}`;
    return null;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return `${field}:=${literal(value)}`;
  return null;
}

export async function upsertSearchDocument(doc: WorkItemDocument): Promise<void> {
  await ensureWorkItemsCollection();
  await getTypesenseClient().collections(WORK_ITEMS_COLLECTION).documents().upsert(doc);
}

export async function deleteSearchDocument(kind: "bug" | "idea", sourceId: string): Promise<void> {
  await ensureWorkItemsCollection();
  try { await getTypesenseClient().collections(WORK_ITEMS_COLLECTION).documents(documentId(kind, sourceId)).delete(); }
  catch (error) { if ((error as { httpStatus?: number }).httpStatus !== 404) throw error; }
}

const CLAIM_ONE = `
  UPDATE "SearchIndexOutbox" AS claimed SET "status"='processing', "claimedAt"=NOW()
  WHERE claimed."id" = (
    SELECT event."id" FROM "SearchIndexOutbox" AS event
    WHERE event."status"='pending' AND event."availableAt"<=NOW()
      AND NOT EXISTS (
        SELECT 1 FROM "SearchIndexOutbox" AS earlier
        WHERE earlier."kind"=event."kind" AND earlier."sourceId"=event."sourceId"
          AND earlier."id"<event."id" AND earlier."status" IN ('pending','processing')
      )
      AND NOT EXISTS (
        SELECT 1 FROM "SearchIndexControl" AS control
        WHERE control."id"=1 AND control."leaseUntil">NOW()
      )
    ORDER BY event."id" FOR UPDATE SKIP LOCKED LIMIT 1
  ) RETURNING claimed.*`;

type OutboxEvent = {
  id: bigint; kind: string; sourceId: string; action: string; organisationId: string | null;
  projectId: string | null; status: string; attempts: number; availableAt: Date;
  claimedAt: Date | null; processedAt: Date | null; lastError: string | null; createdAt: Date;
};

async function claimNext(): Promise<OutboxEvent | null> {
  return prisma.$transaction(async (tx) => {
    const control = await tx.$queryRaw<Array<{ leaseUntil: Date | null }>>`SELECT "leaseUntil" FROM "SearchIndexControl" WHERE "id"=1 FOR UPDATE`;
    if (control[0]?.leaseUntil && control[0].leaseUntil > new Date()) return null;
    const { maxAttempts } = searchOutboxPolicy();
    await tx.$executeRaw`UPDATE "SearchIndexOutbox"
      SET "attempts"="attempts"+1,
          "status"=CASE WHEN "attempts"+1 >= ${maxAttempts} THEN 'failed' ELSE 'pending' END,
          "claimedAt"=NULL, "availableAt"=NOW(),
          "lastError"=COALESCE("lastError", 'Worker claim expired before acknowledgement.')
      WHERE "status"='processing' AND "claimedAt"<NOW()-INTERVAL '5 minutes'`;
    const rows = await tx.$queryRawUnsafe<OutboxEvent[]>(CLAIM_ONE);
    return rows[0] ?? null;
  });
}

async function applyEvent(event: OutboxEvent): Promise<void> {
  if (event.kind === "bug") {
    const row = await prisma.bug.findUnique({ where: { id: event.sourceId } });
    return row ? upsertSearchDocument(bugSearchDocument(row)) : deleteSearchDocument("bug", event.sourceId);
  }
  if (event.kind === "idea") {
    const row = await prisma.idea.findUnique({ where: { id: event.sourceId } });
    return row ? upsertSearchDocument(ideaSearchDocument(row)) : deleteSearchDocument("idea", event.sourceId);
  }
  throw new Error(`Unknown search-index kind: ${event.kind}`);
}

export async function processSearchOutbox(limit = 100): Promise<{ processed: number; failed: number; skipped?: "disabled" | "unconfigured" }> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("Outbox processing limit must be an integer from 1 to 1000.");
  let configured = true;
  try { typesenseConfig(); } catch { configured = false; }
  if (!configured) return { processed: 0, failed: 0, skipped: "unconfigured" };
  const [control] = await prisma.$queryRaw<Array<{ indexingEnabled: boolean }>>`SELECT "indexingEnabled" FROM "SearchIndexControl" WHERE "id"=1`;
  if (!control?.indexingEnabled) return { processed: 0, failed: 0, skipped: "disabled" };
  const { maxAttempts } = searchOutboxPolicy();
  let processed = 0;
  let failed = 0;
  for (let i = 0; i < limit; i += 1) {
    const event = await claimNext();
    if (!event) break;
    try {
      await applyEvent(event);
      await prisma.$executeRaw`UPDATE "SearchIndexOutbox" SET "status"='processed', "processedAt"=${new Date()}, "claimedAt"=NULL, "lastError"=NULL WHERE "id"=${event.id}`;
      processed += 1;
    } catch (error) {
      const attempts = event.attempts + 1;
      const status = attempts >= maxAttempts ? "failed" : "pending";
      await prisma.$executeRaw`UPDATE "SearchIndexOutbox" SET "status"=${status}, "attempts"=${attempts}, "claimedAt"=NULL, "availableAt"=${new Date(Date.now() + Math.min(3600, 2 ** Math.min(attempts, 10)) * 1000)}, "lastError"=${(error instanceof Error ? error.message : String(error)).slice(0, 2000)} WHERE "id"=${event.id}`;
      failed += 1;
      console.error(`[search-index] ${status === "failed" ? "permanently failed" : "retry scheduled for"} ${event.kind}:${event.sourceId} (attempt ${attempts}/${maxAttempts})`, error);
    }
  }
  return { processed, failed };
}

export type FailedSearchOutboxEvent = {
  id: bigint;
  kind: string;
  sourceId: string;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
};

export async function listFailedSearchOutbox(limit = 50, afterId = "0"): Promise<FailedSearchOutboxEvent[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error("Failed-event listing limit must be an integer from 1 to 200.");
  if (!/^(0|[1-9]\d{0,18})$/.test(afterId) || BigInt(afterId) > BigInt("9223372036854775807")) throw new Error("Failed-event cursor must be a valid nonnegative event ID.");
  return prisma.$queryRaw<FailedSearchOutboxEvent[]>`SELECT "id", "kind", "sourceId", "attempts", "lastError", "createdAt"
    FROM "SearchIndexOutbox" WHERE "status"='failed' AND "id">${BigInt(afterId)} ORDER BY "id" ASC LIMIT ${limit}`;
}

export async function retryFailedSearchOutbox(eventId: string): Promise<boolean> {
  if (!/^[1-9]\d{0,18}$/.test(eventId) || BigInt(eventId) > BigInt("9223372036854775807")) throw new Error("Outbox event ID must be a positive integer.");
  const rows = await prisma.$queryRaw<Array<{ id: bigint }>>`UPDATE "SearchIndexOutbox"
    SET "status"='pending', "attempts"=0, "claimedAt"=NULL, "processedAt"=NULL,
        "availableAt"=NOW(), "lastError"=NULL
    WHERE "id"=${BigInt(eventId)} AND "status"='failed'
    RETURNING "id"`;
  return rows.length > 0;
}

export async function pruneProcessedSearchOutbox(now = new Date()): Promise<number> {
  const { retentionDays, cleanupBatchSize } = searchOutboxPolicy();
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const rows = await prisma.$queryRaw<Array<{ id: bigint }>>`WITH candidates AS (
      SELECT "id" FROM "SearchIndexOutbox"
      WHERE "status"='processed' AND "processedAt" < ${cutoff}
      ORDER BY "processedAt" ASC, "id" ASC
      FOR UPDATE SKIP LOCKED LIMIT ${cleanupBatchSize}
    ) DELETE FROM "SearchIndexOutbox" AS event USING candidates
      WHERE event."id"=candidates."id" RETURNING event."id"`;
  return rows.length;
}

export async function indexAllWorkItems(batchSize = 200, afterBatch?: () => Promise<void>) {
  await ensureWorkItemsCollection();
  const totals = { processed: 0, indexed: 0, skipped: 0, failed: 0 };
  for (const kind of ["bug", "idea"] as const) {
    let afterId: string | undefined;
    while (true) {
      const rows = kind === "bug"
        ? await prisma.bug.findMany({ orderBy: { id: "asc" }, ...(afterId ? { cursor: { id: afterId }, skip: 1 } : {}), take: batchSize })
        : await prisma.idea.findMany({ orderBy: { id: "asc" }, ...(afterId ? { cursor: { id: afterId }, skip: 1 } : {}), take: batchSize });
      if (rows.length === 0) break;
      afterId = rows.at(-1)!.id;
      const docs = rows.map((row) => kind === "bug" ? bugSearchDocument(row as Bug) : ideaSearchDocument(row as Idea));
      const results = await getTypesenseClient().collections(WORK_ITEMS_COLLECTION).documents().import(docs as never, { action: "upsert" });
      const lines = Array.isArray(results) ? results : String(results).split("\n").filter(Boolean).map((line) => JSON.parse(line));
      for (const [lineIndex, line] of (lines as Array<{ success?: boolean; error?: string }>).entries()) {
        totals.processed += 1;
        if (line.success) totals.indexed += 1; else totals.failed += 1;
        if (!line.success) console.error(`[search-index] import failed for ${kind}:${rows[lineIndex]?.id ?? "unknown"}`, line.error ?? "Typesense rejected the document.");
      }
      totals.skipped += Math.max(0, rows.length - lines.length);
      await afterBatch?.();
      if (rows.length < batchSize) break;
    }
  }
  return totals;
}

export async function searchWorkItems(input: { query: string; kind: "bug" | "idea"; organisationId: string; projectId?: string; track?: string; includeDeleted?: boolean; page?: number; perPage?: number; sortBy?: string; queryBy?: string; extraFilters?: string[] }) {
  // A configured endpoint is not enough: until durable capture is enabled,
  // the collection may be stale or empty and PostgreSQL must remain the path.
  typesenseConfig();
  const [control] = await prisma.$queryRaw<Array<{ indexingEnabled: boolean }>>`SELECT "indexingEnabled" FROM "SearchIndexControl" WHERE "id"=1`;
  if (!control?.indexingEnabled) throw new Error("Typesense indexing is disabled; use PostgreSQL search.");
  await ensureWorkItemsCollection();
  const filters = [`kind:=${input.kind}`, `organisationId:=${input.organisationId}`];
  if (input.projectId) filters.push(`projectId:=${input.projectId}`);
  if (input.track) filters.push(`track:=${input.track}`);
  if (!input.includeDeleted) filters.push("isDeleted:=false");
  filters.push(...(input.extraFilters ?? []));
  const response = await getTypesenseClient().collections(WORK_ITEMS_COLLECTION).documents().search({
    q: input.query, query_by: input.queryBy ?? "title(infix:always),description(infix:always),numberText", query_by_weights: input.queryBy ? (input.queryBy.includes(",") ? "10,3" : "10") : "10,3,1",
    filter_by: filters.join(" && "), page: input.page ?? 1,
    per_page: Math.min(input.perPage ?? 25, 250), prefix: false,
    ...(input.sortBy ? { sort_by: input.sortBy } : {}),
  });
  return {
    found: response.found ?? 0,
    hits: (response.hits ?? []).flatMap((hit) => {
      const doc = hit.document as unknown as WorkItemDocument;
      return doc?.sourceId ? [{ id: doc.sourceId, kind: doc.kind, score: hit.text_match ?? 0 }] : [];
    }),
  };
}
