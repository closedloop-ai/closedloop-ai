/**
 * ISS-4833 / ISS-4821: the ONE window the Session Timeline is drawn over.
 *
 * The session-detail screen used to derive its timeline extent in three
 * different places that could disagree on the same session:
 *   - the axis TOTAL label measured `startedAt → resolveSessionDurationEnd(...)`;
 *   - the axis FOOTER printed the first plotted marker's time (`span.first`);
 *   - the bucket/marker/dot GEOMETRY divided by `startedAt → endedAt ?? updatedAt`
 *     (`getLimitDotPercent`, `alignBucketRowsToTranscript`).
 * So a session whose activity ran past a stale `endedAt` showed an axis label
 * covering the honest span while every later dot clamped to the right edge, and
 * the axis' left label named an instant its own scale did not start at.
 *
 * This module is the single derivation all three now read
 * ({@link resolveSessionTimelineWindow}), plus the geometry that consumes it —
 * extracted out of the (grandfathered, over-ceiling)
 * `agent-session-detail-view.tsx` so the window lives beside the math it drives.
 *
 * It imports `projectActivitySegments` — which lives under `components/activity`
 * but is a pure, surface-agnostic projection — deliberately: the Activity-phases
 * strip's own `spanStartMs`/`spanEndMs` ARE the phases-span caption the axis has
 * to reconcile with, so re-deriving the tiling bounds here would be exactly the
 * duplicate-derivation drift this module exists to remove.
 */

import type {
  ActivityBucket,
  AgentSessionDetail,
  TurnItem,
} from "@repo/api/src/types/agent-session";
import { clamp, clampPercent } from "@repo/api/src/utils/math";
import { resolveSessionTimelineAxisEnd } from "@repo/app/agents/lib/session-duration";
import { projectActivitySegments } from "../components/activity/activity-segments-projection";

/**
 * The only field the geometry reads off a session: its transcript rows. Kept
 * structural (rather than the whole `AgentSessionDetail`) so a caller — and a
 * test — passes what the math actually consumes instead of casting a stub.
 */
export type SessionTranscriptRows = {
  readonly turnItems?: readonly TurnItem[] | null;
};

/**
 * The half-open-ish `[startMs, endMs]` extent the timeline plots over. Both
 * bounds are finite epoch-ms and `endMs >= startMs` — a resolver returns `null`
 * rather than an inverted or non-finite window, so a consumer never has to
 * re-validate it.
 */
export type SessionTimelineWindow = {
  readonly startMs: number;
  readonly endMs: number;
};

