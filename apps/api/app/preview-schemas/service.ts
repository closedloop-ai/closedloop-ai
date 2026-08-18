import { Prisma, withDb } from "@repo/database";
import { normalizePreviewSchemaName } from "@repo/database/schema-utils";
import type {
  CategoryCounters,
  CounterBucket,
  SchemaCategory,
} from "@repo/database/scripts/cleanup-preview-schemas-lib";
import {
  buildSummary,
  categorizeSchema,
  computeExitCode,
  deriveBranchSchemaName,
  isMergeQueuePreview,
  isOrphanGraceElapsed,
  makeCounters,
} from "@repo/database/scripts/cleanup-preview-schemas-lib";
import { listAllBranchNames } from "@repo/github";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { getPrismaRawQuerySqlState } from "@/lib/db-utils";
import { PreviewSchemaSourceRepo } from "./constants";
import type { DropBudget } from "./service/drop-budget";
import {
  createDropBudget,
  deferDropIfExhausted,
  getSweepBudgetMs,
} from "./service/drop-budget";
import { getQueueTtlDays, getQueueTtlHours } from "./service/queue-ttl";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SchemaDecision = {
  schemaName: string;
  category: SchemaCategory;
  branch: string | null;
  isQueuePreview: boolean;
  /**
   * `last_seen_at` as classification saw it, or `null` when the schema had no
   * registry row. Carried to the DROP so it can re-verify nothing re-registered
   * the schema in between (see {@link isStillDroppable}).
   */
  lastSeenAt: Date | null;
};

/**
 * SQLSTATEs Postgres raises when it declines to wait for a lock or cancels a
 * statement that outran its timeout.
 */
const DropContentionSqlState = {
  LockNotAvailable: "55P03",
  QueryCanceled: "57014",
} as const;

/**
 * How long a DROP may wait for its ACCESS EXCLUSIVE lock before Postgres gives
 * up. Comfortably shorter than the sweep's headroom under `maxDuration`, so a
 * schema pinned by a live build costs a bounded pause instead of the function.
 */
const DROP_LOCK_TIMEOUT_MS = 5000;
/** Ceiling on the DROP itself once it holds the lock. */
const DROP_STATEMENT_TIMEOUT_MS = 30_000;
/** Interactive-transaction ceiling, above both statement budgets. */
const DROP_TX_TIMEOUT_MS = 40_000;

export type SweepResult = {
  summary: string;
  counters: CategoryCounters;
  exitCode: 0 | 1;
};

export type DropResult = {
  schemaName: string;
  dropped: boolean;
  alreadyGone: boolean;
  error: string | null;
};

export type DryRunResult = {
  summary: string;
  wouldDropStale: string[];
  wouldDropOrphaned: string[];
  wouldDropOrphanBranch: string[];
  wouldKeepInGrace: string[];
  /**
   * Orphan-branch candidates the mass-drop cap withheld. Reported separately
   * from `keptActive` so a dry-run cannot show an empty orphan-branch set when
   * the real reason is that the safety cap refused the whole pass.
   */
  withheldByMassDropCap: string[];
  keptActive: string[];
  counters: CategoryCounters;
};

// ---------------------------------------------------------------------------
// Registry helpers
// ---------------------------------------------------------------------------

/**
 * Reads `public.preview_schemas` for a given schema name.
 *
 * Returns `{ registryRow, registryTableMissing }` for use with
 * `categorizeSchema()`. SQLSTATE 42P01 (undefined_table) indicates the
 * registry table has never been created — all schemas are treated as orphaned
 * in that edge case. Any other error is rethrown so the caller can skip the
 * schema rather than misclassify it.
 *
 * The `branch` column is included so the branch-aware pass can cross-reference
 * against live GitHub branches without a second query.
 */
async function readRegistryRow(schemaName: string): Promise<{
  registryRow: { lastSeenAt: Date; branch: string | null } | null;
  registryTableMissing: boolean;
}> {
  try {
    const rows = await withDb((db) =>
      db.$queryRaw<{ last_seen_at: string; branch: string | null }[]>(
        Prisma.sql`
          SELECT last_seen_at, branch
          FROM public.preview_schemas
          WHERE schema_name = ${schemaName}
          ORDER BY last_seen_at DESC
          LIMIT 1
        `
      )
    );

    if (rows.length === 0) {
      return { registryRow: null, registryTableMissing: false };
    }

    return {
      registryRow: {
        lastSeenAt: new Date(rows[0].last_seen_at),
        branch: rows[0].branch ?? null,
      },
      registryTableMissing: false,
    };
  } catch (err) {
    // SQLSTATE 42P01 = undefined_table
    if ((err as { code?: string }).code === "42P01") {
      return { registryRow: null, registryTableMissing: true };
    }
    throw err;
  }
}

/**
 * Lists all schemas in `pg_namespace` whose names start with `preview_`.
 */
