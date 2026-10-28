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
  type TransactionClient,
  withDb,
} from "@repo/database";
import { chunksOf } from "@/lib/chunks-of";
import { POSTGRES_MAX_ACCEPTED_BIND_PARAMETERS } from "@/lib/postgres-bind-parameters";

/**
 * Artifact activity event store service (FEA-3859 / FEA-3535 Slice 1).
 *
 * The write + read half of the append-only artifact activity log
 * (`artifact_activity_events`). `recordActivityEvent` persists one row per
 * captured mutation; `listActivityEvents` returns an org-scoped, per-artifact,
 * newest-first, keyset-paginated page.
 *
 * The record calls come from `apps/api/lib/artifact-activity-capture.ts` on the
 * document write paths (FEA-3864). `listActivityEvents` has no production
 * caller: `GET /documents/[id]/activity` reads `artifact_activity_events`
 * itself, in `artifact-activity-feed-service.ts` (`projectEvents`), with its
 * own projection and keyset fragment — so this is a second reader of the same
 * table, kept today only by its own tests.
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
function toActivityEvent(row: ActivityEventRow): ArtifactActivityEvent {
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
 * Called from artifact mutation paths through the shared capture helpers.
 * Callers record one event per changed field (a status change and an
 * assignee change on the same PUT are two rows), so the feed can render each
 * independently.
 *
 * `client` is the MUTATION's transaction (ISS-10993). Supplied, the row is
 * written on it, so the receipt and the change it describes commit or roll back
 * together; a row that cannot be written fails the mutation rather than leaving
 * a hole in a published feed. Omitted — the DB-backed tests of this store, which
 * have no mutation to join — it opens its own.
 */
async function recordActivityEvent(
  input: RecordActivityEventInput,
  client?: TransactionClient
): Promise<ArtifactActivityEvent> {
  const parsed = recordActivityEventInputSchema.parse(input);

  const row = client
    ? await insertActivityEvent(client, parsed)
    : await withDb.tx((tx) => insertActivityEvent(tx, parsed));

  return toActivityEvent(row);
}

/**
 * Tenant guard plus insert, on whichever client the caller owns. The FK on
 * `artifact_id` alone does not prove the artifact belongs to `organizationId`,
 * so a mismatched caller could otherwise stamp an event under the wrong tenant
 * while pointing at another org's artifact — the check therefore has to share a
 * transaction with the insert it protects.
 */
async function insertActivityEvent(
  tx: TransactionClient,
  parsed: RecordActivityEventInput
): Promise<PrismaArtifactActivityEvent> {
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

  return await tx.artifactActivityEvent.create({
    data: {
      organizationId: parsed.organizationId,
      artifactId: parsed.artifactId,
      actorType: parsed.actorType,
      actorId: parsed.actorId ?? null,
      action: parsed.action,
      before: toJsonInput(parsed.before),
      after: toJsonInput(parsed.after),
      transactionId: parsed.transactionId ?? null,
      undoOfTransactionId: parsed.undoOfTransactionId ?? null,
    },
  });
}

/**
 * Persist many activity events in a single tenant-scoped batch. Used by the
 * batch write paths (e.g. `POST /documents/batch-update-status`) where one
 * request can touch hundreds of artifacts: recording each event through its own
 * `recordActivityEvent` transaction would open one pooled DB connection per
 * artifact and starve the pool (`apps/api/AGENTS.md` bounded-fan-out rule). This
 * collapses the whole batch into one transaction — per slice of
 * `ACTIVITY_EVENT_WRITE_CHUNK_SIZE` events, one `findMany` to keep only
 * artifacts that belong to `organizationId`, then one `createMany` insert — so
 * a 500-item batch costs exactly one connection and two statements.
 *
 * Sliced because the statement is REFUSED, not slowed, past the bind ceiling
 * (ISS-9158, whitlockk review): `POST /artifact-links/batch-move` with
 * `includeDownstream` is uncapped and has walked 9,875-node graphs, whose
 * events issued as one `createMany` would bind ~89,000 parameters against a
 * budget of 32,766. Every slice runs inside the same transaction, so the write
 * stays all-or-nothing.
 *
 * Tenant isolation is preserved: any event whose `artifactId` does not belong
 * to `organizationId` is dropped (never inserted under the wrong tenant), the
 * same guarantee `recordActivityEvent` enforces per-row. Returns the number of
 * rows actually inserted.
 *
 * `client` is the MUTATION's transaction (ISS-10993); see
 * {@link recordActivityEvent}. Every slice runs on it, so the whole batch and
 * the mutation it describes share one commit.
 */
