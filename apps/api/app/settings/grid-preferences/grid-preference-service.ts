import type { JsonObject } from "@repo/api/src/types/common";
import {
  GRID_PREFERENCE_CONTRACT_VERSION,
  type GridPreference,
  GridPreferenceErrorCode,
  type GridPreferenceResetResponse,
  GridPreferenceResetStatus,
  type GridPreferenceRevisionConflict,
  type GridPreferenceSelector,
  isGridPreferenceGridKey,
  isGridPreferenceKind,
  isGridPreferenceScopeKey,
  isSupportedGridPreferenceSelector,
} from "@repo/api/src/types/grid-preferences";
import { Result, Status } from "@repo/api/src/types/result";
import { Prisma, type TransactionClient, withDb } from "@repo/database";
import { v7 as uuidv7 } from "uuid";
import {
  type RecordWriteInTransaction,
  writeInShape,
} from "@/lib/record-write-in-transaction";
import type { GridPreferenceWrite } from "./grid-preference-receipt";

type GridPreferenceServiceSelector = GridPreferenceSelector & {
  organizationId: string;
  userId: string;
};

type UpsertPreferenceInput = GridPreferenceServiceSelector & {
  value: JsonObject;
  expectedRevision?: number;
};

type ResetPreferenceInput = GridPreferenceServiceSelector & {
  expectedRevision?: number;
};

type GridPreferenceServiceError = {
  status: typeof Status.Conflict;
  conflict: GridPreferenceRevisionConflict;
};

type GridPreferenceRow = {
  gridKey: string;
  preferenceKind: string;
  scopeKey: string;
  value: unknown;
  revision: number;
  createdAt: Date | string;
  updatedAt: Date | string;
};

/**
 * Persists caller-scoped grid preference records. Every write is tenant- and
 * user-scoped and uses PostgreSQL row-level conflict/update locking for CAS.
 */
function listPreferences(input: {
  organizationId: string;
  userId: string;
}): Promise<GridPreference[]> {
  return withDb(async (db) => {
    const rows = await db.$queryRaw<GridPreferenceRow[]>(Prisma.sql`
      SELECT
        "grid_key" AS "gridKey",
        "preference_kind" AS "preferenceKind",
        "scope_key" AS "scopeKey",
        "value",
        "revision",
        "created_at" AS "createdAt",
        "updated_at" AS "updatedAt"
      FROM "grid_preferences"
      WHERE "organization_id" = ${input.organizationId}::uuid
        AND "user_id" = ${input.userId}::uuid
        AND "deleted_at" IS NULL
      ORDER BY "updated_at" DESC, "grid_key" ASC, "preference_kind" ASC, "scope_key" ASC
    `);
    return rows.map(toGridPreference);
  });
}

function getPreference(
  input: GridPreferenceServiceSelector
): Promise<GridPreference | null> {
  return withDb((db) => readPreference(db, input));
}

function upsertPreference(
  input: UpsertPreferenceInput,
  recordWrite?: RecordWriteInTransaction<GridPreferenceWrite>
): Promise<Result<GridPreference, GridPreferenceServiceError>> {
  return writeInShape(recordWrite, {
    unrecorded: () => withDb((db) => writeUpsertPreference(db, input)),
    recorded: (record) =>
      withDb.tx(async (tx) => {
        const result = await writeUpsertPreference(tx, input);
        if (result.ok) {
          await record(tx, { changed: true });
        }
        return result;
      }),
  });
}

function resetPreference(
  input: ResetPreferenceInput,
  recordWrite?: RecordWriteInTransaction<GridPreferenceWrite>
): Promise<Result<GridPreferenceResetResponse, GridPreferenceServiceError>> {
  return writeInShape(recordWrite, {
    unrecorded: () => withDb((db) => writeResetPreference(db, input)),
    recorded: (record) =>
      withDb.tx(async (tx) => {
        const result = await writeResetPreference(tx, input);
        if (result.ok) {
          // Resetting a preference that is not stored is a no-op.
          await record(tx, {
            changed: result.value.status === GridPreferenceResetStatus.Deleted,
          });
        }
        return result;
      }),
  });
}

