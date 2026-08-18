/**
 * @file db-host-op-lanes.ts
 * @description ISS-5941 — the db-host's op ADMISSION POLICY, extracted from
 * `db-host-worker.ts` so the routing decision is executable in a test.
 *
 * The worker is a `utilityProcess` entry: it registers a `process.parentPort`
 * listener at module load, so nothing can import it to check which lane an op
 * lands in. The policy therefore lives here, and the worker's `dispatchInvoke`
 * consumes it — there is one decision, in one place, and a test can drive it.
 *
 * ## The three lanes
 *
 * - **Exclusive** ({@link HEAVY_STORE_OPS} + the insights recompute) — a width-1
 *   mutex. These are whole-corpus scans whose peaks must never SUM.
 * - **Bounded read** ({@link BOUNDED_READ_OPS}) — a semaphore. Heavy reads that
 *   must not be serialized behind a backfill, but must not fan out without
 *   limit either.
 * - **Ungated** (everything else) — every other op on the invoke surface. Most
 *   are cheap and user-facing; some (the DATA_REVISION rebuild's writes,
 *   `importer.importSession`) are neither, and remain ungated because this
 *   change deliberately did not widen its blast radius. See "What this does not
 *   fix" below.
 *
 * ## Why the bounded lane exists (ISS-5941)
 *
 * FEA-3150 built the memory-aware admission governor, and it works — but it was
 * only ever wired to two `store:` backfills and `dashboard.getInsights`. Every
 * other op reaches the runtime through the worker's GENERIC invoke path, which
 * takes neither the gate's pre-admission wait nor the backfill's memory-aware
 * yield. `db-host-worker.ts` already said so in an aside about the DATA_REVISION
 * rebuild; the heavy `syncSource` reads in {@link BOUNDED_READ_OPS} are the same
 * hole, and they are the ones the Sessions surface fans out.
 *
 * ISS-6027 widened that set to the whole-corpus `dashboard.*` reads, which
 * ISS-5938 had moved onto the same reader pool through the same ungated generic
 * path. See {@link BOUNDED_READ_OPS} for why they meet the membership criterion.
 *
 * No single call site is unbounded — the total is what nothing caps. ONE
 * Sessions page request peaks at 4 concurrent (see
 * {@link SESSIONS_PAGE_MAX_CONCURRENT_BOUNDED_OPS} for the phase-by-phase
 * derivation), but other surfaces — branch trace, session detail,
 * agent-components — issue their own alongside it, and the renderer can have
 * several requests outstanding at once. Nothing anywhere caps that sum, and
 * every in-flight call holds its own result set live, so peak memory is linear
 * in it. Measured at a 15-way fan-out on a seeded large-account corpus, bounding
 * it at the shipped ceiling of 2 cut peak JS heap from 2236/1530 MB to
 * 1046/1131 MB (two runs per arm; full numbers in the PR).
 *
 * ## What this lane is NOT justified by (read before citing "exit code 5")
 *
 * A db-host `exit (code: 5)` is NOT itself evidence of a V8 heap OOM, and this
 * lane does not claim it is. PR #2806 root-caused the recurring code-5 exits as
 * a TRAPPED NATIVE FAILURE — the child's reported exit code is the SIGNAL number
 * (SIGTRAP→5 on Electron 39), and the real cause was an `@libsql/client`
 * connection leak, since patched. A genuine JS-heap OOM prints a `FATAL ERROR`
 * banner on the piped stderr first. See the RCA at the top of `db-host-client.ts`
 * and the standing warning in `shared-branches-api.ts`: re-add admission control
 * only alongside NEW evidence of real memory pressure at the call site, never as
 * a reprise of the corrected "exit 5 = OOM" theory.
 *
 * The evidence this lane rests on is that new measurement, not that attribution:
 * a 15-way fan-out of these ops on a seeded corpus holds 2174/2173 MB of
 * peak JS heap against a ~4 GiB pointer-compression cage, and at a larger corpus
 * the same ungated fan-out reproduces a REAL heap OOM — `FATAL ERROR: Ineffective
 * mark-compacts near heap limit`, rc=134, banner and all. That is a measured
 * headroom problem at these call sites, and it is what the ceiling addresses.
 *
 * ## Why the bound is 2
 *
 * Heap, and only heap, is what has numbers behind it. At the same 15-way
 * fan-out, a ceiling of 2 roughly HALVED peak JS heap while 4 cut it 38% — so 2
 * is worth about double on the axis this lane exists to defend. See
 * {@link BOUNDED_READ_OP_LIMIT}.
 *
 * **No latency measurement exists at any ceiling**, so nothing here should be
 * read as a latency trade-off that was evaluated. An earlier revision set the
 * ceiling to one whole page request's width (4) to stop a lone request queueing
 * against itself and called that a guarantee; it was an argument, not a
 * measurement, and it is the rejected alternative now. What the lane throttles
 * is both ADDITIONAL concurrent surfaces piling onto the same worker AND, at
 * this width, the widest phase of a single request.
 *
 * `DEFAULT_READER_POOL_SIZE` is also 2, which makes the ceiling free for part of
 * the traffic and is worth stating precisely because an earlier revision of this
 * file had the relationship backwards. For a phase made only of
 * `aggregateUsage`, the POOL is the binding constraint, not the lane:
 * `aggregateSqliteUsage` wraps its reads in one `prisma.read` `$transaction` and
 * holds a single reader connection for its whole duration, so concurrent facet
 * aggregates beyond 2 would sit on the adapter's per-connection mutex holding a
 * lane permit while executing no SQL at all. At a ceiling of 2 they simply wait
 * in the lane instead, at no throughput cost.
 *
 * ISS-6027 is why that paragraph reads "for part of the traffic" and not "for
 * the traffic": it holds only between ops that are BOTH in the lane, and the
 * `dashboard.*` reads ISS-5938 put on this pool were not. Adding them narrows
 * the gap, it does not close it — `dashboard.getInsights` draws on the same 2
 * connections from the EXCLUSIVE lane, and ungated ops elsewhere on the invoke
 * surface still issue their own `prisma.read`. So a bounded op can still find
 * both connections busy while holding a permit. This is a bound on the ops named
 * in {@link BOUNDED_READ_OPS}, never an invariant over the pool.
 *
 * The cost is real in the MIXED phases, where a gated op is NOT holding a reader
 * connection for its whole life: `loadSyncedSessions` interleaves `prisma.write`
 * flushes and cooperative loop yields between its read chunks,
 * `loadUsageSessions` folds its rows in JS after the read returns, and
 * `getWorkflowData` / `getAnalytics` put most of their work on the WRITER client
 * as typed counts (FEA-2211) — sequentially ahead of the pool reads in the
 * former, concurrently with them in the latter's one `Promise.all`. There,
 * width past the pool would have let JS/write work overlap someone else's SQL,
 * and a ceiling of 2 gives that up. That is the known, accepted cost of this
 * value.
 *
 * Neither op is made lazy and neither result is truncated: every caller still
 * receives the complete aggregate/hydration it asked for. The bound changes WHEN
 * work runs, never WHAT it returns.
 *
 * ## What this does not fix
 *
 * - **A single oversized read.** The lane bounds the concurrent term only. One
 *   full-event-data hydration of a large session set can exceed the heap by
 *   itself, and no ceiling above 0 prevents that. The FEA-2038 `omitEventData`
 *   discipline on corpus-wide callers remains load-bearing.
 *
 *   ISS-6027 makes the "one result set" half of `limit × one result set` a
 *   LOOSER figure than it reads: a permit is per OP, and `dashboard.getPacks` /
 *   `getAnalytics` / `getCoreFeatures` fold several corpus reads inside one op —
 *   `getCoreFeatures` fans out five concurrently. Gating them is still strictly
 *   tighter than the ungated status quo, because those same reads previously ran
 *   with no permit at all, and gating the PARTS is not available: an internal
 *   call never re-enters `runInvokeOp`, so only the outer op has a seam. What
 *   bounds a single bundle's own peak is its constituent reads' SQL-side folds
 *   (ISS-5629/ISS-5630/ISS-5631), not this ceiling.
 * - **A wedged writer.** `loadSyncedSessions` interleaves `prisma.write`
 *   flushes, so if the single write queue wedges, its tasks hold permits until
 *   the process restarts and the lane stops admitting. That is strictly worse
 *   than before for `aggregateUsage`, which is read-only and was previously
 *   immune. ISS-6027 adds a second exposure of the same shape: the dashboard
 *   members' typed counts run on the WRITER connection, so a long-running write
 *   blocks them on that connection's mutex while they hold permits — reached
 *   through connection contention rather than the write queue, but with the same
 *   effect on the lane. Accepted knowingly: a wedged writer already hangs every
 *   `loadSyncedSessions` caller, and a permit timeout would break the bound this
 *   lane exists to guarantee. If it ever bites, the fix is to make the writes
 *   evictable (ISS-4572's owner-token mechanism), not to widen the lane.
 * - **An interactive read queued behind a corpus-scale background one.** The
 *   cloud-sync lane's batch `loadSyncedSessions`
 *   (`agent-session-sync-service.ts`, main process, so it arrives here as this
 *   same op) draws from the SAME permits, and during first-launch backfill it
 *   runs continuously. So a Sessions page load can queue behind a sync
 *   hydration. That is the freeze a semaphore was picked over a mutex to avoid,
 *   narrowed from "always" to "often" rather than eliminated — the ceiling
 *   caps how many can hold permits, it does not prioritize between them.
 *
 *   ISS-6027 widens that gap to a second pair: a dashboard load's ten ops and a
 *   Sessions poll now share one FIFO queue, so each can wait on the other. Both
 *   are INTERACTIVE, which is why neither is marked background — ISS-6079's
 *   `runAsBackgroundDbReads` deprioritises background PASSES, and ranking two
 *   user-facing surfaces against each other is a product decision, not an
 *   implementation one. A priority lane (interactive ops jumping the queue) is
 *   the fix if it bites;
 *   sizing by caller is the same problem as the op-name gap recorded on
 *   {@link BOUNDED_READ_OPS}.
 * - **Heavy ops that reach the worker OUTSIDE a named namespace.** ISS-5957
 *   closed the "nothing forces a newly-added heavy op to declare a lane" hole
 *   for the three namespaces where both prior escapes happened — a new
 *   `syncSource.*`, `dashboard.*`, or named Branch read now fails `tsc` until
 *   someone declares its lane (`db-host-op-lane-registry.ts`). It did NOT close
 *   it for the open-ended `prisma.client.<model>.<method>` and raw
 *   `$queryRawUnsafe` paths the proxy also serves, which is how the raw Branch
 *   corpus reads in `database/branch-reads.ts` still arrive. That key space
 *   cannot be enumerated by `keyof`, so a green `tsc` is not proof that every
 *   heavy read is classified. ISS-5941 called this "a separate mechanism"; it
 *   still is.
 */

