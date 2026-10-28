/**
 * ISS-9483 (PRD-721 R10-S08) — the population sizes the Sessions list query
 * benchmarks seed, and the replication that reaches them from the parity
 * corpus. Read by `apps/api/app/agent-sessions/service/session-list-query.bench.ts`
 * and `apps/desktop/test/session-list-query.bench.ts`.
 *
 * Pure data and pure functions: no test runner, no database, no Electron.
 */
import type { SessionListParityRow } from "./session-list-parity-model";

/**
 * Sessions in one desktop store: the largest `ipc.session_count` each device
 * reported on a retained `ipc.*` perf span (Datadog APM, service `cl-desktop`,
 * 2026-09-10 to 2026-10-10, 44 devices), at the nearest-rank p50 and p95
 * across devices. The IPC head sampler always emits slow and errored calls
 * and samples the rest (`apps/desktop/src/main/dashboard/agent-dashboard-ipc-perf.ts`),
 * which biases the sample toward larger stores.
 */
export const DESKTOP_STORE_SESSIONS = { p50: 2293, p95: 7865 } as const;

/**
 * `rows` repeated until there are at least `count`, each copy's keys suffixed
 * with its copy number so every key stays unique. Every copy keeps its
 * template's values, so a filter selects the same share of the population at
 * any size. This also means the replicated population holds only as many
 * distinct `lastActivityAt`/cost/priority values as the template has rows
 * (8 for the conform scenario), each repeated `count / 8` times — e.g. at
 * `DESKTOP_STORE_SESSIONS.p95` (7,872 rows), about 984 copies of each. A
 * latency conclusion drawn from a non-indexed/scan-shaped query at that size
 * reflects this low-cardinality distribution's index selectivity and
 * tie-break cost, not a real store's.
 */
export function replicateParityRows(
  rows: readonly SessionListParityRow[],
  count: number
): SessionListParityRow[] {
  const copies = Math.max(1, Math.ceil(count / rows.length));
  return Array.from({ length: copies }, (_, copy) =>
    rows.map((row) => ({ ...row, key: `${row.key}-${copy}` }))
  ).flat();
}