export const gridPreferenceService = {
  listPreferences,
  getPreference,
  upsertPreference,
  resetPreference,
};

async function readPreference(
  db: Pick<TransactionClient, "$queryRaw">,
  input: GridPreferenceServiceSelector
): Promise<GridPreference | null> {
  const rows = await db.$queryRaw<GridPreferenceRow[]>(Prisma.sql`
    SELECT
      "grid_key" AS "gridKey",
      "preference_kind" AS "preferenceKind",
      "scope_key" AS "scopeKey",
      "value",
      "revision",
      "created_at" AS "createdAt",
      "updated_at" AS "updatedAt"
    FROM "grid_preferences"
    WHERE "organization_id" = ${input.organizationId}::uuid
      AND "user_id" = ${input.userId}::uuid
      AND "grid_key" = ${input.gridKey}
      AND "preference_kind" = ${input.preferenceKind}
      AND "scope_key" = ${input.scopeKey}
      AND "deleted_at" IS NULL
    LIMIT 1
  `);
  return rows[0] ? toGridPreference(rows[0]) : null;
}

async function buildRevisionConflict(
  tx: Pick<TransactionClient, "$queryRaw">,
  input: GridPreferenceServiceSelector & { expectedRevision?: number }
): Promise<GridPreferenceRevisionConflict> {
  if (input.expectedRevision === undefined) {
    throw new Error("grid preference CAS returned no row without a revision");
  }
  const current = await readPreference(tx, input);
  return {
    code: GridPreferenceErrorCode.StaleRevision,
    selector: toSelector(input),
    expectedRevision: input.expectedRevision,
    ...(current ? { currentRevision: current.revision, current } : {}),
    contractVersion: GRID_PREFERENCE_CONTRACT_VERSION,
  };
}

function toGridPreference(row: GridPreferenceRow): GridPreference {
  const selector = toValidatedSelector(row);
  return {
    ...selector,
    value: row.value as JsonObject,
    revision: row.revision,
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
    contractVersion: GRID_PREFERENCE_CONTRACT_VERSION,
  };
}

function toValidatedSelector(row: GridPreferenceRow): GridPreferenceSelector {
  if (!isGridPreferenceGridKey(row.gridKey)) {
    throw new Error(
      `Invalid persisted grid preference gridKey: ${row.gridKey}`
    );
  }
  if (!isGridPreferenceKind(row.preferenceKind)) {
    throw new Error(
      `Invalid persisted grid preference preferenceKind: ${row.preferenceKind}`
    );
  }
  if (!isGridPreferenceScopeKey(row.scopeKey)) {
    throw new Error(
      `Invalid persisted grid preference scopeKey: ${row.scopeKey}`
    );
  }

  const selector = {
    gridKey: row.gridKey,
    preferenceKind: row.preferenceKind,
    scopeKey: row.scopeKey,
  };
  if (!isSupportedGridPreferenceSelector(selector)) {
    throw new Error(
      `Unsupported persisted grid preference selector: ${JSON.stringify(selector)}`
    );
  }
  return selector;
}

function toSelector(
  input: GridPreferenceServiceSelector
): GridPreferenceSelector {
  return {
    gridKey: input.gridKey,
    preferenceKind: input.preferenceKind,
    scopeKey: input.scopeKey,
  };
}

