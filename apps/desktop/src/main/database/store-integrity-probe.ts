/**
 * @file store-integrity-probe.ts
 * @description FEA-1999 — desktop SQLite store integrity-health signal.
 *
 * A periodic, cheap, off-the-hot-path probe of the local SQLite/libSQL store. It
 * turns a silent, user-reported store corruption into a fleet dashboard metric:
 *
 *   1. `PRAGMA quick_check(N)` — the cheap variant of `integrity_check` (it skips
 *      the expensive per-index table cross-scan), with `N` capping the reported
 *      error count so a corrupt store can never produce an unbounded result set.
 *   2. index-presence — every index the embedded migration manifest declares must
 *      still exist in `sqlite_master`. This is the FEA-1968-class regression guard
 *      (a corruptible/expected index silently dropped); `quick_check` does not
 *      flag a *missing* index, only an inconsistent one, so this is complementary.
 *
 * AC2 (no IPC-latency regression): the probe runs on the reader pool
 * (`prisma.read`), whose `query_only` connections read a committed WAL snapshot
 * concurrently with the writer — it never takes the write lock and never
 * serializes behind a store write or an IPC read. The poll timer is `unref()`'d
 * (never keeps the app alive), the first run is delayed and skipped while a boot
 * import is in progress (the first-launch backfill hot path), and a concurrency
 * guard drops a tick if the prior check is still running.
 *
 * AC1 (never row content): raw SQLite error strings are NEVER forwarded. Each is
 * classified into a bounded {@link StoreIntegrityIssue} carrying only a category
 * enum and a single `[A-Za-z0-9_]` schema identifier (an index/table name)
 * extracted from the message — rowids, page numbers, and column values are
 * dropped. Modeled on the existing `createApiErrorWatchdog` poller (watchdog.ts);
 * kept electron-free so it (and its test) import only the Prisma/telemetry types.
 */

import type {
  StoreIntegrityCheckName,
  StoreIntegrityDiagnostics,
  StoreIntegrityIssue,
  StoreIntegrityIssueCategory,
  StoreIntegrityObjectType,
} from "../telemetry-protocol.js";
import { MIGRATIONS } from "./migrations-manifest.js";

/** Default poll interval. Integrity drift is rare and the probe is cheap, so a
 *  slow cadence keeps fleet telemetry volume negligible. */
export const STORE_INTEGRITY_INTERVAL_MS_DEFAULT = 30 * 60 * 1000; // 30 min
/** Delay before the FIRST probe so it never lands on the first-launch backfill. */
export const STORE_INTEGRITY_INITIAL_DELAY_MS_DEFAULT = 5 * 60 * 1000; // 5 min
/** `N` in `PRAGMA quick_check(N)` — caps reported errors (bounds cost/payload). */
export const STORE_INTEGRITY_MAX_ERRORS_DEFAULT = 32;
/** Cap on issues carried in the emitted diagnostics (the rest are counted only). */
export const STORE_INTEGRITY_MAX_REPORTED_ISSUES_DEFAULT = 16;
/** Defensive cap on a forwarded object identifier (mirrors the server schema). */
const MAX_OBJECT_IDENTIFIER_LENGTH = 128;

export type TokenParityResult = {
  usageInput: number;
  usageOutput: number;
  usageCacheRead: number;
  usageCacheWrite: number;
  eventsInput: number;
  eventsOutput: number;
  eventsCacheRead: number;
  eventsCacheWrite: number;
  divergentSessionCount: number;
};

/** The minimal read surface the probe needs, satisfied structurally by the
 *  desktop `SqliteAgentDatabase`. The probe runs in the MAIN process, so it
 *  cannot pass a `prisma.read` callback across the db-host method proxy (a
 *  function can't be structured-cloned over IPC). Instead it calls the
 *  clone-safe `runStoreIntegrityCheck` method, which runs the reads on the
 *  reader pool INSIDE the db host and returns plain rows (FEA-2252). Kept
 *  structural so the probe stays trivially fakeable in tests. */
export type StoreIntegrityReader = {
  runStoreIntegrityCheck(maxErrors: number): Promise<{
    quickRows: Record<string, unknown>[];
    indexRows: { name: string }[];
  }>;
  runTokenParityCheck?(): Promise<TokenParityResult>;
};

