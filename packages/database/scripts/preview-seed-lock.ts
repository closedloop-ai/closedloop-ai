/**
 * ISS-6804 — cross-instance, schema-scoped admission for the preview seed.
 *
 * Every accepted `/preview-schemas/seed` request enters a fresh seed and its own
 * `pg.Pool`. Duplicate workflow dispatches, or a replayed still-valid OIDC
 * token, can therefore run several seeds against the SAME preview schema at
 * once, multiplying the query fan-out and the connection count on the shared
 * stage instance until real traffic starves. The seed's upserts make SERIAL
 * retries safe, but nothing bounded CONCURRENT work (review: davetho).
 *
 * A Postgres advisory lock is the admission gate because it is cross-instance
 * by construction: two Vercel functions on different machines contend on the
 * database, which is the only thing they share. Same shape as the per-schema
 * gate in `preview-plain-index.ts` — a bounded wait, and a session lock that a
 * crashed holder releases automatically when its connection drops.
 *
 * This gate fails CLOSED. A migrate gate fails open because blocking a deploy
 * is worse than a collision; here the opposite holds — the seed is
 * non-blocking and idempotent, so a refused run costs nothing and self-heals on
 * the next deploy, while running unguarded is exactly the starvation being
 * prevented. Failing open under load would also be backwards: when connections
 * are scarce, acquiring this lock is the first thing to fail, so fail-open
 * would drop the gate precisely when it is most needed.
 */

import { createSqlClient, endQuietly, type SqlClient } from "./db-utils";

/**
 * Advisory-lock namespace for preview-seed admission.
 *
 * This is the TWO-int keyspace (`pg_advisory_lock(int, int)`), which Postgres
 * keeps separate from the single-int keyspace holding Prisma's `72707369` and
 * the FEA-3065 serialize gate's `30650000`. Within this keyspace it must differ
 * from `preview-plain-index.ts`'s `72707370` (guard-tested), or a seed would
 * spuriously serialize against an index build.
 *
 * The second key is `hashtext(schema)`: two dispatches for the same preview
 * schema serialize, different schemas run free. A rare hashtext collision only
 * over-serializes two unrelated preview schemas; it never mis-scopes a seed.
 */
export const PREVIEW_SEED_LOCK_NAMESPACE = 72_707_371;

/**
 * Bounds the wait so a queued duplicate can never hold the function open. Short
 * on purpose: this is admission, not queueing. A caller that loses the race is
 * answered immediately rather than made to wait out a peer's full seed — the
 * peer is already doing the identical work. Long enough only to absorb the
 * sub-second overlap of two near-simultaneous dispatches.
 */
export const PREVIEW_SEED_LOCK_TIMEOUT_MS = 3000;

/**
 * Bounds the CONNECT itself. pg's default is wait-forever, which on a starved
 * instance is a hang rather than an error — the failure mode this gate exists
 * to prevent (ISS-5285, same reasoning).
 */
export const PREVIEW_SEED_LOCK_CONNECT_TIMEOUT_MS = 10_000;

/** `lock_timeout` cancels the acquire. */
const LOCK_NOT_AVAILABLE_SQLSTATE = "55P03";
/** `statement_timeout` cancels it, if one is set lower than `lock_timeout`. */
const STATEMENT_TIMEOUT_SQLSTATE = "57014";

/**
 * Why a seed was not admitted. `contended` means a peer holds the schema — the
 * expected, benign answer to a duplicate dispatch. `unavailable` means the gate
 * itself could not be established. They are kept apart so the caller can answer
 * "already running" without claiming it as a seed failure.
 */
export const SeedAdmissionRefusal = {
  Contended: "contended",
  Unavailable: "unavailable",
} as const;
export type SeedAdmissionRefusal =
  (typeof SeedAdmissionRefusal)[keyof typeof SeedAdmissionRefusal];

export type PreviewSeedAdmission<T> =
  | { admitted: true; result: T }
  | { admitted: false; refusal: SeedAdmissionRefusal; detail: string };

export type PreviewSeedAdmissionDeps = {
  databaseUrl: string;
  schema: string;
  /** Client factory — defaults to the shared `createSqlClient`; injected in tests. */
  createClient?: (databaseUrl: string) => SqlClient;
  lockTimeoutMs?: number;
};

/**
 * Runs `fn` while holding the preview schema's admission lock, or refuses.
 *
 * `fn` runs at most once and never runs unguarded. Its own errors propagate
 * after the lock is released.
 */
export async function withPreviewSeedAdmission<T>(
  deps: PreviewSeedAdmissionDeps,
  fn: () => Promise<T>
): Promise<PreviewSeedAdmission<T>> {
  const lockTimeoutMs = deps.lockTimeoutMs ?? PREVIEW_SEED_LOCK_TIMEOUT_MS;
  const createClient = deps.createClient ?? defaultLockClient;

  let client: SqlClient | null = null;
  try {
    client = createClient(deps.databaseUrl);
    await client.connect();
    // `set_config` (not `SET`) so the bound is a parameter, never interpolated.
    // `is_local=false` → session scope, which is what the acquire below runs in.
    await client.query("SELECT set_config('lock_timeout', $1, false)", [
      `${lockTimeoutMs}ms`,
    ]);
    await client.query("SELECT pg_advisory_lock($1, hashtext($2))", [
      PREVIEW_SEED_LOCK_NAMESPACE,
      deps.schema,
    ]);
  } catch (error) {
    await endQuietly(client);
    return {
      admitted: false,
      refusal: classifyAdmissionFailure(error),
      detail: describeAdmissionError(error),
    };
  }

  try {
    return { admitted: true, result: await fn() };
  } finally {
    // Closing the connection releases the session lock on its own; the explicit
    // unlock just returns it promptly to a waiting peer.
    try {
      await client.query("SELECT pg_advisory_unlock($1, hashtext($2))", [
        PREVIEW_SEED_LOCK_NAMESPACE,
        deps.schema,
      ]);
    } catch {
      // Best-effort; the close below is what actually guarantees release.
    }
    await endQuietly(client);
  }
}

/**
 * The gate's own connection carries the same IAM database token the seed does,
 * so it takes the VERIFIED TLS path rather than `createSqlClient`'s historical
 * unverified default.
 */
function defaultLockClient(databaseUrl: string): SqlClient {
  return createSqlClient(databaseUrl, {
    connectionTimeoutMillis: PREVIEW_SEED_LOCK_CONNECT_TIMEOUT_MS,
    allowInsecure: false,
  });
}

function classifyAdmissionFailure(error: unknown): SeedAdmissionRefusal {
  const code = (error as { code?: unknown } | null)?.code;
  return code === LOCK_NOT_AVAILABLE_SQLSTATE ||
    code === STATEMENT_TIMEOUT_SQLSTATE
    ? SeedAdmissionRefusal.Contended
    : SeedAdmissionRefusal.Unavailable;
}

function describeAdmissionError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
