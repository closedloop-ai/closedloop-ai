/**
 * pg connection-pool ceilings (FEA-3299 / PRD-528).
 *
 * A leaf module on purpose: it imports nothing, so a consumer that only needs to
 * size work against the pool can read these numbers without pulling in Prisma,
 * `pg`, the AWS RDS signer, and the env machinery that `index.ts` loads at module
 * top level.
 *
 * These exist so the pool's size and the limits derived from it cannot drift
 * apart. Any code that fans out concurrent work is spending this budget, and on
 * 2026-07-15 a fan-out that had never been sized against it took the API down.
 *
 * **Size against ACQUISITIONS, not against ORM calls (ISS-8431).** This file
 * used to say that `withDb` does not hold a connection and every query inside it
 * borrows its own — true, but it invited the reader to assume the two units are
 * interchangeable, one connection per call. They stopped being interchangeable
 * at the Prisma 7 driver-adapter / query-compiler migration: on a
 * non-transactional read Prisma runs every included relation as a parallel child
 * query and each child takes its own connection in the same tick, so ONE
 * `findMany` with ten `include`s measures 11 concurrent acquisitions. A bound
 * counted in calls therefore admits `calls x relationEdges` connections and does
 * not describe this resource. `DB_ACQUISITION_BUDGET_MAX` below is the bound in
 * the right unit; `apps/api/lib/db-fanout.ts` bounds concurrent calls, which is
 * a different and weaker thing.
 */

/**
 * Pool size on the IAM/Vercel path (`getPool`'s `else` branch in `index.ts`).
 *
 * Per Vercel instance. Raising it is not a fix for pool pressure: ~22 instances
 * times a larger pool approaches the server's connection ceiling and converts an
 * app-level failure into a database-level one (PRD-528 explicitly non-goals
 * resizing).
 */
export const DB_POOL_MAX_IAM = 20;

/**
 * Pool size on the `DATABASE_URL` path (local dev and remote ECS tasks).
 *
 * The value is pg's own default, which this branch used to inherit implicitly;
 * FEA-3315 passes it explicitly so the pool ceiling is a number somebody chose
 * rather than a driver default that could move under us. Consumers size against
 * the *smaller* of the two pools, which is the binding constraint — that is why
 * `apps/api/lib/db-fanout.ts` derives its bound from this constant and not from
 * `DB_POOL_MAX_IAM`.
 *
 * Deliberately NOT raised. The same arithmetic that forbids raising
 * `DB_POOL_MAX_IAM` applies here: more connections per task multiplied by the
 * task count marches toward the server's `max_connections` ceiling and converts
 * an app-level failure into a database-level one (the 53300 class).
 */
export const DB_POOL_MAX_DATABASE_URL_DEFAULT = 10;

/**
 * How long a caller may wait for a pooled connection before the acquisition
 * fails, on **both** branches (FEA-3315).
 *
 * pg's `connectionTimeoutMillis` bounds two things at once: the TCP/TLS/IAM
 * handshake for a brand-new connection, and the time a caller spends queued
 * behind a saturated pool. The second is the one that matters here — pg-pool
 * only arms a timer when this option is set (`pg-pool@3.13.0/index.js:206`
 * short-circuits to an untimed `_pendingQueue.push` when it is falsy), so the
 * `DATABASE_URL` branch previously queued the 11th concurrent caller
 * indefinitely: no timeout, no error, no failed request.
 *
 * 30s is the value the IAM branch has run in production since PRD-528, and it
 * is shared rather than re-picked per branch on purpose. It is long enough that
 * a genuinely slow first handshake to RDS is not mistaken for saturation, and
 * it is the bound the `cl-api / cl-mcp — pg pool-acquire timeouts` monitor runbook
 * already documents. A second, smaller, unproven number for the other branch
 * would buy a faster failure at the cost of a new false-failure mode and a
 * constant nobody could justify.
 *
 * On expiry pg rejects with the exact message
 * `timeout exceeded when trying to connect`, which is the string that monitor
 * alerts on and that `pool-telemetry.ts` classifies as
 * `db_pool_acquire_timeout`.
 */
export const DB_POOL_ACQUIRE_TIMEOUT_MS = 30_000;

/**
 * The exact message pg rejects an expired acquisition with
 * (`pg-pool@3.13.0/index.js:45`) — the QUEUE-WAIT timeout, raised once
 * `connectionTimeoutMillis` elapses while a caller is queued. Matched on the
 * exact literal so it is never confused with pg-pool's *handshake* timeout
 * ("Connection terminated due to connection timeout"), which is a different
 * failure with a different remedy.
 *
 * Shared rather than re-typed per consumer: `pool-telemetry.ts` classifies on
 * this exact string to emit `db_pool_acquire_timeout`, and
 * `acquisition-budget.ts` fails a permit wait with it so a caller blocked by the
 * budget lands in the same monitor as a caller blocked by the pool. Two copies
 * would let one drift and silently split that signal in half.
 */
export const DB_POOL_ACQUIRE_TIMEOUT_MESSAGE =
  "timeout exceeded when trying to connect";

/**
 * Max pooled connections one logical unit of work may hold at once (ISS-8431).
 *
 * The invariant `DB_FANOUT_MAX_CONCURRENCY` was written to express — one unit of
 * work spends at most **half of the smallest pool**, leaving the rest for the
 * concurrent requests the pool exists to serve — but stated in the unit that
 * actually bounds the resource. Derived from the smaller pool for the same
 * reason that one is: it is the binding constraint, so shrinking it moves this
 * automatically rather than silently re-opening the outage.
 *
 * Enforced by `gateDbAcquisitions` in `acquisition-budget.ts`, which counts
 * `pool.connect` rather than ORM calls, so an include tree of any width is
 * bounded by it.
 */
export const DB_ACQUISITION_BUDGET_MAX = Math.floor(
  DB_POOL_MAX_DATABASE_URL_DEFAULT / 2
);
