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
 *  - Recoverable gate (davetho): the caller invokes this after EVERY successful
 *    preview migration, not only on first-create/reset, so a non-blocking failure
 *    on one deploy is retried idempotently on the next.
 *  - Authoritative target schema (davetho): the subprocess DATABASE_URL is
 *    stripped of any `?schema=` and the intended schema is passed via PGSCHEMA so
 *    a stale `?schema=public` cannot silently win and route writes into `public`.
 *  - Bounded timeout (closedloop-ai-stage): a hung seed is killed and reported as
 *    a distinct non-blocking timeout instead of blocking the pipeline forever.
 */
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { isPreviewSchema } from "./preview-schema";
import type { SeedProgramSummary } from "./seed/program";

// Bounded timeout for the preview seed subprocess. Override with
// PREVIEW_SEED_TIMEOUT_MS for unusually large preview datasets.
export const DEFAULT_PREVIEW_SEED_TIMEOUT_MS = 300_000;

// Explicit stdout/stderr buffer cap. spawnSync's 1 MB default would kill the
// child with ENOBUFS once the seed's per-model summary output grows past it
// (and a non-blocking failure would then be misclassified) — 64 MB is well
// above any realistic seed log volume (review: tamsinb).
export const PREVIEW_SEED_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

// The seed binds to the synthetic/Sandbox bootstrap identity (FEA-1715) via
// --bootstrap-user so preview data hangs off an authenticatable org. These are
// the seed program's OWN arguments — what follows `pnpm … seed --` on the build
// and what `runSeedProgram` receives in-process (ISS-6804), from one place.
export const PREVIEW_SEED_CLI_ARGS: readonly string[] = [
  "--profile",
  "ci-preview",
  "--bootstrap-user",
];

export const PREVIEW_SEED_ARGS: readonly string[] = [
  "--filter=@repo/database",
  "seed",
  "--",
  ...PREVIEW_SEED_CLI_ARGS,
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
 * The environment the preview seed runs under, whether spawned or in-process:
 * an authoritative target schema — any `?schema=` is stripped from the
 * DATABASE_URL and the intended schema is supplied via PGSCHEMA (which the
 * seed's schema resolution honors only after the DSN, so the DSN value must not
 * conflict) — and SEED_ALLOW_REMOTE=1, because preview databases are
 * non-localhost.
 *
 * TLS is the VERIFIED path. FEA-1786 forced ALLOW_INSECURE_SSL=1 here because
 * the seed's strict verification rejected the RDS chain ("self-signed
 * certificate in certificate chain"); PR #2084 then fixed that at the root by
 * merging Amazon's RDS CA bundle into `VERIFIED_SSL_CA` (scripts/db-utils.ts),
 * which `resolveSslOption` returns under `rejectUnauthorized: true`. Forcing the
 * flag after that only carried the IAM database token over unauthenticated TLS,
 * so it is no longer set. An operator can still opt out via the ambient
 * environment — `baseEnv` is spread first — but nothing on this path does.
 */
export function previewSeedEnv(
  databaseUrl: string,
  schema: string,
  baseEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const url = new URL(databaseUrl);
  url.searchParams.delete("schema");
  return {
    ...baseEnv,
    DATABASE_URL: url.toString(),
    PGSCHEMA: schema,
    SEED_ALLOW_REMOTE: "1",
  };
}

/** The preview seed as a `pnpm` subprocess — the build's path. */
export function buildPreviewSeedInvocation(
  databaseUrl: string,
  schema: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
  timeoutMs: number = resolvePreviewSeedTimeoutMs(baseEnv)
): PreviewSeedInvocation {
  return {
    command: "pnpm",
    args: [...PREVIEW_SEED_ARGS],
    env: previewSeedEnv(databaseUrl, schema, baseEnv),
    timeoutMs,
  };
}

export type PreviewSeedInProcessResult =
  | { ran: false; reason: "not_a_preview_schema" }
  | { ran: true; ok: true; summary: SeedProgramSummary }
  | {
      ran: true;
      ok: false;
      /** The seed program's own failure text. */
      error: string;
    };

/**
 * ISS-6804: the preview seed IN THIS PROCESS — for a caller with no `pnpm`,
 * i.e. the `/preview-schemas/seed` route in an api-stage function. Same
 * arguments, same env, same preview-only guard and same never-throws contract
 * as `runPreviewSeed`; the difference is that the result comes back as data the
 * route can answer with instead of a swallowed warning.
 *
 * `baseEnv` is spread under the seed's own variables the way the subprocess
 * inherits `process.env` — the Sandbox identity (`SEED_SANDBOX_*`), `PGHOST`,
 * `STAGE_PGHOST` all come from it. The seed program is imported lazily so a
 * caller that only spawns never loads the seed graph.
 */
export async function runPreviewSeedInProcess(
  databaseUrl: string,
  schema: string | null,
  baseEnv: NodeJS.ProcessEnv = process.env,
  logger: Pick<Console, "log" | "warn" | "error"> = console
): Promise<PreviewSeedInProcessResult> {
  if (schema === null || !isPreviewSchema(schema)) {
    return { ran: false, reason: "not_a_preview_schema" };
  }
  const { runSeedProgram } = await import("./seed/program");
  logger.log(`↪ Running seed for preview schema ${schema} (in-process)...`);
  const result = await runSeedProgram({
    argv: PREVIEW_SEED_CLI_ARGS,
    env: previewSeedEnv(databaseUrl, schema, baseEnv),
    logger,
  });
  if (result.exitCode !== 0 || !result.summary) {
    const error = result.error ?? "seed exited without a summary";
    logger.warn(`⚠️  Preview seed failed (non-blocking): ${error}`);
    return { ran: true, ok: false, error };
  }
  return { ran: true, ok: true, summary: result.summary };
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
 * code so a debugger is not sent down the wrong path (review: tamsinb).
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