/**
 * The PLOTTED-ACTIVITY window: both ends anchored to data the screen actually
 * draws, never to a lifecycle timestamp on its own.
 *
 * The candidate instants are the union of the two things rendered on this
 * screen's two stacked strips:
 *   - every TIMED transcript row (`turnItems`) — the rows the cost bars, event
 *     dots and jump targets are placed from;
 *   - the Activity-phases tiling's OWN span (`activitySegmentRows`, via the
 *     `spanStartMs`/`spanEndMs` that {@link projectActivitySegments} hands the
 *     "phases span …" caption) — so on a COMPLETE tiling the axis total
 *     reconciles with the caption directly beneath it instead of stating a
 *     second, different number.
 *
 * FEA-3594 (sweeper/heal) is guarded structurally rather than by a heuristic:
 * `endedAt` is not a candidate at all while plotted rows exist, so a sweeper
 * stamping `endedAt` hours after the real work finished cannot stretch either
 * the axis label or the geometry past the last thing on screen. This is the
 * ISS-4833 correction to the `max(endedAt, lastActivityAt)` anchor, which could
 * not tell a genuinely-last `endedAt` from a swept one.
 *
 * ISS-5137 — why the phase contribution is the tiling's WHOLE span rather than
 * its non-idle subset. ISS-4833 filtered IDLE segments out of the candidate set,
 * on the reasoning that the classifier's `appendIdleTiling` closes the tail with
 * an idle pad running out to `endedAt`, so unioning the raw span smuggled the
 * swept timestamp back in. That guard worked, and it broke a shipped contract to
 * do it: the caption beneath the axis measures the tiling INCLUDING its idle
 * spans, so on any tiling with a leading or trailing idle segment — which is the
 * normal desktop-synced shape — the axis stated one number and the caption
 * directly under it stated another. The reported symptom was `calendar span
 * 18m 0s` sitting above `phases span 20m 0s` for a 12:00→12:20 session whose
 * work stopped at 12:18. That is precisely the ISS-4791/ISS-4675 defect those
 * two captions exist to prevent, reintroduced one row apart, and it under-reports
 * the session's elapsed time on a label whose own words are "calendar span" —
 * idle minutes are calendar minutes.
 *
 * So the two properties trade against each other and reconciliation wins: two
 * adjacent captions contradicting each other is a defect a reader can see on
 * every affected session, while a swept `endedAt` inflates BOTH captions
 * together — visible, consistent, and fixable at the classifier that stamps it.
 *
 * What that trade COSTS, stated here rather than left as a caption-only story
 * (stage review, ISS-5137). This window is the geometry's denominator too, so
 * widening it moves pixels, not just text — but only on one of the two
 * consumers. {@link getWindowPercent} divides by `endMs - startMs`, so on a
 * session whose tail idle pad reaches a swept `endedAt` the cost bars and event
 * dots compress toward the left edge. {@link alignBucketRowsToTranscript} is
 * NOT affected: it buckets over the timed rows' own `[min, max]` clamped inside
 * this window (FEA-3586), and this window is a union that already contains every
 * one of those rows, so both clamps are identities and bar-click jump targets do
 * not move.
 *
 * And FEA-3594's structural guard is NARROWER after this change, not unchanged.
 * `endedAt` is still never a DIRECT candidate, but on any session carrying a
 * tiling it re-enters indirectly through that tail idle pad, which the desktop
 * classifier runs out to `deriveSessionBoundsMs`' `endedAt + 1ms`. The guard
 * therefore holds only for sessions with NO tiling — the pre-backfill / older-
 * payload remainder — and not for the swept desktop-synced population it was
 * written about. What bounds that reduction: on exactly that population this
 * resolver converges to within that 1ms on the PRIOR window
 * (`startedAt → endedAt ?? updatedAt`) the surface shipped before ISS-4833, so
 * this gives up an improvement the reconciled path had rather than regressing
 * what was already on screen. Every claim in these two paragraphs is pinned in
 * `session-timeline-geometry.test.ts`.
 *
 * Where reconciliation with the caption does NOT hold, and deliberately so
 * (wongk review, ISS-4833): when the tiling is TRUNCATED
 * (`activitySegmentRowsTruncated`, or the row cap) it is a start-ordered PREFIX,
 * so a transcript that continues past it legitimately widens this window beyond
 * the phase-only span the caption formats. The axis has to cover everything
 * drawn; the caption reports the phases' own span and already carries its
 * "later phases truncated" note. The two totals differing on that path is the
 * honest reading of partial data, not drift — so this module claims
 * reconciliation only for a complete tiling.
 *
 * Degradation, in order:
 *   - no plotted rows at all (an older/pre-backfill detail, or a session whose
 *     transcript has not synced): fall back to the lifecycle anchors —
 *     `startedAt` and {@link resolveSessionTimelineAxisEnd} — which keeps the
 *     ISS-4684 pre-backfill repair (`lastActivityAt` collapsed onto `startedAt`
 *     still reaches `endedAt`) for exactly the rows that need it;
 *   - no usable bound at all: `null`, and the caller keeps its prior behavior
 *     rather than plotting against a fabricated window.
 */