import { BOUNDED_READ_OPS } from "./db-host-op-lane-registry.js";
import {
  type AdmissionGate,
  type BoundedLaneTiming,
  type BoundedOpLane,
  createBoundedOpLane,
  createHeavyOpGate,
} from "./heavy-op-gate.js";

/**
 * Store ops (keyed by the suffix after `store:`) that are memory-heavy corpus
 * scans and MUST serialize against the insights recompute via the shared
 * heavy-op gate so their heap peaks never SUM past the single worker's heap.
 * These are the `*.backfill` jobs that scan thousands of transcripts/sessions.
 *
 * Everything else on the store-op surface — trace-comment create/reply/list,
 * plan confirm/reject, overlay reads/writes, catalog seed, etc. — is cheap and
 * often user-facing, so it runs UNGATED. Gating the whole surface (the earliest
 * approach) queued those interactive ops behind a full backfill for its entire
 * duration, which is exactly what we must avoid.
 */
export const HEAVY_STORE_OPS: ReadonlySet<string> = new Set<string>([
  "artifactLinks.backfill",
  "activitySegments.backfill",
]);

/**
 * The MAXIMUM number of {@link BOUNDED_READ_OPS} a SINGLE Sessions page request
 * can have in flight at once. `getSharedAgentSessionsPageData` runs in two
 * sequential phases, so this is the larger of the two, not their sum:
 *
 * 1. `Promise.allSettled([getSharedAgentSessions, getSharedAgentSessionUsage])`
 *    — 2 concurrent (the list `loadSyncedSessions` and the usage
 *    `aggregateUsage`).
 * 2. `applyFacetScopedCounts`, awaited AFTER phase 1 has fully settled — a
 *    `Promise.all` issuing one relaxed usage read per FILTERED facet dimension.
 *    There are exactly 4 dimensions (Owner, Harness, Model, Repository), so this
 *    phase peaks at 4 when the user has filtered on all of them, and issues
 *    nothing at all when they have filtered on none.
 *
 * So 4 is an upper bound on GATED concurrency, and a tight one now that the
 * `canUseAggregateSessionFilters` fallback (`loadUsageSessions`) is in the lane
 * too: a filtered facet read takes a permit on EITHER branch, so the phase peaks
 * at 4 whichever way it resolves. It stays an upper bound because each branch
 * inside `getSharedAgentSessions` / `getSharedAgentSessionUsage` issues its own
 * reads sequentially, so no single branch ever holds two permits.
 *
 * This is a fact about the PAGE, not the lane's ceiling — see
 * {@link BOUNDED_READ_OP_LIMIT}, which is deliberately LOWER. It is retained
 * because it is the exact size of the self-queueing cost that ceiling accepts:
 * a fully-filtered page request wants 4 permits and will get them 2 at a time.
 */