export type StoreIntegrityProbeOptions = {
  /** Sink for each probe result. The wiring passes
   *  `Observability.storeIntegrityResult`, which owns the emit cadence. */
  emit: (diagnostics: StoreIntegrityDiagnostics) => void;
  intervalMs?: number;
  initialDelayMs?: number;
  maxErrors?: number;
  maxReportedIssues?: number;
  /** When provided and it returns true, the tick is skipped (boot import is on
   *  the hot path). The next interval re-evaluates it. */
  isBootImportInProgress?: () => boolean;
  /** Migration manifest to derive expected indexes from. Defaults to the
   *  embedded {@link MIGRATIONS}; injectable for tests. */
  migrations?: readonly { readonly sql: string }[];
  log?: (message: string) => void;
  now?: () => number;
};

export type StoreIntegrityProbe = {
  /** Run one probe and return its (un-emitted) diagnostics. Exposed for tests
   *  and used internally by the poll tick. */
  runOnce(): Promise<StoreIntegrityDiagnostics>;
  start(): void;
  stop(): void;
};

function maybeUnref(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === "object" && timer && "unref" in timer) {
    timer.unref();
  }
}

/** First own-enumerable value of a row object. `PRAGMA quick_check` returns a
 *  single column whose name is engine-defined (libSQL surfaces it as
 *  `quick_check`), so we read positionally rather than by key to stay robust to
 *  that name. */
function firstRowValue(row: unknown): unknown {
  if (row && typeof row === "object") {
    for (const value of Object.values(row as Record<string, unknown>)) {
      return value;
    }
  }
  return undefined;
}

const IDENTIFIER_RE = /[A-Za-z0-9_]+/;

/** A clamped, identifier-only copy of a captured schema name. */
function safeIdentifier(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  // The capture groups below already constrain to [A-Za-z0-9_]; this is a
  // belt-and-braces clamp so an identifier can never carry length or content
  // beyond a schema name.
  const match = value.match(IDENTIFIER_RE);
  if (!match) {
    return undefined;
  }
  return match[0].slice(0, MAX_OBJECT_IDENTIFIER_LENGTH);
}

type MessageRule = {
  re: RegExp;
  category: StoreIntegrityIssueCategory;
  objectType: StoreIntegrityObjectType;
};

// Known `PRAGMA quick_check` / `integrity_check` message shapes. Each rule
// captures ONLY a schema identifier (group 1, `[A-Za-z0-9_]+`) — never the rest
// of the message — so the forwarded `object` can never carry row content. The
// first matching rule wins; anything unmatched degrades to `other` with NO
// object (e.g. structural "Page N: ..." lines).
const MESSAGE_RULES: readonly MessageRule[] = [
  {
    re: /\brow\s+\d+\s+missing from index\s+([A-Za-z0-9_]+)/i,
    category: "missing_index_entry",
    objectType: "index",
  },
  {
    re: /\browid\s+\d+\s+missing from index\s+([A-Za-z0-9_]+)/i,
    category: "missing_index_entry",
    objectType: "index",
  },
  {
    re: /\bwrong\s*#\s*of entries in index\s+([A-Za-z0-9_]+)/i,
    category: "wrong_index_entry_count",
    objectType: "index",
  },
  {
    re: /\bnon-unique entry in index\s+([A-Za-z0-9_]+)/i,
    category: "non_unique_index_entry",
    objectType: "index",
  },
  {
    re: /\bNULL value in\s+([A-Za-z0-9_]+)\.[A-Za-z0-9_]+/i,
    category: "constraint",
    objectType: "table",
  },
  {
    re: /\bCHECK constraint failed in\s+([A-Za-z0-9_]+)/i,
    category: "constraint",
    objectType: "table",
  },
  {
    re: /\bforeign key mismatch[^A-Za-z0-9_]+([A-Za-z0-9_]+)/i,
    category: "constraint",
    objectType: "table",
  },
];

// Structural-corruption phrases that carry no object name we can safely surface.
const MALFORMED_PATTERN =
  /\b(page|tree|cell|freelist|btreeinitpage|database (disk image|page)|never used|fragment|multiple uses|offset|out of order|misuse)\b/i;

/**
 * Classify one `quick_check` output row into a redacted issue, or `null` when
 * the row is the healthy `"ok"` sentinel (or otherwise empty/non-string).
 */