function toIsoString(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

/**
 * The preference upsert as it shipped before receipts (ISS-12552): one
 * compare-and-swap statement, then a read of the current row on a conflict.
 */
async function writeUpsertPreference(
  db: Pick<TransactionClient, "$queryRaw">,
  input: UpsertPreferenceInput
): Promise<Result<GridPreference, GridPreferenceServiceError>> {
  const rows = await db.$queryRaw<GridPreferenceRow[]>(Prisma.sql`
    WITH incoming AS (
      SELECT
        ${uuidv7()}::uuid AS "id",
        ${input.organizationId}::uuid AS "organization_id",
        ${input.userId}::uuid AS "user_id",
        ${input.gridKey} AS "grid_key",
        ${input.preferenceKind} AS "preference_kind",
        ${input.scopeKey} AS "scope_key",
        ${JSON.stringify(input.value)}::jsonb AS "value"
    ),
    candidate AS (
      SELECT *
      FROM incoming
      WHERE ${input.expectedRevision ?? null}::integer IS NULL
        OR EXISTS (
          SELECT 1
          FROM "grid_preferences"
          WHERE "organization_id" = incoming."organization_id"
            AND "user_id" = incoming."user_id"
            AND "grid_key" = incoming."grid_key"
            AND "preference_kind" = incoming."preference_kind"
            AND "scope_key" = incoming."scope_key"
            AND "deleted_at" IS NULL
            AND "revision" = ${input.expectedRevision ?? null}::integer
        )
    )
    INSERT INTO "grid_preferences" (
      "id",
      "organization_id",
      "user_id",
      "grid_key",
      "preference_kind",
      "scope_key",
      "value",
      "revision",
      "created_at",
      "updated_at"
    )
    SELECT
      "id",
      "organization_id",
      "user_id",
      "grid_key",
      "preference_kind",
      "scope_key",
      "value",
      1,
      now(),
      now()
    FROM candidate
    ON CONFLICT (
      "organization_id",
      "user_id",
      "grid_key",
      "preference_kind",
      "scope_key"
    )
    DO UPDATE SET
      "value" = EXCLUDED."value",
      "revision" = "grid_preferences"."revision" + 1,
      "deleted_at" = NULL,
      "updated_at" = now()
    WHERE ${input.expectedRevision ?? null}::integer IS NULL
      OR (
        "grid_preferences"."deleted_at" IS NULL
        AND "grid_preferences"."revision" = ${input.expectedRevision ?? null}::integer
      )
    RETURNING
      "grid_key" AS "gridKey",
      "preference_kind" AS "preferenceKind",
      "scope_key" AS "scopeKey",
      "value",
      "revision",
      "created_at" AS "createdAt",
      "updated_at" AS "updatedAt"
  `);
  const row = rows[0];
  if (row) {
    return Result.ok(toGridPreference(row));
  }
  return Result.err({
    status: Status.Conflict,
    conflict: await buildRevisionConflict(db, input),
  });
}

/**
 * The preference reset as it shipped before receipts (ISS-12552): one
 * soft-delete statement, then a read of the current row on a conflict.
 */
async function writeResetPreference(
  db: Pick<TransactionClient, "$queryRaw">,
  input: ResetPreferenceInput
): Promise<Result<GridPreferenceResetResponse, GridPreferenceServiceError>> {
  const rows = await db.$queryRaw<Array<{ previousRevision: number }>>(
    Prisma.sql`
    UPDATE "grid_preferences"
    SET
      "deleted_at" = now(),
      "revision" = "revision" + 1,
      "updated_at" = now()
    WHERE "organization_id" = ${input.organizationId}::uuid
      AND "user_id" = ${input.userId}::uuid
      AND "grid_key" = ${input.gridKey}
      AND "preference_kind" = ${input.preferenceKind}
      AND "scope_key" = ${input.scopeKey}
      AND "deleted_at" IS NULL
      AND (
        ${input.expectedRevision ?? null}::integer IS NULL
        OR "revision" = ${input.expectedRevision ?? null}::integer
      )
    RETURNING "revision" - 1 AS "previousRevision"
  `
  );
  const deleted = rows[0];
  if (deleted) {
    return Result.ok({
      status: GridPreferenceResetStatus.Deleted,
      selector: toSelector(input),
      previousRevision: deleted.previousRevision,
      contractVersion: GRID_PREFERENCE_CONTRACT_VERSION,
    });
  }
  if (input.expectedRevision !== undefined) {
    return Result.err({
      status: Status.Conflict,
      conflict: await buildRevisionConflict(db, input),
    });
  }
  return Result.ok({
    status: GridPreferenceResetStatus.Missing,
    selector: toSelector(input),
    contractVersion: GRID_PREFERENCE_CONTRACT_VERSION,
  });
}
