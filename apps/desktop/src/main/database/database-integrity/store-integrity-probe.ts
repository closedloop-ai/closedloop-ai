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
 *   2. index-presence — every index name the INJECTED index policy declares must
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
 * dropped. A start/stop interval poller (the shape the former
 * `createApiErrorWatchdog` also used, before it was removed); kept electron-free
 * so it (and its test) import only the Prisma/telemetry types.
 *
 * ── Schema-agnostic by construction ──────────────────────────────────────────
 * Everything above is ENGINE-level: a PRAGMA, SQLite's own `sqlite_master`
 * catalog, and the WAL sidecar. This module — and this whole `database-integrity/`
 * directory — deliberately names no table of ours AND imports no artifact of our
 * schema, so the probe would work against any SQLite store. Every schema-specific
 * input is INJECTED by the schema-aware wiring, never reached for here:
 *
 *   - the index POLICY, via {@link StoreIntegrityProbeOptions.expectedIndexNames}
 *     — `../store-index-policy.ts` derives it from our migration manifest. It
 *     defaults to EMPTY, not to that manifest: a probe pointed at some other
 *     SQLite store must report nothing, not report every Closedloop index missing.
 *   - a check that needs our schema, via
 *     {@link StoreIntegrityProbeOptions.extraChecks} as a
 *     {@link StoreIntegrityOptionalCheck} — `../token-parity.ts` (token_usage vs
 *     token_events) is the one such check today.
 *
 * The dependency therefore runs one way only — schema-aware modules import this
 * directory, never the reverse.
 */

import { z } from "zod";
import {
  type StoreIntegrityCheckName,
  type StoreIntegrityDiagnostics,
  type StoreIntegrityIssue,
  type StoreIntegrityIssueCategory,
  type StoreIntegrityObjectType,
  WalProbeAnomalyReason,
} from "../../telemetry/telemetry-protocol.js";
// TYPE-only: this module is deliberately free of the Prisma/libSQL runtime (see
// the file header), so it must never take a VALUE import from prisma-client.ts.
// The bounded `WalProbeAnomalyReason` the schema below validates against lives in
// telemetry-protocol.ts precisely so this stays type-only.
import type { WalProbeHealth } from "../prisma-client.js";

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

/**
 * One OPTIONAL sub-check, in the type-erased form the probe runs. Build one with
 * {@link defineStoreIntegrityOptionalCheck} rather than by hand — that helper
 * keeps the schema and its classifier bound to the same type without a cast.
 *
 * This is the seam that lets a SCHEMA-AWARE check ride this schema-agnostic
 * probe: the wiring injects it via {@link StoreIntegrityProbeOptions.extraChecks}
 * instead of the probe importing it. `../token-parity.ts` is the one such check
 * today (it aggregates `token_usage` against `token_events`, which is exactly the
 * knowledge this directory must not hold).
 */
export type StoreIntegrityOptionalCheck = {
  name: StoreIntegrityCheckName;
  /** Human-readable label used only in the failure log line. */
  label: string;
  /** `undefined` when the reader cannot serve this check — it is then skipped. */
  read: (() => Promise<unknown>) | undefined;
  /**
   * Parse `raw`, THROWING when it is invalid, and return a classifier bound to
   * the parsed value. Splitting parse from classify keeps the type erasure
   * cast-free; both halves run under the runner's guard, which records the
   * check as RUN only once BOTH have succeeded.
   */
  parse: (raw: unknown) => (issues: StoreIntegrityIssue[]) => void;
};

/**
 * Build a {@link StoreIntegrityOptionalCheck} from a Zod schema plus a typed
 * classifier. The returned descriptor is type-erased so the probe can hold a
 * heterogeneous array of them, but no `as` cast is needed: the parsed value is
 * captured in the closure the `parse` step returns, where it is still `T`.
 */
export function defineStoreIntegrityOptionalCheck<T>(spec: {
  name: StoreIntegrityCheckName;
  label: string;
  read: (() => Promise<unknown>) | undefined;
  schema: z.ZodType<T>;
  classify: (value: T, issues: StoreIntegrityIssue[]) => void;
}): StoreIntegrityOptionalCheck {
  return {
    name: spec.name,
    label: spec.label,
    read: spec.read,
    parse: (raw) => {
      const value = spec.schema.parse(raw);
      return (issues) => spec.classify(value, issues);
    },
  };
}

