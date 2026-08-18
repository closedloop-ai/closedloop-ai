/**
 * FEA-3071 Slice 2 — the merge-triggered preview-schema migrator (the P1002
 * storm fix).
 *
 * WHY: when a migration lands on `main`, the single stage `public` deploy AND
 * every rebased `preview_*` deploy all migrate the shared stage RDS at once. Past
 * ~10 stacked migrates the FEA-3065 serialize gate fails open and the losers
 * collide on Prisma's per-DB advisory lock (72707369) → P1002. Slice 1's at-head
 * probe only helps a preview that is ALREADY at head; right after a migration
 * every preview is behind, so they still storm.
 *
 * THIS module walks every preview schema serially (effective concurrency 1) and
 * brings each to head, so that by the time a human redeploys their preview the
 * Slice-1 probe finds it at head and skips the lock entirely. It runs on the ONE
 * non-fanned-out deploy that already fires on every merge to main — the stage
 * `public` `migrate.ts` prebuild (see migrate.ts) — AFTER `public` is migrated.
 *
 * SAFETY (per the Codex review of PLN-1509):
 *  - **Fails CLOSED** on gate contention (`serializeMode: "skip"`): a catch-up is
 *    non-urgent, and running a migrate unguarded would make the walk itself a
 *    source of 72707369 contention. A schema it can't serialize is left to
 *    self-heal on its own next deploy. (User deploys keep fail-open.)
 *  - **Never refreshes the registry** (`last_seen_at`): the per-schema apply skips
 *    `upsertSchemaRegistry`, AND injects a no-op recovery upsert so a reset during
 *    the walk doesn't refresh TTL either — otherwise the 7-day reaper would never
 *    reap. The walk is maintenance, not user activity.
 *  - **Best-effort**: every per-schema failure is caught and counted; the walk
 *    never throws, so it can never fail the `public` deploy that hosts it.
 *  - **Admission-deadline bounded**: stops admitting new schemas after `budgetMs`
 *    wall-clock, most-recently-seen first (likeliest to redeploy soon); the
 *    remaining deadline is threaded into each schema's serialize-lock wait so no
 *    schema blocks on the lock past the deadline. (Residual: one in-flight migrate
 *    subprocess can finish past it — retry-bounded, seconds.)
 *  - **Seed on reset only**: a reset wipes the schema, so it re-seeds to match a
 *    real deploy; the common no-reset catch-up skips the redundant seed.
 *
 * DI-able: enumerate / sign / apply / seed / clock are all injected so the walk
 * is unit-testable without a database, an IAM signer, or a prisma subprocess.
 */

import { normalizeExplicitSchemaName } from "../schema-utils";
import { createSqlClient, endQuietly, type SqlClient } from "./db-utils";
import { SerializeLockContendedError } from "./migration-lock";
import {
  applyMigrationsToSchema,
  type MigrationPipelineDeps,
  runMigrateWithRetry,
} from "./migration-pipeline";
import { isPreviewSchema } from "./preview-schema";
import { runPreviewSeed } from "./preview-seed";

/** Default wall-clock budget for the whole walk. One-line tunable via env. */
export const DEFAULT_PREVIEW_MIGRATOR_BUDGET_MS = 180_000;

/**
 * Enumerate preview schemas from the catalog, recency-ordered. `pg_namespace`
 * (the API service's source of truth) is joined to the `preview_schemas` registry
 * LEFT (never INNER — an unregistered schema must still be walked) so the ordering
 * favors the most-recently-seen schemas without dropping any. `_` is a SQL LIKE
 * wildcard, so the literal `preview_` prefix is matched with an explicit ESCAPE.
 */
const ENUM_SQL_WITH_REGISTRY = String.raw`
  SELECT n.nspname AS schema_name, r.branch AS branch
  FROM pg_namespace n
  LEFT JOIN preview_schemas r ON r.schema_name = n.nspname
  WHERE n.nspname LIKE 'preview\_%' ESCAPE '\'
  ORDER BY r.last_seen_at DESC NULLS LAST, n.nspname
`;

/** Fallback when the `preview_schemas` registry table does not exist (42P01). */
const ENUM_SQL_PLAIN = String.raw`
  SELECT nspname AS schema_name
  FROM pg_namespace
  WHERE nspname LIKE 'preview\_%' ESCAPE '\'
  ORDER BY nspname
`;

const UNDEFINED_TABLE_SQLSTATE = "42P01";

type MigratorLogger = {
  log: (message: string) => void;
  warn: (message: string) => void;
};

export type MigratePreviewsSummary = {
  discovered: number;
  /** Brought to head (or already at head) without error. */
  succeeded: number;
  /** Skipped because the serialize gate was contended (fail-closed). */
  skippedContended: number;
  /** Not attempted because the wall-clock budget was exhausted first. */
  skippedBudget: number;
  /** Failed with a non-contention error (logged, best-effort continue). */
  failed: number;
};

