import type { ActivityBucket } from "../agent-sync/agent-session-sync-contract.js";

/**
 * The Session Timeline bin's own construction and rounding, split out of
 * `session-trace.ts` (ISS-5999).
 *
 * That file is grandfathered under the 1,000-line ceiling and shrink-only, and
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
    byModel: {},
    /*
     * ISS-5819 review (wongk): the bin's own wall-clock bounds, carried with it.
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
