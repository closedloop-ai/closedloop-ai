import type { MergedTraceItem } from "@repo/api/src/types/branch-trace";
import {
  TraceExtentRejection,
  type UntrustworthyTraceExtent,
  untrustworthyTraceExtents,
} from "@repo/lib/branches/merged-trace";
import { log } from "@repo/observability/log";
import {
  EmissionRollupCause,
  FixedWindowEmissionThrottle,
} from "@/lib/observability/fixed-window-emission-throttle";

export function warnOnUntrustworthyTraceExtents(
  items: readonly MergedTraceItem[],
  context: { organizationId: string }
): void {
  // Reporting must never change what the caller gets back: this runs inside a
  // trace response that has already been computed, so a throttle or sink
  // failure must not become a way to fail a read that had nothing wrong with
  // it.
  try {
    // The terminal drain. Deliberately unconditional and on the CLEAN path too,
    // so a burst of one signature followed by quiet is flushed by the next
    // branch-trace read from ANY org, rather than waiting for that same org to
    // hold that same corrupt trace again.
    throttle.drainExpired(Date.now());
    const refused = untrustworthyTraceExtents(items);
    if (refused.length > 0) {
      reportRefusedExtents(refused, context.organizationId);
    }
  } catch (error) {
    log.warn("[merged-trace-extent] Failed to report a refused extent", {
      event: MERGED_TRACE_TOOL_EXTENT_INVALID_EVENT,
      organizationId: context.organizationId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function warnOnUnreadableTraceItems(
  unreadableCountBySession: ReadonlyMap<string, number>,
  context: { organizationId: string }
): void {
  try {
    // Unconditional and on the clean path too, so a burst followed by quiet is
    // flushed by the next branch-trace read from ANY org.
    unreadableThrottle.drainExpired(Date.now());
    if (unreadableCountBySession.size === 0) {
      return;
    }
    reportUnreadableItems(unreadableCountBySession, context.organizationId);
  } catch (error) {
    log.warn("[merged-trace-extent] Failed to report an unreadable item", {
      event: MERGED_TRACE_ITEM_UNREADABLE_EVENT,
      organizationId: context.organizationId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Exported for tests, which need a clean keyspace and their own window. */
export function resetMergedTraceExtentThrottle(): void {
  throttle.clear();
  unreadableThrottle.clear();
}

/** The event name a Datadog query keys on. See the module docstring. */
export const MERGED_TRACE_TOOL_EXTENT_INVALID_EVENT =
  "merged_trace_tool_extent_invalid";

/** Cap the refusals carried on the warning so one bad corpus cannot flood logs. */
const EXTENT_LOG_SAMPLE_SIZE = 10;

/** Reason values are fixed snake_case tokens, so `|` cannot collide with a key part. */
const KEY_DELIMITER = "|";
const REASON_DELIMITER = ",";

/**
 * What the throttle key and the rollup are allowed to carry. `reasons` is
 * derived entirely from the CLOSED {@link TraceExtentRejection} vocabulary, so
 * the keyspace is bounded at compile time (one key per org per subset of five
 * reasons) — never from a producer-supplied string, which would move the
 * amplification out of the log stream and into the keyspace.
 */
type ExtentDetectionScope = {
  organizationId: string;
  reasons: readonly TraceExtentRejection[];
};

function reportRefusedExtents(
  refused: readonly UntrustworthyTraceExtent[],
  organizationId: string
): void {
  const reasons = observedReasons(refused);
  const detectionScope: ExtentDetectionScope = { organizationId, reasons };
  const decision = throttle.record(
    `${organizationId}${KEY_DELIMITER}${reasons.join(REASON_DELIMITER)}`,
    detectionScope,
    Date.now()
  );
  if (decision.flushedSuppressedCount > 0) {
    emitAggregate(
      detectionScope,
      decision.flushedSuppressedCount,
      EmissionRollupCause.Window
    );
  }
  if (!decision.emit) {
    return;
  }
  log.warn(MERGED_TRACE_TOOL_EXTENT_INVALID_EVENT, {
    ...detectionScope,
    refusedCount: refused.length,
    countByReason: tallyByReason(refused),
    // The refused values themselves, capped: `endMs` is the diagnosable part
    // (a µs stamp and a pre-start stamp are different producer bugs) and one
    // broken session must not be able to flood a request's log line with them.
    sample: refused
      .slice(0, EXTENT_LOG_SAMPLE_SIZE)
      .map(({ sessionId, reason, endMs }) => ({ sessionId, reason, endMs })),
    occurrences: 1,
  });
}

/**
 * The rollup for occurrences a closed window suppressed, as ONE line carrying
 * their total. It omits `refusedCount`, `countByReason`, and `sample` — the
 * suppressed occurrences did not necessarily share any of them — and carries
 * `aggregated` so a query can tell a rollup from a first occurrence. Same shape
 * and same `flushedBy` vocabulary as `branch-last-active-cohort.ts`, so one
 * Datadog query reads both.
 */
function emitAggregate(
  detectionScope: ExtentDetectionScope,
  occurrences: number,
  flushedBy: EmissionRollupCause
): void {
  log.warn(MERGED_TRACE_TOOL_EXTENT_INVALID_EVENT, {
    ...detectionScope,
    occurrences,
    aggregated: true,
    flushedBy,
  });
}

/**
 * The distinct reasons this trace actually carried, sorted and de-duplicated so
 * the ORDER items happened to arrive in cannot mint a second throttle key for a
 * producer bug already being throttled.
 */
function observedReasons(
  refused: readonly UntrustworthyTraceExtent[]
): TraceExtentRejection[] {
  return [...new Set(refused.map((entry) => entry.reason))].sort();
}

/**
 * Occurrences per reason, counted into an EXHAUSTIVE record — a reason added to
 * `TraceExtentRejection` and not named here fails `tsc`, instead of silently
 * landing in a key the monitor's group-by has never seen — but EMITTED with its
 * zeroes dropped.
 *
 * The zeroes are the point. A reason at 0 on this line is not a measurement
 * that no such extent exists; it is a reason this request happened not to see,
 * and for `not_finite` it is a reason this path can never see at all (module
 * docstring, whitlockk). Omitting an absent count keeps a Datadog group-by honest:
 * a facet with no data reads as no data, not as a confident zero.
 */
function tallyByReason(
  refused: readonly UntrustworthyTraceExtent[]
): Partial<Record<TraceExtentRejection, number>> {
  const tally: Record<TraceExtentRejection, number> = {
    [TraceExtentRejection.NotFinite]: 0,
    [TraceExtentRejection.FractionalMs]: 0,
    [TraceExtentRejection.Negative]: 0,
    [TraceExtentRejection.BeyondRepresentableInstant]: 0,
    [TraceExtentRejection.BeforeStart]: 0,
  };
  for (const entry of refused) {
    tally[entry.reason] += 1;
  }
  const observed: Partial<Record<TraceExtentRejection, number>> = {};
  for (const [reason, count] of Object.entries(tally)) {
    if (count > 0) {
      observed[reason as TraceExtentRejection] = count;
    }
  }
  return observed;
}

/**
 * Per-(org, reason-set) emission bound, per `apps/api/AGENTS.md`'s Emission and
 * Abuse Control rule (#6809 review).
 *
 * Branch detail is polled and re-read on every navigation and cache
 * invalidation, and this warn sits on the READ path — so without a bound one
 * authenticated member holding one branch with one corrupt extent emits a line
 * per request, forever. That is the rule's amplification vector driven by a
 * non-adversarial caller. The shared engine keeps both bounds it asks for: at
 * most one line per key per window plus one rollup, and a hard max-entry LRU cap
 * on the keyspace.
 *
 * WHAT `sum(occurrences)` IS WORTH. A suppressed count is materialised by an
 * EVENT, never by a clock. All three of this engine's events are wired: the next
 * refusal on the SAME key rolling its window over, an LRU eviction through
 * `onFlush`, and `drainExpired`, which runs on EVERY branch-trace read whether
 * or not that read refused anything. What that still does not buy: an instance
 * that takes a burst and then serves no further trace read before freezing loses
 * its terminal window, and each serverless instance counts independently.
 * `sum(occurrences)` is an eventual LOWER BOUND on the real refusal volume, not
 * a live exact total — read a rise as a floor being crossed.
 */
const throttle = new FixedWindowEmissionThrottle<ExtentDetectionScope>({
  onFlush: (detectionScope, suppressedCount, cause) =>
    emitAggregate(detectionScope, suppressedCount, cause),
});

/** The event name a Datadog query keys on for a dropped, unparseable item. */
export const MERGED_TRACE_ITEM_UNREADABLE_EVENT =
  "merged_trace_item_unreadable";

/** Cap the per-Session breakdown so one broken branch cannot flood a log line. */
const UNREADABLE_LOG_SAMPLE_SIZE = 10;

function reportUnreadableItems(
  unreadableCountBySession: ReadonlyMap<string, number>,
  organizationId: string
): void {
  const decision = unreadableThrottle.record(
    organizationId,
    { organizationId },
    Date.now()
  );
  if (decision.flushedSuppressedCount > 0) {
    emitUnreadableAggregate(
      organizationId,
      decision.flushedSuppressedCount,
      EmissionRollupCause.Window
    );
  }
  if (!decision.emit) {
    return;
  }
  const entries = [...unreadableCountBySession];
  log.warn(MERGED_TRACE_ITEM_UNREADABLE_EVENT, {
    organizationId,
    sessionCount: entries.length,
    // Scope-distinct from the wire contract's per-Session `unreadableItemCount`
    // (`BranchTraceSessionHydration`): this one is the whole read's total.
    totalUnreadableItemCount: entries.reduce(
      (sum, [, count]) => sum + count,
      0
    ),
    sample: entries
      .slice(0, UNREADABLE_LOG_SAMPLE_SIZE)
      .map(([sessionId, count]) => ({ sessionId, count })),
    occurrences: 1,
  });
}

/**
 * The rollup for occurrences a closed window suppressed. It omits the counts and
 * the breakdown — the suppressed occurrences did not necessarily share them —
 * and carries `aggregated` so a query can tell a rollup from a first occurrence.
 */
function emitUnreadableAggregate(
  organizationId: string,
  occurrences: number,
  flushedBy: EmissionRollupCause
): void {
  log.warn(MERGED_TRACE_ITEM_UNREADABLE_EVENT, {
    organizationId,
    occurrences,
    aggregated: true,
    flushedBy,
  });
}

/**
 * Per-org emission bound, for the reason its sibling above documents at length:
 * branch detail is polled and re-read on every navigation, and this warn sits on
 * that read path, so without a bound one member holding one branch with one
 * unreadable item emits a line per request forever.
 *
 * Keyed on the org ALONE. There is no closed producer vocabulary to split on
 * here the way the extent reasons split that one, and a session id is
 * producer-supplied — keying on it would move the amplification out of the log
 * stream and into the keyspace.
 */
const unreadableThrottle = new FixedWindowEmissionThrottle<{
  organizationId: string;
}>({
  onFlush: (scope, suppressedCount, cause) =>
    emitUnreadableAggregate(scope.organizationId, suppressedCount, cause),
});