/**
 * One enumerated preview schema plus the registry branch that last deployed it
 * (undefined when unregistered or on the plain catalog fallback). Carrying the
 * branch lets a walk-triggered reset of a `gh-readonly-queue/*` schema skip the
 * data clone exactly like the build-time deploy does (ISS-5285).
 */
export type PreviewSchemaEntry = {
  schemaName: string;
  branch: string | undefined;
};

export type MigrateAllPreviewsDeps = {
  /** Lists preview schemas + registry branch, recency-ordered. Defaults to the catalog query. */
  enumeratePreviewSchemas?: (
    baseDatabaseUrl: string
  ) => Promise<PreviewSchemaEntry[]>;
  /**
   * Brings ONE preview schema to head and reports whether it was reset and
   * whether a post-reset clone failed. Defaults to the shared pipeline core
   * bound to fail-closed + a no-op recovery upsert. `remainingBudgetMs` is the
   * walk's remaining admission deadline, threaded into the serialize-lock wait
   * so no single schema can block on the lock past the deadline.
   * `refreshDatabaseUrl` re-signs the schema's IAM URL for post-clone steps
   * (ISS-5285 token expiry); `branch` is the registry branch (queue refs skip
   * the post-reset clone, ISS-5285).
   */
  applyToSchema?: (
    databaseUrl: string,
    schema: string,
    remainingBudgetMs: number,
    refreshDatabaseUrl: () => Promise<string>,
    branch: string | undefined
  ) => Promise<{ didReset: boolean; cloneFailed: boolean }>;
  /** Re-seeds a schema after a reset. Defaults to the real preview seed. */
  runPreviewSeed?: (databaseUrl: string, schema: string) => void;
  /** Injected clock (ms). Defaults to `Date.now`. */
  now?: () => number;
  budgetMs?: number;
  logger?: MigratorLogger;
};

