import { validateHost } from "@repo/database/scripts/cleanup-preview-schemas-lib";
import { cloneFailureCodeOf } from "@repo/database/scripts/clone-schema";
import {
  type RolledBackRetryFailure,
  rolledBackRetryFailureOf,
  sanitizeOperatorCliOutput,
  sanitizeOperatorMessageFragment,
} from "@repo/database/scripts/migrate-deploy-recovery";
import { isPrismaAdvisoryLockError } from "@repo/database/scripts/migrate-retry";
import {
  cutMigrateRunsAtDeadline,
  flushMigrateTelemetry,
} from "@repo/database/scripts/migrate-telemetry";
import {
  SerializeLockContendedError,
  withMigrationSerializeLock,
} from "@repo/database/scripts/migration-lock";
import { runMigrationPipeline } from "@repo/database/scripts/migration-pipeline";
import type {
  VibeEnvironmentMarker,
  VibeEnvironmentMode,
} from "@repo/database/scripts/vibe-environment";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { isTimeoutError, withTimeout } from "@/lib/with-timeout";
import {
  IAM_NOT_CONFIGURED_MESSAGE,
  mintSchemaUrls,
} from "../service/iam-schema-url";
import { EnsureFailureReason } from "./constants";
import {
  applyMigrateRuntimeLayout,
  resolveMigrateRuntimeLayout,
} from "./prisma-runtime-layout";

/**
 * How `public` reads in an operator-facing message. The pipeline represents it
 * as `null`, which is correct on the wire and unreadable in a red CI log.
 */
const PUBLIC_SCHEMA_LABEL = "public";

/**
 * What a refused host tells the CLIENT. Deliberately says nothing about which
 * hosts are involved: `validateHost`'s own message names both `PGHOST` and
 * `STAGE_PGHOST`, and the staging workflow prints this body straight into a
 * GitHub Actions log — far more widely readable than a Vercel log, and the
 * exact sink this PR's sanitizer exists to keep infrastructure detail out of
 * (ISS-6403, review: whitlockk). The detail goes to `log.error` instead.
 */
const HOST_REFUSED_MESSAGE =
  "Refusing to ensure a schema: this deployment is not wired to the allowlisted non-production database host";

export type EnsureSchemaResult =
  | {
      ok: true;
      branch: string;
      /** `null` is the pipeline's own representation of the `public` schema. */
      schema: string | null;
      invalidIndexes: string[] | null;
      schemaEngineBinary: string | null;
      /** ISS-12056: the schema's vibe environment marker, `null` for any other schema. */
      vibeEnvironment: VibeEnvironmentMarker | null;
      /** ISS-12056: a vibe environment request dropped the schema and built it anew. */
      rebuilt: boolean;
    }
  | { ok: false; reason: EnsureFailureReason; message: string };

/**
 * Brings ONE schema to migration head through the EXISTING
 * `runMigrationPipeline`, from a runtime function rather than the build.
 *
 * `schema` is the pipeline's own schema argument, so `null` means `public` —
 * exactly what `resolveSchemaName` hands the build on the production target, and
 * what ISS-5984's post-deploy hook passes. Every preview-only step inside the
 * pipeline (registry upsert, at-head probe, prestamp, clone-from-public, seed)
 * already self-guards on that same value, so `public` takes the identical path
 * the build takes today, ownership preflight (ISS-5952) included.
 *
 * KNOWN GAP, deliberately not papered over: the pipeline's last step,
 * `runPreviewSeed`, spawns `pnpm --filter=@repo/database seed`, and a serverless
 * function carries no package manager, so that spawn ENOENTs. It is fail-soft
 * by design (warn and continue), so a preview schema bootstrapped through this
 * route is migrated and CLONED FROM `public` but not synthetically seeded —
 * hence no seeding claim anywhere in this route's contract. ISS-5984 decided to
 * leave it there rather than bundle the seed: the clone is what makes a preview
 * serve, the seed (FEA-1715) only adds synthetic rows on top, and bundling it
 * would trace the seed's whole graph into the function for a non-prerequisite.
 * `public` never seeded and never will — `runPreviewSeed` no-ops for it.
 *
 * Nothing in the pipeline changes: the P1002 serialize gate, the FEA-3071
 * at-head probe, prestamp, clone, seed and the ISS-5285 token re-mint are the
 * ones already in production. What a function has to add is the environment the
 * pipeline's `spawn("prisma", …)` gets for free on the build — a `prisma` on
 * `PATH`, a config discoverable from cwd, and the native schema engine.
 */
