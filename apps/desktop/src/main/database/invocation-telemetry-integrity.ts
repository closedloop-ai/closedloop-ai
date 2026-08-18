/**
 * @file invocation-telemetry-integrity.ts
 * @description ISS-4976 — the `agent_component_invocations` per-invocation
 * telemetry sanity check, the SCHEMA-COUPLED counterpart to the engine-level
 * probes in `database-integrity/`.
 *
 * The row→wire projection OMITS a per-invocation telemetry value it cannot
 * defend, which is correct for the generation hash (sending it would have the
 * cloud `.strict()` ingest boundary reject the whole part and dead-letter the
 * generation) but leaves the resulting cloud NULL indistinguishable from
 * "capture never computed it". This check is the missing half: it says a
 * collector actually WROTE an impossible value, which is a store-health fact, so
 * it rides the already-monitored FEA-1999 integrity event instead of a new sink.
 *
 * It names one of our tables, so it must NOT live in `database-integrity/` —
 * that directory is deliberately engine-level only (`PRAGMA quick_check`,
 * `sqlite_master`, WAL depth, DB-file process holders). It follows the shape
 * `token-parity.ts` established for exactly this situation: the SQL, the READ,
 * the wire SCHEMA, and the CLASSIFIER live here, and
 * {@link invocationTelemetryCheck} composes them into the probe's generic
 * optional-check descriptor so the schema-aware wiring injects the check rather
 * than the probe importing it. The dependency runs one way only — this module
 * imports `database-integrity/`, never the reverse.
 */

import {
  AGENT_COMPONENT_INVOCATION_MAX_COST,
  AGENT_COMPONENT_INVOCATION_MAX_TOKENS,
  AgentComponentInvocationKind,
} from "@repo/api/src/types/agent-component-invocation";
import { z } from "zod";
import type { StoreIntegrityIssue } from "../telemetry/telemetry-protocol.js";
import {
  defineStoreIntegrityOptionalCheck,
  type StoreIntegrityOptionalCheck,
} from "./database-integrity/store-integrity-probe.js";
import type { DesktopPrisma } from "./prisma-client.js";

/**
 * Bounded, content-free counts of stored invocation rows whose telemetry is
 * impossible rather than absent.
 */
export type InvocationTelemetryIntegrityCounts = {
  outOfRangeTokenRows: number;
  outOfRangeCostRows: number;
  nonSubagentUsageRows: number;
};

/**
 * The minimal reader surface this check needs, satisfied structurally by the
 * desktop `SqliteAgentDatabase` (and by the db-host proxy in production).
 * Optional for the same reason the probe's other optional checks are: a test
 * fake, or a version-skewed host predating this read, need not serve it.
 */
export type InvocationTelemetryReader = {
  runInvocationTelemetryIntegrityCheck?(): Promise<InvocationTelemetryIntegrityCounts>;
};

/** The tally as it arrives ACROSS the db-host method proxy. A version-skewed
 *  host that cannot serve the read fails this parse, which drops the whole
 *  check (it is omitted from `checksRun`) rather than reporting it as clean. */
export const INVOCATION_TELEMETRY_INTEGRITY_SCHEMA = z.object({
  outOfRangeTokenRows: z.number().int().nonnegative(),
  outOfRangeCostRows: z.number().int().nonnegative(),
  nonSubagentUsageRows: z.number().int().nonnegative(),
});

/**
 * Count the stored invocation rows whose per-invocation telemetry is IMPOSSIBLE
 * rather than merely absent. Content-free by construction: it returns three
 * counts and never a row value.
 *
 * @param maxTokens largest token count a safe-integer JSON number can carry
 * @param maxCost largest value the cloud `numeric(14, 6)` cost column can hold
 * @param subagentKind the one `component_kind` allowed to carry turn usage
 */
