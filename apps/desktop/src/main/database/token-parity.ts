/**
 * @file token-parity.ts
 * @description The token_usage↔token_events parity check — the one
 * SCHEMA-COUPLED thread that used to run through the three `store-integrity-*`
 * modules. Those modules moved to `database-integrity/`, which is deliberately
 * engine-level only (`PRAGMA quick_check`, `sqlite_master`, WAL depth, DB-file
 * process holders) and must never name one of our tables; this module owns
 * everything about the parity check that does.
 *
 * Three pieces live here, all previously split across that trio:
 *  - the parity SOURCE POLICY (`tokenUsageEventParitySourceFilter`): the Codex
 *    OTel writer persists to `token_usage` but not `token_events`, so OTel-only
 *    rows must be excluded from any usage-vs-events reconciliation. It is shared
 *    with the FEA-3232 cost-conservation predicate (`token-cost-writes.ts`) and
 *    the heal passes (`token-cost-maintenance.ts`) so the policies cannot drift;
 *  - the READ (`runTokenParityCheck`), which is clone-safe and runs on the
 *    reader pool inside the db host;
 *  - the CLASSIFIER (`classifyTokenParity`) plus the wire schema the value is
 *    validated against as it crosses the db-host method proxy.
 *
 * `tokenParityCheck` composes them into the probe's generic optional-check
 * descriptor, so the probe stays free of any token knowledge and the wiring
 * (which is already schema-aware) injects this check rather than the probe
 * importing it. The dependency therefore runs one way only — this module imports
 * `database-integrity/`, never the reverse.
 */

import { z } from "zod";
import type { StoreIntegrityIssue } from "../telemetry/telemetry-protocol.js";
import {
  defineStoreIntegrityOptionalCheck,
  type StoreIntegrityOptionalCheck,
} from "./database-integrity/store-integrity-probe.js";
import type { DesktopPrisma } from "./prisma-client.js";

/** The token-parity totals, as returned by the read and as they arrive across
 *  the db-host method proxy. */
export type TokenParityResult = {
  usageInput: number;
  usageOutput: number;
  usageCacheRead: number;
  usageCacheWrite: number;
  eventsInput: number;
  eventsOutput: number;
  eventsCacheRead: number;
  eventsCacheWrite: number;
  /**
   * Divergent `(session_id, model)` PAIRS, not sessions — the comparison groups
   * by both, so one session disagreeing on three models contributes three. The
   * classifier range-checks it and then tests it for `> 0`, but it crosses the
   * db-host proxy as part of this contract, so read it as a pair count.
   */
  divergentSessionCount: number;
};

/** The minimal reader surface the parity check needs, satisfied structurally by
 *  the desktop `SqliteAgentDatabase` (and by the db-host proxy in production).
 *  Optional for the same reason the probe's other optional checks are: a test
 *  fake, or a version-skewed host, need not serve it. */
export type TokenParityReader = {
  runTokenParityCheck?(): Promise<TokenParityResult>;
};

/**
 * token_usage rows eligible for token_events parity/conservation comparison.
 * The Codex OTel writer persists to token_usage but not token_events, so
 * OTel-only rows must be excluded from any usage-vs-events reconciliation —
 * shared by {@link runTokenParityCheck} and the FEA-3232 cost-conservation
 * predicate (token-cost-writes.ts) so the two policies cannot drift. Pass the
 * token_usage table alias when the query joins other relations, so the
 * `usage_source` reference stays unambiguous if a joined side ever grows a
 * column of the same name.
 */
export function tokenUsageEventParitySourceFilter(alias = ""): string {
  const prefix = alias ? `${alias}.` : "";
  return `COALESCE(${prefix}usage_source, 'jsonl_parser') != 'otel_log_payload'`;
}

export const TOKEN_USAGE_EVENT_PARITY_SOURCE_FILTER =
  tokenUsageEventParitySourceFilter();

/**
 * The token-parity totals as they arrive ACROSS the db-host method proxy.
 *
 * This boundary validates SHAPE, not plausibility, and the split is deliberate
 * (ISS-5342). A missing key, a `null`, a string, a `NaN` — anything that is not
 * a JS number — means the value did not come from the read above at all (a
 * version-skewed host, a partial row), so it fails this parse and drops the
 * whole check: it is omitted from `checksRun` rather than feeding a nonsense
 * total to the classifier.
 *
 * A number that IS a number but cannot be a token total — negative, fractional,
 * past the safe-integer range — is a different fact, and it deliberately parses.
 * Neither `token_usage` nor `token_events` carries a nonnegative CHECK on its
 * `BIGINT` columns, so a corrupt store produces such a total from the REAL
 * query. Rejecting it here would route genuine store corruption through
 * `runOptionalCheck`'s transport-failure catch, which logs locally and returns
 * BEFORE appending to `checksRun` or `issues` — leaving `healthy` true and
 * publishing nothing to the monitored `storeIntegrityResult` event. Letting it
 * through means {@link classifyTokenParity} reports it as a bounded corruption
 * issue on that monitored path instead.
 */
