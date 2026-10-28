/**
 * @file db-host-invoke-dispatch.ts
 * @description ISS-5941 — the db-host's invoke DISPATCH, extracted from
 * `db-host-worker.ts` so the routing decision is executable against synthetic
 * inputs rather than merely inspectable.
 *
 * The worker is a `utilityProcess` entry: it registers a `process.parentPort`
 * listener at module load, so nothing can import it to drive `dispatchInvoke`.
 * Before this split the only available guard was an AST scan proving the three
 * `opLanes.*` method names appeared somewhere inside that function — which a
 * dead call or an unconditional bypass would have kept green. The dispatch body
 * now lives here behind an injected-dependency seam, and its tests execute the
 * real branch.
 *
 * ## Delivery happens INSIDE the lane — across BOTH hops
 *
 * `deliver` posts the successful result over IPC, and it is awaited from within
 * the op's lane permit rather than after it. That boundary is load-bearing: the
 * corpus-sized result is live in this process until main holds it. Releasing
 * the permit at the moment the callable resolved would let the next queued
 * hydration start while a full result set is still in flight, and the lane's
 * `limit × one result set` heap bound would not cover the real IPC lifetime.
 *
 * ISS-8246 M1 moved execution onto a store thread, which put a SECOND hop in
 * that lifetime. ISS-12022 made that hop a transfer of the bytes the store
 * thread encoded, and the hop to main a post of those bytes, paged past one
 * page and only as main pulls. Both sit inside the permit — `runOnStore`
 * resolves only after the bytes land here, and `deliver` resolves only once
 * main has pulled the last page — so the bound still covers the result's whole
 * real lifetime. Hoisting either out would let a corpus-sized read escape
 * `BOUNDED_READ_OP_LIMIT` while a copy of it is still in flight.
 *
 * The permit does NOT span store-side execution alone, and that is the point of
 * the milestone: the store thread runs the op while this thread keeps answering
 * messages.
 *
 * The insights branch is the deliberate exception: `InsightsResultCache`
 * single-flights the recompute, so one computing caller's value is handed to
 * every concurrent requester and to later cache hits that never enter a lane at
 * all. Delivery there belongs to each caller, outside the gate.
 *
 * ## Which ops take which lane is the REGISTRY's decision, not this file's
 *
 * Both branches match against sets exported by `db-host-op-lane-registry.ts` —
 * `EXCLUSIVE_OPS` here, `BOUNDED_READ_OPS` inside `runInvokeOp`. Neither is
 * restated as a literal. ISS-5957's review caught the exclusive half hard-coded
 * as `"dashboard.getInsights"` while the registry independently declared the
 * same op `Exclusive`: two statements of one fact, free to drift, with the
 * registry's the one that read like policy and the dispatcher's the one that
 * actually ran.
 */

import type { Importer } from "../../dashboard/agent-dashboard-db-types.js";
import type { DesktopPrisma } from "../prisma-client.js";
import type { WriteDispatchProbe } from "../write-queue.js";
import { EXCLUSIVE_OPS } from "./db-host-op-lane-registry.js";
import type { DbHostOpLanes } from "./db-host-op-lanes.js";
import { DB_HOST_STORE_OP_PREFIX } from "./db-host-store-op-registry.js";

/**
 * Everything `dispatchDbHostInvoke` needs from the worker module, injected so
 * the dispatch is import-safe. Each member is the worker's real collaborator;
 * a test supplies a synthetic one and drives the same branches.
 */
export type DbHostInvokeDeps = {
  /** The admission lanes (`db-host-op-lanes.ts` owns which op takes which). */
  lanes: DbHostOpLanes;
  /**
   * True once the store thread has reported itself open. Checked here rather
   * than on the store thread so a pre-Init op fails without paying a round
   * trip; the store repeats the check, and with the same message, because a
   * caller must not be able to tell which side refused.
   */
  isOpen: () => boolean;
  /**
   * Run one op on the store thread — dotted runtime path or `store:` op alike;
   * the store resolves which. Resolves after the result has crossed back, so a
   * caller holding a lane permit holds it across that hop too.
   */
  runOnStore: (
    op: string,
    args: unknown[],
    cancellationToken?: string
  ) => Promise<unknown>;
  /**
   * ISS-7256 — answer {@link UNDISPATCHED_WRITE_PROBE_OP} from the dispatcher's
   * mirror of the store thread's write queue. Backed by
   * `write-dispatch-mirror.ts`, and it must never touch `runOnStore`: this op is
   * asked precisely when the store thread cannot answer.
   */
  probeUndispatchedWrite: (token: string) => WriteDispatchProbe;
  /** FEA-2055 insights cache: single-flight + debounce around the recompute. */
  getInsights: (
    args: unknown[],
    compute: (markReadStart: () => void) => Promise<unknown>
  ) => Promise<unknown>;
  /**
   * Post the successful result to the main process. Awaited INSIDE the op's
   * lane permit for gated ops, so the permit spans the transfer — see this
   * file's header.
   */
  deliver: (value: unknown) => void | Promise<void>;
};