export function invocationTelemetryIntegritySql(
  maxTokens: number,
  maxCost: number,
  subagentKind: string
): string {
  const tokenColumns = [
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "footprint_tokens",
  ];
  const outOfRangeToken = tokenColumns
    .map(
      (column) =>
        `(${column} IS NOT NULL AND (${column} < 0 OR ${column} > ${maxTokens}))`
    )
    .join(" OR ");
  const usagePresent = ["model", ...tokenColumns.slice(0, 4)]
    .concat("estimated_cost")
    .map((column) => `${column} IS NOT NULL`)
    .join(" OR ");
  return `SELECT
      SUM(CASE WHEN ${outOfRangeToken} THEN 1 ELSE 0 END) AS out_of_range_token_rows,
      SUM(CASE WHEN estimated_cost IS NOT NULL
                AND (estimated_cost < 0 OR estimated_cost > ${maxCost})
               THEN 1 ELSE 0 END) AS out_of_range_cost_rows,
      SUM(CASE WHEN component_kind != '${subagentKind}' AND (${usagePresent})
               THEN 1 ELSE 0 END) AS non_subagent_usage_rows
    FROM agent_component_invocations`;
}

export function runInvocationTelemetryIntegrityCheck(
  prisma: DesktopPrisma
): Promise<InvocationTelemetryIntegrityCounts> {
  return prisma.read(async (reader) => {
    const [row] = await reader.$queryRawUnsafe<
      {
        out_of_range_token_rows: bigint | number | null;
        out_of_range_cost_rows: bigint | number | null;
        non_subagent_usage_rows: bigint | number | null;
      }[]
    >(
      invocationTelemetryIntegritySql(
        AGENT_COMPONENT_INVOCATION_MAX_TOKENS,
        AGENT_COMPONENT_INVOCATION_MAX_COST,
        AgentComponentInvocationKind.Subagent
      )
    );
    return {
      outOfRangeTokenRows: Number(row?.out_of_range_token_rows ?? 0),
      outOfRangeCostRows: Number(row?.out_of_range_cost_rows ?? 0),
      nonSubagentUsageRows: Number(row?.non_subagent_usage_rows ?? 0),
    };
  });
}

/**
 * ISS-4976 (@wongk / @closedloop-ai-stage review) — report that a collector
 * WROTE an impossible per-invocation telemetry value. `object` carries a bounded
 * column identifier only, never a row value, matching the rest of this event.
 */
export function classifyInvocationTelemetry(
  counts: InvocationTelemetryIntegrityCounts,
  issues: StoreIntegrityIssue[]
): void {
  const offenders: Array<{ count: number; object: string }> = [
    { count: counts.outOfRangeTokenRows, object: "token_counts" },
    { count: counts.outOfRangeCostRows, object: "estimated_cost" },
    { count: counts.nonSubagentUsageRows, object: "component_kind" },
  ];
  for (const offender of offenders) {
    if (offender.count > 0) {
      issues.push({
        check: "invocation_telemetry",
        category: "invocation_telemetry_out_of_range",
        object: offender.object,
        objectType: "unknown",
      });
    }
  }
}

/**
 * Compose the read + schema + classifier into the probe's generic optional-check
 * descriptor. The wiring passes the result as an `extraChecks` entry, which is
 * how the schema-agnostic probe runs a schema-aware check without importing one.
 *
 * The read is a CLOSURE, never
 * `reader.runInvocationTelemetryIntegrityCheck?.bind(reader)` — detaching a
 * method off the db-host proxy is never valid (it builds the op path
 * `…Check.bind` and posts the non-clone-safe proxy as an argument; that is how
 * ISS-4818 took Desktop down). See the proxy note on `StoreIntegrityReader`.
 */
export function invocationTelemetryCheck(
  reader: InvocationTelemetryReader
): StoreIntegrityOptionalCheck {
  return defineStoreIntegrityOptionalCheck({
    name: "invocation_telemetry",
    label: "invocation telemetry integrity check",
    read: reader.runInvocationTelemetryIntegrityCheck
      ? () => Promise.resolve(reader.runInvocationTelemetryIntegrityCheck?.())
      : undefined,
    schema: INVOCATION_TELEMETRY_INTEGRITY_SCHEMA,
    classify: classifyInvocationTelemetry,
  });
}