/** The minimal read surface the probe needs, satisfied structurally by the
 *  desktop `SqliteAgentDatabase`. The probe runs in the MAIN process, so it
 *  cannot pass a `prisma.read` callback across the db-host method proxy (a
 *  function can't be structured-cloned over IPC). Instead it calls the
 *  clone-safe `runStoreIntegrityCheck` method, which runs the reads on the
 *  reader pool INSIDE the db host and returns plain rows (FEA-2252). Kept
 *  structural so the probe stays trivially fakeable in tests.
 *
 *  In production this object IS that db-host method proxy, so never detach one
 *  of its methods with `Function.prototype.bind`/`call`/`apply`. Call optional
 *  methods through a closure on `reader` instead — one op-path call on the
 *  proxy, correct `this` on a plain-object reader.
 *
 *  A detach now fails fast: `bind`/`call`/`apply` are in the proxy's
 *  `NON_OP_PROPS`, so they resolve to `undefined` and the call site throws a
 *  synchronous, local `TypeError`. Before that guard existed the proxy's `get`
 *  trap answered them like any other property, and
 *  `reader.runTokenParityCheck.bind(reader)` silently built the op path
 *  `runTokenParityCheck.bind`, posted it to the child with the
 *  non-clone-safe proxy as an argument, and the unawaited
 *  `DbHostDataCloneError` reached `handleUnhandledRejection`, which shows the
 *  crash dialog and exits the app. That is how this probe (ISS-4818) and, before
 *  it, `syncSource.advanceSyncState` (ISS-4620) each took Desktop down; the
 *  closures below and the trap guard are belt-and-braces against a third.
 *
 *  The proxy answers every op path, so a test fake is the only reader that
 *  actually omits the optional methods. */
