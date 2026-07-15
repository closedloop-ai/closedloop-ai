/**
 * FEA-3065 — application-side serialization gate for `prisma migrate deploy`.
 *
 * Prisma Migrate serializes every deploy on a single hardcoded, per-database
 * advisory lock (`pg_advisory_lock(72707369)`) with a fixed, non-configurable
 * 10 s acquire timeout. When several `apps/api` deploys migrate the same
 * physical database at once (an api-stage `public` deploy plus a burst of
 * `preview_*` deploys on the shared stage instance), the losers fail with
 * P1002. FEA-3062 added a retry that tolerates the collision; this gate
 * prevents it: every migrate first waits in Postgres's advisory-lock queue
 * on OUR own key, so only one process runs `prisma migrate deploy` at a time
 * and Prisma's `72707369` lock is uncontended in the common case.
 *
 * The acquire is a **bounded blocking** `pg_advisory_lock` under
 * `statement_timeout` (an orderly wait queue, not a re-poll lottery), on a
 * dedicated connection. It **fails open on ANY gate error** — a budget-timeout
 * cancel, a transient connect/query failure, anything — by running the wrapped
 * function without the gate, so the gate can never turn a would-succeed migrate
 * into a failed deploy (the FEA-3062 retry remains the backstop). No I/O or
 * env reads at module load; the pg client is injected so this is unit-testable
 * without a database. Sibling-lib pattern, see `migrate-retry.ts`.
 */

import { createSslClient } from "./db-utils";

/**
 * Our advisory-lock key. A single database-scoped constant, mirroring Prisma's
 * own fixed `72707369` so it serializes exactly the same set of migrates
 * (a per-schema key would under-serialize and P1002 would return). `30650000`
 * encodes provenance (FEA-3065), is a JS safe integer / valid `int8`, and is
 * greppable in logs. MUST differ from Prisma's key (guard-tested).
 *
 * RESERVED PROJECT-WIDE: `30650000` is the single-int `pg_advisory_lock` key
 * for migration serialization and must not be reused by any other advisory
 * lock. `pg_advisory_lock` and `pg_advisory_xact_lock` share ONE keyspace, so
 * a collision (even with an xact-lock elsewhere) would spuriously serialize
 * unrelated work. Today the only other advisory locks are Prisma's `72707369`
 * and `pg_advisory_xact_lock(hashtext(...))` hashes, so this bare int is free —
 * keep it that way.
 */
export const MIGRATION_SERIALIZE_LOCK_KEY = 30_650_000;

/** Prisma's hardcoded migration advisory-lock key — the gate key must not equal it. */
export const PRISMA_MIGRATE_ADVISORY_LOCK_KEY = 72_707_369;

/**
 * `statement_timeout` bounding the blocking acquire. 300 s covers ~10 sequential
 * ~30 s fresh-preview migrate holds and satisfies the stacked cap
 * (`300 + ~60 migrate + ~180 retry = 540 s`) under the ~15 min RDS IAM-token
 * window. One-line tunable; fail-open makes an imperfect value safe. (FEA-3065)
 */
export const MIGRATION_SERIALIZE_LOCK_BUDGET_MS = 300_000;

/** SQLSTATE emitted when `statement_timeout` cancels the blocking acquire. */
export const STATEMENT_TIMEOUT_SQLSTATE = "57014";

/** Minimal `pg.Client` surface the gate needs — kept narrow so tests can mock it. */
export type MigrationLockClient = {
  connect(): Promise<void>;
  query(text: string, values?: unknown[]): Promise<unknown>;
  end(): Promise<void>;
};

type MigrationLockLogger = { log: (message: string) => void };

export type MigrationSerializeLockDeps = {
  databaseUrl: string;
  /** Client factory — defaults to the real `createSslClient`; injected in tests. */
  createClient?: (databaseUrl: string) => MigrationLockClient;
  logger?: MigrationLockLogger;
  budgetMs?: number;
  lockKey?: number;
};

function describeGateError(error: unknown): string {
  if (error instanceof Error) {
    const rawCode = (error as Error & { code?: unknown }).code;
    const codeFragment = typeof rawCode === "string" ? ` [${rawCode}]` : "";
    return `${error.message}${codeFragment}`;
  }
  return String(error);
}

/**
 * Adapts the real `pg.Client` (from `createSslClient`) to the narrow
 * `MigrationLockClient` surface — explicit delegation avoids relying on the
 * heavily-overloaded `pg.Client.query` structurally matching our interface.
 */
function defaultCreateClient(databaseUrl: string): MigrationLockClient {
  const client = createSslClient(databaseUrl);
  return {
    connect: async () => {
      await client.connect();
    },
    query: (text, values) => client.query(text, values),
    end: async () => {
      await client.end();
    },
  };
}

async function endQuietly(client: MigrationLockClient | null): Promise<void> {
  if (!client) {
    return;
  }
  try {
    await client.end();
  } catch {
    // Closing the connection is best-effort; the session (and its advisory
    // lock) is released by the server when the socket drops regardless.
  }
}

/**
 * Run `fn` while holding the migration serialization advisory lock. Acquires a
 * bounded blocking `pg_advisory_lock` on a dedicated connection; on success
 * runs `fn` then releases (unlock + close). On **any** acquisition failure it
 * logs and runs `fn` *without* the gate (fail-open). `fn`'s own errors always
 * propagate after the lock is released.
 */
export async function withMigrationSerializeLock<T>(
  deps: MigrationSerializeLockDeps,
  fn: () => Promise<T>
): Promise<T> {
  const logger = deps.logger ?? console;
  const budgetMs = deps.budgetMs ?? MIGRATION_SERIALIZE_LOCK_BUDGET_MS;
  const lockKey = deps.lockKey ?? MIGRATION_SERIALIZE_LOCK_KEY;
  const createClient = deps.createClient ?? defaultCreateClient;

  let client: MigrationLockClient | null = null;
  let acquired = false;
  try {
    client = createClient(deps.databaseUrl);
    await client.connect();
    // `set_config` (not `SET`) so the budget is a bound parameter, not string
    // interpolation. `is_local=false` → session scope.
    await client.query("SELECT set_config('statement_timeout', $1, false)", [
      String(budgetMs),
    ]);
    logger.log("[migration-lock] waiting for serialize lock");
    await client.query("SELECT pg_advisory_lock($1::bigint)", [lockKey]);
    acquired = true;
    logger.log("[migration-lock] acquired serialize lock");
  } catch (error) {
    // Fail-open on ANY gate error (connect / set_config / acquire, incl. the
    // 57014 statement-timeout cancel). Run unguarded — the FEA-3062 retry
    // inside `fn` is the backstop, so worst case is exactly today's behavior.
    logger.log(
      `[migration-lock] proceeding WITHOUT serialize lock: ${describeGateError(error)}`
    );
    await endQuietly(client);
    return await fn();
  }

  // Lock held: run the migrate, then always release.
  try {
    return await fn();
  } finally {
    if (acquired && client) {
      try {
        await client.query("SELECT pg_advisory_unlock($1::bigint)", [lockKey]);
      } catch {
        // Best-effort; closing the connection below releases the session lock.
      }
    }
    await endQuietly(client);
  }
}
