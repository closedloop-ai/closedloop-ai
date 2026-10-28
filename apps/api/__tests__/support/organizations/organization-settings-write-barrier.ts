import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { requireFixtureDatabaseUrl } from "@/__tests__/utils/fixture-db";

/**
 * Hold a production `organizations` UPDATE at the statement boundary so a
 * competing `settings` write can be committed INSIDE its window, then let it
 * proceed. Introduced by ISS-7092 for `completeWizard`; generalized by ISS-7111
 * for any `Organization.settings` writer. Mirrors the ISS-6421 advisory-lock
 * barrier (`pr-lifecycle-atom-barrier`).
 *
 * The trigger is deliberately `FOR EACH STATEMENT`, not `FOR EACH ROW`. A
 * row-level BEFORE trigger fires from `GetTupleForTrigger`, which has already
 * taken the row lock — the held statement would then block the competing writer
 * on that row lock and the two would simply wait on each other forever. A
 * statement-level trigger fires before any row is examined or locked, so the
 * held statement holds nothing and the competing writer commits freely.
 *
 * The competing connection sets `application_name`, which is how the trigger
 * tells it apart from the production code under test and lets it through.
 *
 * `skipStatements` lets a caller reach a LATER write in a flow that issues
 * several. The counter is a sequence, so it is non-transactional and counts
 * statements ISSUED rather than committed — a rolled-back UPDATE still consumes
 * its turn.
 *
 * BLAST RADIUS — read before reusing this. A statement-level trigger has no
 * `NEW`/`OLD` row, so unlike the ISS-6421 barrier (which predicates on
 * `NEW.branch_artifact_id`) this one CANNOT be scoped to a single row: while it
 * is installed it parks EVERY non-racer `UPDATE` on `organizations`, for every
 * organization. (Transition tables, the other way to see rows from a
 * statement-level trigger, are rejected by PostgreSQL on `BEFORE` triggers, and
 * the timing has to stay `BEFORE` for the reason in the paragraph above.) That
 * is tolerable only because `apps/api`'s `test:integration` script runs
 * `--no-file-parallelism` against a dedicated `postgres:16` service, so no
 * other suite has an `organizations` write in flight. Dropping that flag, or
 * pointing this lane at a shared dev database, would let a foreign waiter
 * satisfy `waitUntilBlocked()` and silently collapse the interleave back to a
 * sequential run — which the unguarded read-modify-write passes. Keep the flag.
 *
 * PARK TIMEOUT (ISS-7167) — the park is bounded in time, and must stay bounded.
 * The trigger sets a transaction-local `lock_timeout` before it waits, so a
 * statement that reaches the barrier and is never released aborts with
 * `lock_not_available` (55P03) instead of waiting forever. Without that bound,
 * a barrier still held when its test ends leaves each parked backend blocked
 * inside an open transaction for the rest of the run: Vitest's 30s test timeout
 * fails the TEST but cancels nothing in PostgreSQL, so the backend keeps its
 * connection, the pool never gets it back, and because the whole tier shares one
 * database under `--no-file-parallelism` the stuck backends accumulate until
 * `max_connections` is gone. From that point every remaining file fails —
 * `Unable to start a transaction`, then `sorry, too many clients already`
 * (53300) — including the ~24 files that never touch this helper. Bounding the
 * wait converts that run-wide outage into a handful of honest local failures.
 */
const RACE_WRITER_APPLICATION_NAME = "settings-barrier-race-writer";
/** Exported so a test can observe the barrier's own advisory lock in `pg_locks`. */
export const ORGANIZATION_SETTINGS_BARRIER_LOCK_CLASS_ID = 7092;
/**
 * Comfortably longer than any legitimate park (the racer commits and releases
 * in well under a second) and comfortably shorter than the integration tier's
 * 30s `testTimeout`, so an abandoned park always surfaces as a real error from
 * the write under test rather than as a test timeout with a live backend behind
 * it.
 */
const DEFAULT_PARK_TIMEOUT_MS = 10_000;