export const SESSIONS_PAGE_MAX_CONCURRENT_BOUNDED_OPS = 4;

/**
 * ISS-5957 — the same fact for the BRANCHES surface, derived the same way, and
 * the reason admitting the two named Branch reads costs that surface nothing.
 *
 * `getSharedBranchesPageData` — the widest Branches request — also runs in
 * sequential phases, and each phase contains at most ONE bounded op:
 *
 * 1. `Promise.all([readBranchTokenAggregateRows, readBranchCanonicalActivityRows])`
 *    — 1 bounded (the activity read; the token aggregate is a `prisma.client.*`
 *    path and takes no permit).
 * 2. `Promise.allSettled([buildBranchListResult, buildAnalyticsHalf])`, awaited
 *    after phase 1 settles. `buildBranchListResult` issues only `prisma.client.*`
 *    reads. Inside `buildAnalyticsHalf`, `readCanonicalBranchMetricEventRows`
 *    contributes the single `readBranchMetricEventEvidence`; its two siblings in
 *    that `Promise.all` are `prisma.client.*` paths.
 *
 * The standalone list (`getSharedBranches`), the detail read, and the analytics
 * and cohort readers are all the same shape or narrower — in every one, the
 * activity read is awaited AFTER the `Promise.all` that carries the evidence
 * read, never alongside it. So no Branches request ever wants a second permit,
 * and unlike a fully-filtered Sessions request (which wants 4 and gets 2 at a
 * time) it pays NO self-queueing cost at {@link BOUNDED_READ_OP_LIMIT}.
 *
 * The cost of admitting them is therefore purely CROSS-surface — a Branches read
 * can now wait behind a Sessions or dashboard one, and vice versa — which is the
 * identical trade ISS-6027 accepted for `dashboard.*`, and it is recorded under
 * "What this does not fix" rather than claimed away.
 */
