/**
 * @file db-host-query-perf.ts
 * @description ISS-6339 — the query-duration accumulator that sits at the
 * db-host statement boundary.
 *
 * Local DB performance is a stated customer-experience priority and had no
 * signal at all: nothing measured how long a statement took, and nothing counted
 * the slow ones. This module is the counting half; `store-perf-sampler.ts` owns
 * the cadence and `../../telemetry/store-perf-telemetry.ts` owns the emit.
 *
 * ## Bounded cardinality is the contract, not a nicety
 *
 * A duration keyed by the SQL text — or by table plus column — is a per-store,
 * per-query label set, which is a cost incident on a metrics backend and a
 * privacy problem besides (a raw statement carries bound values). So the ONLY
 * label this produces is the statement FAMILY: the leading keyword, folded into
 * the closed {@link SqlStatementFamily} set. Eight families times
 * {@link QUERY_DURATION_BUCKET_BOUNDS_MS}`.length + 1` buckets is the entire
 * cardinality of the signal, and it cannot grow with the store, the schema, or
 * the workload.
 *
 * ## Why the classifier reads charcodes instead of a regex
 *
 * `record` runs once per statement on the store's hot path, so it must not
 * allocate proportionally to the work it measures. `sql.trim().toLowerCase()`
 * would allocate two strings per query and a regex would allocate a match array;
 * {@link sqlStatementFamily} instead scans a bounded prefix in place and
 * compares with `charCodeAt`, allocating nothing. The per-family accumulator
 * rows are created at most once each (eight for the process lifetime) and then
 * mutated in place, so a sample window of a million statements allocates the
 * same eight objects as a window of one.
 */

import {
  type QueryPerfFamilyDiagnostics,
  SqlStatementFamily,
} from "../../telemetry/telemetry-protocol.js";

/**
 * Upper bounds (inclusive, milliseconds) of the duration histogram. A sample
 * lands in the first bucket whose bound it does not exceed; anything slower
 * lands in the implicit overflow bucket, so a family always reports exactly
 * `BOUNDS.length + 1` counts.
 *
 * Chosen so the interesting range for a local SQLite store — sub-millisecond
 * point reads through multi-second table scans — is resolved without a
 * per-store-tunable knob that would make two machines' histograms incomparable.
 */
export const QUERY_DURATION_BUCKET_BOUNDS_MS: readonly number[] = [
  1, 5, 10, 50, 100, 500, 1000,
];

/** Statements at or above this take part in the slow-query counter. */
export const SLOW_QUERY_THRESHOLD_MS_DEFAULT = 100;

/**
 * One family's counts for one sample window. Clone-safe: numbers only. This is
 * the wire shape ({@link QueryPerfFamilyDiagnostics}) rather than a private
 * mirror of it, so a field added to the event cannot silently stop being filled.
 */
export type QueryPerfFamilySample = QueryPerfFamilyDiagnostics;

/** One drained sample window. */
export type QueryPerfSample = {
  /** Wall time the window covered, so a rate can be derived downstream. */
  windowMs: number;
  slowQueryThresholdMs: number;
  /** At most one entry per {@link SqlStatementFamily}; empty families omitted. */
  families: QueryPerfFamilySample[];
};

export type QueryPerfRecorder = {
  /**
   * Record one settled statement. Called from the adapter boundary on every
   * query, so it must stay allocation-free and non-throwing.
   */
  record(sql: string, durationMs: number): void;
  /**
   * Take and reset the accumulated window. Returns `null` when nothing was
   * recorded since the previous drain — an empty window is not a measurement,
   * and emitting a zeroed histogram for it would make an idle app
   * indistinguishable from one whose instrumentation broke.
   */
  drain(): QueryPerfSample | null;
};

export type QueryPerfRecorderOptions = {
  slowQueryThresholdMs?: number;
  /** Monotonic clock for the window span. Defaults to `performance.now()`. */
  now?: () => number;
};

/**
 * Build the process-lifetime accumulator. One per db-host; the caller wires
 * {@link QueryPerfRecorder.record} into `createDesktopPrisma`'s
 * `onStatementSettled` hook and drains it on the sampler cadence.
 */
