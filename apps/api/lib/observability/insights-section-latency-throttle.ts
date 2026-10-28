/**
 * ISS-7512 — bound `insights.dashboard.section_latency` emission at the single
 * `/insights/*` choke point (`createInsightsHandler`).
 *
 * WHY. That handler emits one sample per SUCCESSFUL section read, and nothing
 * in front of it throttles the caller: `withAnyAuth` authenticates but applies
 * no abuse control, and the section routes have no rate limiter of their own.
 * So this is the "before any limiter" case rather than the "limiter is too
 * loose" one — an authenticated member can replay a section route and drive an
 * unbounded emit stream. `apps/api/AGENTS.md` ("Emission and Abuse Control"):
 * a metric emitted per request is an amplification vector whenever an
 * authenticated caller can drive the path; bound emission at the choke point
 * and keep a bounded suppressed count. Low-cardinality TAGS solve tag
 * explosion, which is a different problem from log VOLUME.
 *
 * The latency answer never depends on the metric, so suppressing the emission
 * cannot change what the reader receives.
 *
 * THE KEY IS THE ORG PLUS THE METRIC'S OWN TAG TUPLE, and those are two
 * different jobs. `orgId` is the amplification unit — one tenant is what a
 * replay drives — and it stays in this process-local key, never on the emitted
 * payload, so it bounds volume without touching the metric's cardinality (see
 * the "why no org/user/team id" note in `insights-metrics.ts`). Keying on the
 * tag tuple as well is what keeps the SAMPLE representative: with a
 * section-only key, a slow `period=all` read would be silenced for a window by
 * a fast `period=7` read that happened to land first, and the panel would
 * report a latency profile no reader experienced. `teamScoped` is omitted
 * because it is fully determined by `scope` (`scope === Team`), so including it
 * would only duplicate a key part.
 *
 * This is the insights-specific binding of the shared
 * {@link FixedWindowEmissionThrottle}, which owns the windowing, the LRU
 * keyspace cap, and the guarantee that an evicted key's suppressed count is
 * flushed rather than dropped. Same relationship
 * `session-ingestion-policy-denied-throttle.ts` has to that engine; the engine
 * is not reimplemented here.
 */

import type {
  InsightsPeriod,
  InsightsScope,
  InsightsSection,
} from "@repo/api/src/types/insights";
import type { SessionAnalyticsSection } from "@repo/api/src/types/session-analytics";
import {
  type EmissionThrottleFlushCause,
  FixedWindowEmissionThrottle,
} from "./fixed-window-emission-throttle";
import { emitInsightsSectionLatencySuppressed } from "./insights-metrics";

export const INSIGHTS_SECTION_LATENCY_WINDOW_MS = 60_000;
export const INSIGHTS_SECTION_LATENCY_MAX_ENTRIES = 10_000;

/**
 * Composite-key delimiter. Every key part is a closed const-union token with no
 * `|` in it, and `orgId` is a UUID, so this cannot collide across parts.
 */
const KEY_DELIMITER = "|";

/**
 * The metric's own tag tuple, carried through the throttle so a rollup raised
 * by an eviction or an expiry drain can name what it is rolling up without
 * parsing the composite key back apart.
 */
export type InsightsSectionLatencyKeyParts = {
  section: InsightsSection | SessionAnalyticsSection;
  period: InsightsPeriod;
  scope: InsightsScope;
};

export type InsightsSectionLatencyThrottleDecision = {
  emit: boolean;
  flushedSuppressedCount: number;
};

/**
 * Called when a key that still holds suppressed samples is dropped — by the
 * max-entry cap or by an expiry drain — so the pending rollup is emitted rather
 * than discarded. `suppressedCount` is always positive.
 */
export type InsightsSectionLatencyFlushHandler = (
  parts: InsightsSectionLatencyKeyParts,
  suppressedCount: number,
  cause: EmissionThrottleFlushCause
) => void;

export type InsightsSectionLatencyThrottleOptions = {
  windowMs?: number;
  maxEntries?: number;
  /**
   * Sink for suppressed counts flushed by LRU eviction or an expiry drain.
   * Defaults to a no-op so a caller that does not wire it up simply loses the
   * flush (never throws); the production instance below wires it to the
   * aggregate emitter.
   */
  onFlush?: InsightsSectionLatencyFlushHandler;
};

/**
 * Per-(org, section, period, scope) fixed-window throttle for the section
 * latency metric. The FIRST successful read of a key in a window emits its
 * duration; the rest are counted and suppressed, and flushed as one
 * `insights.dashboard.section_latency_suppressed` rollup.
 *
 * WHAT THE PANEL IS WORTH AFTER THIS, stated plainly so nobody reads a
 * throttled gauge as a census. `insights.dashboard.section_latency` is a
 * SAMPLE — at most one read per org per tag tuple per minute — so its p50/p95
 * describe the sampled reads, not every read. The paired suppressed rollup is
 * what makes that legible: `sum(count)` over it against the sample count says
 * how much of the traffic the sample stands for. A window whose suppressed
 * count is zero was fully observed.
 */
export class InsightsSectionLatencyThrottle {
  private readonly throttle: FixedWindowEmissionThrottle<InsightsSectionLatencyKeyParts>;

  constructor(options: InsightsSectionLatencyThrottleOptions = {}) {
    this.throttle =
      new FixedWindowEmissionThrottle<InsightsSectionLatencyKeyParts>({
        windowMs: options.windowMs ?? INSIGHTS_SECTION_LATENCY_WINDOW_MS,
        maxEntries: options.maxEntries ?? INSIGHTS_SECTION_LATENCY_MAX_ENTRIES,
        onFlush: options.onFlush,
      });
  }

  /**
   * Record one successful section read and decide whether it emits its sample.
   * The read has already completed and been returned to the caller before this
   * runs, and the handler acts only on the returned decision, so a throttling
   * bug can never change the response.
   */
  record(
    orgId: string,
    parts: InsightsSectionLatencyKeyParts,
    now: number
  ): InsightsSectionLatencyThrottleDecision {
    return this.throttle.record(
      [orgId, parts.section, parts.period, parts.scope].join(KEY_DELIMITER),
      parts,
      now
    );
  }

  /**
   * Flush and drop keys whose window is certainly over. Called from the handler
   * on every section read — the terminal path this process already runs — so a
   * burst followed by quiet still reaches the rollup instead of sitting in
   * memory until the SAME key is touched again. O(1) when nothing has expired.
   */
  drainExpired(now: number): number {
    return this.throttle.drainExpired(now);
  }

  /** How many keys are resident. The bound this class exists to hold. */
  get size(): number {
    return this.throttle.size;
  }

  clear(): void {
    this.throttle.clear();
  }
}

/**
 * Process-local shared throttle for the production choke point. Ephemeral per
 * serverless instance by design (`apps/api/AGENTS.md`, "Serverless Routes and
 * State"): each instance bounds itself independently, so no single hot instance
 * can be replayed into an unbounded emit stream. Tests construct their own
 * instance to control time and window bounds.
 */
export const insightsSectionLatencyThrottle =
  new InsightsSectionLatencyThrottle({
    onFlush: (parts, suppressedCount) =>
      emitInsightsSectionLatencySuppressed({ ...parts, suppressedCount }),
  });
