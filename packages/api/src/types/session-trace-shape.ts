/**
 * The Session Trace's RENDERED shapes — the span it covers, the markers and
 * throttle bands drawn on it, and the phases (with their iteration counts and
 * loopbacks) it resolves to — in their own module.
 *
 * Split out of `agent-session.ts` (ISS-5636) for the same reason
 * `./activity-bucket` was (ISS-5999): this is a self-contained cluster with
 * its own invariants. `agent-session.ts` re-exports them, so every existing
 * `@repo/api/src/types/agent-session` import keeps working unchanged.
 *
 * The seam is derived-vs-evidence, not alphabetical: everything here is what a
 * fold over a session's raw event stream PRODUCED, while the
 * `SessionTrace*Source` records it was folded FROM stay next to the source-kind
 * const objects they discriminate on. That is also why the cluster moved for
 * this issue in particular — a bounded read makes every shape here describe a
 * PREFIX (see `AgentSessionDetail.eventsTruncated`, and its per-derivation
 * `autonomyTruncated`/`steeringEpisodesTruncated` siblings for the scalars
 * folded off these shapes).
 */

export type SessionSpan = {
  first: string;
  last: string;
  /**
   * ISS-5850: the wall-clock extent the producer's activity bins TILE, in epoch
   * ms — `startMs` inclusive, `endMs` exclusive. `first`/`last` above are the
   * same two edges as anchor-less clock offsets, which is why they cannot
   * answer this question.
   *
   * WHY THIS EXISTS. A strip is a bag of bins with no bounds of its own
   * (`ActivityBucket`), and the window a consumer renders is NOT the window the
   * bins were measured on. The desktop collector bins over the session's REAL
   * ACTIVITY EXTENT — `buildTraceActivityFields` clamps to
   * `[firstActivity, lastActivity]`, routinely a strict subset of the session's
   * lifecycle — while the detail page's axis window is resolved from
   * transcript / phase / lifecycle bounds and spans the whole run.
   *
   * Without this field a consumer can only ASSUME the bins tile the window it is
   * drawing, so every column outside the measured extent renders as a confident
   * measured zero — "no tokens billed" for an interval the collector never
   * looked at. That is the distinction-collapse this field closes: an unmeasured
   * interval and an observed-idle one are different facts and must not render
   * the same.
   *
   * NOT DERIVABLE from the bins. The union of `binStartMs`/`binEndMs` equals the
   * extent only while a producer emits a COMPLETE, CONTIGUOUS tiling — which
   * both current producers happen to do, and which nothing in the contract
   * promises. A producer that drops empty bins would report a narrower union
   * than it measured, and the consumer would mark genuinely-measured quiet as
   * unmeasured. The producer states its extent instead of the consumer guessing.
   *
   * OPTIONAL and additive: a version-skewed producer, and every payload
   * persisted before this field existed, omits BOTH. A consumer that reads
   * neither must say the extent is unknown rather than fall back to the old
   * assumption silently — see `resolveTimelineSourceExtent`. Omitted rather than
   * `null` so an older reader sees the fields as simply not there.
   *
   * Both or neither: a half-stated extent is not an extent, and
   * `resolveTimelineSourceExtent` refuses one.
   */
  startMs?: number;
  endMs?: number;
};

export type SessionMarker = {
  kind: "commit" | "pr" | "fail" | "frust" | "prompt";
  x: number;
  t: string;
  label: string;
  tl: number;
  illustrative?: boolean;
};

export type SessionThrottle = {
  x0: number;
  t0: string;
  t1: string;
  durMin: number;
  tl: number;
};

export type SessionPhase = {
  key: string;
  label: string;
  dur: string;
  cost: string;
  cOut: number;
  cCache: number;
  cIn: number;
};

export type PhaseIterations = Record<string, number>;

export type PhaseLoopback = {
  from: string;
  to: string;
  label: string;
  depth: number;
};