export function createQueryPerfRecorder(
  options?: QueryPerfRecorderOptions
): QueryPerfRecorder {
  const slowQueryThresholdMs =
    options?.slowQueryThresholdMs ?? SLOW_QUERY_THRESHOLD_MS_DEFAULT;
  const now = options?.now ?? (() => performance.now());
  const rows = new Map<SqlStatementFamily, QueryPerfFamilySample>();
  let windowStartedAt = now();

  return {
    record(sql: string, durationMs: number): void {
      // A non-finite or negative duration cannot describe a statement that ran.
      // Counting it would corrupt both the histogram and `maxDurationMs`, and
      // this runs on the hot path where there is no richer context to report
      // from, so the honest handling is to leave the sample out of the window.
      if (!(Number.isFinite(durationMs) && durationMs >= 0)) {
        return;
      }
      const family = sqlStatementFamily(sql);
      let row = rows.get(family);
      if (row === undefined) {
        row = emptyFamilySample(family);
        rows.set(family, row);
      }
      row.count += 1;
      row.buckets[bucketIndex(durationMs)] += 1;
      if (durationMs >= slowQueryThresholdMs) {
        row.slowCount += 1;
      }
      if (durationMs > row.maxDurationMs) {
        row.maxDurationMs = durationMs;
      }
    },
    drain(): QueryPerfSample | null {
      if (rows.size === 0) {
        return null;
      }
      const at = now();
      const families = [...rows.values()].map((row) => ({
        family: row.family,
        count: row.count,
        slowCount: row.slowCount,
        maxDurationMs: Math.round(row.maxDurationMs),
        buckets: row.buckets,
      }));
      rows.clear();
      const windowMs = Math.max(0, Math.round(at - windowStartedAt));
      windowStartedAt = at;
      return { windowMs, slowQueryThresholdMs, families };
    },
  };
}

/** ASCII codes the classifier compares against, upper-case. */
const CHAR_A = 65;
const CHAR_Z = 90;
const LOWER_TO_UPPER_OFFSET = 32;
const CHAR_SPACE = 32;
const CHAR_TAB = 9;
const CHAR_NEWLINE = 10;
const CHAR_CARRIAGE_RETURN = 13;
const CHAR_OPEN_PAREN = 40;
const CHAR_SLASH = 47;
const CHAR_STAR = 42;
const CHAR_HYPHEN = 45;

/**
 * How far into a statement the classifier will look for its leading keyword. A
 * statement whose keyword is not inside this window is `other` — the point is a
 * bounded, allocation-free read, not a SQL parser.
 */
const KEYWORD_SCAN_LIMIT = 512;

function isSpace(code: number): boolean {
  return (
    code === CHAR_SPACE ||
    code === CHAR_TAB ||
    code === CHAR_NEWLINE ||
    code === CHAR_CARRIAGE_RETURN
  );
}

/**
 * Index of the first character of the leading keyword, skipping leading
 * whitespace, wrapping parentheses, `-- line` comments and slash-star blocks.
 * Prisma prefixes some statements with a comment, and a compound `SELECT` may be
 * parenthesised, so both would otherwise classify as `other`.
 */
function firstKeywordIndex(sql: string): number {
  const limit = Math.min(sql.length, KEYWORD_SCAN_LIMIT);
  let i = 0;
  while (i < limit) {
    const code = sql.charCodeAt(i);
    if (isSpace(code) || code === CHAR_OPEN_PAREN) {
      i += 1;
    } else if (code === CHAR_HYPHEN && sql.charCodeAt(i + 1) === CHAR_HYPHEN) {
      i = skipToLineEnd(sql, i + 2, limit);
    } else if (code === CHAR_SLASH && sql.charCodeAt(i + 1) === CHAR_STAR) {
      i = skipBlockComment(sql, i + 2, limit);
    } else {
      return i;
    }
  }
  return limit;
}