export async function ensureSchemaAtHead(
  branch: string,
  schema: string | null,
  /**
   * ISS-6403 Finding 1: bound the pipeline at `budgetMs` and report the expiry
   * in this function's own result, instead of letting the platform kill the
   * invocation and answer with a `FUNCTION_INVOCATION_TIMEOUT` the caller
   * cannot interpret.
   *
   * A PARAMETER, not a module constant, because the two callers run under
   * different ceilings: the HTTP route declares 300s, while
   * `ensurePreviewSchemaBootstrap` runs inside whatever ordinary request first
   * touched a cold preview. Applying the route's number to that path would arm
   * a timer that outlives its own request and then reject on the warm instance
   * — clearing the bootstrap memo while the abandoned migrate is still running,
   * so the next request starts a SECOND concurrent migrate on the same schema
   * (review). Omitted — the bootstrap gate today — behaves exactly as before.
   *
   * ISS-11781: `gateBudgetMs` caps the wait for the FEA-3065 serialize gate and
   * makes a wait that runs out fail CLOSED, so a busy gate answers `Contended`
   * with nothing run instead of a waiter the deadline abandons. Any other gate
   * error still fails open. Omitted — the gate is untouched.
   */
  opts: {
    budgetMs?: number;
    gateBudgetMs?: number;
    /** ISS-12056: build the schema as an empty vibe environment of this mode. */
    vibeEnvironment?: VibeEnvironmentMode;
  } = {}
): Promise<EnsureSchemaResult> {
  // THE host invariant, and it lives HERE rather than on the HTTP route so
  // every caller inherits it (ISS-6403, review: davetho). The route was the
  // only entry point when this check was written; `ensurePreviewSchemaBootstrap`
  // imports this function directly, so a flag-on preview accidentally wired to
  // the production host — the exact configuration failure the check exists to
  // contain — would have minted a production URL and run the create/migrate/
  // clone pipeline without ever passing the route's guard. A guard on one entry
  // point is not an invariant.
  //
  // FIRST, before the layout probe and long before a URL is minted: nothing
  // this function does to a production database is recoverable. `apps/api` also
  // runs in production with PGHOST/PGUSER/PGDATABASE/AWS_ROLE_ARN all present,
  // so an unguarded call there would create a `preview_*` schema on the
  // production RDS and clone every table into it — a full copy of production
  // data, in a schema no reaper touches (the orphan sweep and the 7-day TTL are
  // preview-fleet machinery).
  //
  // On the HOST, not on a deployment label, because the host is the resource at
  // risk — and `VERCEL_ENV` cannot express the distinction anyway: api-stage
  // deploys to a Vercel *production* target, so `VERCEL_ENV` reads
  // `"production"` on stage too (`apps/app/lib/environment.ts`), and refusing on
  // it would refuse on the one deployment that is supposed to work. Reuses the
  // sibling cleanup sweep's `validateHost` allowlist rather than re-deriving it:
  // PGHOST must equal the explicitly configured STAGE_PGHOST. FAILS CLOSED — an
  // unset STAGE_PGHOST is "cannot verify host safety", not "proceed", because
  // production is precisely where that variable will not be set.
  const hostError = validateHost({
    pgHost: process.env.PGHOST,
    stagePgHost: process.env.STAGE_PGHOST,
  });
  if (hostError) {
    log.error("[preview-schema-ensure] Refusing: host is not allowlisted", {
      branch,
      schema,
      hostError,
    });
    return {
      ok: false,
      reason: EnsureFailureReason.HostNotAllowed,
      message: HOST_REFUSED_MESSAGE,
    };
  }

  // Resolved BEFORE any connection is opened: without the bundled CLI, config
  // and engine the spawned `prisma migrate deploy` cannot succeed, and failing
  // here names the missing piece instead of surfacing an opaque spawn error.
  const layoutResult = resolveMigrateRuntimeLayout(process.cwd());
  if (!layoutResult.ok) {
    log.error("[preview-schema-ensure] Prisma runtime layout unresolved", {
      schema,
      reason: layoutResult.reason,
      rootsTried: layoutResult.rootsTried,
    });
    return {
      ok: false,
      reason: EnsureFailureReason.Failed,
      message: layoutResult.reason,
    };
  }
  applyMigrateRuntimeLayout(layoutResult.layout);

  const urls = await mintSchemaUrls(schema);
  if (!urls) {
    return {
      ok: false,
      reason: EnsureFailureReason.Failed,
      message: IAM_NOT_CONFIGURED_MESSAGE,
    };
  }

  log.info("[preview-schema-ensure] Ensuring preview schema at head", {
    branch,
    schema,
    schemaEngineBinary: layoutResult.layout.schemaEngineBinary,
  });

  try {
    // ISS-6403 Finding 1, and the hazard that answering rather than dying
    // creates (review). Before this change a run past the ceiling ended in a
    // platform kill that tore the sandbox down WITH its `prisma migrate deploy`
    // child. Now the handler returns and the instance stays warm, so the
    // abandoned child runs on — and the natural operator response to a red
    // staging job is to re-run it, which can land on this same instance and
    // spawn a SECOND migrate against the same schema.
    //
    // So an in-flight run is joined, not duplicated: the same shape as
    // `ensurePreviewSchemaBootstrap`'s `bootstrapAttempt` memo, for the same
    // reason. The entry is cleared when the PIPELINE settles, never when a
    // caller's deadline fires — clearing it on the deadline is precisely what
    // would let the next request start a second migrate under the first.
    const { invalidIndexes, vibeEnvironment, rebuilt } =
      await runPipelineWithinBudget(
        joinInFlightPipeline(schema, opts.vibeEnvironment, () =>
          runMigrationPipeline(
            urls.databaseUrl,
            schema,
            branch,
            {
              // ISS-6403 Finding 5: the CHILD's working directory, for THIS run only.
              // Prisma 7 discovers `prisma.config.mjs` from cwd and a function's cwd
              // is not where it lives; neither `process.chdir` nor an env var can say
              // that without saying it to every other caller on the instance too.
              // ISS-6781: the ESM store resolver rides the same per-invocation seam.
              // ISS-6810: so does the migrations directory the pipeline's own readers
              // open — the pre-stamp, at-head probe, plain-index build and preflight
              // resolve it off cwd by default, and this process's cwd is `apps/api`.
              prismaCli: {
                cwd: layoutResult.layout.configDir,
                preload: layoutResult.layout.esmResolverEntry,
                migrationsDir: layoutResult.layout.migrationsDir,
              },
              ...(urls.refreshDatabaseUrl
                ? { refreshDatabaseUrl: urls.refreshDatabaseUrl }
                : {}),
              ...failClosedGate(opts.gateBudgetMs),
            },
            vibeEnvironmentRequest(opts.vibeEnvironment)
          )
        ),
        opts.budgetMs
      );

    return {
      ok: true,
      branch,
      schema,
      invalidIndexes:
        invalidIndexes?.map((invalidIndex) => invalidIndex.name) ?? null,
      schemaEngineBinary: layoutResult.layout.schemaEngineBinary,
      vibeEnvironment,
      rebuilt,
    };
  } catch (error) {
    // ISS-6403 Finding 1: a deadline expiry is NOT a migrate failure. The run is
    // still going — holding the serialize lock, possibly mid-DDL — so it is
    // reported with its own reason (and, at the route, its own status) rather
    // than as a `Failed` a caller might reasonably retry into a second migrate.
    if (isTimeoutError(error, ENSURE_PIPELINE_LABEL)) {
      // ISS-6837: the pipeline pushes its telemetry event from a `finally` this
      // run never reaches, so the flush below would drain an empty buffer — the
      // slowest runs, the ones this stream exists to show, emitting nothing.
      // Cut it here, BEFORE that flush, with whatever phase detail it had.
      const cutRuns = cutMigrateRunsAtDeadline(schema);
      log.error("[preview-schema-ensure] Deadline expired mid-migrate", {
        branch,
        schema,
        cutRuns,
      });
      return {
        ok: false,
        reason: EnsureFailureReason.TimedOut,
        // Through the sanitizer like every other message that leaves here. This
        // one is composed entirely in-repo and carries no CLI output, so it has
        // nothing to redact — but the invariant below is "nothing added to this
        // response skips it", and an exception is how that stops being true.
        message: sanitizeOperatorMessageFragment(
          `${parseError(error)}. The migration is STILL RUNNING and holds the serialize lock${
            opts.gateBudgetMs === undefined
              ? " — do not retry until it is known to have finished."
              : ". This request's gate fails closed, so a retry waits for that lock or is refused with nothing applied."
          }`
        ),
      };
    }

    if (isLockContention(error)) {
      return contendedResult(branch, schema, error);
    }

    // ISS-6403: a failed `prisma migrate resolve` embeds the CLI's raw stderr in
    // the message it throws, and this spawn's env carries an IAM-signed
    // DATABASE_URL — so the un-redacted text can carry credential material. The
    // response body is read out loud by the staging workflow into a GitHub
    // Actions log, which is far more widely readable than a Vercel log.
    //
    // PROTECTED SINK, precisely: this returned message, the CLI output beside
    // it, and the structured log line below. The pipeline's own
    // `process.stderr.write(result.stderr)` inside `runMigrateDeploy` still
    // writes the raw CLI output to the function's log — this is not a claim
    // that the raw text is gone, only that it stops crossing into the response.
    //
    // ISS-6558 WIDENED what crosses: the CLI's captured `stdout`/`stderr` used
    // to be dropped here, because `parseError` reads only `.message` and
    // `runMigrateDeploy` attaches those two as properties. An operator saw
    // `failed with exit code 1` and nothing else, so a P3009 and an unreachable
    // database were indistinguishable. They now ride along — which means text
    // Prisma wrote, rather than text this repo composed, reaches an Actions log.
    // `sanitizeOperatorCliOutput` is the whole of what makes that safe: it
    // redacts before it bounds, so a credential cannot survive by being sliced
    // in half. Nothing may be added to this response that skips it.
    //
    // WHAT IT REDACTS, exactly: credential-bearing connection URLs, IAM token
    // query fields, `PG*`/secret-suffixed env assignments, and — added after
    // review: whitlockk caught the regression — the database endpoint a P1000/
    // P1001/P1002/P1003 (or a nested libpq error) names in PROSE, which is not
    // a URL and so matched none of the original patterns. What it does NOT
    // redact, deliberately: the Prisma error code, the failing migration name,
    // and the database/role names Prisma quotes (`vercel_iam` is in source, and
    // this response already names the schema) — those are the diagnosis.
    return failedResult(branch, schema, error);
  } finally {
    // ISS-4392: the pipeline BUFFERS its migrate event in a module-level array
    // that only this flush drains to Datadog's intake — `migrate.ts` calls it in
    // its own `finally`, and it was the sole caller. Without it here the
    // `source:migrate` stream loses every run this route performs (the very
    // stream ISS-5983's at-head acceptance criterion is asserted from), and the
    // buffer grows for the life of a warm instance. Best-effort and
    // deadline-bounded by contract: it never throws and never hangs the caller.
    await flushMigrateTelemetry();
  }
}