export type StoreIntegrityReader = {
  runStoreIntegrityCheck(maxErrors: number): Promise<{
    quickRows: Record<string, unknown>[];
    indexRows: { name: string }[];
  }>;
  /**
   * ISS-4818 — the WAL-depth probe's anomaly tally, read from the db host. Also
   * clone-safe, and optional so a fake reader in a test need not implement it.
   */
  readWalProbeHealth?(): Promise<WalProbeHealth>;
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
  /**
   * The index names this store is expected to declare — the index-presence
   * check reports every one of them that `sqlite_master` does not have.
   *
   * This is a POLICY, and policy is schema knowledge, so it is injected by the
   * schema-aware wiring exactly the way {@link extraChecks} is: see
   * `../store-index-policy.ts`, which derives ours from the migration manifest
   * with {@link extractExpectedIndexNames}. The default is EMPTY rather than
   * that manifest — this directory must hold no schema of ours, and defaulting
   * to it would make the probe report every Closedloop index as missing when
   * pointed at any other SQLite store.
   */
  expectedIndexNames?: readonly string[];
  /**
   * Additional optional sub-checks to run after the built-in engine-level ones,
   * in order. This is how a SCHEMA-AWARE check joins a probe that must not know
   * the schema: the wiring builds it (see `../token-parity.ts`) and passes it
   * here. Each obeys the same contract as the built-ins — skipped when its
   * reader cannot serve it, never able to fail the run it rides alongside, and
   * counted in `checksRun` only once its read actually parsed.
   */
  extraChecks?: readonly StoreIntegrityOptionalCheck[];
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
 * migration runner) so a DDL keyword inside a comment is never matched.
 *
 * The PARSER is engine-level (it reads index DDL, not our tables) so it belongs
 * here; the MANIFEST it is pointed at is schema-specific, so the caller supplies
 * it — `../store-index-policy.ts` passes ours, which is the build-time SSOT
 * auto-generated from the migration files and so stays in sync automatically.
 * Auto-indexes (`sqlite_autoindex_*`, created
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
  expectedIndexNames: readonly string[],
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

/**
 * ISS-4818 — classify the WAL-depth probe's tally into at most ONE issue.
 *
 * A store with no `-wal` sidecar to measure (in-memory / remote) is NOT an
 * anomaly: an unknown depth is the correct answer there, and the producer never
 * counts an attempt for it. `anomalies` therefore already means "reads that were
 * attempted against a measurable store and failed", so a single `> 0` test is
 * the whole predicate — the `measurable` guard here is belt-and-braces against a
 * future producer change, not a second condition.
 *
 * `object` carries the bounded failure-mode enum, not a path: the identifier
 * slot is what reaches Datadog, and the reason is the actionable detail
 * (a malformed value vs a throwing probe point at different root causes), while
 * the `-wal` path is a user filesystem path and must never leave the machine.
 * When no reason was recorded the field is OMITTED rather than filled with a
 * guess — a fabricated failure mode would mislead exactly the person debugging.
 */
function classifyWalProbeHealth(
  health: WalProbeHealth,
  issues: StoreIntegrityIssue[]
): void {
  if (!health.measurable || health.anomalies <= 0) {
    return;
  }
  issues.push({
    check: "wal_frame_probe",
    category: "wal_probe_failure",
    ...(health.lastAnomalyReason
      ? { object: health.lastAnomalyReason, objectType: "unknown" as const }
      : {}),
  });
}

/**
 * Run one OPTIONAL sub-check: skip it entirely when the reader does not
 * implement it, run BOTH its read and its classification under one guard,
 * swallow either failing into a log line, and record it in `checksRun` only
 * once the whole check has succeeded.
 *
 * A failing sub-check must never take down the probe run it rides alongside —
 * `quick_check` / index-presence are the primary signal and always run. That is
 * why the guard spans classification too: a classifier is as much part of an
 * optional check as its read, and letting one escape would throw away the
 * primary diagnostics that had already completed.
 *
 * `checksRun` is the ONLY place "did not run" is distinguishable from "ran and
 * found nothing": the run-level `healthy` is `issueCount === 0`, so a skipped
 * optional check still leaves `healthy` true, and the emit cadence in
 * `Observability.storeIntegrityResult` keys on `healthy`. That is deliberate —
 * an optional check is optional precisely because a host that cannot serve it
 * (an older db-host, a store with no measurable `-wal`) is a normal state, and
 * flipping the whole fleet's store to "unhealthy" for it would drown the real
 * quick_check/index signal. So the honest reading is: `healthy` answers "did any
 * check that ran find a problem", and a consumer that needs "was the WAL probe
 * actually evaluated" must read `checksRun`, which this function keeps truthful
 * by appending only after the read parsed.
 *
 * Both optional checks share this shape, so it lives here once (and keeps
 * `runOnce` inside the cognitive-complexity budget).
 */
async function runOptionalCheck(args: {
  check: StoreIntegrityOptionalCheck;
  checksRun: StoreIntegrityCheckName[];
  issues: StoreIntegrityIssue[];
  log: (message: string) => void;
}): Promise<void> {
  if (!args.check.read) {
    return;
  }
  // Issues land in a SCRATCH array, not straight into `args.issues`: the
  // classifier is inside the guard below, and one that throws part-way must not
  // leave half its issues behind in the run's real list.
  const produced: StoreIntegrityIssue[] = [];
  try {
    // Every optional read crosses the dynamic DB-host method proxy, so what
    // resolves here is `unknown` at runtime however the interface is typed: a
    // version-skewed host can resolve null, a partial row, or a reason string
    // this build has no meaning for. Parse BEFORE anything is recorded.
    const classify = args.check.parse(await args.check.read());
    // Classification runs under the SAME guard as the read. It is part of the
    // optional check, and an optional check can never fail the run it rides
    // alongside; a throwing classifier outside this try would propagate out of
    // `runOnce` and discard the quick_check / index-presence diagnostics that
    // already completed — the exact failure this contract exists to prevent.
    classify(produced);
  } catch (error) {
    args.log(
      `store-integrity: ${args.check.label} failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return;
  }
  // Only now is the check claimed as RUN — a read that threw, a value that
  // failed to parse, or a classifier that threw all leave its name out of
  // `checksRun` and contribute no issues.
  args.checksRun.push(args.check.name);
  args.issues.push(...produced);
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
  const expectedIndexNames = options.expectedIndexNames ?? [];

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

    // ISS-4818 — surface a malformed WAL-frame probe. The checkpoint cadence
    // already degrades gracefully on a bad depth read (ISS-4723 PR1 / ISS-4819:
    // it takes the explicit unknown fallback rather than reading the failure as
    // an empty WAL), but it did so SILENTLY, so a store whose depth read is
    // chronically broken ran with the WAL ceiling backstop disabled and nothing
    // reported it. Riding this already-monitored probe rather than adding a new
    // event gets the cadence for free: `Observability.storeIntegrityResult`
    // emits on first failure, on a change of affected object, on the heartbeat
    // while it persists, and once on recovery.
    await runOptionalCheck({
      check: defineStoreIntegrityOptionalCheck({
        name: "wal_frame_probe",
        label: "wal frame probe health read",
        // A closure, NOT `reader.readWalProbeHealth?.bind(reader)` — detaching a
        // method off the db-host proxy is never valid. See the proxy note on
        // {@link StoreIntegrityReader}.
        read: reader.readWalProbeHealth
          ? () => Promise.resolve(reader.readWalProbeHealth?.())
          : undefined,
        schema: WAL_PROBE_HEALTH_SCHEMA,
        classify: classifyWalProbeHealth,
      }),
      checksRun,
      issues,
      log,
    });

    // Injected schema-aware checks (token parity today) run last, each under the
    // same never-fail-the-run contract as the built-ins above.
    for (const check of options.extraChecks ?? []) {
      await runOptionalCheck({ check, checksRun, issues, log });
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
      // interval. `tick` is passed by reference to `setInterval` — it is
      // internally guarded and never rejects, so an unhandled rejection can
      // never escape a tick. The concurrency guard inside `tick` prevents the
      // one-shot and the first interval fire from overlapping.
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

/**
 * ISS-4818 — the WAL-frame-probe health shape as it arrives ACROSS the db-host
 * method proxy. `lastAnomalyReason` is pinned to the bounded reason enum because
 * that value becomes an issue's `object`, which reaches Datadog: an arbitrary
 * string from a version-skewed host must never get there. An unknown reason
 * fails the parse, which drops the whole check (it is omitted from `checksRun`)
 * rather than shipping a value nobody can act on.
 */
const WAL_PROBE_HEALTH_SCHEMA = z.object({
  measurable: z.boolean(),
  probes: z.number().int().nonnegative(),
  anomalies: z.number().int().nonnegative(),
  lastAnomalyReason: z
    .enum(Object.values(WalProbeAnomalyReason))
    .nullable()
    .default(null),
});