export function classifyQuickCheckRow(
  value: unknown
): StoreIntegrityIssue | null {
  if (typeof value !== "string") {
    return null;
  }
  const text = value.trim();
  if (text === "" || text.toLowerCase() === "ok") {
    return null;
  }

  for (const rule of MESSAGE_RULES) {
    const match = text.match(rule.re);
    if (match) {
      const object = safeIdentifier(match[1]);
      return {
        check: "quick_check",
        category: rule.category,
        ...(object ? { object, objectType: rule.objectType } : {}),
      };
    }
  }

  if (MALFORMED_PATTERN.test(text)) {
    return { check: "quick_check", category: "malformed_structure" };
  }
  return { check: "quick_check", category: "other" };
}

// One alternation matched left-to-right so DDL is applied in TEXTUAL order
// within a migration (a `DROP INDEX x; CREATE INDEX x …` recreate must leave x
// present, not removed). Alternative 1 = CREATE INDEX (groups 1=index, 2=table);
// alternative 2 = DROP INDEX (group 3=index); alternative 3 = DROP TABLE
// (group 4=table).
const INDEX_DDL_RE =
  /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([A-Za-z0-9_]+)"?\s+ON\s+"?([A-Za-z0-9_]+)"?|DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?"?([A-Za-z0-9_]+)"?|DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?"?([A-Za-z0-9_]+)"?/gi;
const SQL_LINE_COMMENT_RE = /--[^\n]*/g;

/**
 * Derive the net set of index names the migration manifest declares, applying
 * each migration's DDL in textual order: a `CREATE [UNIQUE] INDEX [IF NOT
 * EXISTS] <name> ON <table>` adds, a `DROP INDEX <name>` removes that index, and
 * a `DROP TABLE <table>` removes every index that was created on that table
 * (SQLite drops a table's indexes implicitly). Order matters within a single
 * migration too — a drop-then-recreate of the same index must leave it present —
 * so all three are matched by one left-to-right alternation rather than three
 * category-grouped passes. `--` line comments are stripped first (mirroring the
 * migration runner) so a DDL keyword inside a comment is never matched. The
 * manifest is the build-time SSOT (auto-generated from the migration files), so
 * this stays in sync automatically. Auto-indexes (`sqlite_autoindex_*`, created
 * implicitly for UNIQUE/PK constraints) are never named in migration DDL, so
 * they are never expected here and never falsely flagged.
 */
export function extractExpectedIndexNames(
  migrations: readonly { readonly sql: string }[]
): string[] {
  // index name → the table it was declared on (for DROP TABLE cascade).
  const indexTable = new Map<string, string>();
  for (const migration of migrations) {
    const sql = migration.sql.replace(SQL_LINE_COMMENT_RE, "");
    for (const match of sql.matchAll(INDEX_DDL_RE)) {
      const [, createdIndex, createdTable, droppedIndex, droppedTable] = match;
      if (createdIndex) {
        indexTable.set(createdIndex, createdTable);
      } else if (droppedIndex) {
        indexTable.delete(droppedIndex);
      } else if (droppedTable) {
        // Collect-then-delete so the cascade never mutates the Map mid-iteration.
        const orphaned = [...indexTable.entries()]
          .filter(([, table]) => table === droppedTable)
          .map(([indexName]) => indexName);
        for (const indexName of orphaned) {
          indexTable.delete(indexName);
        }
      }
    }
  }
  return [...indexTable.keys()];
}

function classifyIndexPresence(
  indexRows: { name: string }[] | undefined,
  expectedIndexNames: string[],
  issues: StoreIntegrityIssue[]
): void {
  const presentIndexes = new Set(
    (Array.isArray(indexRows) ? indexRows : []).map((row) => row.name)
  );
  for (const expected of expectedIndexNames) {
    if (!presentIndexes.has(expected)) {
      issues.push({
        check: "index_presence",
        category: "missing_index",
        object: expected,
        objectType: "index",
      });
    }
  }
}

function classifyTokenParity(
  parity: TokenParityResult,
  issues: StoreIntegrityIssue[]
): void {
  const fields: Array<{ name: string; usage: number; events: number }> = [
    {
      name: "input_tokens",
      usage: parity.usageInput,
      events: parity.eventsInput,
    },
    {
      name: "output_tokens",
      usage: parity.usageOutput,
      events: parity.eventsOutput,
    },
    {
      name: "cache_read_tokens",
      usage: parity.usageCacheRead,
      events: parity.eventsCacheRead,
    },
    {
      name: "cache_write_tokens",
      usage: parity.usageCacheWrite,
      events: parity.eventsCacheWrite,
    },
  ];
  for (const field of fields) {
    if (field.usage !== field.events) {
      issues.push({
        check: "token_parity",
        category: "token_store_divergence",
        object: field.name,
        objectType: "unknown",
      });
    }
  }
  if (parity.divergentSessionCount > 0) {
    issues.push({
      check: "token_parity",
      category: "token_store_divergence",
      object: "token_events",
      objectType: "table",
    });
  }
}