/**
 * Resolve a dotted op path against the open runtime and CALL it.
 *
 * ISS-8246 M1 — this runs on the store thread (`db-store-host.ts`), which is the
 * only side holding the runtime. It lives here, beside {@link resolveDbHostOp},
 * rather than in the store host, for the reason that module cannot be imported
 * by a test: the store host's graph opens SQLite. Keeping the resolve-and-call
 * decision in an import-safe module is what lets `db-host op is not callable`
 * stay covered by an executed branch instead of an assertion about source text.
 */
export function callDbHostOp(
  root: object,
  op: string,
  args: unknown[]
): Promise<unknown> {
  const { fn, thisArg } = resolveDbHostOp(root, op);
  if (typeof fn !== "function") {
    throw new Error(`db-host op is not callable: ${op}`);
  }
  // Dynamic dispatch boundary: the op path + args are validated against the
  // SqliteAgentDatabase contract on the main-process proxy side.
  const callable = fn as (...callArgs: unknown[]) => unknown;
  return Promise.resolve(callable.apply(thisArg, args));
}

/** Resolve a dotted op path (e.g. "sessions.getAll") to its fn + receiver. */
export function resolveDbHostOp(
  root: object,
  op: string
): { fn: unknown; thisArg: unknown } {
  const parts = op.split(".");
  let thisArg: unknown;
  let target: unknown = root;
  for (const part of parts) {
    if (typeof target !== "object" || target === null) {
      throw new Error(`db-host op not found: ${op}`);
    }
    thisArg = target;
    target = Reflect.get(target, part);
  }
  return { fn: target, thisArg };
}

/**
 * Route one invoke request to its lane, run it, and deliver its result.
 *
 * Returns nothing: the successful value reaches main through `deps.deliver`
 * (called inside the lane), and a throw propagates to the caller, which posts
 * the error response.
 */
