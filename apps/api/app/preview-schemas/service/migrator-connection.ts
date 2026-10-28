/**
 * A short-lived connection as the MIGRATOR identity, for the one piece of DDL
 * this app still issues at request time: the preview-schema `DROP SCHEMA`.
 *
 * ISS-5978 (PRD-598 ISS-1 / Q-E): the runtime pool behind `withDb` is being
 * demoted to DML-only, and `DROP SCHEMA` needs schema ownership, so the drop
 * must never ride that pool. It connects the way the ensure route's migrate
 * does — `mintSchemaUrls`, i.e. `MIGRATE_PGUSER` falling back to `PGUSER` — and
 * only OFF Vercel (local dev, the integration tier) falls back to
 * `DATABASE_URL`, which there is the single role that owns everything.
 */

import {
  createSqlClient,
  endQuietly,
  type SqlClient,
} from "@repo/database/scripts/db-utils";
import { withTimeout } from "@/lib/with-timeout";
import { mintSchemaUrls } from "./iam-schema-url";

/** pg waits forever on connect by default; a sweep must not. */
const MIGRATOR_CONNECT_TIMEOUT_MS = 10_000;
/**
 * Client-side ceiling on every query, above the DROP's own 30 s
 * `statement_timeout`, for a connection that goes silent mid-statement where
 * the server-side timeout never reports back.
 */
const MIGRATOR_QUERY_TIMEOUT_MS = 40_000;
/**
 * Ceiling on the WHOLE call — token mint, connect and every query — and the one
 * number the sweep's headroom is sized against.
 *
 * `withDb.tx`'s 40 s transaction timeout used to bound the entire in-flight
 * drop, and `FALLBACK_SWEEP_BUDGET_MS` (240 s) reserves exactly that 60 s under
 * the cron route's `maxDuration` (300 s) for one drop to finish AFTER the
 * budget is spent — `deferDropIfExhausted` only checks before a drop starts.
 * The per-step bounds above do not reconstruct it: they leave the IAM token
 * mint unbounded, because `createSchemaUrlMinter` signs through a fresh STS
 * credentials resolution per call with no timeout of its own. One bound over
 * the whole call restores the ceiling the headroom was sized for.
 */
const MIGRATOR_TOTAL_TIMEOUT_MS = 40_000;
const MIGRATOR_TIMEOUT_LABEL = "Migrator connection";

export function withMigratorClient<T>(
  fn: (client: SqlClient) => Promise<T>,
  env: NodeJS.ProcessEnv = process.env
): Promise<T> {
  return withTimeout(
    runOnMigratorClient(fn, env),
    MIGRATOR_TOTAL_TIMEOUT_MS,
    MIGRATOR_TIMEOUT_LABEL
  );
}

export const MIGRATOR_NOT_CONFIGURED_MESSAGE =
  "No migrator connection is configured: set the RDS IAM variables (AWS_REGION, PGHOST, MIGRATE_PGUSER or PGUSER, PGDATABASE) or DATABASE_URL";

/**
 * `DATABASE_URL`, but only in an environment that has no IAM config by design.
 *
 * On Vercel `DATABASE_URL` is the RUNTIME pool's URL — the `vercel_iam` role
 * this change demotes — so falling back to it there turns ONE missing IAM
 * variable into 42501 on every schema, which reads as a privilege regression
 * rather than as the misconfiguration it is. Refusing instead surfaces
 * {@link MIGRATOR_NOT_CONFIGURED_MESSAGE}, which names the actual cause.
 *
 * `VERCEL_ENV` is the discriminator because it is set on every Vercel
 * deployment and on none of the others. Production-vs-not is the wrong axis
 * here: api-stage deploys to a Vercel *production* target.
 */
function offVercelFallbackUrl(env: NodeJS.ProcessEnv): string | undefined {
  return env.VERCEL_ENV ? undefined : env.DATABASE_URL;
}

async function runOnMigratorClient<T>(
  fn: (client: SqlClient) => Promise<T>,
  env: NodeJS.ProcessEnv
): Promise<T> {
  const iamUrls = await mintSchemaUrls(null, env);
  const databaseUrl = iamUrls?.databaseUrl ?? offVercelFallbackUrl(env);
  if (!databaseUrl) {
    throw new Error(MIGRATOR_NOT_CONFIGURED_MESSAGE);
  }

  // `allowInsecure: false` means "never UNVERIFIED TLS", not "always TLS":
  // `resolveSslOption` answers `false` for localhost and for an explicit
  // `?sslmode=disable` before it reads the flag. That is the correct reading on
  // both branches reachable here — the minted IAM URL carries `sslmode=require`
  // against a remote RDS host, so its token always rides a verified chain,
  // while the fallback is off-Vercel only, where plaintext to a local or
  // container Postgres is the point.
  // ponytail: one connection (and token) per DROP; share one per sweep if the
  // drop volume ever makes the connects show up against the sweep budget.
  const client = createSqlClient(databaseUrl, {
    connectionTimeoutMillis: MIGRATOR_CONNECT_TIMEOUT_MS,
    queryTimeoutMillis: MIGRATOR_QUERY_TIMEOUT_MS,
    allowInsecure: false,
  });
  try {
    await client.connect();
    return await fn(client);
  } finally {
    await endQuietly(client);
  }
}
