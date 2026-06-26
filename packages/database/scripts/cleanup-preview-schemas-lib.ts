import { parseArgs } from "node:util";

/**
 * Pure helpers for cleanup-preview-schemas.ts.
 *
 * No I/O, no process.env reads, no pg calls — all inputs are arguments.
 * This design allows the decision logic to be unit-tested without a live database.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SchemaCategory = "active" | "stale" | "orphaned";

export type CategoryCounters = {
  "ttl-expired": { kept: number; dropped: number; errored: number };
  orphan: { kept: number; dropped: number; errored: number };
  "orphan-branch": { kept: number; dropped: number; errored: number };
  "pr-closed": { kept: number; dropped: number; errored: number };
  // Failures during registry-read (transient DB errors during classification),
  // tracked separately from per-category drop failures so operators can tell
  // "couldn't classify schema" from "failed to DROP schema".
  registryReadErrored: number;
};

export type CounterBucket = Exclude<
  keyof CategoryCounters,
  "registryReadErrored"
>;

export type CategorizeSchemaInput = {
  schemaName: string;
  registryRow: { lastSeenAt: Date } | null;
  registryTableMissing: boolean;
  ttlDays: number;
  now: Date;
};

export type ParsedCliArgs = {
  dryRun: boolean;
  branch: string | null;
  mode: "daily" | "pr-close";
};

// ---------------------------------------------------------------------------
// categorizeSchema
// ---------------------------------------------------------------------------

/**
 * Categorizes a preview schema as "active", "stale", or "orphaned".
 *
 * - "orphaned": The registry table does not exist for this schema
 *   (registryTableMissing === true), meaning it was never properly registered.
 * - "stale": The registry row exists but last_seen_at is older than ttlDays.
 * - "active": The registry row exists and last_seen_at is within ttlDays.
 *
 * When registryRow is null and registryTableMissing is false, the schema has
 * a registry table but no row — treated as "orphaned" (no evidence of a live
 * deploy having registered it).
 */
export function categorizeSchema(input: CategorizeSchemaInput): SchemaCategory {
  const { registryRow, registryTableMissing, ttlDays, now } = input;

  if (registryTableMissing || registryRow === null) {
    return "orphaned";
  }

  const cutoffMs = ttlDays * 24 * 60 * 60 * 1000;
  const cutoff = new Date(now.getTime() - cutoffMs);

  if (registryRow.lastSeenAt < cutoff) {
    return "stale";
  }

  return "active";
}

// ---------------------------------------------------------------------------
// Shared category list
// ---------------------------------------------------------------------------

const CATEGORIES = [
  "ttl-expired",
  "orphan",
  "orphan-branch",
  "pr-closed",
] as const;

// ---------------------------------------------------------------------------
// buildSummary
// ---------------------------------------------------------------------------

/**
 * Produces a human-readable summary string from per-category counters.
 *
 * Format (one line per category, all four categories always present):
 *   summary: ttl-expired[dropped=N kept=N errored=N] orphan[...] orphan-branch[...] pr-closed[...]
 */
export function buildSummary(counters: CategoryCounters): string {
  const parts = CATEGORIES.map((cat) => {
    const { dropped, kept, errored } = counters[cat];
    return `${cat}[dropped=${dropped} kept=${kept} errored=${errored}]`;
  });
  parts.push(`registry-read[errored=${counters.registryReadErrored}]`);

  return `summary: ${parts.join(" ")}`;
}

// ---------------------------------------------------------------------------
// validateHost
// ---------------------------------------------------------------------------

/**
 * Validates the PGHOST env var is a valid Neon/stage hostname.
 *
 * Returns null when valid, or an error message string when invalid.
 *
 * Rules:
 * - pgHost must be defined and non-empty.
 * - stagePgHost must be defined and non-empty.
 * - pgHost must exactly equal stagePgHost (case-insensitive).
 */
