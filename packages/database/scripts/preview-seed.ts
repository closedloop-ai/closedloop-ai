/**
 * Preview-schema seeding step for the migration pipeline (FEA-1715, re-introduced
 * from the deferred FEA-1332/PLN-817 work with the PR #1472 review hardening
 * applied).
 *
 * Runs `pnpm seed --profile ci-preview --bootstrap-user` against a freshly
 * migrated preview schema so preview deploys get representative synthetic data
 * without a manual step. The run is NON-BLOCKING — a broken seed fixture must
 * never block a preview deploy.
 *
 * Hardening applied here vs. the original (deferred) machinery:
 *  - Recoverable gate (shafty023): the caller invokes this after EVERY successful
 *    preview migration, not only on first-create/reset, so a non-blocking failure
 *    on one deploy is retried idempotently on the next.
 *  - Authoritative target schema (shafty023): the subprocess DATABASE_URL is
 *    stripped of any `?schema=` and the intended schema is passed via PGSCHEMA so
 *    a stale `?schema=public` cannot silently win and route writes into `public`.
 *  - Bounded timeout (closedloop-ai-stage): a hung seed is killed and reported as
 *    a distinct non-blocking timeout instead of blocking the pipeline forever.
 */
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { isPreviewSchema } from "./preview-schema";

// Bounded timeout for the preview seed subprocess. Override with
// PREVIEW_SEED_TIMEOUT_MS for unusually large preview datasets.
export const DEFAULT_PREVIEW_SEED_TIMEOUT_MS = 300_000;

// Explicit stdout/stderr buffer cap. spawnSync's 1 MB default would kill the
// child with ENOBUFS once the seed's per-model summary output grows past it
// (and a non-blocking failure would then be misclassified) — 64 MB is well
// above any realistic seed log volume (review: thadeusb).
export const PREVIEW_SEED_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

// The seed binds to the synthetic/Sandbox bootstrap identity (FEA-1715) via
// --bootstrap-user so preview data hangs off an authenticatable org.
export const PREVIEW_SEED_ARGS: readonly string[] = [
  "--filter=@repo/database",
  "seed",
  "--",
  "--profile",
  "ci-preview",
  "--bootstrap-user",
];

export type PreviewSeedInvocation = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
};

export type PreviewSeedDeps = {
  spawnSyncFn?: typeof spawnSync;
  logger?: Pick<Console, "log" | "warn">;
};

/**
 * Builds the preview seed subprocess invocation with an authoritative target
 * schema: any `?schema=` is stripped from the DATABASE_URL and the intended
 * schema is supplied via PGSCHEMA (which the seed's schema resolution honors
 * only after the DSN, so the DSN value must not conflict). SEED_ALLOW_REMOTE=1
 * is set because preview databases are non-localhost.
 *
 * ALLOW_INSECURE_SSL=1 makes the seed connect to RDS with `rejectUnauthorized:
 * false` — matching how the runtime app pool (packages/database/index.ts) and
 * `prisma migrate deploy` already connect to the same RDS. Without it the seed's
 * default strict TLS verification rejects the RDS cert chain ("self-signed
 * certificate in certificate chain") and the preview seed dies on its first
 * query (FEA-1786). This opts the automated preview path into the established
 * connection posture; the seed CLI keeps its stricter default for manual runs.
 */
export function buildPreviewSeedInvocation(
  databaseUrl: string,
  schema: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
  timeoutMs: number = resolvePreviewSeedTimeoutMs(baseEnv)
): PreviewSeedInvocation {
  const url = new URL(databaseUrl);
  url.searchParams.delete("schema");
  const schemaStrippedUrl = url.toString();
  return {
    command: "pnpm",
    args: [...PREVIEW_SEED_ARGS],
    env: {
      ...baseEnv,
      DATABASE_URL: schemaStrippedUrl,
      PGSCHEMA: schema,
      SEED_ALLOW_REMOTE: "1",
      ALLOW_INSECURE_SSL: "1",
    },
    timeoutMs,
  };
}

/**
 * Runs the seed against a preview schema. Only acts on `preview_` schemas; any
 * other schema (production/staging/`public`) is a no-op. Failures — non-zero
 * exit, spawn error, or timeout — are logged and swallowed so the migration
 * pipeline always succeeds.
 */
export function runPreviewSeed(
  databaseUrl: string,
  schema: string | null,
  deps: PreviewSeedDeps = {}
): void {
  // `isPreviewSchema` is not a TS type predicate, so the explicit `=== null`
  // check (first, so it is clearly meaningful) is what narrows `schema` to
  // `string` for buildPreviewSeedInvocation below.
  if (schema === null || !isPreviewSchema(schema)) {
    return;
  }
  const logger = deps.logger ?? console;
  const spawnSyncFn = deps.spawnSyncFn ?? spawnSync;
  const invocation = buildPreviewSeedInvocation(databaseUrl, schema);

  logger.log(`↪ Running seed for preview schema ${schema}...`);
  const result = spawnSyncFn(invocation.command, invocation.args, {
    stdio: "pipe",
    encoding: "utf8",
    timeout: invocation.timeoutMs,
    maxBuffer: PREVIEW_SEED_MAX_BUFFER_BYTES,
    env: invocation.env,
  });

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  const failure = describePreviewSeedFailure(result, invocation.timeoutMs);
  if (failure) {
    logger.warn(`⚠️  Preview seed ${failure} (non-blocking).`);
  }
}

/**
 * Classifies a finished preview seed subprocess. Returns a human-readable
 * failure description (timeout vs. generic failure) or null on success. Only an
 * ETIMEDOUT error counts as a timeout — other SIGTERM kills (notably ENOBUFS
 * when the output exceeds maxBuffer) are reported as failures WITH their error
 * code so a debugger is not sent down the wrong path (review: thadeusb).
 */
export function describePreviewSeedFailure(
  result: SpawnSyncReturns<string>,
  timeoutMs: number
): string | null {
  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  if (errorCode === "ETIMEDOUT") {
    return `timed out after ${timeoutMs}ms`;
  }
  if (result.error) {
    const codeSuffix = errorCode ? ` (${errorCode})` : "";
    return `failed${codeSuffix}: ${result.error.message}`;
  }
  if (result.status !== 0) {
    return `failed with exit code ${result.status ?? "unknown"}`;
  }
  return null;
}

function resolvePreviewSeedTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env.PREVIEW_SEED_TIMEOUT_MS;
  if (raw === undefined) {
    return DEFAULT_PREVIEW_SEED_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_PREVIEW_SEED_TIMEOUT_MS;
}
