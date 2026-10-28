import type {
  CategoryCounters,
  CounterBucket,
  SchemaCategory,
} from "@repo/database/scripts/cleanup-preview-schemas-lib";
import {
  categorizeSchema,
  isMergeQueuePreview,
  isOrphanGraceElapsed,
  makeCounters,
} from "@repo/database/scripts/cleanup-preview-schemas-lib";
import { isRetainedEnvironmentSchema } from "@repo/database/scripts/vibe-environment-retention";
import { listAllBranchNames } from "@repo/github";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { PreviewSchemaSourceRepo } from "./constants";
import { dropSchemaForBranch } from "./service/drop-branch";
import type { DropBudget } from "./service/drop-budget";
import {
  createDropBudget,
  deferDropIfExhausted,
  getSweepBudgetMs,
} from "./service/drop-budget";
import { executeDrop, isDropContentionError } from "./service/drop-execution";
import { buildDryRunSummary } from "./service/dry-run-summary";
import {
  cleanupStaleObservationsSafely,
  readObservation,
  readObservations,
  upsertObservations,
} from "./service/orphan-observations";
import { getQueueTtlDays, getQueueTtlHours } from "./service/queue-ttl";
import { listPreviewSchemas, readRegistryRow } from "./service/schema-registry";
import { keepRetainedEnvironmentOutOfSweep } from "./service/vibe-environment-retention";
import type { VibeObjectCleanupReport } from "./service/vibe-object-cleanup";
import {
  summarizeSweep,
  sweepOrphanedVibeObjects,
} from "./service/vibe-object-cleanup";

export type { DropResult } from "./service/drop-branch";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SchemaDecision = {
  schemaName: string;
  category: SchemaCategory;
  branch: string | null;
  isQueuePreview: boolean;
  isRetainedEnvironment: boolean;
  /**
   * `last_seen_at` as classification saw it, or `null` when the schema had no
   * registry row. Carried to the DROP so it can re-verify nothing re-registered
   * the schema in between (see {@link isStillDroppable}).
   */
  lastSeenAt: Date | null;
};

export type SweepResult = {
  summary: string;
  counters: CategoryCounters;
  /** ISS-12056: S3 objects of dropped vibe environments, deleted by prefix. */
  vibeObjects: VibeObjectCleanupReport;
  exitCode: 0 | 1;
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
// Drop revalidation and classification
// ---------------------------------------------------------------------------

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
 * have a newer `last_seen_at`. Vibe and prototype retention is checked again
 * against the current provenance before either condition can admit a drop.
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

    if (isRetainedEnvironmentSchema(schemaName, registryRow?.branch ?? null)) {
      return false;
    }

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

    const category = keepRetainedEnvironmentOutOfSweep(
      categorizeSchema({
        schemaName,
        registryRow,
        registryTableMissing,
        ttlDays: isQueuePreview ? queueTtlDays : ttlDays,
        now,
      }),
      schemaName,
      branch
    );

    decisions.push({
      schemaName,
      category,
      branch,
      isQueuePreview,
      isRetainedEnvironment: isRetainedEnvironmentSchema(schemaName, branch),
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
   * orphan-branch schemas. Active schemas (seen within `ttlDays`, or on a
   * `vibe/`, `prototype/` or `functional-prototype/` branch) are preserved, and
   * those three prefixes' schemas also sit out the orphan-branch pass.
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
      const vibeObjects = await sweepOrphanedVibeObjects(budget);
      return {
        counters,
        vibeObjects,
        ...summarizeSweep(counters, vibeObjects),
      };
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

    // After every DROP, so this run's dropped vibe schemas are already absent
    // from pg_namespace and their objects are deleted here.
    const vibeObjects = await sweepOrphanedVibeObjects(budget);
    const { summary, exitCode } = summarizeSweep(counters, vibeObjects);

    log.info(`[preview-schema-cleanup] ${summary}`, { exitCode });

    return { summary, counters, vibeObjects, exitCode };
  },

  dropSchemaForBranch,

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
 *
 * A vibe/, prototype/ or functional-prototype/ schema sits out the same way,
 * with no reaper at all: its cleanup is manual (see
 * `vibe-environment-retention.ts`).
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
          !sitsOutBranchAwarePass(d) &&
          liveBranches !== null &&
          d.branch !== null &&
          !liveBranches.has(d.branch),
      });
    }
  }

  const branchAwareCandidateCount =
    liveBranches === null
      ? 0
      : activeDecisions.filter(
          (d) => !sitsOutBranchAwarePass(d) && d.branch !== null
        ).length;
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
        `[preview-schema-cleanup] Skipped ${label} schema: retention policy or registry changed since classification`,
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
        "[preview-schema-cleanup] Skipped orphan schema: retention policy or registry changed since classification",
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

function sitsOutBranchAwarePass(decision: SchemaDecision): boolean {
  return decision.isQueuePreview || decision.isRetainedEnvironment;
}
