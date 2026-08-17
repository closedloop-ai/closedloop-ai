/**
 * The Session Timeline's bar shape, in its own module.
 *
 * Split out of `agent-session.ts` (ISS-5999) rather than added to: that file is
 * grandfathered under the 1,000-line ceiling and shrink-only, and the bucket is
 * a self-contained wire shape with its own producers and its own invariants —
 * the USD contract and the bin bounds below are about this record, not about the
 * session that carries it. `agent-session.ts` re-exports it, so every existing
 * `@repo/api/src/types/agent-session` import keeps working unchanged.
 */

/**
 * A time-axis activity bucket backing the session-detail cost bar. `cIn`,
 * `cOut`, and `cCache` are ALWAYS the bucket's estimated cost in **USD dollars**
 * (never token counts), split by input / output / cache, and `byModel` carries
 * that same USD split keyed by model. (`total` and `toolStart` are event /
 * tool-call counts, not costs.)
 *
 * The USD is *normally* the trace producer's per-event `*_cost_usd_estimated`
 * (input / output / cache_*) column sum, but that is only one source:
 * `buildTraceActivityFields` reprices from token counts when all four stored
 * costs are absent, and the renderer synthesizes from `session.estimatedCost`
 * when no persisted buckets exist — the USD invariant above holds across all
 * three paths.
 *
 * `key` is a stable local/render identity for derived timeline buckets.
 */
export type ActivityBucket = {
  key?: string;
  label: string;
  cIn: number;
  cOut: number;
  cCache: number;
  total: number;
  toolStart: number;
  tl0: number | null;
  byModel: Record<string, { cIn: number; cOut: number; cCache: number }>;
  /**
   * ISS-5819 review (wongk): the wall-clock instants this bin was BINNED OVER,
   * in epoch ms, as the producer measured them — `binStartMs` inclusive,
   * `binEndMs` exclusive.
   *
   * A strip is a bag of bins with no bounds of its own, and each producer bins
   * over a DIFFERENT extent: the desktop collector uses the session's real
   * activity extent (`buildTraceActivityFields`), while the renderer's own axis
   * window is resolved from transcript / phase / lifecycle bounds. Anything that
   * re-projects these bins onto a clock therefore has to be told which clock
   * they were measured on, or it moves measured cost into intervals the producer
   * never established.
   *
   * OPTIONAL and additive: a version-skewed producer, and every payload
   * persisted before this field existed, omits them. Consumers that need real
   * bounds must degrade to the ordinal strip when they are absent rather than
   * guess a window — see `session-timeline-projection.ts`. Omitted rather than
   * `null` so an older reader sees the field as simply not there.
   */
  binStartMs?: number;
  binEndMs?: number;
};