export function resolveSessionTimelineWindow(
  session: SessionTimelineWindowSource
): SessionTimelineWindow | null {
  const plotted = collectPlottedActivityBounds(session);
  const startMs = plotted?.minMs ?? getDateMs(session.startedAt);
  const lifecycleEndMs = getDateMs(
    resolveSessionTimelineAxisEnd(
      session.endedAt,
      session.lastActivityAt,
      session.updatedAt
    )
  );
  /*
   * The same resolver with its `updatedAt` fallback WITHHELD: that argument is
   * the sync-bump last resort, right for a session with nothing plotted at all
   * (some bound beats none) but never evidence of when work happened. Omitting
   * it yields the latest OBSERVED bound, or `NaN` when there is none.
   */
  const observedEndMs = getDateMs(
    resolveSessionTimelineAxisEnd(session.endedAt, session.lastActivityAt)
  );
  const endMs = resolveWindowEndMs(session, plotted?.maxMs, {
    lifecycleEndMs,
    observedEndMs,
  });
  return buildWindow(startMs, endMs);
}

/** The fields a window resolver reads. Structural so tests need no full detail. */
export type SessionTimelineWindowSource = {
  readonly activitySegmentRows?: AgentSessionDetail["activitySegmentRows"];
  readonly activitySegmentRowsTruncated?: boolean | null;
  readonly endedAt?: Date | string | null;
  /**
   * ISS-5075: `turnItems` is a chronological PREFIX (the detail read hit its row
   * ceiling), so the last plotted row is a confident UNDERCOUNT of when the run
   * actually ended — see {@link resolveSessionTimelineWindow}.
   */
  readonly eventsTruncated?: true;
  readonly lastActivityAt?: Date | string | null;
  readonly startedAt?: Date | string | null;
  readonly turnItems?: readonly TurnItem[] | null;
  readonly updatedAt?: Date | string | null;
};

/**
 * Fractional position (0-100) of `timestamp` on the timeline, measured over
 * `window`. Falls back to the transcript-row ordinal when the window or the
 * timestamp is unusable, so a dot is still placed rather than dropped.
 *
 * ISS-4821: this used to divide by `endedAt ?? updatedAt` with no
 * `lastActivityAt` in the chain, so on a session whose activity continued past a
 * stale `endedAt` every later dot clamped to 100% and stacked on the right edge.
 */
export function getLimitDotPercent(
  window: SessionTimelineWindow | null,
  session: SessionTranscriptRows,
  timestamp: unknown,
  fallbackRow: number
): number {
  return (
    getWindowPercent(window, timestamp) ??
    getTraceRowPercent(session, fallbackRow)
  );
}

/**
 * `timestamp`'s fractional position (0-100) on `window`, or `null` when either
 * is unusable.
 *
 * ISS-4821 review (wongk / codex): this is the seam PERSISTED geometry rebases
 * through. A stored `x`/`x0` was computed by the producer over ITS window
 * (`startedAt → resolvePresentationEndMs`), which the detail DTO does not carry,
 * so once this screen resolves a different window the stored fraction points at
 * the wrong instant — the axis gets relabeled while the dot stays put. Any
 * persisted coordinate whose ABSOLUTE instant survives into the DTO is
 * recomputed here, and the stored fraction is kept only as the fallback for the
 * shapes that carry no absolute instant.
 */
export function getWindowPercent(
  window: SessionTimelineWindow | null,
  timestamp: unknown
): number | null {
  const timestampMs = getDateMs(timestamp);
  if (
    !(window && Number.isFinite(timestampMs) && window.endMs > window.startMs)
  ) {
    return null;
  }
  return clampPercent(
    ((timestampMs - window.startMs) / (window.endMs - window.startMs)) * 100
  );
}