async function recordActivityEvents(
  input: RecordActivityEventsInput,
  client?: TransactionClient
): Promise<number> {
  const parsed = recordActivityEventsInputSchema.parse(input);
  if (parsed.events.length === 0) {
    return 0;
  }

  return client
    ? await insertActivityEvents(client, parsed)
    : await withDb.tx((tx) => insertActivityEvents(tx, parsed));
}

/**
 * The sliced batch insert, on whichever client the caller owns. Slicing is
 * inside one transaction so the write stays all-or-nothing across slices.
 */
async function insertActivityEvents(
  tx: TransactionClient,
  parsed: RecordActivityEventsInput
): Promise<number> {
  let inserted = 0;
  for (const events of chunksOf(
    parsed.events,
    ACTIVITY_EVENT_WRITE_CHUNK_SIZE
  )) {
    const artifactIds = [...new Set(events.map((e) => e.artifactId))];
    // Tenant guard: one query resolves which of the requested artifacts
    // belong to the org. Events pointing at any other artifact are dropped so
    // a caller cannot stamp events under the wrong tenant (mirrors the
    // per-row guard in `recordActivityEvent`).
    const owned = await tx.artifact.findMany({
      where: {
        id: { in: artifactIds },
        organizationId: parsed.organizationId,
      },
      select: { id: true },
    });
    const ownedIds = new Set(owned.map((row) => row.id));
    const rows = events
      .filter((event) => ownedIds.has(event.artifactId))
      .map((event) => ({
        organizationId: parsed.organizationId,
        artifactId: event.artifactId,
        actorType: event.actorType,
        actorId: event.actorId ?? null,
        action: event.action,
        before: toJsonInput(event.before),
        after: toJsonInput(event.after),
        transactionId: parsed.transactionId ?? null,
        undoOfTransactionId: parsed.undoOfTransactionId ?? null,
      }));
    if (rows.length === 0) {
      continue;
    }
    const result = await tx.artifactActivityEvent.createMany({ data: rows });
    inserted += result.count;
  }
  return inserted;
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
      select: ACTIVITY_EVENT_SELECT,
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

/**
 * Columns one `ArtifactActivityEvent` row binds in a `createMany`: the nine
 * the store writes plus the `id` and `createdAt` Prisma fills client-side
 * (`uuid(7)` / `now()`). Counted off the model rather than off the object
 * literal above, because a default the CLIENT fills is a bind the literal
 * never shows — the same count `judge-score-fanout.ts` makes.
 *
 * A column added to that literal without this number moving sizes the chunk
 * below on a width the statement no longer has, so a FULL chunk is refused
 * outright — and `recordBatchEvents` swallows the refusal, losing the whole
 * slice with no signal. ISS-10458 review.
 */
export const BIND_PARAMETERS_PER_ACTIVITY_EVENT_ROW = 11;

/**
 * Events per `recordActivityEvents` slice. Sized off the `createMany`, the
 * wider of the slice's two statements: the tenant-guard `findMany` binds one
 * parameter per distinct artifact id plus the org, so it always fits under
 * the same slice. Floors at 1 so a future ceiling change cannot make the loop
 * issue empty statements forever.
 */
export const ACTIVITY_EVENT_WRITE_CHUNK_SIZE = Math.max(
  1,
  Math.floor(
    POSTGRES_MAX_ACCEPTED_BIND_PARAMETERS /
      BIND_PARAMETERS_PER_ACTIVITY_EVENT_ROW
  )
);

/** The columns {@link toActivityEvent} reads off an activity-event row. */
type ActivityEventRow = Pick<
  PrismaArtifactActivityEvent,
  | "id"
  | "organizationId"
  | "artifactId"
  | "actorType"
  | "actorId"
  | "action"
  | "before"
  | "after"
  | "createdAt"
>;

/**
 * A pin, not a reduction: it is what stops a column added later from reaching
 * the list response without anyone choosing to put it there. `transaction_id`
 * (ISS-9465) is the first column it holds back — the rows carry it, and it
 * gains a reader when a surface needs to group a bulk mutation's receipts.
 */
const ACTIVITY_EVENT_SELECT = {
  id: true,
  organizationId: true,
  artifactId: true,
  actorType: true,
  actorId: true,
  action: true,
  before: true,
  after: true,
  createdAt: true,
} as const satisfies Record<keyof ActivityEventRow, true>;