export function validateHost(input: {
  pgHost: string | undefined;
  stagePgHost: string | undefined;
}): string | null {
  const { pgHost, stagePgHost } = input;

  if (!pgHost) {
    return "PGHOST is not set";
  }

  if (!stagePgHost) {
    return "STAGE_PGHOST is not set; cannot verify host safety";
  }

  if (pgHost.toLowerCase() !== stagePgHost.toLowerCase()) {
    return `PGHOST (${pgHost}) does not match STAGE_PGHOST (${stagePgHost}); refusing to run against non-stage host`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// deriveBranchSchemaName
// ---------------------------------------------------------------------------

/**
 * Derives the preview schema name from a git branch name using the provided
 * normalizer function.
 *
 * The normalizer should be normalizePreviewSchemaName from schema-utils.ts —
 * passed as an argument so this helper remains pure and testable without
 * importing from the sibling module.
 *
 * Throws if the derived name does not start with "preview_", which would
 * indicate an unexpected normalizer was passed.
 */
export function deriveBranchSchemaName(
  branchName: string,
  normalize: (ref: string) => string
): string {
  const schemaName = normalize(branchName);

  if (!schemaName.startsWith("preview_")) {
    throw new Error(
      `Normalizer produced a non-preview_ schema name "${schemaName}" for branch "${branchName}"; refusing to proceed`
    );
  }

  return schemaName;
}

export function getBranchModeCounterBucket(
  mode: ParsedCliArgs["mode"]
): CounterBucket {
  return mode === "pr-close" ? "pr-closed" : "orphan-branch";
}

// ---------------------------------------------------------------------------
// parseCliArgs
// ---------------------------------------------------------------------------

/**
 * Parses CLI arguments: --dry-run, --branch <name>, --mode <daily|pr-close>.
 *
 * Returns a typed config object. Throws on unrecognized flags (strict mode).
 * Throws with a descriptive message if --mode receives an unrecognized value.
 */
export function parseCliArgs(argv: string[]): ParsedCliArgs {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      "dry-run": { type: "boolean", default: false },
      branch: { type: "string" },
      mode: { type: "string", default: "daily" },
    },
  });

  const rawMode = values.mode as string;
  if (rawMode !== "daily" && rawMode !== "pr-close") {
    throw new Error(
      `Invalid --mode value "${rawMode}"; expected "daily" or "pr-close"`
    );
  }

  return {
    dryRun: values["dry-run"] ?? false,
    branch: values.branch ?? null,
    mode: rawMode,
  };
}

// ---------------------------------------------------------------------------
// computeExitCode
// ---------------------------------------------------------------------------

/**
 * Returns 0 if no errors across all categories, 1 if any errored > 0.
 */
export function computeExitCode(counters: CategoryCounters): 0 | 1 {
  const hasCategoryErrors = CATEGORIES.some((cat) => counters[cat].errored > 0);

  return hasCategoryErrors || counters.registryReadErrored > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// isOrphanGraceElapsed
// ---------------------------------------------------------------------------

/**
 * Determines whether the orphan grace window has elapsed for a schema.
 *
 * - `firstObservedAt === null` means this is the first observation — the schema
 *   was just discovered as an orphan and should be recorded but NOT dropped.
 * - When `firstObservedAt` is set, the schema is eligible for drop only if
 *   `now - firstObservedAt > graceHours`.
 * - A `graceHours` of 0 makes any previously-observed orphan immediately eligible.
 */
export function isOrphanGraceElapsed(
  firstObservedAt: Date | null,
  graceHours: number,
  now: Date
): boolean {
  if (firstObservedAt === null) {
    return false;
  }

  const graceMs = graceHours * 60 * 60 * 1000;
  return now.getTime() - firstObservedAt.getTime() > graceMs;
}

// ---------------------------------------------------------------------------
// Factory helper for a zeroed CategoryCounters object
// ---------------------------------------------------------------------------

export function makeCounters(): CategoryCounters {
  return {
    "ttl-expired": { kept: 0, dropped: 0, errored: 0 },
    orphan: { kept: 0, dropped: 0, errored: 0 },
    "orphan-branch": { kept: 0, dropped: 0, errored: 0 },
    "pr-closed": { kept: 0, dropped: 0, errored: 0 },
    registryReadErrored: 0,
  };
}