export type OrganizationSettingsWriteBarrierOptions = {
  /**
   * Let this many `organizations` UPDATE statements through before parking the
   * next one. Defaults to 0 — park the first. ISS-7111 needs 1, because
   * `runPostConnectBackfill` claims the run gate before it persists the summary.
   */
  skipStatements?: number;
  /** Named in the timeout error when no statement ever reaches the barrier. */
  subject?: string;
  /**
   * How long a parked statement may wait before PostgreSQL cancels it with
   * `lock_not_available` (55P03). Defaults to {@link DEFAULT_PARK_TIMEOUT_MS};
   * see the PARK TIMEOUT note above for why it may never be unbounded. Values
   * below 1ms are clamped up, because `lock_timeout = 0` means "wait forever" —
   * a `0` here would reopen ISS-7167 through the call site instead of the SQL.
   */
  parkTimeoutMs?: number;
};

export type OrganizationSettingsWriteBarrier = {
  /**
   * Atomically set one top-level `settings` key from the competing connection,
   * bypassing the barrier. Returns once the write is committed and visible.
   */
  commitCompetingSettingsKey(
    organizationId: string,
    key: string,
    value: unknown
  ): Promise<void>;
  /**
   * Atomically stamp `updated_at` from the competing connection, bypassing the
   * barrier. Returns once the write is committed and visible. ISS-7157 uses it
   * to make the parked writer the LOSER of a contended write, so its own
   * earlier captured timestamp has something newer to try to overwrite.
   */
  commitCompetingUpdatedAt(organizationId: string, at: Date): Promise<void>;
  /** Resolve once a production UPDATE is parked at the barrier. */
  waitUntilBlocked(): Promise<void>;
  /** Let the parked UPDATE through. */
  release(): Promise<void>;
  dispose(): Promise<void>;
};