function extractSqlstate(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * A catalog name is walkable only if it is a preview schema AND already in the
 * canonical form the pipeline creates (`normalizeExplicitSchemaName` is a
 * fixed-point). This guards two things:
 *  - the SQL LIKE `_` wildcard (a `previewXfoo` match) — `isPreviewSchema` catches it;
 *  - a NON-canonical valid identifier like `preview_foo-bar` (review: wongk). The
 *    seed path passes the name via `PGSCHEMA`, which `resolveSchemaName` normalizes
 *    (`preview_foo-bar` -> `preview_foo_bar`); if the canonical twin also exists the
 *    seed would write into the WRONG schema. We only ever created canonical names,
 *    so a non-canonical catalog entry is anomalous — skip it rather than risk the
 *    cross-schema seed write.
 */
function isWalkableSchemaName(name: string): boolean {
  return isPreviewSchema(name) && normalizeExplicitSchemaName(name) === name;
}

async function readSchemaRows(
  databaseUrl: string,
  sql: string,
  createClient: (databaseUrl: string) => SqlClient
): Promise<PreviewSchemaEntry[]> {
  const client = createClient(databaseUrl);
  try {
    await client.connect();
    const result = (await client.query(sql)) as { rows?: unknown };
    const rows = Array.isArray(result?.rows) ? result.rows : [];
    const entries: PreviewSchemaEntry[] = [];
    for (const row of rows) {
      const name = (row as { schema_name?: unknown }).schema_name;
      if (typeof name === "string" && isWalkableSchemaName(name)) {
        const branch = (row as { branch?: unknown }).branch;
        entries.push({
          schemaName: name,
          branch: typeof branch === "string" ? branch : undefined,
        });
      }
    }
    return entries;
  } finally {
    await endQuietly(client);
  }
}

/**
 * Default enumeration: try the recency-ordered registry join; if the registry
 * table is missing (42P01), fall back to a plain name-ordered catalog scan.
 */
export async function defaultEnumeratePreviewSchemas(
  baseDatabaseUrl: string,
  createClient: (databaseUrl: string) => SqlClient = createSqlClient
): Promise<PreviewSchemaEntry[]> {
  try {
    return await readSchemaRows(
      baseDatabaseUrl,
      ENUM_SQL_WITH_REGISTRY,
      createClient
    );
  } catch (error) {
    if (extractSqlstate(error) === UNDEFINED_TABLE_SQLSTATE) {
      return readSchemaRows(baseDatabaseUrl, ENUM_SQL_PLAIN, createClient);
    }
    throw error;
  }
}

/** No-op registry upsert: the walk must never refresh `last_seen_at` (TTL reaper). */
function noopRecoveryUpsert(): Promise<void> {
  return Promise.resolve();
}

/**
 * Default per-schema apply: the shared pipeline core, bound to fail-closed
 * (`serializeMode: "skip"`) and a no-op recovery upsert so the walk neither
 * migrates unguarded nor refreshes the schema's TTL. `remainingBudgetMs` bounds
 * the serialize-lock wait so a schema can't block on the lock past the walk's
 * admission deadline. `refreshDatabaseUrl` re-signs the schema's IAM URL so the
 * post-clone index build never runs on an expired token (ISS-5285). `branch` is
 * the registry branch, threaded into the pipeline so a walk-triggered reset of
 * a `gh-readonly-queue/*` schema skips the data clone (ISS-5285). Exported for
 * tests; `overrides` is injectable like `defaultEnumeratePreviewSchemas`'s
 * `createClient` (production passes none).
 */
export function defaultApplyToSchema(
  databaseUrl: string,
  schema: string,
  remainingBudgetMs: number,
  refreshDatabaseUrl: () => Promise<string>,
  branch: string | undefined,
  overrides: Partial<MigrationPipelineDeps> = {}
): Promise<{ didReset: boolean; cloneFailed: boolean }> {
  return applyMigrationsToSchema(
    databaseUrl,
    schema,
    branch,
    {
      isNew: false,
      serializeMode: "skip",
      serializeBudgetMs: Math.max(1, remainingBudgetMs),
    },
    {
      runMigrate: (url, migrateSchema, migrateBranch, hooks, cli) =>
        runMigrateWithRetry(
          url,
          migrateSchema,
          migrateBranch,
          noopRecoveryUpsert,
          hooks,
          cli
        ),
      // ISS-5285: the walk signs ONCE per schema, before this apply. A reset
      // here runs a full data clone, which can outlive the 15-minute IAM token
      // just as the direct pipeline can — so the post-clone index build gets a
      // freshly-signed URL too (review: wongk).
      refreshDatabaseUrl,
      ...overrides,
    }
  );
}

/**
 * Walks every preview schema serially and brings each to head. `signDatabaseUrl`
 * mints a fresh IAM-authenticated URL for a schema (the caller owns signing so a
 * single `Signer` is reused and re-signed per schema, staying under the 15-min
 * token window). Returns a summary; never throws.
 */
export async function migrateAllPreviewSchemas(
  baseDatabaseUrl: string,
  signDatabaseUrl: (schema: string) => Promise<string>,
  deps: MigrateAllPreviewsDeps = {}
): Promise<MigratePreviewsSummary> {
  const logger = deps.logger ?? console;
  const enumerate =
    deps.enumeratePreviewSchemas ?? defaultEnumeratePreviewSchemas;
  const applyToSchema = deps.applyToSchema ?? defaultApplyToSchema;
  const seed = deps.runPreviewSeed ?? runPreviewSeed;
  const now = deps.now ?? Date.now;
  const budgetMs = deps.budgetMs ?? DEFAULT_PREVIEW_MIGRATOR_BUDGET_MS;

  const summary: MigratePreviewsSummary = {
    discovered: 0,
    succeeded: 0,
    skippedContended: 0,
    skippedBudget: 0,
    failed: 0,
  };

  let schemas: PreviewSchemaEntry[];
  try {
    schemas = await enumerate(baseDatabaseUrl);
  } catch (error) {
    logger.warn(
      `⚠️ Preview migrator: enumeration failed (skipping walk): ${describe(error)}`
    );
    return summary;
  }

  summary.discovered = schemas.length;
  if (schemas.length === 0) {
    logger.log("↪ Preview migrator: no preview schemas to walk.");
    return summary;
  }
  logger.log(
    `↪ Preview migrator: walking ${schemas.length} preview schema(s) (admission deadline ${budgetMs}ms)...`
  );

  const start = now();
  for (let i = 0; i < schemas.length; i++) {
    const { schemaName: schema, branch } = schemas[i];
    // Admission deadline: the remaining budget is threaded into each schema's
    // serialize-lock wait (below), so no schema can block on the lock past the
    // deadline. Residual: one in-flight `prisma migrate deploy` subprocess can
    // still run to completion past the deadline (bounded by the FEA-3062 retry,
    // seconds in practice) — this is admission control, not a hard kill.
    const remainingBudgetMs = budgetMs - (now() - start);
    if (remainingBudgetMs <= 0) {
      summary.skippedBudget = schemas.length - i;
      logger.warn(
        `⚠️ Preview migrator: admission deadline reached, ${summary.skippedBudget} schema(s) left for self-heal.`
      );
      break;
    }

    const outcome = await migrateOneSchema(schema, branch, remainingBudgetMs, {
      signDatabaseUrl,
      applyToSchema,
      seed,
      logger,
    });
    if (outcome === "succeeded") {
      summary.succeeded++;
    } else if (outcome === "contended") {
      summary.skippedContended++;
    } else {
      summary.failed++;
    }
  }

  logger.log(
    `↪ Preview migrator done: ${summary.succeeded} ok, ${summary.skippedContended} contended, ${summary.skippedBudget} over-budget, ${summary.failed} failed (of ${summary.discovered}).`
  );
  return summary;
}

type SchemaOutcome = "succeeded" | "contended" | "failed";

type MigrateOneSchemaDeps = {
  signDatabaseUrl: (schema: string) => Promise<string>;
  applyToSchema: (
    databaseUrl: string,
    schema: string,
    remainingBudgetMs: number,
    refreshDatabaseUrl: () => Promise<string>,
    branch: string | undefined
  ) => Promise<{ didReset: boolean; cloneFailed: boolean }>;
  seed: (databaseUrl: string, schema: string) => void;
  logger: MigratorLogger;
};

/**
 * Signs, applies, and (on reset) re-seeds ONE schema, classifying the result.
 * Never throws — every failure is logged and mapped to an outcome so the walk
 * loop can tally it and continue best-effort.
 */
async function migrateOneSchema(
  schema: string,
  branch: string | undefined,
  remainingBudgetMs: number,
  deps: MigrateOneSchemaDeps
): Promise<SchemaOutcome> {
  let url: string;
  try {
    url = await deps.signDatabaseUrl(schema);
  } catch (error) {
    deps.logger.warn(
      `⚠️ Preview migrator: could not sign URL for ${schema} (skipping): ${describe(error)}`
    );
    return "failed";
  }

  // Re-signs THIS schema's URL on demand. `signDatabaseUrl` reuses the caller's
  // single `Signer`, so this is a fresh token, not a fresh AWS round-trip.
  const refreshDatabaseUrl = () => deps.signDatabaseUrl(schema);

  try {
    const { didReset, cloneFailed } = await deps.applyToSchema(
      url,
      schema,
      remainingBudgetMs,
      refreshDatabaseUrl,
      branch
    );
    // A reset whose data clone failed leaves the schema at migration head but
    // data-empty/partial; because the at-head probe is migration-state only it
    // would be skipped forever after. Surface it as `failed` (visible for triage
    // / a real redeploy re-clone) rather than silently counting it succeeded
    // (review: wongk).
    if (didReset && cloneFailed) {
      deps.logger.warn(
        `⚠️ Preview migrator: ${schema} reset but data clone failed — left for redeploy re-clone (not counted succeeded).`
      );
      return "failed";
    }
    if (didReset) {
      // ISS-5285: `url` was signed before the apply, and a reset's data clone
      // can have burned most of the token's 15 minutes. The seed spawns a
      // subprocess that opens its own connection, so re-sign first; fall back to
      // the original URL rather than skipping the seed (review: wongk).
      const seedUrl = await refreshDatabaseUrl().catch((error) => {
        deps.logger.warn(
          `⚠️ Preview migrator: could not re-sign URL for ${schema} seed, reusing the existing one: ${describe(error)}`
        );
        return url;
      });
      deps.seed(seedUrl, schema);
    }
    return "succeeded";
  } catch (error) {
    if (error instanceof SerializeLockContendedError) {
      deps.logger.warn(
        `⚠️ Preview migrator: serialize gate contended for ${schema}, skipping (self-heals on next deploy).`
      );
      return "contended";
    }
    deps.logger.warn(
      `⚠️ Preview migrator: ${schema} migrate failed (non-blocking): ${describe(error)}`
    );
    return "failed";
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reads the walk budget from env, falling back to the default. */
export function resolvePreviewMigratorBudgetMs(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = env.PREVIEW_MIGRATOR_BUDGET_MS;
  if (raw === undefined) {
    return DEFAULT_PREVIEW_MIGRATOR_BUDGET_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_PREVIEW_MIGRATOR_BUDGET_MS;
}

/** Builds the walk deps that read from env (budget). Sign/enumerate/apply keep their defaults. */
export function buildPreviewMigratorDeps(
  env: NodeJS.ProcessEnv = process.env
): MigrateAllPreviewsDeps {
  return { budgetMs: resolvePreviewMigratorBudgetMs(env) };
}

/** Explicit truthy tokens for the kill-switch (unset / anything else = disabled). */
const PREVIEW_MIGRATOR_ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);

/**
 * The kill-switch is OFF unless `PREVIEW_MIGRATOR_ENABLED` is an explicit truthy
 * token. A bare `if (process.env.PREVIEW_MIGRATOR_ENABLED)` is wrong — the string
 * `"false"` (or `"0"`) is truthy and would ENABLE the walk (review: wongk). Unset,
 * empty, `"false"`, `"0"`, and any other value all resolve to disabled.
 */
export function isPreviewMigratorEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const raw = env.PREVIEW_MIGRATOR_ENABLED;
  return (
    raw !== undefined &&
    PREVIEW_MIGRATOR_ENABLED_VALUES.has(raw.trim().toLowerCase())
  );
}
