import {
  ARTIFACT_ACTIVITY_LIST_DEFAULT_LIMIT,
  ARTIFACT_ACTIVITY_LIST_MAX_LIMIT,
  type ArtifactActivityEvent,
  type ListActivityEventsInput,
  type ListActivityEventsResult,
  listActivityEventsInputSchema,
  type RecordActivityEventInput,
  type RecordActivityEventsInput,
  recordActivityEventInputSchema,
  recordActivityEventsInputSchema,
} from "@repo/api/src/types/artifact-activity";
import type { JsonValue } from "@repo/api/src/types/common";
import {
  Prisma,
  type ArtifactActivityEvent as PrismaArtifactActivityEvent,
  withDb,
} from "@repo/database";

/**
 * Artifact activity event store service (FEA-3859 / FEA-3535 Slice 1).
 *
 * The write + read half of the append-only artifact activity log
 * (`artifact_activity_events`). `recordActivityEvent` persists one row per
 * captured mutation; `listActivityEvents` returns an org-scoped, per-artifact,
 * newest-first, keyset-paginated page.
 *
 * SHIPS DARK: this slice adds the store only. `recordActivityEvent` is NOT yet
 * called from the `PUT /documents/[id]` write path — that capture seam is
 * Slice 2. There is no read endpoint (Slice 3) or UI (Slice 4+); the list
 * service exists so those slices have a tested read primitive to build on.
 *
 * Org-scoping is mandatory on every query for multi-tenant isolation: reads
 * filter on `organizationId` (never `artifactId` alone), and writes both stamp
 * it and verify the target artifact belongs to that org before inserting (the
 * `artifact_id` FK alone does not prove tenant ownership).
 */

/**
 * Prisma requires a distinct sentinel to persist a JSON `null` (`Prisma.JsonNull`)
 * versus leaving the column SQL `NULL` (`Prisma.DbNull`). We model an
 * omitted/absent snapshot as SQL `NULL` and an explicit JSON null value as JSON
 * `null`, so the round-trip is lossless.
 */
function toJsonInput(
  value: JsonValue | null | undefined
): Prisma.InputJsonValue | typeof Prisma.JsonNull | typeof Prisma.DbNull {
  if (value === undefined) {
    return Prisma.DbNull;
  }
  if (value === null) {
    return Prisma.JsonNull;
  }
  return value as Prisma.InputJsonValue;
}

/**
 * Normalize a JSON column read back from Prisma into a `JsonValue | null`.
 * Depending on client configuration Prisma may surface a JSON `null` value as
 * the `Prisma.JsonNull` sentinel rather than plain `null`; unwrap it so the
 * round-trip is lossless (mirrors the `toJsonInput` write mapping). SQL `NULL`
 * arrives as plain `null` and passes through unchanged.
 */
export function fromJsonColumn(value: unknown): JsonValue | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (value === Prisma.JsonNull) {
    return null;
  }
  return value as JsonValue;
}

/**
 * Map a persisted Prisma row to the shared `ArtifactActivityEvent` DTO. The
 * freeform `actorType` / `action` string columns are cast to their const-object
 * enum types — the write path only ever persists valid members (validated by
 * `recordActivityEventInputSchema`), so no row carries an out-of-vocabulary
 * value.
 */
function toActivityEvent(
  row: PrismaArtifactActivityEvent
): ArtifactActivityEvent {
  return {
    id: row.id,
    organizationId: row.organizationId,
    artifactId: row.artifactId,
    actorType: row.actorType as ArtifactActivityEvent["actorType"],
    actorId: row.actorId,
    action: row.action as ArtifactActivityEvent["action"],
    before: fromJsonColumn(row.before),
    after: fromJsonColumn(row.after),
    createdAt: row.createdAt,
  };
}

/**
 * Persist a single activity event. Input is validated (Zod) before the write:
 * `actorType` / `action` must be known const-object members, ids must be
 * non-empty. The target artifact is then verified to belong to
 * `organizationId` (throws if not) before the row is inserted, so a mismatched
 * caller cannot stamp an event under the wrong tenant. Returns the persisted
 * event as the shared DTO.
 *
 * Not yet wired to any mutation path (Slice 2). Callers are expected to record
 * one event per changed field (a status change and an assignee change on the
 * same PUT are two rows), so the feed can render each independently.
 */