function skipToLineEnd(sql: string, from: number, limit: number): number {
  let i = from;
  while (i < limit && sql.charCodeAt(i) !== CHAR_NEWLINE) {
    i += 1;
  }
  return i;
}

function skipBlockComment(sql: string, from: number, limit: number): number {
  let i = from;
  while (i < limit) {
    if (
      sql.charCodeAt(i) === CHAR_STAR &&
      sql.charCodeAt(i + 1) === CHAR_SLASH
    ) {
      return i + 2;
    }
    i += 1;
  }
  return limit;
}

/**
 * Whether `sql` continues with `keyword` at `from`, case-insensitively, followed
 * by a non-letter (so `SELECTED` does not read as `SELECT`). Compares in place —
 * no slice, no lower-casing, no allocation.
 */
function keywordAt(sql: string, from: number, keyword: string): boolean {
  if (from + keyword.length > sql.length) {
    return false;
  }
  for (let i = 0; i < keyword.length; i++) {
    let code = sql.charCodeAt(from + i);
    if (code >= CHAR_A + LOWER_TO_UPPER_OFFSET) {
      code -= LOWER_TO_UPPER_OFFSET;
    }
    if (code !== keyword.charCodeAt(i)) {
      return false;
    }
  }
  const next = sql.charCodeAt(from + keyword.length);
  if (Number.isNaN(next)) {
    return true;
  }
  const upper =
    next >= CHAR_A + LOWER_TO_UPPER_OFFSET
      ? next - LOWER_TO_UPPER_OFFSET
      : next;
  return !(upper >= CHAR_A && upper <= CHAR_Z);
}

/**
 * The leading keyword of each family, in match order. A flat list rather than a
 * lookup keyed by the statement text, because the key would be the unbounded
 * thing we are refusing to build.
 */
const FAMILY_KEYWORDS: readonly (readonly [string, SqlStatementFamily])[] = [
  ["SELECT", SqlStatementFamily.Select],
  ["WITH", SqlStatementFamily.Select],
  ["INSERT", SqlStatementFamily.Insert],
  ["REPLACE", SqlStatementFamily.Insert],
  ["UPDATE", SqlStatementFamily.Update],
  ["DELETE", SqlStatementFamily.Delete],
  ["PRAGMA", SqlStatementFamily.Pragma],
  ["CREATE", SqlStatementFamily.Ddl],
  ["ALTER", SqlStatementFamily.Ddl],
  ["DROP", SqlStatementFamily.Ddl],
  ["BEGIN", SqlStatementFamily.Transaction],
  ["COMMIT", SqlStatementFamily.Transaction],
  ["ROLLBACK", SqlStatementFamily.Transaction],
  ["SAVEPOINT", SqlStatementFamily.Transaction],
  ["RELEASE", SqlStatementFamily.Transaction],
];

/**
 * Classify a statement into its {@link SqlStatementFamily}. Total: an
 * unrecognised or empty statement is `other` rather than an error, because this
 * runs inside the measurement path and must never become the measured work's
 * failure.
 */
export function sqlStatementFamily(sql: string): SqlStatementFamily {
  const start = firstKeywordIndex(sql);
  for (const [keyword, family] of FAMILY_KEYWORDS) {
    if (keywordAt(sql, start, keyword)) {
      return family;
    }
  }
  return SqlStatementFamily.Other;
}

/** The bucket a duration falls in, including the trailing overflow bucket. */
function bucketIndex(durationMs: number): number {
  for (let i = 0; i < QUERY_DURATION_BUCKET_BOUNDS_MS.length; i++) {
    if (durationMs <= QUERY_DURATION_BUCKET_BOUNDS_MS[i]) {
      return i;
    }
  }
  return QUERY_DURATION_BUCKET_BOUNDS_MS.length;
}

function emptyFamilySample(family: SqlStatementFamily): QueryPerfFamilySample {
  return {
    family,
    count: 0,
    slowCount: 0,
    maxDurationMs: 0,
    buckets: new Array<number>(QUERY_DURATION_BUCKET_BOUNDS_MS.length + 1).fill(
      0
    ),
  };
}