export const BRANCHES_PAGE_MAX_CONCURRENT_BOUNDED_OPS = 1;

/**
 * Concurrency ceiling for {@link BOUNDED_READ_OPS}.
 *
 * **2, chosen for heap headroom** — deliberately BELOW
 * {@link SESSIONS_PAGE_MAX_CONCURRENT_BOUNDED_OPS}, so a fully-filtered Sessions
 * page request does queue against itself, 2 permits at a time.
 *
 * That trade is the point. Heap is the axis this lane exists to fix, and it is
 * the axis that was actually measured: at a 15-way fan-out on a seeded corpus, a
 * ceiling of 2 roughly HALVED peak JS heap (2236/1530 → 1046/1131 MB) where 4
 * cut it 38%. Roughly double the win, on the only metric with numbers behind it.
 *
 * That measurement was taken on the three `syncSource.*` members and has NOT
 * been repeated for the `dashboard.*` members ISS-6027 added — several of which
 * fold multiple corpus reads into one permit, so the "×1 result set per permit"
 * reading of the bound does not transfer. It is still the right ceiling for
 * them (they were previously ungated entirely), but do not read the numbers
 * above as evidence about the dashboard fan-out. See "What this does not fix".
 *
 * **Neither value has a latency measurement. Do not let this comment grow one.**
 * An earlier revision picked 4 to avoid single-request head-of-line blocking and
 * described that as a guarantee; it never was — no page-load latency was
 * measured at 2, at 4, or ungated. So 4 was not better-evidenced than 2, only
 * less conservative, and against a measured heap win the conservative value is
 * the one to hold.
 *
 * The known cost, recorded rather than buried: for the MIXED phases — where a
 * gated op is not holding a reader connection for its whole life
 * (`loadSyncedSessions` interleaving `prisma.write` flushes and loop yields,
 * `loadUsageSessions` folding rows in JS after its read) — a ceiling of 2 gives
 * up overlap a wider lane would have allowed, and a filtered page request pays
 * one extra round of queueing. If that shows up as a real latency regression,
 * the answer is a MEASUREMENT and then a considered change, not a quiet bump.
 *
 * It lands exactly on `DEFAULT_READER_POOL_SIZE` (also 2), which is a useful
 * coincidence rather than the derivation: for a phase made only of
 * `aggregateUsage` the pool already caps execution at 2, so there the ceiling
 * costs nothing at all.
 */
