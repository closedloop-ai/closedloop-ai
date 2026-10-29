/**
 * Safe execution of one `DROP SCHEMA`, and the classification of a drop that
 * Postgres declined rather than failed.
 *
 * A private internal of `app/preview-schemas/service.ts`, which stays the only
 * module routes consume. Split out per the nested-service pattern in
 * `apps/api/AGENTS.md` so the composition root does not carry every concern.
 * Shared by both callers that drop a schema: the branch drop and the sweep.
 */

import { getPrismaRawQuerySqlState } from "@/lib/db-utils";
import { withMigratorClient } from "./migrator-connection";

/**
 * SQLSTATEs Postgres raises when it declines to wait for a lock or cancels a
 * statement that outran its timeout.
 */
const DropContentionSqlState = {
  LockNotAvailable: "55P03",
  QueryCanceled: "57014",
} as const;

/**
 * How long a DROP may wait for its ACCESS EXCLUSIVE lock before Postgres gives
 * up. Comfortably shorter than the sweep's headroom under `maxDuration`, so a
 * schema pinned by a live build costs a bounded pause instead of the function.
 */
const DROP_LOCK_TIMEOUT_MS = 5000;
/** Ceiling on the DROP itself once it holds the lock. */
const DROP_STATEMENT_TIMEOUT_MS = 30_000;

/**
 * Executes `DROP SCHEMA IF EXISTS <name> CASCADE` for a single schema name.
 *
 * The schema name must start with `preview_` — this guard is enforced before
 * calling this helper by `dropSchemaForBranch` and the sweep loop.
 *
 * The identifier is interpolated because it cannot be a bind parameter
 * (identifiers are not values); the `preview_` prefix guard and the quote
 * doubling are the safety boundary.
 *
 * Runs on a MIGRATOR connection, never the runtime pool (ISS-5978): the drop
 * needs schema ownership, which the demoted runtime role no longer has.
 */
export async function executeDrop(schemaName: string): Promise<void> {
  // Double-check: never drop a non-preview schema
  if (!schemaName.startsWith("preview_")) {
    throw new Error(
      `Safety guard: refusing to drop non-preview schema "${schemaName}"`
    );
  }
  // One transaction on one connection so `SET LOCAL` applies to the DROP.
  // `DROP SCHEMA … CASCADE` takes an ACCESS EXCLUSIVE lock and would otherwise
  // wait indefinitely behind a live preview build's connection, carrying the
  // function past `maxDuration` regardless of the sweep's own budget (PR #4499
  // review). A failed statement needs no ROLLBACK: closing the connection
  // aborts the open transaction.
  await withMigratorClient(async (client) => {
    await client.query("BEGIN");
    await client.query(`SET LOCAL lock_timeout = '${DROP_LOCK_TIMEOUT_MS}ms'`);
    await client.query(
      `SET LOCAL statement_timeout = '${DROP_STATEMENT_TIMEOUT_MS}ms'`
    );
    await client.query(
      `DROP SCHEMA IF EXISTS "${schemaName.replace(/"/g, '""')}" CASCADE`
    );
    await client.query("COMMIT");
  });
}

/**
 * Whether a drop failure is Postgres declining to wait, rather than a real
 * error: SQLSTATE 55P03 (`lock_not_available`, our `lock_timeout`) or 57014
 * (`query_canceled`, our `statement_timeout`).
 *
 * Both mean the schema was busy — almost certainly an in-flight preview build
 * holding a connection to it — which is precisely a schema we must not drop.
 * Skipping is the correct outcome, so these are counted as kept rather than
 * errored: routing them to `errored` would page on the sweep behaving exactly
 * as intended.
 *
 * The SQLSTATE is read via `getPrismaRawQuerySqlState`, which accepts a bare
 * SQLSTATE on `code` — what the migrator connection's `pg` driver raises — as
 * well as the Prisma raw-query envelopes (`P2010` on `code`, the SQLSTATE under
 * `meta`, where exactly is version-dependent). Going through the extractor
 * rather than naming a field keeps this branch live whichever client surfaces
 * the failure.
 */
export function isDropContentionError(err: unknown): boolean {
  const sqlState = getPrismaRawQuerySqlState(err);
  return (
    sqlState === DropContentionSqlState.LockNotAvailable ||
    sqlState === DropContentionSqlState.QueryCanceled
  );
}