export async function installOrganizationSettingsWriteBarrier(
  options: OrganizationSettingsWriteBarrierOptions = {}
): Promise<OrganizationSettingsWriteBarrier> {
  // The barrier's own two connections are FIXTURE connections, not the
  // production one: installing it creates a sequence, a function and a trigger
  // on `organizations`, which is the migrator's work under the ISS-5978 role
  // split. The production write it parks still arrives on `DATABASE_URL`.
  const databaseUrl = requireFixtureDatabaseUrl("the settings-write barrier");
  const skipStatements = Math.max(0, options.skipStatements ?? 0);
  const requestedParkTimeoutMs =
    options.parkTimeoutMs ?? DEFAULT_PARK_TIMEOUT_MS;
  if (!Number.isFinite(requestedParkTimeoutMs)) {
    // Caught here rather than at trigger-fire time, where it surfaces as an
    // opaque `invalid value for parameter "lock_timeout"` from inside plpgsql.
    throw new Error(
      `parkTimeoutMs must be a finite number, received ${requestedParkTimeoutMs}`
    );
  }
  const parkTimeoutMs = Math.max(1, Math.trunc(requestedParkTimeoutMs));
  const subject = options.subject ?? "the production settings write";
  const suffix = randomUUID().replaceAll("-", "");
  const functionName = `org_settings_barrier_${suffix}`;
  const triggerName = `org_settings_barrier_trigger_${suffix}`;
  const sequenceName = `org_settings_barrier_seq_${suffix}`;
  const lockKeyTwo = Number.parseInt(suffix.slice(0, 7), 16);

  const blocker = new Client({ connectionString: databaseUrl });
  const racer = new Client({ connectionString: databaseUrl });
  try {
    // Inside the `try` because `connect()` is the likeliest thing here to fail
    // under the very pressure this bound exists for: if one side gets 53300 and
    // the other is already connected, the survivor has to be handed back.
    await Promise.all([blocker.connect(), racer.connect()]);
    await racer.query(
      `SET application_name = '${RACE_WRITER_APPLICATION_NAME}'`
    );
    await racer.query(`CREATE SEQUENCE ${sequenceName}`);
    // The two conditions are nested rather than ANDed: PostgreSQL does not
    // guarantee short-circuit evaluation, so a single `AND` would let the
    // racer's own writes consume turns from the skip counter.
    //
    // `set_config(..., is_local => true)` keeps the timeout off the pooled
    // connection: it reverts at the end of the parked statement's TRANSACTION,
    // not at the end of the statement. So park a write that is the last
    // statement of its transaction — otherwise the rest of that transaction
    // silently inherits this timeout.
    await racer.query(`
      CREATE FUNCTION ${functionName}() RETURNS trigger AS $$
      BEGIN
        IF current_setting('application_name') <> '${RACE_WRITER_APPLICATION_NAME}' THEN
          IF nextval('${sequenceName}') > ${skipStatements} THEN
            PERFORM set_config('lock_timeout', '${parkTimeoutMs}', true);
            PERFORM pg_advisory_xact_lock(${ORGANIZATION_SETTINGS_BARRIER_LOCK_CLASS_ID}, ${lockKeyTwo});
          END IF;
        END IF;
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await racer.query(`
      CREATE TRIGGER ${triggerName}
      BEFORE UPDATE ON organizations
      FOR EACH STATEMENT EXECUTE FUNCTION ${functionName}();
    `);
    await blocker.query("SELECT pg_advisory_lock($1, $2)", [
      ORGANIZATION_SETTINGS_BARRIER_LOCK_CLASS_ID,
      lockKeyTwo,
    ]);
  } catch (error) {
    // A half-installed barrier must not keep its two backends: the tier shares
    // one database, so leaked connections are charged against every later file.
    await Promise.allSettled([blocker.end(), racer.end()]);
    throw error;
  }

  let released = false;
  const release = async () => {
    if (!released) {
      await blocker.query("SELECT pg_advisory_unlock($1, $2)", [
        ORGANIZATION_SETTINGS_BARRIER_LOCK_CLASS_ID,
        lockKeyTwo,
      ]);
      released = true;
    }
  };

  return {
    async commitCompetingSettingsKey(
      organizationId: string,
      key: string,
      value: unknown
    ) {
      await racer.query(
        `UPDATE organizations
         SET settings = jsonb_set(
           COALESCE(settings, '{}'::jsonb), ARRAY[$1]::text[], $2::jsonb, true
         )
         WHERE id = $3::uuid`,
        [key, JSON.stringify(value), organizationId]
      );
    },
    async commitCompetingUpdatedAt(organizationId: string, at: Date) {
      // Bound as an ISO-8601 UTC string rather than as a `Date`: node-postgres
      // renders a `Date` in the NODE process's local zone, and `updated_at` is
      // `TIMESTAMP(3)` with no zone, so Postgres would keep those local wall
      // fields and the value would land shifted on any non-UTC runner. The
      // Prisma writers on this column store UTC fields, so the racer must too.
      await racer.query(
        `UPDATE organizations
         SET updated_at = $1::timestamp
         WHERE id = $2::uuid`,
        [at.toISOString(), organizationId]
      );
    },
    async waitUntilBlocked() {
      for (let attempt = 0; attempt < 500; attempt += 1) {
        const result = await racer.query<{ waiting: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_locks
             WHERE locktype = 'advisory'
               AND classid = $1::oid
               AND objid = $2::oid
               AND NOT granted
           ) AS waiting`,
          [ORGANIZATION_SETTINGS_BARRIER_LOCK_CLASS_ID, lockKeyTwo]
        );
        if (result.rows[0]?.waiting) {
          return;
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      throw new Error(
        `${subject} never reached the organizations UPDATE barrier`
      );
    },
    release,
    async dispose() {
      // Every step is in the `finally` chain: a failed drop must still return
      // both backends, or a barrier that errors on teardown leaks two
      // connections into the shared database for the rest of the run.
      try {
        await release();
        await racer.query(
          `DROP TRIGGER IF EXISTS ${triggerName} ON organizations`
        );
        await racer.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
        await racer.query(`DROP SEQUENCE IF EXISTS ${sequenceName}`);
      } finally {
        await Promise.allSettled([blocker.end(), racer.end()]);
      }
    },
  };
}
