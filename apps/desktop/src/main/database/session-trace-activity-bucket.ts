import type { ActivityBucket } from "../agent-sync/agent-session-sync-contract.js";

type ActivityBucketModelCosts = ActivityBucket["byModel"][string];

/**
 * The Session Timeline bin's own construction and rounding, split out of
 * `session-trace.ts` (ISS-5999).
 *
 * That file must not grow, and
 * "what one bin is" is a separable responsibility from "which rows and token
 * events go into which bin", which is what stays behind.
 */

/** Cost is carried to the micro-dollar; below that it is rounding noise. */
function roundCostNumber(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/** An empty bin covering `[binStartMs, binEndMs)`, labelled by clock offset. */
export function createActivityBucket({
  binEndMs,
  binStartMs,
  label,
}: {
  binEndMs: number;
  binStartMs: number;
  label: string;
}): ActivityBucket {
  return {
    label,
    cIn: 0,
    cOut: 0,
    cCache: 0,
    total: 0,
    toolStart: 0,
    tl0: null,
    byModel: createModelCostMap(),
    /*
     * ISS-5819 review (whitlockk): the bin's own wall-clock bounds, carried with it.
     * `label` is a formatted OFFSET from the window's start, so the strip alone
     * cannot say which clock it was binned over — and that window is the
     * session's real activity extent, not its `[startedAt, endedAt]`. Without
     * these a clock re-projection downstream has to borrow some other window,
     * and moves measured cost into intervals we never measured.
     */
    binStartMs,
    binEndMs,
  };
}

/** The same bin with every dollar rounded, as it goes onto the sync wire. */
export function roundActivityBucket(bucket: ActivityBucket): ActivityBucket {
  const byModel = Object.fromEntries(
    Object.entries(bucket.byModel).map(([model, costs]) => [
      model,
      {
        cIn: roundCostNumber(costs.cIn),
        cOut: roundCostNumber(costs.cOut),
        cCache: roundCostNumber(costs.cCache),
      },
    ])
  );
  return {
    ...bucket,
    cIn: roundCostNumber(bucket.cIn),
    cOut: roundCostNumber(bucket.cOut),
    cCache: roundCostNumber(bucket.cCache),
    byModel,
  };
}

/**
 * Fold one token event's USD into `bucket.byModel[model]`, opening the entry on
 * first sight. The only sanctioned writer of that map.
 *
 * A model id is transcript-controlled — `parse-claude-assistant.ts` reads
 * `message.model` verbatim and nothing between it and here allow-lists the
 * string — so `"__proto__"` and `"constructor"` reach this key. On a plain `{}`
 * both read back as an inherited member: truthy, so a `??` first-write check
 * takes them for an already-open entry and the running `+=` lands on
 * `Object.prototype` (or on `Object`) instead, poisoning every plain object in
 * the db-host process with `cIn: NaN` AND dropping that model from the emitted
 * breakdown while its dollars stay in the bucket total (ISS-8234).
 */
export function addActivityBucketModelCost(
  bucket: ActivityBucket,
  model: string,
  costs: ActivityBucketModelCosts
): void {
  const entry = ensureModelCosts(bucket.byModel, model);
  entry.cIn += costs.cIn;
  entry.cOut += costs.cOut;
  entry.cCache += costs.cCache;
}

/**
 * The accumulator `byModel` starts as: a map with no prototype, so no arbitrary
 * string key can name an inherited member. `roundActivityBucket` rebuilds a
 * normally-prototyped object at the emit boundary, so consumers and the sync
 * wire see the shape they always saw.
 */
function createModelCostMap(): ActivityBucket["byModel"] {
  return Object.create(null);
}

/**
 * `Object.hasOwn` for presence and `defineProperty` for the create — the pair
 * that stays correct on a PLAIN-prototyped `byModel` too, which the null map
 * above cannot guarantee on its own: this fold also runs over buckets that
 * arrived from elsewhere. `hasOwn` is the only presence check that cannot
 * mistake an inherited member for an open entry, and `defineProperty` *defines*
 * where `=` would invoke the `__proto__` setter and silently create no key.
 */
function ensureModelCosts(
  byModel: ActivityBucket["byModel"],
  model: string
): ActivityBucketModelCosts {
  if (Object.hasOwn(byModel, model)) {
    return byModel[model];
  }
  const created: ActivityBucketModelCosts = { cIn: 0, cOut: 0, cCache: 0 };
  Object.defineProperty(byModel, model, {
    configurable: true,
    enumerable: true,
    value: created,
    writable: true,
  });
  return created;
}