export async function dispatchDbHostInvoke(
  op: string,
  args: unknown[],
  deps: DbHostInvokeDeps,
  /**
   * ISS-6079: forwarded from `DbHostInvokeRequest.background`. Optional, and
   * absent means interactive — see that field for why the default is not
   * "background".
   */
  options?: {
    background?: boolean;
    /**
     * ISS-9802: forwarded from `DbHostInvokeRequest.cancellationToken`. Absent
     * means the op is uncancellable, which is every op that predates this field.
     */
    cancellationToken?: string;
  }
): Promise<void> {
  const cancellationToken = options?.cancellationToken;
  if (!deps.isOpen()) {
    throw new Error("db-host not initialized");
  }
  // ISS-7256 (whitlockk review) — the ONE op answered here instead of on the store
  // thread, and the reason is the op itself. `importSessionBounded` asks it at a
  // deadline that fires BECAUSE the store thread is inside a long synchronous
  // write, so forwarding it would park the request on the very thread whose
  // blockage is the question. It waits out the caller's 5 s backstop, resolves
  // to no evidence, and the bound takes the old expiry path — the production
  // topology drops the waiter and ISS-7256 fixes nothing. Answered from the
  // dispatcher's mirror, it costs one round trip to a thread that measured a 2 ms
  // worst-case silent window after ISS-8246 M1.
  //
  // The EVICTION (`importer.cancelInFlightWrite`) is deliberately NOT here: it
  // mutates the queue, so only the thread that owns it may run it, and
  // `db-host-invoke-dispatch.test.ts` pins that it still forwards.
  if (op === UNDISPATCHED_WRITE_PROBE_OP) {
    await deps.deliver(deps.probeUndispatchedWrite(probeToken(args)));
    return;
  }
  if (op.startsWith(DB_HOST_STORE_OP_PREFIX)) {
    const storeKey = op.slice(DB_HOST_STORE_OP_PREFIX.length);
    // Only the memory-heavy backfills serialize against the insights recompute
    // (below) via the shared heavy-op gate so their peaks never sum past the
    // worker heap. Lightweight/interactive store ops run immediately so they
    // never queue behind a long-running backfill.
    await deps.lanes.runStoreOp(storeKey, async () => {
      await deps.deliver(await deps.runOnStore(op, args, cancellationToken));
    });
    return;
  }
  // ISS-8246 M1 — resolving the dotted path against the runtime happens on the
  // STORE THREAD, which is the only side holding it. `db-host op is not
  // callable: <op>` still reaches the caller verbatim; it just travels back as
  // a serialized error instead of being thrown here.
  //
  // FEA-2055 — gate the heavy insights computation behind the result cache so
  // concurrent dashboard sections / toggles / backfill churn don't stampede the
  // child. A cache MISS calls the SAME native fn verbatim, so the result is
  // byte-identical to an uncached call.
  // ISS-5957 — the EXCLUSIVE lane is read from the registry, not from a literal
  // restated here. `DashboardOpLaneMap` pins that set to the single insights op,
  // which is what lets this branch apply the cache's single-flight semantics to
  // everything the registry declares exclusive.
  if (EXCLUSIVE_OPS.has(op)) {
    // The cache handles single-flight + debounce + insights-vs-insights bound;
    // a real (cache-miss) recompute additionally takes the shared heavy-op gate
    // so it can never run concurrently with a backfill/store-op chunk.
    //
    // Delivery is OUTSIDE the gate here, unlike every other branch: the cache
    // hands one computed value to every concurrent requester, and serves later
    // hits without entering a lane at all, so the permit cannot span each
    // caller's own post.
    const value = await deps.getInsights(args, (markReadStart) =>
      deps.lanes.runExclusive(() => {
        // Snapshot the freshness epoch AFTER the gate is acquired — at the true
        // read moment — so a long wait behind a backfill/store-op chunk doesn't
        // back-date the cached entry and trigger needless recomputes.
        markReadStart();
        return deps.runOnStore(op, args, cancellationToken);
      })
    );
    await deps.deliver(value);
    return;
  }
  // ISS-5941 — this generic path took NO admission control at all. The heavy
  // corpus reads the Sessions surface fans out now take the bounded read lane;
  // every other op still runs immediately. Policy: `db-host-op-lanes.ts`.
  await deps.lanes.runInvokeOp(
    op,
    async () => {
      const value = await deps.runOnStore(op, args, cancellationToken);
      // Inside the permit on purpose: BOTH hops this result crosses — the store
      // thread's reply above and main's delivery below — keep the result set
      // live, so the lane's heap bound must cover the pair. See the header.
      await deps.deliver(value);
    },
    options
  );
}

/**
 * ISS-7256: the op path main's proxy builds for the read-only dispatch probe.
 *
 * Spelled from `keyof Importer` rather than typed out, so renaming the method
 * fails `tsc` here instead of leaving a dispatcher branch that silently stops
 * matching and quietly forwards the probe to a thread that cannot answer it —
 * which is the exact failure this branch exists to prevent, and it would be
 * invisible: the bound would just go back to expiring.
 */
const UNDISPATCHED_WRITE_PROBE_METHOD =
  "hasUndispatchedWrite" satisfies keyof Importer;
export const UNDISPATCHED_WRITE_PROBE_OP =
  `importer.${UNDISPATCHED_WRITE_PROBE_METHOD}` as const;

/**
 * The session id from a probe's args, or `""` for anything else.
 *
 * A dynamic-dispatch boundary: `args` crossed a structured clone, so its shape
 * is not constrained by the caller's types. An unusable token resolves to `""`,
 * which the mirror has never seen and answers `Absent` for — the same
 * no-evidence answer every other unknown on this path takes, and one that never
 * extends a bound.
 */
function probeToken(args: unknown[]): string {
  const token = args[0];
  return typeof token === "string" ? token : "";
}

/**
 * ISS-12023 (PRD-785): the op path the db-host uses to make the store release
 * its per-connection page caches after a heavy-gate op.
 *
 * Spelled from `keyof DesktopPrisma` for the same reason
 * {@link UNDISPATCHED_WRITE_PROBE_OP} is spelled from `keyof Importer`: this
 * reaches the runtime through the dotted-path resolver, so a rename would leave
 * a string that silently resolves to nothing and a reclaim that silently stops
 * happening. Here it fails `tsc` instead.
 */
const PRISMA_SHRINK_MEMORY_METHOD =
  "shrinkMemory" satisfies keyof DesktopPrisma;
export const PRISMA_SHRINK_MEMORY_OP =
  `prisma.${PRISMA_SHRINK_MEMORY_METHOD}` as const;