/** What `runMigrationPipeline` resolves to, as the in-flight map stores it. */
type PipelineResult = Awaited<ReturnType<typeof runMigrationPipeline>>;

/** Label `withTimeout` stamps on the deadline error, and `isTimeoutError` reads back. */
const ENSURE_PIPELINE_LABEL = "preview schema ensure";

/**
 * Bounds the pipeline at `budgetMs`, or leaves it exactly as it was when the
 * caller supplies none (ISS-6403 Finding 1).
 *
 * Racing does NOT cancel the work — the spawned CLI and any in-flight query run
 * on until the instance is torn down, as they do today. What it buys is that
 * `ensureSchemaAtHead` reaches its own `catch` first, so a run that outlives the
 * function reports a typed failure instead of an opaque platform timeout.
 */
function runPipelineWithinBudget<T>(
  work: Promise<T>,
  budgetMs: number | undefined
): Promise<T> {
  if (budgetMs === undefined) {
    return work;
  }
  return withTimeout(work, budgetMs, ENSURE_PIPELINE_LABEL);
}

/**
 * Pipelines currently running on THIS instance, keyed by target schema.
 *
 * ISS-6403 Finding 1 (review). Bounded by construction: an entry is added only
 * around a live run and removed the moment that run settles, so the map holds
 * at most the migrations actually in flight on one warm instance.
 *
 * A genuinely WEDGED child therefore keeps its slot until the instance
 * recycles, and every later request for that schema joins it and reaches its
 * own deadline. That is the honest answer — a migrate really is stuck — and it
 * is strictly better than each request stacking another one on top of it.
 */