async function listPreviewSchemas(): Promise<string[]> {
  const rows = await withDb((db) =>
    db.$queryRaw<{ nspname: string }[]>(Prisma.sql`
      SELECT nspname
      FROM pg_namespace
      WHERE nspname LIKE 'preview_%'
      ORDER BY nspname
    `)
  );
  return rows.map((r) => r.nspname);
}

/**
 * Executes `DROP SCHEMA IF EXISTS <name> CASCADE` for a single schema name.
 *
 * The schema name must start with `preview_` — this guard is enforced before
 * calling this helper by `dropSchemaForBranch` and the sweep loop.
 *
 * `$executeRawUnsafe` is required because the schema identifier is dynamic and
 * cannot be parameterized with `Prisma.sql` (identifiers are not values).
 * The `preview_` prefix guard provides the safety boundary.
 */
async function executeDrop(schemaName: string): Promise<void> {
  // Double-check: never drop a non-preview schema
  if (!schemaName.startsWith("preview_")) {
    throw new Error(
      `Safety guard: refusing to drop non-preview schema "${schemaName}"`
    );
  }
  // Run inside a transaction so `SET LOCAL` pins to the same connection as the
  // DROP — `withDb` alone borrows a pooled connection per query, so a session
  // GUC set there would not reliably apply. `DROP SCHEMA … CASCADE` takes an
  // ACCESS EXCLUSIVE lock and would otherwise wait indefinitely behind a live
  // preview build's connection, carrying the function past `maxDuration`
  // regardless of the sweep's own budget (PR #4499 review).
  await withDb.tx(
    async (tx) => {
      await tx.$executeRawUnsafe(
        `SET LOCAL lock_timeout = '${DROP_LOCK_TIMEOUT_MS}ms'`
      );
      await tx.$executeRawUnsafe(
        `SET LOCAL statement_timeout = '${DROP_STATEMENT_TIMEOUT_MS}ms'`
      );
      await tx.$executeRawUnsafe(
        `DROP SCHEMA IF EXISTS "${schemaName.replace(/"/g, '""')}" CASCADE`
      );
    },
    { timeout: DROP_TX_TIMEOUT_MS }
  );
}

/**
 * Whether a drop failure is Postgres declining to wait, rather than a real
 * error: SQLSTATE 55P03 (`lock_not_available`, our `lock_timeout`) or 57014
 * (`query_canceled`, our `statement_timeout`).
 *
 * Both mean the schema was busy — almost certainly an in-flight preview build
 * holding a connection to it — which is precisely a schema we must not drop.
 * Skipping is the correct outcome, so these are counted as kept rather than
 * errored: routing them to `errored` would page on the sweep behaving exactly
 * as intended.
 *
 * The SQLSTATE is read via `getPrismaRawQuerySqlState`, not `error.code`: for a
 * raw query Prisma sets `code` to its own `P2010` and puts the driver SQLSTATE
 * in `meta.code`, so matching on `code` alone would never fire and quietly turn
 * this whole branch into dead code.
 */
function isDropContentionError(err: unknown): boolean {
  const sqlState = getPrismaRawQuerySqlState(err);
  return (
    sqlState === DropContentionSqlState.LockNotAvailable ||
    sqlState === DropContentionSqlState.QueryCanceled
  );
}

/**
 * Re-checks the registry immediately before a DROP and reports whether the
 * schema is still safe to remove.
 *
 * Classification and the DROP are separated by the rest of the sweep — with a
 * large backlog, minutes. In that window an ejected merge group can be
 * requeued under the byte-identical branch name, which maps to the SAME schema:
 * `upsertSchemaRegistry` refreshes `last_seen_at` and the migration pipeline
 * starts writing to it. Dropping on the stale decision would delete a schema
 * out from under a live build (PR #4499 review).
 *
 * `observedLastSeenAt` is what classification saw — `null` for an orphan (no
 * registry row at all). The schema is still droppable only if that has not
 * changed: an orphan must still have no row, and a TTL-expired schema must not
 * have a newer `last_seen_at`.
 *
 * Fails CLOSED: a registry-read error returns `false`, so an unverifiable
 * schema is skipped rather than dropped.
 */
async function isStillDroppable(
  schemaName: string,
  observedLastSeenAt: Date | null
): Promise<boolean> {
  try {
    const { registryRow } = await readRegistryRow(schemaName);

    if (observedLastSeenAt === null) {
      // Classified as an orphan. A row appearing since means a deploy just
      // registered it — it is live now.
      return registryRow === null;
    }

    return (
      registryRow !== null &&
      registryRow.lastSeenAt.getTime() <= observedLastSeenAt.getTime()
    );
  } catch (err) {
    log.warn(
      "[preview-schema-cleanup] Skipping drop: could not re-verify registry row",
      { schemaName, error: parseError(err) }
    );
    return false;
  }
}

