import { keys } from "@repo/database/keys";
import { Client } from "pg";

/**
 * Hold the ROW lock on one `organizations` row from a competing connection, so
 * a production settings write blocks on it, then commit and let the production
 * write proceed. ISS-7157 uses this to prove the writer reads its `updated_at`
 * stamp AFTER the lock is granted rather than before it waited.
 *
 * WHY NOT `organization-settings-write-barrier`. That barrier parks a statement
 * at a `BEFORE UPDATE … FOR EACH STATEMENT` trigger, deliberately BEFORE any
 * row is examined or locked, so the parked writer holds nothing and the racer
 * can commit inside its window. That is the right tool for proving a
 * concurrently written sibling key survives, and it is the wrong tool here: the
 * behaviour under test is what the writer does once it is BLOCKED ON THE ROW,
 * and a trigger that fires before the row lock cannot produce that state. This
 * helper is the mirror image — the competing writer takes the row lock and the
 * production write is the one that waits.
 *
 * The transaction is left open between construction and {@link
 * OrganizationRowLockHolder.commitAfter}, so this holds one connection and one
 * row lock for that whole window. `dispose()` rolls back an uncommitted
 * transaction and must run BEFORE any fixture cleanup that deletes the row,
 * which would otherwise queue behind this lock.
 */
const LOCK_HOLDER_APPLICATION_NAME = "settings-row-lock-holder";
/**
 * Bounds the wait for the production write to reach the lock. Comfortably more
 * polls than a local interleave needs, and each poll is a round trip, so an
 * exhausted budget is a real failure rather than a slow runner.
 */
const MAX_CONTENTION_POLLS = 500;

export type OrganizationRowLockHolder = {
  /**
   * Resolve once some other backend is blocked BY THIS ONE — i.e. the
   * production write has reached the row lock and is waiting on it.
   */
  waitUntilContended(): Promise<void>;
  /**
   * Commit the competing write, releasing the row lock, but not before
   * `releaseAt`. Holding for a known interval is what makes the assertion
   * decidable by a constant rather than by how long a round trip happened to
   * take: the production writer's pre-lock reading and its post-lock reading
   * are otherwise microseconds apart, and `updated_at` is `TIMESTAMP(3)`.
   */
  commitAfter(releaseAt: Date): Promise<void>;
  dispose(): Promise<void>;
};

/**
 * Open a transaction that stamps `updated_at` on one organization and keeps its
 * row lock until {@link OrganizationRowLockHolder.commitAfter}.
 *
 * `competingUpdatedAt` is bound as an ISO-8601 UTC string rather than as a
 * `Date` for the reason the settings-write barrier documents: node-postgres
 * renders a `Date` in the NODE process's local zone and `updated_at` is
 * `TIMESTAMP(3)` with no zone, so a `Date` lands shifted on a non-UTC runner.
 */
export async function holdOrganizationRowLock(
  organizationId: string,
  competingUpdatedAt: Date,
  subject = "the production settings write"
): Promise<OrganizationRowLockHolder> {
  const databaseUrl = keys().DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for the organization row lock");
  }

  const client = new Client({ connectionString: databaseUrl });
  let backendPid: number;
  try {
    await client.connect();
    await client.query(
      `SET application_name = '${LOCK_HOLDER_APPLICATION_NAME}'`
    );
    const pid = await client.query<{ pid: number }>(
      "SELECT pg_backend_pid() AS pid"
    );
    const readPid = pid.rows[0]?.pid;
    if (readPid === undefined) {
      throw new Error("could not read the row-lock holder's backend pid");
    }
    backendPid = readPid;
    await client.query("BEGIN");
    await client.query(
      `UPDATE organizations
       SET updated_at = $1::timestamp
       WHERE id = $2::uuid`,
      [competingUpdatedAt.toISOString(), organizationId]
    );
  } catch (error) {
    // A half-open holder must not keep its backend: the integration tier shares
    // one database, so a leaked connection is charged against every later file.
    await client.end().catch(() => undefined);
    throw error;
  }

  let settled = false;

  return {
    async waitUntilContended() {
      for (let attempt = 0; attempt < MAX_CONTENTION_POLLS; attempt += 1) {
        const result = await client.query<{ waiting: boolean }>(
          `SELECT EXISTS (
             SELECT 1
             FROM pg_stat_activity a
             WHERE a.datname = current_database()
               AND a.pid <> $1::int
               AND $1::int = ANY(pg_blocking_pids(a.pid))
           ) AS waiting`,
          [backendPid]
        );
        if (result.rows[0]?.waiting) {
          return;
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 5);
        });
      }
      throw new Error(`${subject} never blocked on the organizations row lock`);
    },
    async commitAfter(releaseAt: Date) {
      const remainingMs = releaseAt.getTime() - Date.now();
      if (remainingMs > 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, remainingMs);
        });
      }
      await client.query("COMMIT");
      settled = true;
    },
    async dispose() {
      try {
        if (!settled) {
          await client.query("ROLLBACK");
          settled = true;
        }
      } finally {
        await client.end().catch(() => undefined);
      }
    },
  };
}