/**
 * FEA-3412: Repair the jump target of persisted `activityBuckets`.
 *
 * The timeline's bar `onClick` calls `onJump(bucket.tl0)`, and every client
 * consumer of `tl0` (the jump, the "you are here" tracker in `getRowPercent`)
 * treats it as a transcript `turnItems._row` — the number rendered as
 * `[data-row]` on each trace row. But the persisted buckets are produced by the
 * desktop sync path (`apps/desktop/.../session-trace.ts`), which sets `tl0` to
 * the sync-time *timeline-event* array index, not `_row`. Those two numbering
 * schemes diverge (tool events coalesce into a single turn; subagents are
 * appended after the timeline), so a bar click scrolled to the wrong row — or,
 * when the stale index overshot every rendered `[data-row]`, appeared to do
 * nothing. Re-key each bucket's `tl0` to the first transcript row that falls in
 * that bar's time slice so a click lands on a real, in-range row.
 *
 * FEA-3586: the rows are bucketed over `[firstTimedRow, lastTimedRow]` clamped
 * inside `window` — not the raw window — because when the outer bound overshoots
 * the last real activity, bucketing `tl0` over the wide window collapses every
 * transcript row into the first bucket(s) and a bar click past hour one resolves
 * to the top of the transcript.
 *
 * ISS-4821: the outer bound is now the caller's resolved
 * {@link SessionTimelineWindow} rather than `endedAt ?? updatedAt`. Under the
 * plotted-activity window that clamp can no longer cut rows dated after a stale
 * `endedAt` down into the final bucket. Only buckets the producer already marked
 * as jump targets (`tl0 != null`) are repaired, so idle bars stay non-clickable
 * exactly as before. A zero-duration span is treated as valid and floored at
 * 1ms, matching the producer.
 *
 * ISS-5124: this function is TOTAL over its input — every bucket it returns
 * carries either a verified transcript `_row` or `null`, never the producer's
 * raw sync-time index. When it cannot repair (no timed rows, or no usable
 * window) it now DEMOTES the unrepaired targets rather than passing them
 * through; see {@link demoteUnrepairedJumpRows} for why the previous no-op was
 * the defect and not merely a missing improvement.
 */
export function alignBucketRowsToTranscript(
  buckets: ActivityBucket[],
  session: SessionTranscriptRows,
  window: SessionTimelineWindow | null
): ActivityBucket[] {
  const timedRows = (session.turnItems ?? []).filter(hasTimedTraceRow);
  if (timedRows.length === 0 || !window) {
    return demoteUnrepairedJumpRows(buckets);
  }
  // FEA-3586: clamp the transcript's own [min, max] inside the window so a
  // repaired `tl0` lines up with the bar the reader actually clicked. Folded
  // rather than spread — see collectPlottedActivityBounds for why.
  const { minMs: activityMinMs, maxMs: activityMaxMs } =
    getTimedRowBounds(timedRows);
  const startMs = clamp(activityMinMs, window.startMs, window.endMs);
  const endMs = clamp(activityMaxMs, startMs, window.endMs);
  // Mirror the desktop producer, which accepts a zero-duration span (all rows at
  // one instant) as valid and floors it at 1ms via `Math.max(1, endMs - startMs)`.
  // Bailing on equality would leave those buckets carrying their raw
  // timeline-index `tl0`, re-breaking bar clicks. Over a 1ms span the earliest
  // timed row lands in bucket 0 and every later row clamps into the last bucket,
  // so each repaired `tl0` still resolves to a real, in-range transcript row.
  const spanMs = Math.max(1, endMs - startMs);

  // The `_row` of the earliest-by-time row in each bucket — the row that renders
  // at the top of that slice. Tracked by timestamp (not min `_row`) because a
  // subagent turn carries an out-of-order `_row` yet still renders in time order.
  const firstRowByBucket = new Array<number | null>(buckets.length).fill(null);
  const firstMsByBucket = new Array<number>(buckets.length).fill(
    Number.POSITIVE_INFINITY
  );
  let earliestMs = Number.POSITIVE_INFINITY;
  let earliestRow = timedRows[0]._row;
  for (const row of timedRows) {
    const ms = getTurnItemMs(row);
    if (ms < earliestMs) {
      earliestMs = ms;
      earliestRow = row._row;
    }
    const index = getBucketIndexFromMs(ms, startMs, spanMs, buckets.length);
    if (ms < firstMsByBucket[index]) {
      firstMsByBucket[index] = ms;
      firstRowByBucket[index] = row._row;
    }
  }

  // Forward-fill so a jump-target bucket whose own slice caught no transcript
  // row still resolves to the nearest preceding row — matching `scrollToTraceRow`
  // ("greatest data-row ≤ target") — while leading gaps fall back to the earliest
  // row so an early bar scrolls to the top.
  let carry = earliestRow;
  return buckets.map((bucket, index) => {
    const resolved = firstRowByBucket[index];
    if (resolved != null) {
      carry = resolved;
    }
    if (bucket.tl0 == null || bucket.tl0 === carry) {
      return bucket;
    }
    return { ...bucket, tl0: carry };
  });
}

