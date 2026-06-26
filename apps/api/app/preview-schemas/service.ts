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
  isOrphanGraceElapsed,
  makeCounters,
} from "@repo/database/scripts/cleanup-preview-schemas-lib";
import { listAllBranchNames } from "@repo/github";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { PreviewSchemaSourceRepo } from "./constants";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SchemaDecision = {
  schemaName: string;
  category: SchemaCategory;
  branch: string | null;
};

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
  await withDb((db) =>
    db.$executeRawUnsafe(
      `DROP SCHEMA IF EXISTS "${schemaName.replace(/"/g, '""')}" CASCADE`
    )
  );
}

/**
 * Classifies all preview schemas against the registry and returns decisions.
 * Registry-read errors are counted in `counters.registryReadErrored` without
 * stopping the sweep (matching the behaviour of the CLI script).
 */
async function categorizeAllSchemas(
  schemaNames: string[],
  ttlDays: number,
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

    const category = categorizeSchema({
      schemaName,
      registryRow,
      registryTableMissing,
      ttlDays,
      now,
    });

    decisions.push({
      schemaName,
      category,
      branch: registryRow?.branch ?? null,
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

    const schemaNames = await listPreviewSchemas();

    if (schemaNames.length === 0) {
      await cleanupStaleObservationsSafely(counters);
      const summary = buildSummary(counters);
      return { summary, counters, exitCode: computeExitCode(counters) };
    }

    log.info("[preview-schema-cleanup] Starting daily sweep", {
      total: schemaNames.length,
      ttlDays,
      graceHours,
    });

    // Fetch live branches for branch-aware pass. Gracefully degrade on error.
    const liveBranches = await fetchLiveBranches();

    const decisions = await categorizeAllSchemas(
      schemaNames,
      ttlDays,
      now,
      counters
    );

    const {
      stale: staleSchemas,
      orphaned: orphanedSchemas,
      active: activeSchemas,
      orphanBranch: orphanBranchSchemas,
    } = partitionDecisionsWithBranch(decisions, liveBranches);

    log.info("[preview-schema-cleanup] Categorized schemas", {
      stale: staleSchemas.length,
      orphaned: orphanedSchemas.length,
      active: activeSchemas.length,
      orphanBranch: orphanBranchSchemas.length,
    });

    await dropSchemas(staleSchemas, counters, "ttl-expired", "stale");

    // Grace window for orphans: observe first, drop only after grace elapses
    await processOrphansWithGrace(orphanedSchemas, counters, graceHours, now);
    await dropSchemas(
      orphanBranchSchemas,
      counters,
      "orphan-branch",
      "orphan-branch"
    );

    // Active schemas are preserved — count them as kept under ttl-expired
    counters["ttl-expired"].kept += activeSchemas.length;

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
        keptActive: [],
        counters,
      });
      return {
        summary,
        wouldDropStale: [],
        wouldDropOrphaned: [],
        wouldDropOrphanBranch: [],
        wouldKeepInGrace: [],
        keptActive: [],
        counters,
      };
    }

    // Fetch live branches for branch-aware pass. Gracefully degrade on error.
    const liveBranches = await fetchLiveBranches();

    const decisions = await categorizeAllSchemas(
      schemaNames,
      ttlDays,
      now,
      counters
    );

    const {
      stale: wouldDropStale,
      orphaned: allOrphaned,
      active: keptActive,
      orphanBranch: wouldDropOrphanBranch,
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

    const summary = buildDryRunSummary({
      wouldDropStale,
      wouldDropOrphaned,
      wouldDropOrphanBranch,
      wouldKeepInGrace,
      keptActive,
      counters,
    });

    log.info(`[preview-schema-cleanup] ${summary}`, {
      wouldDropStale: wouldDropStale.slice(0, 5),
      wouldDropOrphaned: wouldDropOrphaned.slice(0, 5),
      wouldDropOrphanBranch: wouldDropOrphanBranch.slice(0, 5),
      wouldKeepInGrace: wouldKeepInGrace.slice(0, 5),
      keptActive: keptActive.slice(0, 5),
    });

    return {
      summary,
      wouldDropStale,
      wouldDropOrphaned,
      wouldDropOrphanBranch,
      wouldKeepInGrace,
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
 * Upserts an observation row for a given schema name. Uses INSERT ON CONFLICT
 * DO NOTHING so the `first_observed_at` timestamp is captured exactly once per
 * schema — subsequent calls are idempotent no-ops.
 */
async function upsertObservation(schemaName: string): Promise<void> {
  await withDb((db) =>
    db.$executeRaw(Prisma.sql`
      INSERT INTO public.preview_schemas_observations (schema_name)
      VALUES (${schemaName})
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
 * mass-drop caused by branch-format drift.
 */
function partitionDecisionsWithBranch(
  decisions: SchemaDecision[],
  liveBranches: Set<string> | null
): {
  stale: string[];
  orphaned: string[];
  orphanBranch: string[];
  active: string[];
} {
  const stale: string[] = [];
  const orphaned: string[] = [];
  const activeDecisions: Array<SchemaDecision & { isOrphanBranch: boolean }> =
    [];
  const orphanBranch: string[] = [];
  const active: string[] = [];

  for (const d of decisions) {
    if (d.category === "stale") {
      stale.push(d.schemaName);
    } else if (d.category === "orphaned") {
      orphaned.push(d.schemaName);
    } else {
      activeDecisions.push({
        ...d,
        isOrphanBranch:
          liveBranches !== null &&
          d.branch !== null &&
          !liveBranches.has(d.branch),
      });
    }
  }

  const branchAwareCandidateCount =
    liveBranches === null
      ? 0
      : activeDecisions.filter((d) => d.branch !== null).length;
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
        maxFraction: BRANCH_AWARE_MASS_DROP_MAX_FRACTION,
      }
    );
  }

  for (const d of activeDecisions) {
    if (!skipBranchAwarePass && d.isOrphanBranch) {
      orphanBranch.push(d.schemaName);
    } else {
      active.push(d.schemaName);
    }
  }

  return { stale, orphaned, orphanBranch, active };
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
 */
async function dropSchemas(
  schemaNames: string[],
  counters: CategoryCounters,
  bucket: CounterBucket,
  label: string
): Promise<void> {
  for (const schemaName of schemaNames) {
    try {
      await executeDrop(schemaName);
      log.info(`[preview-schema-cleanup] Dropped ${label} schema`, {
        schemaName,
      });
      counters[bucket].dropped += 1;
    } catch (err) {
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
 */
async function processOrphansWithGrace(
  orphanedSchemas: string[],
  counters: CategoryCounters,
  graceHours: number,
  now: Date
): Promise<void> {
  for (const schemaName of orphanedSchemas) {
    try {
      const observation = await readObservation(schemaName);
      const firstObservedAt = observation?.firstObservedAt ?? null;

      // Upsert observation (idempotent — records first_observed_at once)
      await upsertObservation(schemaName);

      if (isOrphanGraceElapsed(firstObservedAt, graceHours, now)) {
        // Grace window elapsed — drop the schema
        try {
          await executeDrop(schemaName);
          log.info(
            "[preview-schema-cleanup] Dropped orphan schema (grace elapsed)",
            { schemaName }
          );
          counters.orphan.dropped += 1;
        } catch (dropErr) {
          log.error("[preview-schema-cleanup] Failed to drop orphan schema", {
            schemaName,
            error: parseError(dropErr),
          });
          counters.orphan.errored += 1;
        }
      } else {
        // Within grace window — keep the schema
        log.info(
          "[preview-schema-cleanup] Orphan schema kept (within grace window)",
          { schemaName, firstObservedAt }
        );
        counters.orphan.kept += 1;
      }
    } catch (err) {
      // Observation read/upsert failure — count as errored, continue
      log.error(
        "[preview-schema-cleanup] Failed to process orphan schema observation",
        { schemaName, error: parseError(err) }
      );
      counters.orphan.errored += 1;
    }
  }
}
