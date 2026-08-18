/**
 * pg connection-pool ceilings (FEA-3299 / PRD-528).
 *
 * A leaf module on purpose: it imports nothing, so a consumer that only needs to
 * size work against the pool can read these numbers without pulling in Prisma,
 * `pg`, the AWS RDS signer, and the env machinery that `index.ts` loads at module
 * top level.
 *
 * These exist so the pool's size and the limits derived from it cannot drift
 * apart. `withDb` does not hold a connection — every query inside it borrows its
 * own — so any code that fans out concurrent queries is spending this budget,
 * and on 2026-07-15 a fan-out that had never been sized against it took the API
 * down. `apps/api/lib/db-fanout.ts` derives its concurrency bound from these and
 * pins the relationship with a test.
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
 * it is the bound the `cl-api — pg pool-acquire timeouts` monitor runbook
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