export const BOUNDED_READ_OP_LIMIT = 2;

export type DbHostOpLanes = {
  /** Width-1 mutex — the insights recompute takes this directly. */
  runExclusive: <T>(task: () => Promise<T>) => Promise<T>;
  /** Route a `store:` op by its key: exclusive when heavy, otherwise immediate. */
  runStoreOp: <T>(storeKey: string, task: () => Promise<T>) => Promise<T>;
  /** Route a generic dotted invoke op: bounded when heavy-read, else immediate. */
  runInvokeOp: <T>(
    op: string,
    task: () => Promise<T>,
    options?: { background?: boolean }
  ) => Promise<T>;
};

/**
 * Build the worker's lanes. Both lanes share ONE `admit` gate — the FEA-3150
 * memory-aware pre-admission wait — so a heavy op never starts on top of an
 * existing RSS/heap high-water regardless of which lane it took.
 */
export function createDbHostOpLanes(opts?: {
  admit?: AdmissionGate;
  /**
   * Profiling seam: called once per completed BOUNDED-lane trip with the op
   * name and its admission breakdown. Omitted in production, which is what
   * keeps the lane's own timing off the hot path entirely — `runBounded` reads
   * no clock when it receives no observer.
   *
   * It exists because `db-ops.jsonl` measures an op from the moment the worker
   * dispatches it, so a lane wait is billed to the op as if it were execution.
   * That makes "the query is slow" and "the query waited" the same number, and
   * they have opposite fixes.
   */
  onBoundedTiming?: (op: string, timing: BoundedLaneTiming) => void;
}): DbHostOpLanes {
  const admit = opts?.admit;
  const onBoundedTiming = opts?.onBoundedTiming;
  const { runExclusive } = createHeavyOpGate({ admit });
  const readLane: BoundedOpLane = createBoundedOpLane({
    limit: BOUNDED_READ_OP_LIMIT,
    admit,
  });

  return {
    runExclusive,
    runStoreOp<T>(storeKey: string, task: () => Promise<T>): Promise<T> {
      return HEAVY_STORE_OPS.has(storeKey) ? runExclusive(task) : task();
    },
    runInvokeOp<T>(
      op: string,
      task: () => Promise<T>,
      options?: { background?: boolean }
    ): Promise<T> {
      if (!BOUNDED_READ_OPS.has(op)) {
        return task();
      }
      return readLane.runBounded(
        task,
        onBoundedTiming
          ? (timing) => onBoundedTiming(op, timing)
          : /* production: no observer, so no clock reads at all */ undefined,
        options
      );
    },
  };
}
