// ISS-6136 — the shared IN-list chunking bound and the helpers that run the
// slices, split out of `session-pr-links.ts`. That file owns the session→PR
// predicates and the merged-PR classification; how an id list is partitioned and
// how the partitions are executed is a concern of its own, with its own callers
// (five, only one of which is `session-pr-links.ts`) and its own suite,
// `session-pr-links-chunking.test.ts`.

import type { LimitFunction } from "p-limit";
import { mapWithDbConcurrency } from "./db-fanout";

/**
 * Ceiling on a single `IN (…)` list, so no id-keyed read below can push past the
 * driver's bind-parameter limit and turn a wide window into a rejected statement.
 * Exported so a caller composing its own id-keyed read chunks on the SAME bound
 * rather than picking a second one — see {@link readInIdChunks}.
 */
export const LINK_BRANCH_QUERY_CHUNK_SIZE = 500;

/**
 * Splits an id list into {@link LINK_BRANCH_QUERY_CHUNK_SIZE}-wide slices.
 *
 * The one place the `IN`-list bound is applied, so every id-keyed read chunks on
 * the same number instead of each picking its own.
 */
export function chunkQueryIds(ids: readonly string[]): string[][] {
  const chunks: string[][] = [];
  for (
    let offset = 0;
    offset < ids.length;
    offset += LINK_BRANCH_QUERY_CHUNK_SIZE
  ) {
    chunks.push(ids.slice(offset, offset + LINK_BRANCH_QUERY_CHUNK_SIZE));
  }
  return chunks;
}

/**
 * Runs `read` once per {@link chunkQueryIds} chunk and concatenates the rows.
 *
 * ISS-6136: chunks run under `mapWithDbConcurrency`, not one at a time. The
 * "connection storm" this loop was serialized to avoid is what that helper
 * exists to bound — it caps in-flight calls at `DB_FANOUT_MAX_CONCURRENCY` and
 * runs them under a `withDbAcquisitionBudget` that JOINS an ambient budget
 * rather than opening a second ceiling, so a nested fan-out cannot stack. The
 * alternatives were never just "sequential" and "unbounded" — a BOUNDED fan-out
 * is the third. Serializing cost the whole chunk count in round trips: on a
 * production `/agent-sessions/usage` trace (17.4 s, 134 `postgresql.query`
 * spans) the three chunked reads on this path spent 4.2 s of wall clock with
 * never more than ONE of their own queries in flight, while the request's
 * 5-wide budget sat idle — peak in-flight depth reached 5 for 605 ms of those
 * 17.4 s.
 *
 * **NOT safe to call from inside an interactive transaction.** `withDb` joins an
 * ambient transaction, so a caller reaching here from within
 * `withBranchProductReadSnapshot` (or any `withDb.tx`) issues
 * `DB_FANOUT_MAX_CONCURRENCY` statements on ONE pinned connection: the driver
 * queues them, so the concurrency buys nothing, and when one rejects every
 * sibling already sent comes back `25P02` — one legible error becomes N. A
 * transactional caller must pass `pLimit(1)` as `limiter`, built per call;
 * `readOrgMergedPullRequestAdmissionByBranchId` in `pull-request-population.ts`
 * is the worked example. No caller does it today — both live callers are on the
 * non-transactional usage path — but the hazard is a property of this helper,
 * not of theirs.
 *
 * `loadSessionLocCost` (`agent-components/loc-per-dollar.ts`) still chunks
 * strictly serially and its test pins that on purpose; this change deliberately
 * does not reach it. Not because bounded fan-out would be wrong there, but
 * because that loop fails OPEN per chunk while this one is fail-fast, and
 * nothing has measured it the way the traces above measured this path. Two
 * policies for the same shape is a drift risk, tracked rather than resolved
 * here.
 *
 * Order-preserving, because `mapWithDbConcurrency` is: the concatenation is
 * still a direct function of chunk order then within-chunk order, which callers
 * that index into the result depend on.
 *
 * @param limiter Pass a shared limiter when a caller runs this CONCURRENTLY with
 *   another fan-out, so the two share one call budget instead of stacking — or
 *   a per-call `pLimit(1)` to opt out of fan-out entirely, per the transaction
 *   note above.
 */
export async function readInIdChunks<Row>(
  ids: readonly string[],
  read: (chunk: string[]) => Promise<Row[]>,
  limiter?: LimitFunction
): Promise<Row[]> {
  const chunkRows = await mapWithDbConcurrency(
    chunkQueryIds(ids),
    (chunk) => read(chunk),
    limiter
  );
  const rows: Row[] = [];
  for (const rowsForChunk of chunkRows) {
    // Appended one at a time rather than spread into `push`. Chunking bounds the
    // ID LIST, not the row count — neither caller's `read` supplies a `take`,
    // deliberately — and a spread passes every row as an argument, so one
    // chunk's ~125k rows throw `RangeError: Maximum call stack size exceeded`
    // instead of returning. Behaviour-identical on every input.
    for (const row of rowsForChunk) {
      rows.push(row);
    }
  }
  return rows;
}

/**
 * Sums `count` over the same chunks. The chunks partition the id list, so the
 * sum is the whole-population count — not an approximation of one.
 *
 * Concurrency and the `limiter` argument carry the same meaning as
 * {@link readInIdChunks}.
 */
export async function countInIdChunks(
  ids: readonly string[],
  count: (chunk: string[]) => Promise<number>,
  limiter?: LimitFunction
): Promise<number> {
  const counts = await mapWithDbConcurrency(
    chunkQueryIds(ids),
    (chunk) => count(chunk),
    limiter
  );
  let total = 0;
  for (const chunkCount of counts) {
    total += chunkCount;
  }
  return total;
}