/** Position a dot by its ordinal among trace rows, when no usable time exists. */
export function getTraceRowPercent(
  session: SessionTranscriptRows,
  fallbackRow: number
): number {
  const rows = session.turnItems?.filter(hasTraceRow) ?? [];
  if (rows.length <= 1) {
    return 0;
  }
  const index = rows.findIndex((row) => row._row >= fallbackRow);
  if (index >= 0) {
    return (index / (rows.length - 1)) * 100;
  }
  return 100;
}

/** Coerce a `Date`/ISO string to epoch ms, or `NaN` when absent/unparseable. */
export function getDateMs(value: unknown): number {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value !== "string") {
    return Number.NaN;
  }
  return Date.parse(value);
}

/** A turn item that carries both a transcript row and a rendered timestamp. */
export function hasTraceRow(
  item: TurnItem
): item is TurnItem & { _row: number; t: string } {
  return "_row" in item && "t" in item;
}

/** A `hasTraceRow` item whose timestamp actually parses. */
export function hasTimedTraceRow(item: TurnItem): item is TurnItem & {
  _row: number;
  t: string;
} {
  return hasTraceRow(item) && Number.isFinite(getTurnItemMs(item));
}

/** The epoch-ms of a turn item, preferring the pre-parsed `tMs` when present. */
export function getTurnItemMs(item: TurnItem): number {
  if ("tMs" in item && typeof item.tMs === "number") {
    return item.tMs;
  }
  if (!("t" in item) || typeof item.t !== "string") {
    return Number.NaN;
  }
  const parsed = Date.parse(item.t);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/** Which of `bucketCount` equal slices of `[firstMs, firstMs + spanMs]` holds `value`. */
export function getBucketIndexFromMs(
  value: number,
  firstMs: number,
  spanMs: number,
  bucketCount: number
): number {
  return clamp(
    Math.floor(((value - firstMs) / spanMs) * bucketCount),
    0,
    bucketCount - 1
  );
}

/**
 * Validate a candidate window. A non-finite bound, or an end EARLIER than its
 * start, yields `null` rather than a repaired window: an inverted window is
 * nonsensical source data (a corrupt `endedAt`), and silently clamping it to
 * zero length would let the geometry plot against a fabricated extent. `null`
 * is the honest "unknown", and every consumer already degrades to its ordinal
 * placement on it — which is also exactly what the prior per-call-site guards
 * (`endMs < startMs` → no-op) did.
 */
function buildWindow(
  startMs: number,
  endMs: number
): SessionTimelineWindow | null {
  if (
    !(Number.isFinite(startMs) && Number.isFinite(endMs)) ||
    endMs < startMs
  ) {
    return null;
  }
  return { startMs, endMs };
}

/** The union min/max of the instants this screen actually plots, or `null`. */
function collectPlottedActivityBounds(
  session: SessionTimelineWindowSource
): { minMs: number; maxMs: number } | null {
  let minMs = Number.POSITIVE_INFINITY;
  let maxMs = Number.NEGATIVE_INFINITY;
  let seen = false;
  const consider = (ms: number): void => {
    if (!Number.isFinite(ms)) {
      return;
    }
    seen = true;
    minMs = Math.min(minMs, ms);
    maxMs = Math.max(maxMs, ms);
  };
  // Folded rather than collected-then-spread: `Math.min(...instants)` passes one
  // argument per timed turn item, and the detail payload caps neither, so a long
  // session could reach V8's argument limit and throw a RangeError inside the
  // render path — taking the detail subtree down instead of degrading
  // (stage review, ISS-4833).
  for (const item of session.turnItems ?? []) {
    if (hasTimedTraceRow(item)) {
      consider(getTurnItemMs(item));
    }
  }
  const phaseSpan = getPhaseTilingSpan(session);
  if (phaseSpan) {
    consider(phaseSpan.startMs);
    consider(phaseSpan.endMs);
  }
  if (!seen) {
    return null;
  }
  return { minMs, maxMs };
}

/**
 * The `[min, max]` epoch-ms of a set of already-timed transcript rows, folded
 * rather than spread so the argument count cannot reach V8's limit on a long
 * session (stage review, ISS-4833). Callers pass rows they have already
 * filtered with {@link hasTimedTraceRow}, so every value is finite.
 */
export function getTimedRowBounds(
  timedRows: readonly (TurnItem & { _row: number; t: string })[]
): { minMs: number; maxMs: number } {
  let minMs = Number.POSITIVE_INFINITY;
  let maxMs = Number.NEGATIVE_INFINITY;
  for (const row of timedRows) {
    const ms = getTurnItemMs(row);
    minMs = Math.min(minMs, ms);
    maxMs = Math.max(maxMs, ms);
  }
  return { minMs, maxMs };
}

/**
 * The Activity-phases tiling's own span — the SAME `spanStartMs`/`spanEndMs`
 * that `session-activity-segments.tsx` formats into the "phases span …" caption
 * printed directly beneath the axis. `null` when the session carries no usable
 * tiling.
 *
 * ISS-5137: this is the single-sourcing that keeps the two adjacent captions
 * from stating different numbers for the same session. The axis does not
 * re-derive a span from a subset of the projection's segments; it reads the
 * projection's published bounds, so "the span the phases strip covers" has
 * exactly one definition and both captions render it. Idle spans are rendered on
 * that strip and measured by that caption, so they are part of the span it
 * reports — see {@link resolveSessionTimelineWindow} for why that outranks
 * ISS-4833's idle exclusion.
 */
function getPhaseTilingSpan(
  session: SessionTimelineWindowSource
): { endMs: number; startMs: number } | null {
  const phases = projectActivitySegments(session.activitySegmentRows, {
    rowsTruncated: session.activitySegmentRowsTruncated,
  });
  if (phases.spanStartMs === null || phases.spanEndMs === null) {
    return null;
  }
  return { endMs: phases.spanEndMs, startMs: phases.spanStartMs };
}

/**
 * The window's right edge, given the last PLOTTED instant and the session's own
 * lifecycle end.
 *
 * Normally the plotted max wins outright — that is the whole ISS-4833 guard: a
 * sweeper-stamped `endedAt` must not stretch the axis past the last thing drawn.
 *
 * ISS-5075 (stage review) is the one case where it cannot: when the detail read
 * hit its row ceiling, `turnItems` is a chronological PREFIX, so the last
 * plotted row marks where WE STOPPED READING, not where the run stopped. Ending
 * the axis there would make the Session Timeline's own "calendar span" contradict
 * the Duration property on the same screen, and would silently rescale the strip
 * so a partial run looked like a complete one. On that path the observed end is
 * honored when it is later, leaving the uncovered tail visibly unread — which
 * the strip's own treatment then marks.
 *
 * ISS-5075 (logical QA review): that extension takes the OBSERVED bound only,
 * NOT the axis-end resolver's `updatedAt` fallback. The population that trips
 * the event cap is exactly a long STILL-RUNNING session, which is also the
 * population most likely to carry neither `endedAt` nor `lastActivityAt` — so
 * the sync bump would have widened the calendar span on every resync while the
 * bars stayed put, the same ever-growing figure this change refuses elsewhere.
 * With no observed bound the plotted max stands.
 */
function resolveWindowEndMs(
  session: SessionTimelineWindowSource,
  plottedMaxMs: number | undefined,
  ends: { lifecycleEndMs: number; observedEndMs: number }
): number {
  if (plottedMaxMs == null) {
    return ends.lifecycleEndMs;
  }
  if (session.eventsTruncated && Number.isFinite(ends.observedEndMs)) {
    return Math.max(plottedMaxMs, ends.observedEndMs);
  }
  return plottedMaxMs;
}

/**
 * ISS-5124: strip the jump target off every bucket {@link alignBucketRowsToTranscript}
 * could not repair, so an unverified target is never handed to the UI.
 *
 * The repair bails on two inputs — no timed transcript rows, and no usable
 * window — and used to return `buckets` untouched. That looked like a safe
 * no-op and was not, because the value it preserved is not a transcript row at
 * all: the desktop producer writes its sync-time TIMELINE-EVENT array index
 * into `tl0`, and this function is the only thing that ever converts that
 * number into a `turnItems._row`. Skipping it does not leave the bar "as the
 * producer intended"; it leaves a number from a different numbering scheme
 * pointed at the transcript.
 *
 * Everything downstream then reads that number as real. `tl0 != null` is what
 * {@link getRowPercent} measures the "you are here" line against, and what makes
 * `getBucketButtonLabel` announce `Jump to activity bucket …` — an accessible
 * name promising navigation. Nothing between here and the click re-checks it:
 * `getBucketJumpBlock`'s `isRowInReadTranscript` is the reactive mirror of
 * `TraceRowTranslators.toRendered`, which returns the row UNCHANGED whenever the
 * two projections coincide (`IDENTITY_TRACE_ROW_TRANSLATORS`, and the
 * `sourceItems === renderedItems` short-circuit in `timeline-row-space.ts`), so
 * a bogus index passes that guard as readily as a real row. The click reaches
 * `findTraceScrollTarget`, whose contract is "greatest `[data-row]` ≤ row" —
 * so an index that overshoots every rendered anchor resolves to the LAST one.
 * That is the ISS-5124 report exactly: several distinct bars landing on one
 * identical `scrollTop` near the bottom of a long transcript, and the rest
 * reading as dead controls.
 *
 * `null` is the honest answer here, not a lesser one. It is already the whole
 * vocabulary for "this bar has nowhere to send you" — the inert
 * `Activity bucket …` name, the withdrawn affordance, and
 * `TraceScrollOutcome.NoJumpTarget` — so a demoted bar is indistinguishable
 * from a genuinely idle one, which is correct: in both cases this screen has no
 * transcript row to offer. Deliberately NOT "keep the raw index and hope": a
 * control that announces a jump it cannot make is worse than one that never
 * offered it, and it lies to a screen-reader user in the accessible name.
 *
 * Returns `buckets` by reference when nothing needed demoting, preserving the
 * identity the prior early-return had. That is an optimization, not a
 * correctness requirement, and a narrow one: the caller's own `useMemo` in
 * `agent-session-detail-view.tsx` usually stops the recompute first, so this
 * only pays off when that memo re-runs over an unchanged, already-idle
 * `session.activityBuckets` and the downstream `jumpBlocks` memo can then
 * skip on `Object.is`.
 */
function demoteUnrepairedJumpRows(buckets: ActivityBucket[]): ActivityBucket[] {
  if (buckets.every((bucket) => bucket.tl0 == null)) {
    return buckets;
  }
  return buckets.map((bucket) =>
    bucket.tl0 == null ? bucket : { ...bucket, tl0: null }
  );
}
