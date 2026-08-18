import { validateHost } from "@repo/database/scripts/cleanup-preview-schemas-lib";
import {
  createSchemaUrlMinter,
  readIamAuthConfig,
} from "@repo/database/scripts/iam-database-url";
import {
  sanitizeOperatorCliOutput,
  sanitizeOperatorMessageFragment,
} from "@repo/database/scripts/migrate-deploy-recovery";
import { flushMigrateTelemetry } from "@repo/database/scripts/migrate-telemetry";
import { runMigrationPipeline } from "@repo/database/scripts/migration-pipeline";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
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
 * (ISS-6403, review: wongk). The detail goes to `log.error` instead.
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
    }
  | { ok: false; reason: EnsureFailureReason; message: string };

type SchemaUrls = {
  databaseUrl: string;
  refreshDatabaseUrl?: () => Promise<string>;
};

/**
 * Mints the connection URL for `schema` by signing an RDS IAM token.
 *
 * IAM ONLY, deliberately — the build migrate's `DATABASE_URL` fallback does NOT
 * come along. `DATABASE_URL` is also what `@repo/database` uses for this app's
 * own runtime pool, so honoring it here would run `migrate deploy` over the
 * application's connection: the wrong role (the exact 42501 partial-DDL wedge
 * ISS-5952's ownership preflight exists for), and — because `addSchemaToUrl`
 * leaves an existing `?schema=` alone — potentially the wrong SCHEMA, while the
 * response still names the branch's preview schema. A build script running once
 * per controlled deploy can carry that precedence; an on-demand endpoint cannot.
 *
 * The returned minter is also the ISS-5285 `refreshDatabaseUrl` seam, which
 * re-signs after the (unbounded) clone.
 */
async function mintSchemaUrls(
  schema: string | null
): Promise<SchemaUrls | null> {
  const iamAuthConfig = readIamAuthConfig(process.env);
  if (!iamAuthConfig) {
    return null;
  }

  const mintSchemaUrl = createSchemaUrlMinter(iamAuthConfig);
  return {
    databaseUrl: await mintSchemaUrl(schema),
    refreshDatabaseUrl: () => mintSchemaUrl(schema),
  };
}

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
  schema: string | null
): Promise<EnsureSchemaResult> {
  // THE host invariant, and it lives HERE rather than on the HTTP route so
  // every caller inherits it (ISS-6403, review: shafty023). The route was the
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
      message:
        "RDS IAM credentials are not configured: AWS_ROLE_ARN, AWS_REGION, PGHOST, PGUSER and PGDATABASE are all required",
    };
  }

  log.info("[preview-schema-ensure] Ensuring preview schema at head", {
    branch,
    schema,
    schemaEngineBinary: layoutResult.layout.schemaEngineBinary,
  });

  try {
    const { invalidIndexes } = await runMigrationPipeline(
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
      }
    );

    return {
      ok: true,
      branch,
      schema,
      invalidIndexes:
        invalidIndexes?.map((invalidIndex) => invalidIndex.name) ?? null,
      schemaEngineBinary: layoutResult.layout.schemaEngineBinary,
    };
  } catch (error) {
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
    // review: wongk caught the regression — the database endpoint a P1000/
    // P1001/P1002/P1003 (or a nested libpq error) names in PROSE, which is not
    // a URL and so matched none of the original patterns. What it does NOT
    // redact, deliberately: the Prisma error code, the failing migration name,
    // and the database/role names Prisma quotes (`vercel_iam` is in source, and
    // this response already names the schema) — those are the diagnosis.
    const message = sanitizeOperatorMessageFragment(parseError(error));
    const cliOutput = sanitizeOperatorCliOutput(error);
    log.error("[preview-schema-ensure] Migration pipeline failed", {
      branch,
      schema,
      error: message,
      ...(cliOutput ? { cliOutput } : {}),
    });
    return {
      ok: false,
      reason: EnsureFailureReason.Failed,
      message: `Failed to ensure schema "${schema ?? PUBLIC_SCHEMA_LABEL}": ${message}${
        cliOutput ? `\n${cliOutput}` : ""
      }`,
    };
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