async function recordActivityEvent(
  input: RecordActivityEventInput
): Promise<ArtifactActivityEvent> {
  const parsed = recordActivityEventInputSchema.parse(input);

  const row = await withDb.tx(async (tx) => {
    // Tenant guard: the FK on `artifact_id` alone does not prove the artifact
    // belongs to `organizationId`, so a mismatched caller could otherwise
    // stamp an event under the wrong tenant while pointing at another org's
    // artifact. Verify org ownership in the same transaction before inserting.
    const artifact = await tx.artifact.findFirst({
      where: {
        id: parsed.artifactId,
        organizationId: parsed.organizationId,
      },
      select: { id: true },
    });
    if (artifact === null) {
      throw new Error(
        `artifact ${parsed.artifactId} not found in organization ${parsed.organizationId}`
      );
    }

    return tx.artifactActivityEvent.create({
      data: {
        organizationId: parsed.organizationId,
        artifactId: parsed.artifactId,
        actorType: parsed.actorType,
        actorId: parsed.actorId ?? null,
        action: parsed.action,
        before: toJsonInput(parsed.before),
        after: toJsonInput(parsed.after),
      },
    });
  });

  return toActivityEvent(row);
}

/**
 * Persist many activity events in a single tenant-scoped batch. Used by the
 * batch write paths (e.g. `POST /documents/batch-update-status`) where one
 * request can touch hundreds of artifacts: recording each event through its own
 * `recordActivityEvent` transaction would open one pooled DB connection per
 * artifact and starve the pool (`apps/api/AGENTS.md` bounded-fan-out rule). This
 * collapses the whole batch into two queries inside one transaction — one
 * `findMany` to keep only artifacts that belong to `organizationId`, then one
 * `createMany` insert — so a 500-item batch costs exactly one connection.
 *
 * Tenant isolation is preserved: any event whose `artifactId` does not belong
 * to `organizationId` is dropped (never inserted under the wrong tenant), the
 * same guarantee `recordActivityEvent` enforces per-row. Returns the number of
 * rows actually inserted.
 */
async function recordActivityEvents(
  input: RecordActivityEventsInput
): Promise<number> {
  const parsed = recordActivityEventsInputSchema.parse(input);
  if (parsed.events.length === 0) {
    return 0;
  }

  return await withDb.tx(async (tx) => {
    const artifactIds = [...new Set(parsed.events.map((e) => e.artifactId))];
    // Tenant guard: one query resolves which of the requested artifacts belong
    // to the org. Events pointing at any other artifact are dropped so a caller
    // cannot stamp events under the wrong tenant (mirrors the per-row guard in
    // `recordActivityEvent`).
    const owned = await tx.artifact.findMany({
      where: { id: { in: artifactIds }, organizationId: parsed.organizationId },
      select: { id: true },
    });
    const ownedIds = new Set(owned.map((row) => row.id));
    const rows = parsed.events
      .filter((event) => ownedIds.has(event.artifactId))
      .map((event) => ({
        organizationId: parsed.organizationId,
        artifactId: event.artifactId,
        actorType: event.actorType,
        actorId: event.actorId ?? null,
        action: event.action,
        before: toJsonInput(event.before),
        after: toJsonInput(event.after),
      }));
    if (rows.length === 0) {
      return 0;
    }
    const result = await tx.artifactActivityEvent.createMany({ data: rows });
    return result.count;
  });
}

/**
 * List an artifact's activity events, newest first, org-scoped and
 * keyset-paginated.
 *
 * Pagination is keyset (not offset): pass the previous page's `nextCursor`
 * (the last row's `id`) as `cursor` to fetch the next page. Ordering is
 * `(createdAt desc, id desc)` so a shared `createdAt` breaks deterministically
 * and the `id` cursor is stable. `limit` is clamped to
 * `ARTIFACT_ACTIVITY_LIST_MAX_LIMIT`.
 *
 * `nextCursor` is non-null only when a further page exists: the query fetches
 * one extra row (`take + 1`) as a lookahead, drops it from the returned page,
 * and sets the cursor to the last returned row's id.
 */
async function listActivityEvents(
  input: ListActivityEventsInput
): Promise<ListActivityEventsResult> {
  const parsed = listActivityEventsInputSchema.parse(input);

  const take = Math.min(
    parsed.limit ?? ARTIFACT_ACTIVITY_LIST_DEFAULT_LIMIT,
    ARTIFACT_ACTIVITY_LIST_MAX_LIMIT
  );

  const rows = await withDb((db) =>
    db.artifactActivityEvent.findMany({
      where: {
        organizationId: parsed.organizationId,
        artifactId: parsed.artifactId,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      // Lookahead: fetch one extra row to detect whether a next page exists.
      take: take + 1,
      ...(parsed.cursor ? { cursor: { id: parsed.cursor }, skip: 1 } : {}),
    })
  );

  const hasMore = rows.length > take;
  const pageRows = hasMore ? rows.slice(0, take) : rows;
  const items = pageRows.map(toActivityEvent);
  const nextCursor = hasMore ? (pageRows.at(-1)?.id ?? null) : null;

  return { items, nextCursor };
}

export const artifactActivityService = {
  recordActivityEvent,
  recordActivityEvents,
  listActivityEvents,
};
