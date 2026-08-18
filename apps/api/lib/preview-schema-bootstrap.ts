import { normalizePreviewSchemaName } from "@repo/database/schema-utils";
import { deriveBranchSchemaName } from "@repo/database/scripts/cleanup-preview-schemas-lib";
import { log } from "@repo/observability/log";

/**
 * ISS-5984: the lazy, first-DB-request bootstrap of a preview schema.
 *
 * `ensureSchemaExists` is the ONLY place a preview schema is ever created, and
 * until now it ran only from the `@repo/database` prebuild. The runtime client
 * merely resolves the schema name and hands it to `PrismaPg`, so a preview whose
 * schema does not exist fails EVERY query. Turning the build-time migrate off
 * (ISS-5985) without this leaves every new branch with no schema at all.
 *
 * This gate is installed into `@repo/database` as a bootstrap hook by
 * `apps/api/instrumentation.node.ts`, so it runs inside `getDatabase()` —
 * strictly before the first Prisma client (and therefore the first query) of a
 * cold instance, and NOT at all for a request that never touches the database.
 *
 * ## Why the memo is per-instance and best-effort
 *
 * `apps/api/AGENTS.md` forbids relying on process-local state for CORRECTNESS.
 * This memo is an optimization only: `runMigrationPipeline` is idempotent (the
 * FEA-3071 at-head probe makes a repeat run a no-op), so a lost memo costs one
 * extra probe, never a wrong result. What the memo does buy is that a burst of
 * concurrent first requests on one instance runs ONE bootstrap rather than N
 * concurrent `prisma migrate deploy` spawns against the same schema.
 *
 * A FAILED bootstrap clears the memo. A poisoned memo would leave the instance
 * permanently unable to bootstrap even once the transient cause cleared, and a
 * preview whose schema never appears is indistinguishable from a broken deploy.
 *
 * ## Closed by default, on two independent conditions
 *
 * `VERCEL_ENV === "preview"` AND an explicit truthy `PREVIEW_SCHEMA_BOOTSTRAP`
 * token. Polarity is opt-IN (the inverse of `isBuildMigrateEnabled`'s
 * kill-switch polarity, and the same as `isPreviewMigratorEnabled`): this adds
 * behavior that does not ship today, so unset, empty, a typo, or a value some
 * future tool injects all leave it OFF.
 */

/** Named once so the predicate and the log line cannot drift apart. */
const PREVIEW_SCHEMA_BOOTSTRAP_VAR = "PREVIEW_SCHEMA_BOOTSTRAP";

/** Explicit truthy tokens that enable the bootstrap. Anything else leaves it off. */
const PREVIEW_SCHEMA_BOOTSTRAP_ENABLED_VALUES = new Set([
  "1",
  "true",
  "yes",
  "on",
]);

/** The only `VERCEL_ENV` this may ever run in. */
const PREVIEW_VERCEL_ENV = "preview";

/**
 * The in-flight/completed bootstrap for this instance. `null` means "not
 * attempted, or the last attempt failed" — both of which must re-run.
 */
let bootstrapAttempt: Promise<void> | null = null;

/**
 * Both gates, in one predicate, so no call site can check only one of them.
 * Defaults OFF: an unset token is not enabled, whatever `VERCEL_ENV` says.
 */
export function isPreviewSchemaBootstrapEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (env.VERCEL_ENV !== PREVIEW_VERCEL_ENV) {
    return false;
  }
  const raw = env[PREVIEW_SCHEMA_BOOTSTRAP_VAR];
  return (
    raw !== undefined &&
    PREVIEW_SCHEMA_BOOTSTRAP_ENABLED_VALUES.has(raw.trim().toLowerCase())
  );
}

/**
 * Brings this preview deployment's own schema to migration head, at most once
 * per instance. Resolves immediately (and does no I/O) when either gate is
 * closed, which is the deployed default everywhere.
 *
 * Rejects when the bootstrap fails, so the caller's query fails with the real
 * cause rather than the opaque `relation does not exist` that a missing schema
 * would produce three frames later.
 */
export function ensurePreviewSchemaBootstrap(
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  if (!isPreviewSchemaBootstrapEnabled(env)) {
    return Promise.resolve();
  }

  const branch = env.VERCEL_GIT_COMMIT_REF;
  if (!branch) {
    // Vercel always sets this on a preview deploy. Absent, the schema name is
    // underivable — and `resolveSchemaName` has already fallen back to `public`
    // for the runtime pool, so there is nothing preview-shaped to bootstrap.
    log.warn("[preview-schema-bootstrap] No VERCEL_GIT_COMMIT_REF; skipping");
    return Promise.resolve();
  }

  if (bootstrapAttempt) {
    return bootstrapAttempt;
  }

  const attempt = runBootstrap(branch);
  bootstrapAttempt = attempt;
  // Clear the memo on failure, WITHOUT clobbering a newer attempt that a later
  // request may already have installed. Registered on a detached branch so this
  // handler never counts as handling the caller's rejection.
  attempt.catch(() => {
    if (bootstrapAttempt === attempt) {
      bootstrapAttempt = null;
    }
  });
  return attempt;
}

/**
 * The one bootstrap run. Imports the ensure service DYNAMICALLY: that module
 * pulls `runMigrationPipeline` and the Prisma runtime layout probe, and this
 * module is imported by `instrumentation.node.ts` — i.e. by every function in
 * the app. A static import would trace that weight into all of them, when only
 * a flag-on preview ever executes it.
 */
async function runBootstrap(branch: string): Promise<void> {
  const schema = deriveBranchSchemaName(branch, normalizePreviewSchemaName);
  log.info("[preview-schema-bootstrap] Bootstrapping preview schema", {
    branch,
    schema,
  });

  const { ensureSchemaAtHead } = await import(
    "@/app/preview-schemas/ensure/service"
  );
  const result = await ensureSchemaAtHead(branch, schema);

  if (!result.ok) {
    throw new Error(
      `Preview schema bootstrap failed for "${schema}": ${result.message}`
    );
  }

  log.info("[preview-schema-bootstrap] Preview schema is at head", {
    branch,
    schema,
    invalidIndexes: result.invalidIndexes,
  });
}