/**
 * Classifies all preview schemas against the registry and returns decisions.
 * Registry-read errors are counted in `counters.registryReadErrored` without
 * stopping the sweep (matching the behaviour of the CLI script).
 */
async function categorizeAllSchemas(
  schemaNames: string[],
  ttlDays: number,
  queueTtlDays: number,
  now: Date,
  counters: CategoryCounters
): Promise<SchemaDecision[]> {
  const decisions: SchemaDecision[] = [];

  for (const schemaName of schemaNames) {
    let registryRow: { lastSeenAt: Date; branch: string | null } | null;
    let registryTableMissing: boolean;
    try {
      ({ registryRow, registryTableMissing } =
        await readRegistryRow(schemaName));
    } catch (err) {
      log.warn(
        "[preview-schema-cleanup] Skipping schema: registry read error",
        {
          schemaName,
          error: parseError(err),
        }
      );
      counters.registryReadErrored += 1;
      continue;
    }

    const branch = registryRow?.branch ?? null;
    const isQueuePreview = isMergeQueuePreview({ schemaName, branch });

    const category = categorizeSchema({
      schemaName,
      registryRow,
      registryTableMissing,
      ttlDays: isQueuePreview ? queueTtlDays : ttlDays,
      now,
    });

    decisions.push({
      schemaName,
      category,
      branch,
      isQueuePreview,
      lastSeenAt: registryRow?.lastSeenAt ?? null,
    });
  }

  return decisions;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const FALLBACK_TTL_DAYS = 7;
const FALLBACK_GRACE_HOURS = 48;
// Keep the cap focused on systemic branch-format drift, not ordinary cleanup of
// one or two deleted branches.
const BRANCH_AWARE_MASS_DROP_MIN_CANDIDATES = 10;
const BRANCH_AWARE_MASS_DROP_MAX_FRACTION = 0.5;

/**
 * Resolves the TTL default from `process.env.PREVIEW_SCHEMA_TTL_DAYS`, falling
 * back to {@link FALLBACK_TTL_DAYS} when unset, non-numeric, or non-positive.
 * Read inside the service methods so ops can adjust the TTL via env var without
 * a code change (matches the GHA workflow's prior behavior).
 */
function getDefaultTtlDays(): number {
  const raw = process.env.PREVIEW_SCHEMA_TTL_DAYS;
  if (raw === undefined || raw === "") {
    return FALLBACK_TTL_DAYS;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : FALLBACK_TTL_DAYS;
}

/**
 * Resolves the orphan grace window from `process.env.PREVIEW_ORPHAN_GRACE_HOURS`,
 * falling back to {@link FALLBACK_GRACE_HOURS} when unset, non-numeric, or negative.
 * Follows the same pattern as {@link getDefaultTtlDays}.
 */
function getDefaultGraceHours(): number {
  const raw = process.env.PREVIEW_ORPHAN_GRACE_HOURS;
  if (raw === undefined || raw === "") {
    return FALLBACK_GRACE_HOURS;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : FALLBACK_GRACE_HOURS;
}

export const previewSchemaCleanupService = {
  /**
   * Sweeps all `preview_` schemas: drops stale (TTL-expired), orphaned, and
   * orphan-branch schemas. Active schemas (seen within `ttlDays`) are preserved.
   *
   * The branch-aware pass fetches live GitHub branches once at sweep start and
   * demotes `active` schemas whose stored branch is no longer present to the
   * `orphan-branch` category. Schemas with NULL branch are skipped by this pass
   * and fall through to TTL-based handling. If the GitHub API is unavailable, the
   * branch-aware pass is skipped with a warning and the TTL + orphan paths still
   * execute (graceful degradation).
   * Registry orphans are subject to a grace window — first-time orphans are
   * observed but not dropped; only orphans past the grace window are dropped.
   *
   * Returns a structured summary and counters. Uses `computeExitCode` semantics:
   * `exitCode` is 1 when any DROP, registry-read, or cleanup error occurred.
   */
  async runDailySweep(ttlDays = getDefaultTtlDays()): Promise<SweepResult> {
    const counters = makeCounters();
    const now = new Date();
    const graceHours = getDefaultGraceHours();
    const queueTtlHours = getQueueTtlHours();
    // Start the clock BEFORE listing and classifying. Classification is one
    // sequential registry round trip per schema plus a paginated GitHub branch
    // fetch, which on the backlog this exists to drain is not free — anchoring
    // at the first DROP instead would make the real ceiling
    // `classification + budget + one in-flight drop` and silently spend the
    // headroom the default reserves under the route's `maxDuration`.
    const budget = createDropBudget(getSweepBudgetMs());

    const schemaNames = await listPreviewSchemas();

    if (schemaNames.length === 0) {
      await cleanupStaleObservationsSafely(counters);
      const summary = buildSummary(counters);
      return { summary, counters, exitCode: computeExitCode(counters) };
    }

    log.info("[preview-schema-cleanup] Starting daily sweep", {
      total: schemaNames.length,
      ttlDays,
      queueTtlHours,
      graceHours,
    });

    // Fetch live branches for branch-aware pass. Gracefully degrade on error.
    const liveBranches = await fetchLiveBranches();

    const decisions = await categorizeAllSchemas(
      schemaNames,
      ttlDays,
      getQueueTtlDays(),
      now,
      counters
    );

    const {
      stale: staleSchemas,
      orphaned: orphanedSchemas,
      active: activeSchemas,
      orphanBranch: orphanBranchSchemas,
      withheldByMassDropCap,
    } = partitionDecisionsWithBranch(decisions, liveBranches);

    log.info("[preview-schema-cleanup] Categorized schemas", {
      stale: staleSchemas.length,
      orphaned: orphanedSchemas.length,
      active: activeSchemas.length,
      orphanBranch: orphanBranchSchemas.length,
      withheldByMassDropCap: withheldByMassDropCap.length,
    });

    // What classification observed, keyed by schema, so each DROP can re-verify
    // the schema was not re-registered in the meantime (see isStillDroppable).
    const observedLastSeen = new Map(
      decisions.map((d) => [d.schemaName, d.lastSeenAt])
    );

    await dropSchemas(
      staleSchemas,
      counters,
      "ttl-expired",
      "stale",
      budget,
      observedLastSeen
    );

    // Grace window for orphans: observe first, drop only after grace elapses
    await processOrphansWithGrace(
      orphanedSchemas,
      counters,
      graceHours,
      now,
      budget
    );
    await dropSchemas(
      orphanBranchSchemas,
      counters,
      "orphan-branch",
      "orphan-branch",
      budget,
      observedLastSeen
    );

    // Active schemas are preserved — count them as kept under ttl-expired
    counters["ttl-expired"].kept += activeSchemas.length;
    // Candidates the mass-drop cap refused are attributed to the bucket that
    // actually withheld them, exactly once. Folding them into `ttl-expired.kept`
    // instead — as this did before ISS-5343 — reports a refused pass as an empty
    // one, which is why the cap sat permanently tripped and unnoticed.
    counters["orphan-branch"].kept += withheldByMassDropCap.length;

    await cleanupStaleObservationsSafely(counters);

    const summary = buildSummary(counters);
    const exitCode = computeExitCode(counters);

    log.info(`[preview-schema-cleanup] ${summary}`, { exitCode });

    return { summary, counters, exitCode };
  },

  /**
   * Drops the preview schema for a specific git branch name.
   *
   * Derives the schema name via `normalizePreviewSchemaName`.
   * `deriveBranchSchemaName` throws if the result does not start with
   * `preview_`; `executeDrop` enforces the same prefix guard.
   *
   * `DROP SCHEMA IF EXISTS` is idempotent. We check `pg_namespace` before
   * dropping so callers can distinguish a fresh drop from an already-absent
   * schema.
   */
  async dropSchemaForBranch(branch: string): Promise<DropResult> {
    const schemaName = deriveBranchSchemaName(
      branch,
      normalizePreviewSchemaName
    );

    try {
      // Check existence before DROP to distinguish "dropped" from "already gone"
      const existing = await withDb((db) =>
        db.$queryRaw<{ nspname: string }[]>(Prisma.sql`
          SELECT nspname
          FROM pg_namespace
          WHERE nspname = ${schemaName}
        `)
      );

      if (existing.length === 0) {
        log.info("[preview-schema-cleanup] Schema already absent", {
          schemaName,
          branch,
        });
        return { schemaName, dropped: false, alreadyGone: true, error: null };
      }

      await executeDrop(schemaName);
      log.info("[preview-schema-cleanup] Dropped schema for branch", {
        schemaName,
        branch,
      });
      return { schemaName, dropped: true, alreadyGone: false, error: null };
    } catch (err) {
      // Catches both the existence-check query and the executeDrop call so a
      // failure in either surfaces as a structured DropResult.error rather
      // than a thrown exception that callers misinterpret as auth failure.
      const message = parseError(err);
      log.error("[preview-schema-cleanup] Failed to drop schema for branch", {
        schemaName,
        branch,
        error: message,
      });
      return { schemaName, dropped: false, alreadyGone: false, error: message };
    }
  },

  /**
   * Dry-run mode: classifies all `preview_` schemas but executes zero DROPs.
   *
   * Returns a report of what would be dropped with a 5-schema sample of each
   * category. No database mutations occur (observation reads only, no upserts).
   *
   * Applies the same branch-aware logic as `runDailySweep()`: schemas whose
   * stored branch is no longer present on the GitHub remote are reported as
   * `wouldDropOrphanBranch`. GitHub API failure causes the branch-aware pass
   * to be skipped (graceful degradation). Registry orphans are sub-partitioned
   * into would-drop (grace elapsed) and would-keep-in-grace (within grace).
   */
  async runDryRun(ttlDays = getDefaultTtlDays()): Promise<DryRunResult> {
    const counters = makeCounters();
    const now = new Date();
    const graceHours = getDefaultGraceHours();

    const schemaNames = await listPreviewSchemas();

    if (schemaNames.length === 0) {
      const summary = buildDryRunSummary({
        wouldDropStale: [],
        wouldDropOrphaned: [],
        wouldDropOrphanBranch: [],
        wouldKeepInGrace: [],
        withheldByMassDropCap: [],
        keptActive: [],
        counters,
      });
      return {
        summary,
        wouldDropStale: [],
        wouldDropOrphaned: [],
        wouldDropOrphanBranch: [],
        wouldKeepInGrace: [],
        withheldByMassDropCap: [],
        keptActive: [],
        counters,
      };
    }

    // Fetch live branches for branch-aware pass. Gracefully degrade on error.
    const liveBranches = await fetchLiveBranches();

    const decisions = await categorizeAllSchemas(
      schemaNames,
      ttlDays,
      getQueueTtlDays(),
      now,
      counters
    );

    const {
      stale: wouldDropStale,
      orphaned: allOrphaned,
      active: keptActive,
      orphanBranch: wouldDropOrphanBranch,
      withheldByMassDropCap,
    } = partitionDecisionsWithBranch(decisions, liveBranches);

    // Sub-partition orphans by grace eligibility (read-only, no upserts)
    const wouldDropOrphaned: string[] = [];
    const wouldKeepInGrace: string[] = [];

    for (const schemaName of allOrphaned) {
      try {
        const observation = await readObservation(schemaName);
        const firstObservedAt = observation?.firstObservedAt ?? null;
        if (isOrphanGraceElapsed(firstObservedAt, graceHours, now)) {
          wouldDropOrphaned.push(schemaName);
        } else {
          wouldKeepInGrace.push(schemaName);
        }
      } catch (err) {
        log.error(
          "[preview-schema-cleanup] Failed to read orphan observation during dry-run",
          { schemaName, error: parseError(err) }
        );
        counters.orphan.errored += 1;
        wouldKeepInGrace.push(schemaName);
      }
    }

    // Match the daily-sweep convention: `kept` reflects schemas preserved by
    // design (the active set). Would-drop counts are surfaced in the
    // dry-run-specific summary string and the structured result fields so
    // they aren't confused with "kept-by-design" in the standard counter
    // schema.
    counters["ttl-expired"].kept = keptActive.length;
    counters["orphan-branch"].kept = withheldByMassDropCap.length;

    const summary = buildDryRunSummary({
      wouldDropStale,
      wouldDropOrphaned,
      wouldDropOrphanBranch,
      wouldKeepInGrace,
      withheldByMassDropCap,
      keptActive,
      counters,
    });

    log.info(`[preview-schema-cleanup] ${summary}`, {
      wouldDropStale: wouldDropStale.slice(0, 5),
      wouldDropOrphaned: wouldDropOrphaned.slice(0, 5),
      wouldDropOrphanBranch: wouldDropOrphanBranch.slice(0, 5),
      wouldKeepInGrace: wouldKeepInGrace.slice(0, 5),
      withheldByMassDropCap: withheldByMassDropCap.slice(0, 5),
      keptActive: keptActive.slice(0, 5),
    });

    return {
      summary,
      wouldDropStale,
      wouldDropOrphaned,
      wouldDropOrphanBranch,
      wouldKeepInGrace,
      withheldByMassDropCap,
      keptActive,
      counters,
    };
  },
};

/**
 * Builds the dry-run summary string. Uses explicit `would-drop` / `kept-active`
 * language so operators reading the workflow log don't confuse a dry-run
 * preview with a real reap outcome.
 */
function buildDryRunSummary(input: {
  wouldDropStale: string[];
  wouldDropOrphaned: string[];
  wouldDropOrphanBranch: string[];
  wouldKeepInGrace: string[];
  withheldByMassDropCap: string[];
  keptActive: string[];
  counters: CategoryCounters;
}): string {
  const totalWouldDrop =
    input.wouldDropStale.length +
    input.wouldDropOrphaned.length +
    input.wouldDropOrphanBranch.length;
  return (
    `[dry-run] summary: would-drop=${totalWouldDrop} ` +
    `(ttl-expired=${input.wouldDropStale.length} orphan=${input.wouldDropOrphaned.length} orphan-branch=${input.wouldDropOrphanBranch.length}); ` +
    `would-keep-in-grace=${input.wouldKeepInGrace.length}; ` +
    `withheld-by-mass-drop-cap=${input.withheldByMassDropCap.length}; ` +
    `kept-active=${input.keptActive.length}; ` +
    `observation-read[errored=${input.counters.orphan.errored}] ` +
    `registry-read[errored=${input.counters.registryReadErrored}]`
  );
}

// ---------------------------------------------------------------------------
// Observation helpers (grace window)
// ---------------------------------------------------------------------------

/**
 * Reads the observation row for a given schema name from
 * `public.preview_schemas_observations`.
 *
 * Returns `{ firstObservedAt }` if a row exists, or `null` if not observed yet.
 * Follows the `readRegistryRow()` pattern.
 */
async function readObservation(
  schemaName: string
): Promise<{ firstObservedAt: Date } | null> {
  const rows = await withDb((db) =>
    db.$queryRaw<{ first_observed_at: string }[]>(Prisma.sql`
      SELECT first_observed_at
      FROM public.preview_schemas_observations
      WHERE schema_name = ${schemaName}
      LIMIT 1
    `)
  );

  if (rows.length === 0) {
    return null;
  }

  return { firstObservedAt: new Date(rows[0].first_observed_at) };
}

/**
 * Reads every orphan's observation row in ONE query.
 *
 * Replaces a per-orphan `readObservation` round trip. The grace-window
 * bookkeeping deliberately runs even after the DROP budget is spent (so the
 * grace clock is never stranded), which made a per-orphan query an unbounded
 * amount of post-budget work on a large orphan backlog — able to carry the
 * function past `maxDuration` on its own (PR #4499 review). Two set-based
 * statements make the whole phase O(1) round trips.
 */
async function readObservations(
  schemaNames: string[]
): Promise<Map<string, Date>> {
  if (schemaNames.length === 0) {
    return new Map();
  }

  const rows = await withDb((db) =>
    db.$queryRaw<{ schema_name: string; first_observed_at: string }[]>(
      Prisma.sql`
        SELECT schema_name, first_observed_at
        FROM public.preview_schemas_observations
        WHERE schema_name = ANY(${schemaNames})
      `
    )
  );

  return new Map(
    rows.map((r) => [r.schema_name, new Date(r.first_observed_at)])
  );
}

/**
 * Records first-observation for every orphan in ONE statement. INSERT … ON
 * CONFLICT DO NOTHING keeps `first_observed_at` captured exactly once per
 * schema, so re-running is an idempotent no-op.
 */
async function upsertObservations(schemaNames: string[]): Promise<void> {
  if (schemaNames.length === 0) {
    return;
  }

  await withDb((db) =>
    db.$executeRaw(Prisma.sql`
      INSERT INTO public.preview_schemas_observations (schema_name)
      SELECT unnest(${schemaNames}::text[])
      ON CONFLICT (schema_name) DO NOTHING
    `)
  );
}

/**
 * Deletes observation rows for schemas that now have a real registry row in
 * `public.preview_schemas`. This keeps the observation table tidy — once a
 * schema gains a registry entry (because a preview deploy registered it),
 * it's no longer an orphan candidate and the observation is stale.
 *
 * Also deletes observations for schemas that no longer exist in pg_namespace
 * (already dropped by a previous sweep).
 */
async function cleanupStaleObservations(): Promise<void> {
  await withDb((db) =>
    db.$executeRaw(Prisma.sql`
      DO $$
      BEGIN
        IF to_regclass('public.preview_schemas') IS NOT NULL THEN
          DELETE FROM public.preview_schemas_observations AS observation
          WHERE EXISTS (
            SELECT 1
            FROM public.preview_schemas AS registry
            WHERE registry.schema_name = observation.schema_name
          );
        END IF;

        DELETE FROM public.preview_schemas_observations AS observation
        WHERE NOT EXISTS (
          SELECT 1
          FROM pg_namespace AS pg_ns
          WHERE pg_ns.nspname = observation.schema_name
            AND pg_ns.nspname LIKE 'preview_%'
        );
      END $$;
    `)
  );
}

async function cleanupStaleObservationsSafely(
  counters: CategoryCounters
): Promise<void> {
  try {
    await cleanupStaleObservations();
  } catch (err) {
    log.error("[preview-schema-cleanup] cleanupStaleObservations failed", {
      error: parseError(err),
    });
    counters.registryReadErrored += 1;
  }
}

// ---------------------------------------------------------------------------
// Private helpers (extracted for deduplication)
// ---------------------------------------------------------------------------

/**
 * Fetches the set of live branch names from the GitHub remote for the preview
 * schema source repo. Returns null on any error so callers can gracefully skip
 * the branch-aware pass without aborting the sweep.
 */
async function fetchLiveBranches(): Promise<Set<string> | null> {
  try {
    const branchNames = await listAllBranchNames(
      PreviewSchemaSourceRepo.owner,
      PreviewSchemaSourceRepo.name
    );
    if (branchNames.length === 0) {
      // A real repo always has at least its default branch. An empty list on a
      // successful response is a degenerate "GitHub unavailable" case; skip the
      // branch-aware pass rather than mass-classifying every schema as orphaned.
      log.warn(
        "[preview-schema-cleanup] GitHub returned zero branches; skipping branch-aware pass"
      );
      return null;
    }
    return new Set(branchNames);
  } catch (err) {
    log.warn(
      "[preview-schema-cleanup] GitHub branch fetch failed; skipping branch-aware pass",
      { error: parseError(err) }
    );
    return null;
  }
}

/**
 * Partitions schema decisions into stale, orphaned, orphan-branch, and active
 * lists.
 *
 * When `liveBranches` is provided (not null), `active` schemas whose stored
 * `branch` is non-null and NOT in the live set are moved to the `orphanBranch`
 * list. Schemas with a null branch are left in the `active` list so TTL handles
 * them. When `liveBranches` is null (GitHub unavailable), no branch-aware
 * reclassification occurs. If a sizable branch-aware candidate set would be
 * mostly reclassified, the branch-aware pass is skipped for this run to avoid a
 * mass-drop caused by branch-format drift; those withheld candidates are
 * returned in `withheldByMassDropCap` rather than silently rejoining `active`.
 *
 * Merge-queue schemas that are still `active` sit out this pass entirely
 * (ISS-5343). They are neither candidates nor voters in the cap's arithmetic:
 * their branch being dead is the merge queue's normal steady state, not
 * evidence of drift, and counting them made the cap trip on every run and
 * disabled the pass for everyone else. Their reaper is the much shorter
 * queue TTL applied during categorization, which also avoids trusting a
 * possibly-partial GitHub branch listing for a schema this short-lived.
 */
function partitionDecisionsWithBranch(
  decisions: SchemaDecision[],
  liveBranches: Set<string> | null
): {
  stale: string[];
  orphaned: string[];
  orphanBranch: string[];
  active: string[];
  withheldByMassDropCap: string[];
} {
  const stale: string[] = [];
  const orphaned: string[] = [];
  const activeDecisions: Array<SchemaDecision & { isOrphanBranch: boolean }> =
    [];
  const orphanBranch: string[] = [];
  const active: string[] = [];
  const withheldByMassDropCap: string[] = [];

  for (const d of decisions) {
    if (d.category === "stale") {
      stale.push(d.schemaName);
    } else if (d.category === "orphaned") {
      orphaned.push(d.schemaName);
    } else {
      activeDecisions.push({
        ...d,
        isOrphanBranch:
          !d.isQueuePreview &&
          liveBranches !== null &&
          d.branch !== null &&
          !liveBranches.has(d.branch),
      });
    }
  }

  const branchAwareCandidateCount =
    liveBranches === null
      ? 0
      : activeDecisions.filter((d) => !d.isQueuePreview && d.branch !== null)
          .length;
  const orphanBranchCandidateCount = activeDecisions.filter(
    (d) => d.isOrphanBranch
  ).length;
  const skipBranchAwarePass = exceedsBranchAwareMassDropCap({
    branchAwareCandidateCount,
    orphanBranchCandidateCount,
  });

  if (skipBranchAwarePass) {
    log.warn(
      "[preview-schema-cleanup] Skipping branch-aware pass: orphan-branch candidates exceed mass-drop cap",
      {
        branchAwareCandidateCount,
        orphanBranchCandidateCount,
        // Reported so drift in the merge-queue naming convention itself stays
        // visible: this count collapsing to zero, or growing without bound, is
        // the signal that the exclusion above has stopped matching reality.
        queuePreviewsExcluded: activeDecisions.filter((d) => d.isQueuePreview)
          .length,
        maxFraction: BRANCH_AWARE_MASS_DROP_MAX_FRACTION,
      }
    );
  }

  for (const d of activeDecisions) {
    if (d.isOrphanBranch && skipBranchAwarePass) {
      withheldByMassDropCap.push(d.schemaName);
    } else if (d.isOrphanBranch) {
      orphanBranch.push(d.schemaName);
    } else {
      active.push(d.schemaName);
    }
  }

  return { stale, orphaned, orphanBranch, active, withheldByMassDropCap };
}

function exceedsBranchAwareMassDropCap({
  branchAwareCandidateCount,
  orphanBranchCandidateCount,
}: {
  branchAwareCandidateCount: number;
  orphanBranchCandidateCount: number;
}): boolean {
  if (branchAwareCandidateCount < BRANCH_AWARE_MASS_DROP_MIN_CANDIDATES) {
    return false;
  }

  return (
    orphanBranchCandidateCount / branchAwareCandidateCount >
    BRANCH_AWARE_MASS_DROP_MAX_FRACTION
  );
}

/**
 * Drops a list of schemas, incrementing the appropriate counter bucket.
 *
 * Every drop is gated on the sweep's remaining time budget. Once spent, the
 * rest of the list is counted into `deferredDrops` and left for the next sweep
 * (which re-enumerates `pg_namespace` from scratch, so it resumes naturally).
 */
async function dropSchemas(
  schemaNames: string[],
  counters: CategoryCounters,
  bucket: CounterBucket,
  label: string,
  budget: DropBudget,
  observedLastSeen: Map<string, Date | null>
): Promise<void> {
  for (const schemaName of schemaNames) {
    if (deferDropIfExhausted(budget, counters)) {
      continue;
    }

    if (
      !(await isStillDroppable(
        schemaName,
        observedLastSeen.get(schemaName) ?? null
      ))
    ) {
      log.info(
        `[preview-schema-cleanup] Skipped ${label} schema: re-registered since classification`,
        { schemaName }
      );
      counters[bucket].kept += 1;
      continue;
    }

    try {
      await executeDrop(schemaName);
      log.info(`[preview-schema-cleanup] Dropped ${label} schema`, {
        schemaName,
      });
      counters[bucket].dropped += 1;
    } catch (err) {
      if (isDropContentionError(err)) {
        log.info(
          `[preview-schema-cleanup] Skipped ${label} schema: still in use (lock/statement timeout)`,
          { schemaName }
        );
        counters[bucket].kept += 1;
        continue;
      }
      log.error(`[preview-schema-cleanup] Failed to drop ${label} schema`, {
        schemaName,
        error: parseError(err),
      });
      counters[bucket].errored += 1;
    }
  }
}

/**
 * Processes orphaned schemas with the grace window. For each orphan:
 * 1. Read its observation row
 * 2. Upsert an observation if not present (first-time orphan)
 * 3. Check grace eligibility via isOrphanGraceElapsed()
 * 4. Drop if grace elapsed, count as kept otherwise
 *
 * Per-orphan errors are isolated: a failure for one orphan is counted as
 * errored and does not stop processing of remaining orphans.
 *
 * The time budget gates step 4 only. Steps 1–3 keep running once it is spent,
 * deliberately: `first_observed_at` is what starts the grace clock, so skipping
 * the upsert would mean a sweep that repeatedly runs out of budget never lets
 * any orphan become eligible. Only the DROP — the expensive part the budget
 * exists to bound — is deferred, and a grace-elapsed orphan that goes
 * undropped is counted into `deferredDrops` so the deferral stays visible.
 *
 * Because that bookkeeping is deliberately un-budgeted, it is set-based: steps
 * 1–2 are two statements for the whole batch rather than two per orphan, so a
 * large orphan backlog cannot itself outrun `maxDuration` after DROP work stops
 * (PR #4499 review).
 */
async function processOrphansWithGrace(
  orphanedSchemas: string[],
  counters: CategoryCounters,
  graceHours: number,
  now: Date,
  budget: DropBudget
): Promise<void> {
  if (orphanedSchemas.length === 0) {
    return;
  }

  let observations: Map<string, Date>;
  try {
    observations = await readObservations(orphanedSchemas);
    // Idempotent — records first_observed_at exactly once per schema.
    await upsertObservations(orphanedSchemas);
  } catch (err) {
    // The batch is all-or-nothing, so a failure here costs the whole orphan
    // pass this run. Every orphan is counted so the loss is visible, and the
    // next sweep retries from scratch.
    log.error(
      "[preview-schema-cleanup] Failed to process orphan schema observations",
      { orphanCount: orphanedSchemas.length, error: parseError(err) }
    );
    counters.orphan.errored += orphanedSchemas.length;
    return;
  }

  for (const schemaName of orphanedSchemas) {
    const firstObservedAt = observations.get(schemaName) ?? null;

    if (!isOrphanGraceElapsed(firstObservedAt, graceHours, now)) {
      // Within grace window — keep the schema
      log.info(
        "[preview-schema-cleanup] Orphan schema kept (within grace window)",
        { schemaName, firstObservedAt }
      );
      counters.orphan.kept += 1;
      continue;
    }

    // Grace window elapsed — drop the schema, budget permitting
    if (deferDropIfExhausted(budget, counters)) {
      continue;
    }

    // An orphan had no registry row when classified; a row appearing since
    // means a deploy just registered it, so it is live and must not be dropped.
    if (!(await isStillDroppable(schemaName, null))) {
      log.info(
        "[preview-schema-cleanup] Skipped orphan schema: registered since classification",
        { schemaName }
      );
      counters.orphan.kept += 1;
      continue;
    }

    try {
      await executeDrop(schemaName);
      log.info(
        "[preview-schema-cleanup] Dropped orphan schema (grace elapsed)",
        { schemaName }
      );
      counters.orphan.dropped += 1;
    } catch (dropErr) {
      if (isDropContentionError(dropErr)) {
        log.info(
          "[preview-schema-cleanup] Skipped orphan schema: still in use (lock/statement timeout)",
          { schemaName }
        );
        counters.orphan.kept += 1;
        continue;
      }
      log.error("[preview-schema-cleanup] Failed to drop orphan schema", {
        schemaName,
        error: parseError(dropErr),
      });
      counters.orphan.errored += 1;
    }
  }
}