const inFlightPipelines = new Map<string, Promise<PipelineResult>>();

/** The pipeline's own representation of `public`, as a map key. */
const PUBLIC_SCHEMA_KEY = "public";

/**
 * Runs `start`, or joins the run already in flight for the same schema on this
 * instance.
 *
 * The cleanup is attached to the PIPELINE's promise, not to whatever a caller
 * ends up awaiting, so a caller giving up on its own deadline never releases
 * the slot while the migrate it abandoned is still holding the serialize lock.
 *
 * ISS-12056: a vibe environment request never joins a plain ensure (which
 * would not rebuild the schema), nor the reverse; the preview build lock
 * serializes the two across instances instead.
 */
function joinInFlightPipeline(
  schema: string | null,
  vibeEnvironment: VibeEnvironmentMode | undefined,
  start: () => Promise<PipelineResult>
): Promise<PipelineResult> {
  const key = `${schema ?? PUBLIC_SCHEMA_KEY}${vibeEnvironment === undefined ? "" : `:vibe:${vibeEnvironment}`}`;
  const existing = inFlightPipelines.get(key);
  if (existing) {
    log.info("[preview-schema-ensure] Joining an in-flight migrate", {
      schema,
    });
    return existing;
  }

  const attempt = start();
  inFlightPipelines.set(key, attempt);
  // Detached so this handler never counts as handling a caller's rejection, and
  // guarded so a newer attempt installed after this one settles is not evicted.
  attempt
    .catch(() => {
      // Settling is all this cares about; the caller owns the error.
    })
    .finally(() => {
      if (inFlightPipelines.get(key) === attempt) {
        inFlightPipelines.delete(key);
      }
    });
  return attempt;
}