export const TOKEN_PARITY_RESULT_SCHEMA = z.object({
  usageInput: z.number(),
  usageOutput: z.number(),
  usageCacheRead: z.number(),
  usageCacheWrite: z.number(),
  eventsInput: z.number(),
  eventsOutput: z.number(),
  eventsCacheRead: z.number(),
  eventsCacheWrite: z.number(),
  divergentSessionCount: z.number(),
});

/**
 * The four token columns both stores carry, summed identically on each side.
 * Written ONCE and shared by all four aggregates below (each store's grand
 * total, and each store's per-`(session_id, model)` grouping) on purpose: a
 * column added to one copy of this list and missed on another would make the two
 * sides incomparable — reporting permanent divergence, or silently ceasing to
 * compare a column — which is exactly the failure this check exists to detect.
 */
const TOKEN_SUM_COLUMNS = `COALESCE(SUM(input_tokens), 0) as input,
    COALESCE(SUM(output_tokens), 0) as output,
    COALESCE(SUM(cache_read_tokens), 0) as cache_read,
    COALESCE(SUM(cache_write_tokens), 0) as cache_write`;

/** One store's token sums, as the adapter surfaces them from a raw read. */
type TokenSumRow = {
  input: bigint;
  output: bigint;
  cache_read: bigint;
  cache_write: bigint;
};

/** One store's token sums per `(session_id, model)`, the grain the divergence
 *  comparison joins on. `where` is the already-built clause (`""` for the store
 *  that takes no filter). */
function groupedTokenSums(table: string, where: string): string {
  return `SELECT session_id, model, ${TOKEN_SUM_COLUMNS}
            FROM ${table} ${where}
            GROUP BY session_id, model`;
}

export function runTokenParityCheck(
  prisma: DesktopPrisma
): Promise<TokenParityResult> {
  // OTel-only rows are excluded via the shared parity-source policy above —
  // the same filter gates the FEA-3232 cost-conservation predicate in
  // token-cost-writes.ts.
  const USAGE_FILTER = `WHERE ${TOKEN_USAGE_EVENT_PARITY_SOURCE_FILTER}`;
  return prisma.read(async (reader) => {
    const [usageRow] = await reader.$queryRawUnsafe<TokenSumRow[]>(
      `SELECT ${TOKEN_SUM_COLUMNS} FROM token_usage ${USAGE_FILTER}`
    );
    const [eventsRow] = await reader.$queryRawUnsafe<TokenSumRow[]>(
      `SELECT ${TOKEN_SUM_COLUMNS} FROM token_events`
    );
    const [divergentRow] = await reader.$queryRawUnsafe<{ cnt: bigint }[]>(
      `SELECT COUNT(*) as cnt FROM (
          SELECT session_id, model FROM (
            ${groupedTokenSums("token_usage", USAGE_FILTER)}
          ) u
          FULL OUTER JOIN (
            ${groupedTokenSums("token_events", "")}
          ) e USING (session_id, model)
          WHERE COALESCE(u.input, 0) != COALESCE(e.input, 0)
            OR COALESCE(u.output, 0) != COALESCE(e.output, 0)
            OR COALESCE(u.cache_read, 0) != COALESCE(e.cache_read, 0)
            OR COALESCE(u.cache_write, 0) != COALESCE(e.cache_write, 0)
        )`
    );
    return {
      usageInput: Number(usageRow?.input ?? 0),
      usageOutput: Number(usageRow?.output ?? 0),
      usageCacheRead: Number(usageRow?.cache_read ?? 0),
      usageCacheWrite: Number(usageRow?.cache_write ?? 0),
      eventsInput: Number(eventsRow?.input ?? 0),
      eventsOutput: Number(eventsRow?.output ?? 0),
      eventsCacheRead: Number(eventsRow?.cache_read ?? 0),
      eventsCacheWrite: Number(eventsRow?.cache_write ?? 0),
      divergentSessionCount: Number(divergentRow?.cnt ?? 0),
    };
  });
}

