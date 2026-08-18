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

import { createSqlClient, endQuietly, type SqlClient } from "./db-utils";

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

/**
 * The gate uses the shared narrow `SqlClient` surface (db-utils). Alias kept for
 * callers/tests that import `MigrationLockClient` by name.
 */
export type MigrationLockClient = SqlClient;

type MigrationLockLogger = { log: (message: string) => void };

/**
 * What the gate does when it cannot acquire the serialize lock (budget-timeout
 * cancel, connect/query failure, anything):
 *  - `"run"` (default): **fail open** — run `fn` WITHOUT the gate. A user deploy
 *    must never be blocked by the gate; the FEA-3062 retry is the backstop.
 *  - `"skip"`: **fail closed** — throw `SerializeLockContendedError` instead of
 *    running `fn` unguarded. Used by the FEA-3071 Slice 2 preview migrator walk:
 *    a best-effort catch-up is non-urgent, and running unguarded would make the
 *    walk itself a source of Prisma-lock (72707369) contention. A skipped schema
 *    is simply left to self-heal on its own next deploy.
 */
export type SerializeLockContendedMode = "run" | "skip";

/**
 * Observed result of the gate acquire, for telemetry (ISS-4392). A plain string
 * union — NOT the telemetry event type — so this module stays decoupled from
 * `migrate-telemetry.ts`; the caller maps it.
 *  - `acquired`: the gate held the lock and ran `fn` guarded.
 *  - `fail_open`: acquire failed and `fn` ran UNGUARDED (`onContended: "run"`).
 *  - `fail_closed`: acquire failed and the work was skipped (`onContended: "skip"`).
 */
export type SerializeLockOutcome = "acquired" | "fail_open" | "fail_closed";

/**
 * Thrown by `withMigrationSerializeLock` when `onContended: "skip"` and the lock
 * could not be acquired. Callers that opt into fail-closed catch this to skip the
 * unit of work rather than run it unguarded.
 */
export class SerializeLockContendedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SerializeLockContendedError";
  }
}

export type MigrationSerializeLockDeps = {
  databaseUrl: string;
  /** Client factory — defaults to the shared `createSqlClient`; injected in tests. */
  createClient?: (databaseUrl: string) => MigrationLockClient;
  logger?: MigrationLockLogger;
  budgetMs?: number;
  lockKey?: number;
  /** Acquire-failure behavior — fail open (`"run"`, default) or fail closed (`"skip"`). */
  onContended?: SerializeLockContendedMode;
  /**
   * Telemetry (ISS-4392): reports the gate outcome and how long the acquire
   * waited. Best-effort and fully isolated — `notifyGateOutcome` swallows any
   * throw from this callback, so it can never change gate behavior.
   */
  onOutcome?: (outcome: SerializeLockOutcome, waitMs: number) => void;
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
  const createClient = deps.createClient ?? createSqlClient;
  const onContended = deps.onContended ?? "run";

  const acquireStartedAt = Date.now();
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
    notifyGateOutcome(
      deps.onOutcome,
      "acquired",
      Date.now() - acquireStartedAt
    );
  } catch (error) {
    await endQuietly(client);
    // Fail CLOSED when the caller opted in (`onContended: "skip"`): the work is
    // non-urgent and running unguarded would reintroduce Prisma-lock contention.
    if (onContended === "skip") {
      notifyGateOutcome(
        deps.onOutcome,
        "fail_closed",
        Date.now() - acquireStartedAt
      );
      logger.log(
        `[migration-lock] serialize lock contended — skipping (fail-closed): ${describeGateError(error)}`
      );
      throw new SerializeLockContendedError(describeGateError(error), {
        cause: error,
      });
    }
    // Fail-open (default) on ANY gate error (connect / set_config / acquire, incl.
    // the 57014 statement-timeout cancel). Run unguarded — the FEA-3062 retry
    // inside `fn` is the backstop, so worst case is exactly today's behavior.
    notifyGateOutcome(
      deps.onOutcome,
      "fail_open",
      Date.now() - acquireStartedAt
    );
    logger.log(
      `[migration-lock] proceeding WITHOUT serialize lock: ${describeGateError(error)}`
    );
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

/**
 * Invoke the ISS-4392 telemetry callback WITHOUT ever letting it affect the gate.
 * A throwing `onOutcome` called inside the acquire `try` would otherwise be caught
 * as a lock failure and flip the gate to fail-open/closed — so it is isolated here.
 */
function notifyGateOutcome(
  onOutcome: MigrationSerializeLockDeps["onOutcome"],
  outcome: SerializeLockOutcome,
  waitMs: number
): void {
  if (!onOutcome) {
    return;
  }
  try {
    onOutcome(outcome, waitMs);
  } catch {
    // Telemetry is best-effort; a throwing callback must never change gate behavior.
  }
}