/**
 * Test-only: drop every in-flight entry so one case's unsettled pipeline cannot
 * be joined by the next. Mirrors `resetMigrateTelemetryForTests`, and exists
 * for the same reason — this state is deliberately process-global in
 * production, which is exactly what makes it leak between cases.
 */
export function resetInFlightPipelinesForTests(): void {
  inFlightPipelines.clear();
}

/**
 * ISS-11781: the pipeline's own gate seam, bound to `gateBudgetMs` and failing
 * closed when that wait runs out. Telemetry still sees the outcome through the
 * forwarded opts.
 */
function failClosedGate(gateBudgetMs: number | undefined) {
  if (gateBudgetMs === undefined) {
    return {};
  }
  return {
    withMigrationSerializeLock: (
      gate: Parameters<typeof withMigrationSerializeLock>[0],
      fn: () => Promise<boolean>
    ) =>
      withMigrationSerializeLock(
        { ...gate, onContended: "skip-on-timeout", budgetMs: gateBudgetMs },
        fn
      ),
  };
}

/**
 * Another migrate held a lock this run needed, so it applied nothing: the
 * serialize gate's wait ran out (its `statement_timeout` cancel), or Prisma
 * timed out on its own advisory lock (P1002) after its retries. Never a
 * migration verdict. The gate refuses only on that timeout: one that failed for
 * any other reason — a refused connection, a bad credential — fails open and
 * the migrate runs (review: marisolashgrove). A P1002 from the deploy that
 * retried a migration resolved as rolled back is not contention: the deploy
 * before it failed mid-migration, so "nothing was applied" is not known
 * (review: whitlockk).
 */