/**
 * ISS-5342 — is this a total the parity read could legitimately have produced?
 *
 * Every field it returns is a `SUM` over a `BIGINT` token column or a `COUNT`,
 * so the only legitimate values are non-negative integers within JS's exact
 * range. A negative one means a collector wrote a negative token count (nothing
 * in either table's DDL forbids it); a fractional one means the column holds a
 * REAL, which SQLite's INTEGER affinity permits when the value cannot be
 * losslessly narrowed; a value past `MAX_SAFE_INTEGER` means the `bigint`→number
 * coercion in the read already lost precision, so the number is not the sum.
 * `Infinity` fails here too. All three are store facts worth reporting, and none
 * can be compared against the other side without lying about the result.
 */
function isImpossibleTokenTotal(value: number): boolean {
  return !Number.isSafeInteger(value) || value < 0;
}

/** One `token_parity` issue naming a bounded schema identifier — never a value. */
function tokenParityIssue(
  category: "token_store_divergence" | "token_total_out_of_range",
  object: string,
  objectType: "table" | "unknown"
): StoreIntegrityIssue {
  return { check: "token_parity", category, object, objectType };
}

/**
 * Classify ONE token column across both stores: report each side whose total is
 * impossible, and compare the two sides only when BOTH are usable.
 *
 * The suppression is the point. `usage_input_tokens = -5` against
 * `events_input_tokens = 100` is not a store divergence — it is one corrupt
 * total — and emitting `token_store_divergence` for it would point whoever reads
 * the monitor at the wrong root cause while double-counting a single fault.
 */
function classifyTokenParityColumn(
  column: { name: string; usage: number; events: number },
  issues: StoreIntegrityIssue[]
): void {
  const usageImpossible = isImpossibleTokenTotal(column.usage);
  const eventsImpossible = isImpossibleTokenTotal(column.events);
  if (usageImpossible) {
    issues.push(
      tokenParityIssue(
        "token_total_out_of_range",
        `usage_${column.name}`,
        "unknown"
      )
    );
  }
  if (eventsImpossible) {
    issues.push(
      tokenParityIssue(
        "token_total_out_of_range",
        `events_${column.name}`,
        "unknown"
      )
    );
  }
  if (
    !(usageImpossible || eventsImpossible) &&
    column.usage !== column.events
  ) {
    issues.push(
      tokenParityIssue("token_store_divergence", column.name, "unknown")
    );
  }
}

/**
 * BOUNDED by construction: the loop below is over a fixed four-entry column
 * table, and each entry contributes at most two issues (one per side, and the
 * divergence branch is mutually exclusive with them), plus at most one for
 * `divergentSessionCount`. So one run emits at most nine `token_parity` issues
 * however corrupt the store is — the totals are aggregates, so nothing here
 * scales with row count. That stays under the probe's own
 * `maxReportedIssues` cap, which trims the run's combined list afterwards.
 */
export function classifyTokenParity(
  parity: TokenParityResult,
  issues: StoreIntegrityIssue[]
): void {
  const columns: Array<{ name: string; usage: number; events: number }> = [
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
  for (const column of columns) {
    classifyTokenParityColumn(column, issues);
  }
  if (isImpossibleTokenTotal(parity.divergentSessionCount)) {
    issues.push(
      tokenParityIssue(
        "token_total_out_of_range",
        "divergent_session_count",
        "unknown"
      )
    );
    return;
  }
  if (parity.divergentSessionCount > 0) {
    issues.push(
      tokenParityIssue("token_store_divergence", "token_events", "table")
    );
  }
}

/**
 * Compose the parity read + schema + classifier into the probe's generic
 * optional-check descriptor. The wiring passes the result as an `extraChecks`
 * entry, which is how the schema-agnostic probe runs a schema-aware check
 * without importing one.
 *
 * The read is a CLOSURE, never `reader.runTokenParityCheck?.bind(reader)` —
 * detaching a method off the db-host proxy is never valid (it builds the op path
 * `runTokenParityCheck.bind` and posts the non-clone-safe proxy as an argument;
 * that is how ISS-4818 took Desktop down). See the proxy note on
 * `StoreIntegrityReader`.
 */
export function tokenParityCheck(
  reader: TokenParityReader
): StoreIntegrityOptionalCheck {
  return defineStoreIntegrityOptionalCheck({
    name: "token_parity",
    label: "token parity check",
    read: reader.runTokenParityCheck
      ? () => Promise.resolve(reader.runTokenParityCheck?.())
      : undefined,
    schema: TOKEN_PARITY_RESULT_SCHEMA,
    classify: classifyTokenParity,
  });
}