export function createStoreIntegrityProbe(
  reader: StoreIntegrityReader,
  options: StoreIntegrityProbeOptions
): StoreIntegrityProbe {
  const intervalMs = options.intervalMs ?? STORE_INTEGRITY_INTERVAL_MS_DEFAULT;
  const initialDelayMs =
    options.initialDelayMs ?? STORE_INTEGRITY_INITIAL_DELAY_MS_DEFAULT;
  const maxErrors = options.maxErrors ?? STORE_INTEGRITY_MAX_ERRORS_DEFAULT;
  const maxReportedIssues =
    options.maxReportedIssues ?? STORE_INTEGRITY_MAX_REPORTED_ISSUES_DEFAULT;
  const log = options.log ?? (() => {});
  const now = options.now ?? (() => Date.now());
  const expectedIndexNames = extractExpectedIndexNames(
    options.migrations ?? MIGRATIONS
  );

  let initialTimer: ReturnType<typeof setTimeout> | null = null;
  let interval: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function runOnce(): Promise<StoreIntegrityDiagnostics> {
    const startedAt = now();
    const checksRun: StoreIntegrityCheckName[] = [];
    const issues: StoreIntegrityIssue[] = [];

    checksRun.push("quick_check", "index_presence");
    // Runs both reads in ONE reader-pool dispatch INSIDE the db host: quick_check
    // and the index-presence query observe the SAME committed WAL snapshot (a
    // schema migration landing between two separate reads could otherwise make
    // the two checks disagree). `quick_check(N)` early-exits after N reported
    // errors (bounding the payload on a corrupt store); a healthy store is still
    // fully page-scanned, which is why this runs on the reader pool off the hot
    // path. `durationMs` ships to Datadog so an oversized store is observable.
    const { quickRows, indexRows } =
      await reader.runStoreIntegrityCheck(maxErrors);

    if (Array.isArray(quickRows)) {
      for (const row of quickRows) {
        const issue = classifyQuickCheckRow(firstRowValue(row));
        if (issue) {
          issues.push(issue);
        }
      }
    }

    classifyIndexPresence(indexRows, expectedIndexNames, issues);

    if (reader.runTokenParityCheck) {
      try {
        const parity = await reader.runTokenParityCheck();
        checksRun.push("token_parity");
        classifyTokenParity(parity, issues);
      } catch (error) {
        log(
          `store-integrity: token parity check failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    const issueCount = issues.length;
    const truncated = issueCount > maxReportedIssues;
    return {
      healthy: issueCount === 0,
      durationMs: Math.max(0, Math.round(now() - startedAt)),
      checksRun,
      issueCount,
      issues: truncated ? issues.slice(0, maxReportedIssues) : issues,
      truncated,
    };
  }

  async function tick(): Promise<void> {
    if (running) {
      return;
    }
    if (options.isBootImportInProgress?.()) {
      log("store-integrity: skipped (boot import in progress)");
      return;
    }
    running = true;
    try {
      options.emit(await runOnce());
    } catch (error) {
      log(
        `store-integrity check failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    } finally {
      running = false;
    }
  }

  return {
    runOnce,
    start(): void {
      if (initialTimer || interval) {
        return;
      }
      // Arm both: a one-shot for the first (delayed) probe and the recurring
      // interval. `tick` is passed by reference — it is internally guarded and
      // never rejects, mirroring the `setInterval(check, …)` pattern in
      // watchdog.ts. The concurrency guard inside `tick` prevents the one-shot
      // and the first interval fire from overlapping.
      initialTimer = setTimeout(tick, initialDelayMs);
      maybeUnref(initialTimer);
      interval = setInterval(tick, intervalMs);
      maybeUnref(interval);
    },
    stop(): void {
      if (initialTimer) {
        clearTimeout(initialTimer);
        initialTimer = null;
      }
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    },
  };
}