function isLockContention(error: unknown): boolean {
  if (error instanceof SerializeLockContendedError) {
    return true;
  }
  return (
    isPrismaAdvisoryLockError(error) && rolledBackRetryFailureOf(error) === null
  );
}

function contendedResult(
  branch: string,
  schema: string | null,
  error: unknown
): EnsureSchemaResult {
  // Same sanitizers as the `Failed` path: a P1002 carries the CLI's output.
  const message = sanitizeOperatorMessageFragment(parseError(error));
  const cliOutput = sanitizeOperatorCliOutput(error);
  log.warn("[preview-schema-ensure] Migration lock not free within budget", {
    branch,
    schema,
    error: message,
  });
  return {
    ok: false,
    reason: EnsureFailureReason.Contended,
    message: `Could not migrate schema "${schema ?? PUBLIC_SCHEMA_LABEL}": the migration lock was not free within this request's budget, so nothing was applied and a retry is safe. ${message}${
      cliOutput ? `\n${cliOutput}` : ""
    }`,
  };
}

function failedResult(
  branch: string,
  schema: string | null,
  error: unknown
): EnsureSchemaResult {
  const message = sanitizeOperatorMessageFragment(parseError(error));
  const cliOutput = sanitizeOperatorCliOutput(error);
  const rolledBack = rolledBackRetryFailureOf(error);
  const cloneErrorCode = cloneFailureCodeOf(error);
  log.error("[preview-schema-ensure] Migration pipeline failed", {
    branch,
    schema,
    error: message,
    ...(cliOutput ? { cliOutput } : {}),
    ...(cloneErrorCode ? { cloneErrorCode } : {}),
    ...(rolledBack ? { rolledBackMigration: rolledBack.migrationName } : {}),
  });
  return {
    ok: false,
    reason: EnsureFailureReason.Failed,
    message: `Failed to ensure schema "${schema ?? PUBLIC_SCHEMA_LABEL}": ${message}${
      cliOutput ? `\n${cliOutput}` : ""
    }${rolledBack ? describeRolledBackRecovery(rolledBack) : ""}`,
  };
}

/** The failure that started a rolled-back recovery, which the retry's own error drops. */
function describeRolledBackRecovery(
  rolledBack: RolledBackRetryFailure
): string {
  const originalCliOutput = sanitizeOperatorCliOutput(rolledBack.originalError);
  const original = sanitizeOperatorMessageFragment(
    `This was the retry after migration "${rolledBack.migrationName}" failed and was resolved as rolled back, so that migration may have committed part of its DDL. Original failure: ${parseError(rolledBack.originalError)}`
  );
  return `\n${original}${originalCliOutput ? `\n${originalCliOutput}` : ""}`;
}

/** Omitted for every caller but the vibe environment route, as before. */
function vibeEnvironmentRequest(mode: VibeEnvironmentMode | undefined): {
  vibeEnvironment?: VibeEnvironmentMode;
} {
  return mode === undefined ? {} : { vibeEnvironment: mode };
}
