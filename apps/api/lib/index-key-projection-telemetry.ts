import {
  EmissionRollupCause,
  FixedWindowEmissionThrottle,
} from "@/lib/observability/fixed-window-emission-throttle";

/**
 * The REASON half of the (org, reason) key: which lane's write was projected.
 *
 * A closed const set rather than free text, because it is half of a monitoring
 * key: a lane spelling its own reason at the call site would silently open a
 * second budget for the same emitter on the next typo.
 */
export const IndexKeyProjectionReason = {
  Component: "component",
  Invocation: "invocation",
  SessionBatch: "session_batch",
  Transcript: "transcript",
} as const;
export type IndexKeyProjectionReason =
  (typeof IndexKeyProjectionReason)[keyof typeof IndexKeyProjectionReason];

/** The amplification unit: one tenant is what a replay drives. */
export type IndexKeyProjectionOrgScope = {
  organizationId: string;
};

/** The tenant + caller one projection is attributed to. */
export type IndexKeyProjectionScope = IndexKeyProjectionOrgScope & {
  computeTargetId: string;
};

/**
 * How a lane emits the aggregate for occurrences a closed window suppressed.
 *
 * `computeTargetId` is OPTIONAL because the coarse tier's rollup deliberately
 * carries none: that total spans every target the org owns, and stamping one
 * would attribute it to whichever target happened to be last.
 */
export type IndexKeyProjectionRollupEmitter = (
  scope: IndexKeyProjectionOrgScope & { computeTargetId?: string },
  occurrences: number,
  flushedBy: EmissionRollupCause
) => void;

/**
 * How many projection events ONE organization may emit per window for ONE
 * reason, across every compute target it owns.
 *
 * Ten, inherited from the invocation lane's tuned budget (ISS-8736): enough that
 * a genuine multi-machine incident still shows several distinct callers, low
 * enough that a fan-out replay cannot outrun it.
 */
export const INDEX_KEY_PROJECTION_ORG_BUDGET = 10;

/** Composite-key delimiter. Every key part is an id or a closed reason, so `|`
 * cannot collide. */
const KEY_DELIMITER = "|";

export type IndexKeyProjectionEmissionGateOptions = {
  reason: IndexKeyProjectionReason;
  onRollup: IndexKeyProjectionRollupEmitter;
  /** Defaults to {@link INDEX_KEY_PROJECTION_ORG_BUDGET}. */
  orgBudget?: number;
};

/**
 * The org/reason choke point one projection emitter reports through.
 *
 * BOUNDED GROWTH, which is the central design constraint rather than an
 * afterthought (root `AGENTS.md`): both tiers are `FixedWindowEmissionThrottle`
 * instances, so each holds at most {@link FIXED_WINDOW_EMISSION_MAX_ENTRIES}
 * keys under a hard LRU cap, and an evicted key still carrying suppressed
 * occurrences flushes them through `onRollup` rather than dropping them. The
 * coarse tier's keyspace is bounded far tighter than that cap in practice: its
 * key carries no caller-varied component at all, so it grows with the number of
 * organizations this instance has served, not with what a caller sends.
 */
export class IndexKeyProjectionEmissionGate {
  private readonly reason: IndexKeyProjectionReason;
  private readonly onRollup: IndexKeyProjectionRollupEmitter;
  private readonly orgBudget: FixedWindowEmissionThrottle<IndexKeyProjectionOrgScope>;
  private readonly targets: FixedWindowEmissionThrottle<IndexKeyProjectionScope>;

  constructor(options: IndexKeyProjectionEmissionGateOptions) {
    this.reason = options.reason;
    this.onRollup = options.onRollup;
    this.orgBudget = new FixedWindowEmissionThrottle({
      maxPerWindow: options.orgBudget ?? INDEX_KEY_PROJECTION_ORG_BUDGET,
      onFlush: (scope, occurrences, cause) =>
        this.onRollup(scope, occurrences, cause),
    });
    this.targets = new FixedWindowEmissionThrottle({
      onFlush: (scope, occurrences, cause) =>
        this.onRollup(scope, occurrences, cause),
    });
  }

  /**
   * Record one projection occurrence and decide whether the caller emits its
   * first-occurrence event.
   *
   * The caller has already performed the projection and acts only on the
   * returned decision, so a bug in here can never change what was written.
   * Rollups for windows this call closed are emitted before it returns, so a
   * suppressed occurrence reaches the aggregate on the next occurrence of its
   * own key rather than waiting for a timer a frozen instance would never fire.
   */
  record(scope: IndexKeyProjectionScope, now: number): boolean {
    // The FINE tier goes first: a replay it suppresses must not spend a slot of
    // the org budget, or one noisy target silences every other caller in the
    // org for the rest of the window.
    const decision = this.targets.record(this.targetKey(scope), scope, now);
    if (decision.flushedSuppressedCount > 0) {
      this.onRollup(
        scope,
        decision.flushedSuppressedCount,
        EmissionRollupCause.Window
      );
    }
    if (!decision.emit) {
      return false;
    }
    const orgScope: IndexKeyProjectionOrgScope = {
      organizationId: scope.organizationId,
    };
    const budget = this.orgBudget.record(this.orgKey(orgScope), orgScope, now);
    if (budget.flushedSuppressedCount > 0) {
      this.onRollup(
        orgScope,
        budget.flushedSuppressedCount,
        EmissionRollupCause.Window
      );
    }
    return budget.emit;
  }

  /**
   * Drop all state WITHOUT flushing. A test-isolation affordance, not a
   * shutdown drain — pending suppressed counts are discarded, which is why
   * production code must not call it.
   */
  clear(): void {
    this.orgBudget.clear();
    this.targets.clear();
  }

  /** How many keys are resident across both tiers. The bound this class holds. */
  get size(): number {
    return this.orgBudget.size + this.targets.size;
  }

  private orgKey(scope: IndexKeyProjectionOrgScope): string {
    return [this.reason, scope.organizationId].join(KEY_DELIMITER);
  }

  private targetKey(scope: IndexKeyProjectionScope): string {
    return [this.reason, scope.organizationId, scope.computeTargetId].join(
      KEY_DELIMITER
    );
  }
}
