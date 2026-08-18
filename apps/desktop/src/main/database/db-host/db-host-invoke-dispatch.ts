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
 * ## Delivery happens INSIDE the lane
 *
 * `deliver` posts the successful result over IPC, and it is invoked from within
 * the op's lane permit rather than after it. That boundary is load-bearing: the
 * result is structured-cloned by `postMessage`, so the corpus-sized value is
 * live in this process until the clone completes. Releasing the permit at the
 * moment the callable resolved would let the next queued hydration start while
 * a full result set is still retained through the clone, and the lane's
 * `limit × one result set` heap bound would not cover the real IPC lifetime.
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
  /** The open runtime the dotted op path resolves against; `null` before Init. */
  getRoot: () => object | null;
  /** Run a `store:` op through the store-op registry. */
  runStoreOp: (op: string, args: unknown[]) => Promise<unknown>;
  /** FEA-2055 insights cache: single-flight + debounce around the recompute. */
  getInsights: (
    args: unknown[],
    compute: (markReadStart: () => void) => Promise<unknown>
  ) => Promise<unknown>;
  /**
   * Post the successful result to the main process. Called INSIDE the op's lane
   * permit for gated ops, so the permit spans the structured clone — see this
   * file's header.
   */
  deliver: (value: unknown) => void;
};

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
  options?: { background?: boolean }
): Promise<void> {
  const root = deps.getRoot();
  if (!root) {
    throw new Error("db-host not initialized");
  }
  if (op.startsWith(DB_HOST_STORE_OP_PREFIX)) {
    const storeKey = op.slice(DB_HOST_STORE_OP_PREFIX.length);
    // Only the memory-heavy backfills serialize against the insights recompute
    // (below) via the shared heavy-op gate so their peaks never sum past the
    // worker heap. Lightweight/interactive store ops run immediately so they
    // never queue behind a long-running backfill.
    await deps.lanes.runStoreOp(storeKey, async () => {
      deps.deliver(await deps.runStoreOp(op, args));
    });
    return;
  }
  const { fn, thisArg } = resolveDbHostOp(root, op);
  if (typeof fn !== "function") {
    throw new Error(`db-host op is not callable: ${op}`);
  }
  // Dynamic dispatch boundary: the op path + args are validated against the
  // SqliteAgentDatabase contract on the main-process proxy side.
  const callable = fn as (...callArgs: unknown[]) => unknown;
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
        return Promise.resolve(callable.apply(thisArg, args));
      })
    );
    deps.deliver(value);
    return;
  }
  // ISS-5941 — this generic path took NO admission control at all. The heavy
  // corpus reads the Sessions surface fans out now take the bounded read lane;
  // every other op still runs immediately. Policy: `db-host-op-lanes.ts`.
  await deps.lanes.runInvokeOp(
    op,
    async () => {
      const value = await Promise.resolve(callable.apply(thisArg, args));
      // Inside the permit on purpose: the clone this triggers keeps the result
      // set live, so the lane's heap bound must cover it.
      deps.deliver(value);
    },
    options
  );
}
