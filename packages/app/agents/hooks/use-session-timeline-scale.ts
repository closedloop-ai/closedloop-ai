"use client";

import type {
  ActivityBucket,
  SessionSpan,
  SyncedActivitySegmentRow,
} from "@repo/api/src/types/agent-session";
import { getRowPercent } from "@repo/app/agents/components/detail/activity-bucket-rendering";
import {
  type ActivityMarker,
  getSessionSpan,
} from "@repo/app/agents/components/detail/session-timeline-axis";
import {
  hasProducerBinBounds,
  type ProjectedTimeline,
  projectSessionTimeline,
  resolveBinMidpointMs,
} from "@repo/app/agents/lib/session-timeline-projection";
import {
  clampTimelineWindowStart,
  defaultTimelineScale,
  followTimelineWindowStart,
  recentreWindowStartForScale,
  resolveTimelineColumnIndex,
  resolveTimelineScaleGeometry,
  TIMELINE_VISIBLE_COLUMNS,
  TimelineScale,
  type TimelineScaleGeometry,
  timelineColumnStartMs,
} from "@repo/app/agents/lib/session-timeline-scale";
import { useCallback, useMemo, useState } from "react";
import {
  buildTimelineModelColors,
  buildTimelineStacks,
  resolveTimelineStackGrouping,
  TimelineStackGrouping as StackGrouping,
  type TimelineStackGrouping,
  type TimelineStackSegment,
} from "../lib/session-timeline-stacks";

/**
 * ISS-5819 — the Session Timeline's control state: which column width, which
 * stretch of the session, and which way the bars are cut.
 *
 * Held in ONE hook rather than three `useState`s at the call site because the
 * three are coupled: changing the scale has to re-centre the window (or the
 * reader is thrown back to the start of the run), and the projection every
 * downstream unit reads is a function of all of them. Splitting them apart is
 * how the toggle ends up acting on a window the scrubber has already moved.
 *
 * An unresolvable window — or a strip whose bins do not say which clock they
 * were measured on — yields `controls`, `scrubber`, `stacks` and `windowedAxis`
 * all `null`, and `columns`/`columnMarkers`/`columnLimitDots` pass the caller's
 * own inputs straight back, so such a strip renders exactly the bars it was
 * handed.
 *
 * The FALLBACKS LIVE HERE, not at the call site. The strip is inside a
 * grandfathered file, and a caller that has to write `projection?.x ?? x` five
 * times is both five chances to fall back to the wrong array and five points of
 * cognitive complexity in a component already at the lint ceiling.
 */
export type SessionTimelineScaleState = {
  readonly columnLimitDots: readonly ActivityMarker[];
  readonly columnMarkers: readonly ActivityMarker[];
  /** The bars to render — the projected columns, or the caller's own buckets. */
  readonly columns: readonly ActivityBucket[];
  /**
   * The `.tl-here` marker's position, as a percentage of the rendered strip;
   * `null` when the reader has not moved, or has scrubbed off-window.
   */
  readonly herePercent: number | null;
  /** `null` when no source window resolved: no scale toggle, no "Group by". */
  readonly controls: {
    readonly grouping: TimelineStackGrouping;
    readonly scale: TimelineScale;
    readonly setGrouping: (grouping: TimelineStackGrouping) => void;
    readonly setScale: (scale: TimelineScale) => void;
  } | null;
  /**
   * `null` when the session already fits the window — the prototype's
   * `maxWindowStart > 0` condition, resolved once so the control's visibility
   * and the window's pannability cannot disagree.
   */
  readonly scrubber: {
    readonly onPositionChange: (column: number) => void;
    /** The absolute column the marker sits on — the thumb IS the marker. */
    readonly position: number;
    readonly totalColumns: number;
  } | null;
  /** Parallel to `columns`; `null` keeps the bars' hardcoded in/out/cache stack. */
  readonly stacks: TimelineStackSegment[][] | null;
  /**
   * ISS-5819 review (wongk): `true` when the chosen scale draws columns NARROWER
   * than the source bins they were cut from, so the bars are interpolated inside
   * a measured bin rather than separately measured.
   *
   * Passed straight through from {@link ProjectedTimeline.subColumnSource} and
   * owed to the reader: a `5m` view of a strip binned in 18-minute bins reads as
   * five-minute measurement, and nothing else on screen says otherwise. The
   * caller states it — see `SessionTimelineControls`, which puts it beside the
   * control that causes it.
   *
   * `false` on the unprojected strip: the caller's own bars are exactly as
   * produced, so no interpolation has happened.
   */
  readonly subColumnSource: boolean;
  /**
   * The axis TICKS for a strip showing less than the whole session. `null` when
   * the window IS the session, so the caller keeps its own session-wide labels
   * on the exact code path it had before.
   *
   * Deliberately no duration: the caption between the ticks measures the RUN,
   * not the viewport. See {@link getWindowedAxis}.
   */
  readonly windowedAxis: {
    readonly span: SessionSpan;
  } | null;
};

export function useSessionTimelineScale({
  activeRow,
  activityPhasesEnabled,
  limitDotEvents,
  markers,
  buckets,
  ownerLabel,
  segmentRows,
  sourceWindow,
}: {
  /**
   * The transcript row the reader is currently on, or `null` before they have
   * scrolled or jumped. ONE of the two ways the timeline position moves — the
   * scrubber is the other, and both resolve through {@link
   * SessionTimelineScaleState.herePercent} so the marker and the thumb can never
   * point at different instants (ISS-5819, ahead of ISS-5843).
   */
  activeRow: number | null;
  /** The strip as produced upstream, and the bars rendered when no window resolves. */
  buckets: readonly ActivityBucket[];
  /**
   * ISS-5841: when activity phases are gated off the phase cut must not survive
   * as the effective grouping. The control no longer offers it, so the only way
   * to arrive here is a flag flipping OFF mid-session with the cut on screen --
   * which would otherwise leave the chart stacked by a dimension its own control
   * no longer lists.
   */
  activityPhasesEnabled: boolean;
  limitDotEvents: readonly ActivityMarker[];
  markers: readonly ActivityMarker[];
  ownerLabel: string;
  segmentRows: readonly SyncedActivitySegmentRow[];
  /**
   * The window this page's MARKERS were positioned over — the SAME window the
   * axis already runs on. `null` when none resolved, and the projection is then
   * skipped rather than run on a guessed scale.
   *
   * It is NOT where the bars go: those are placed from each bin's own
   * `binStartMs`/`binEndMs`, because this window and the producer's binning
   * window are different clocks (see `source` below).
   */
  sourceWindow: { endMs: number; startMs: number } | null;
}): SessionTimelineScaleState {
  /*
   * ISS-5819 review (wongk): the projection runs ONLY on a strip whose bins each
   * state the wall-clock span they were binned over.
   *
   * `sourceWindow` is this page's axis window, resolved from transcript, phase
   * and lifecycle bounds — it is not the window the bins were measured on. The
   * desktop collector bins over the session's real activity extent, so
   * redistributing its bins across the axis window puts measured cost under
   * clock ticks it never happened beneath. Bins that carry their own bounds are
   * projected against those; a strip missing them (an older payload, or the
   * ordinal `buildEvenActivityBuckets` fallback, which has no clock at all) is
   * left exactly as produced — the caller's own bars, no scale toggle, no
   * scrubber.
   *
   * `sourceWindow` still travels with the strip because MARKER geometry was
   * derived against it: a marker with no timestamp carries an ordinal `x`
   * measured over this window, and that is the only window that can turn it back
   * into an instant.
   */
  const source = useMemo(
    () =>
      sourceWindow == null || !hasProducerBinBounds(buckets)
        ? null
        : {
            buckets,
            endMs: sourceWindow.endMs,
            startMs: sourceWindow.startMs,
          },
    [buckets, sourceWindow]
  );
  /*
   * `null` until the reader picks one, and the DEFAULT is derived every render
   * rather than captured in a lazy initializer. The strip is not always there on
   * the first render — the detail read streams, so `source` is routinely `null`
   * at mount — and a captured initializer would pin a 3-day session to the `5m`
   * scale forever, needing 800 scrubber steps to cross.
   *
   * #4753 review (wongk): the default is asked of the RESOLVED GEOMETRY, not of
   * the raw duration, so it accounts for the clock-boundary floor the same
   * geometry applies. See `defaultTimelineScale`.
   */
  const [chosenScale, setChosenScale] = useState<TimelineScale | null>(null);
  const scale =
    chosenScale ??
    (source == null
      ? TimelineScale.FiveMinutes
      : defaultTimelineScale({ endMs: source.endMs, startMs: source.startMs }));
  const [windowStart, setWindowStartState] = useState(0);
  const [grouping, setGrouping] = useState<TimelineStackGrouping>(
    StackGrouping.TokenType
  );

  /*
   * The scrubbed position, and the `activeRow` it was set against.
   *
   * Storing the row alongside the column is what keeps ONE position rather than
   * two: a scrub is authoritative only until the reader moves by some other
   * means (scrolling the transcript, clicking a bar, a jump), at which point
   * `activeRow` changes, the stored `forRow` no longer matches, and the position
   * falls back to the row. No effect and no cross-render sync is needed — the
   * staleness is a comparison, resolved during render.
   */
  const [scrub, setScrub] = useState<{
    column: number;
    forRow: number | null;
  } | null>(null);

  /*
   * Geometry, position and window, resolved in that order and all BEFORE the
   * projection — the projection consumes the window, so it cannot also be what
   * the window is derived from.
   */
  const geometry =
    source == null
      ? null
      : resolveTimelineScaleGeometry({
          endMs: source.endMs,
          scale,
          startMs: source.startMs,
        });
  const rowColumn = resolveRowColumn({ activeRow, geometry, scale, source });
  const activeColumn =
    scrub && scrub.forRow === activeRow ? scrub.column : rowColumn;
  /*
   * The window FOLLOWS the position, panning by the minimum needed to keep it in
   * view. That is what makes the thumb and the marker one control: moving the
   * thumb past the window's edge brings the window along instead of leaving the
   * marker stranded off-screen.
   */
  const followedWindowStart =
    activeColumn == null || geometry == null
      ? clampTimelineWindowStart(windowStart, geometry?.maxWindowStart ?? 0)
      : followTimelineWindowStart({
          activeColumn,
          currentWindowStart: windowStart,
          maxWindowStart: geometry.maxWindowStart,
        });

  const projection = useMemo(
    () =>
      source == null
        ? null
        : projectSessionTimeline({
            limitDotEvents,
            markers,
            scale,
            segmentRows,
            source,
            windowStart: followedWindowStart,
          }),
    [followedWindowStart, limitDotEvents, markers, scale, segmentRows, source]
  );

  /*
   * Colours are assigned from the WHOLE strip, not from the visible columns, so
   * a model keeps its colour while the scrubber moves. Deriving them from
   * `projection.buckets` would recolour the legend on every pan.
   */
  const modelColors = useMemo(
    () => buildTimelineModelColors(buckets),
    [buckets]
  );

  const effectiveGrouping = resolveTimelineStackGrouping(
    grouping,
    activityPhasesEnabled
  );

  const stacks = useMemo(
    () =>
      projection == null
        ? EMPTY_STACKS
        : buildTimelineStacks({
            buckets: projection.buckets,
            grouping: effectiveGrouping,
            modelColors,
            ownerLabel,
            phaseCosts: projection.phaseCosts,
          }),
    [effectiveGrouping, modelColors, ownerLabel, projection]
  );

  const setPosition = useCallback(
    (column: number) => setScrub({ column, forRow: activeRow }),
    [activeRow]
  );

  const setScale = useCallback(
    (nextScale: TimelineScale) => {
      if (source == null) {
        return;
      }
      /*
       * Re-centre on the instant already centred, so switching `1h` to `5m`
       * zooms INTO what the reader is looking at rather than teleporting them
       * to the start of the session. The midpoint is read from the CURRENT
       * geometry rather than from `projection`, because a scale change can be
       * dispatched before the projection for the new scale exists.
       */
      const current = resolveTimelineScaleGeometry({
        endMs: source.endMs,
        scale,
        startMs: source.startMs,
      });
      /*
       * `followedWindowStart`, NOT the `windowStart` state. Scrubbing writes the
       * POSITION, and the window is derived from it every render — so the state
       * is whatever the last scale change left behind, and re-centring on it
       * would throw the reader back to wherever they were before their last
       * scrub. That is the one thing this re-centring exists to prevent.
       */
      // ISS-5844: asked of the boundary model, not multiplied — at `12h` a
      // window holding a DST transition is not `24 x columnMs` of real time,
      // so the arithmetic midpoint is not the instant the reader is centred on.
      const visibleMidpointMs = midpointOfColumns({
        firstColumn: followedWindowStart,
        lastColumn: followedWindowStart + TIMELINE_VISIBLE_COLUMNS,
        originMs: current.originMs,
        scale,
      });
      const next = resolveTimelineScaleGeometry({
        endMs: source.endMs,
        scale: nextScale,
        startMs: source.startMs,
      });
      /*
       * A scrubbed column is an index into THIS scale's grid, so it means
       * nothing in the next one — column 40 of 41 at `12h` is column 40 of 5760
       * at `5m`, i.e. the start of the session, and going the other way hands
       * the slider a value past its own `max` and announces a column that does
       * not exist. Carry the INSTANT across instead; the index is a
       * representation, not the thing being preserved.
       */
      if (activeColumn != null) {
        const instantMs = midpointOfColumns({
          firstColumn: activeColumn,
          lastColumn: activeColumn + 1,
          originMs: current.originMs,
          scale,
        });
        setScrub({
          column: Math.max(
            0,
            Math.min(
              next.totalColumns - 1,
              resolveTimelineColumnIndex({
                instantMs,
                originMs: next.originMs,
                scale: nextScale,
              })
            )
          ),
          forRow: activeRow,
        });
      }
      setChosenScale(nextScale);
      setWindowStartState(
        recentreWindowStartForScale({
          endMs: source.endMs,
          nextScale,
          startMs: source.startMs,
          visibleMidpointMs,
        })
      );
    },
    [activeColumn, activeRow, followedWindowStart, scale, source]
  );

  if (projection == null) {
    return {
      columnLimitDots: limitDotEvents,
      columnMarkers: markers,
      columns: buckets,
      controls: null,
      // With nothing to project onto, the marker derives its position over the
      // caller's own bars, exactly as the strip did before this hook existed.
      herePercent: activeRow == null ? null : getRowPercent(activeRow, buckets),
      scrubber: null,
      stacks: null,
      subColumnSource: false,
      windowedAxis: null,
    };
  }
  /*
   * ONE position for the whole strip. `activeColumn` is an ABSOLUTE column index
   * across the session, and it is what the `.tl-here` marker and the scrubber
   * thumb both read — dragging the thumb moves the marker, and jumping moves the
   * thumb, because there is only one number. Building the scrubber on the window
   * offset instead would have made "where the reader is" and "what is on screen"
   * two independent states that drift apart the moment either one moves.
   */
  return {
    columnLimitDots: projection.limitDotEvents,
    columnMarkers: projection.markers,
    columns: projection.buckets,
    controls: { grouping: effectiveGrouping, scale, setGrouping, setScale },
    herePercent: getHerePercent(activeColumn, projection.windowStart),
    scrubber:
      projection.maxWindowStart > 0
        ? {
            onPositionChange: setPosition,
            // Clamped, so the slider can never be handed a value past its own
            // `max` (which renders a thumb off the track and announces a column
            // that does not exist).
            position: Math.max(
              0,
              Math.min(projection.totalColumns - 1, activeColumn ?? 0)
            ),
            totalColumns: projection.totalColumns,
          }
        : null,
    stacks,
    subColumnSource: projection.subColumnSource,
    windowedAxis: getWindowedAxis(projection),
  };
}

/**
 * The ABSOLUTE column the reader's transcript row falls in, or `null` before
 * they have moved.
 *
 * Resolved from the SOURCE strip rather than from the projected columns, and
 * that ordering is load-bearing: the projection is built over the window, the
 * window follows this position, so deriving the position from the projection
 * would close a cycle. The source bin's midpoint is the instant used, then
 * placed on the clock grid.
 *
 * The bin is picked by the same "last bin whose `tl0` is at or before the row"
 * rule `getRowPercent` uses on the unprojected strip, so projecting moves WHERE
 * the answer is used without changing how a row resolves to a place.
 */
function resolveRowColumn({
  activeRow,
  geometry,
  scale,
  source,
}: {
  activeRow: number | null;
  geometry: TimelineScaleGeometry | null;
  scale: TimelineScale;
  source: {
    buckets: readonly ActivityBucket[];
    endMs: number;
    startMs: number;
  } | null;
}): number | null {
  if (activeRow == null || geometry == null || source == null) {
    return null;
  }
  let binIndex = 0;
  for (const [index, bucket] of source.buckets.entries()) {
    if (bucket.tl0 != null && bucket.tl0 <= activeRow) {
      binIndex = index;
    }
  }
  const bin = source.buckets[binIndex];
  // The bin's OWN midpoint, not `startMs + (binIndex + 0.5) * (span / count)`.
  // The bars are placed from these bounds, so placing the marker from a second,
  // window-derived arithmetic would let the two disagree about which column the
  // reader is standing in. `null` is unreachable behind the caller's
  // `hasProducerBinBounds` gate and is answered as "no position" rather than a
  // fabricated one.
  const binMidpointMs = bin == null ? null : resolveBinMidpointMs(bin);
  if (binMidpointMs == null) {
    return null;
  }
  return Math.max(
    0,
    Math.min(
      geometry.totalColumns - 1,
      resolveTimelineColumnIndex({
        instantMs: binMidpointMs,
        originMs: geometry.originMs,
        scale,
      })
    )
  );
}

/**
 * The instant halfway between two column boundaries (ISS-5844). Both callers
 * want "the time the reader is looking at" and neither may assume a column is
 * `columnMs` of real time, which a DST-crossing `12h` column is not.
 */
function midpointOfColumns({
  firstColumn,
  lastColumn,
  originMs,
  scale,
}: {
  firstColumn: number;
  lastColumn: number;
  originMs: number;
  scale: TimelineScale;
}): number {
  const startMs = timelineColumnStartMs({
    columnIndex: firstColumn,
    originMs,
    scale,
  });
  const endMs = timelineColumnStartMs({
    columnIndex: lastColumn,
    originMs,
    scale,
  });
  return startMs + (endMs - startMs) / 2;
}

/**
 * The marker's left offset as a percentage of the VISIBLE window, or `null` when
 * the position is off-window (the marker is then not drawn, rather than clamped
 * to an edge it is not at).
 */
function getHerePercent(
  activeColumn: number | null,
  windowStart: number
): number | null {
  if (activeColumn == null) {
    return null;
  }
  const visibleIndex = activeColumn - windowStart;
  if (visibleIndex < 0 || visibleIndex >= TIMELINE_VISIBLE_COLUMNS) {
    return null;
  }
  return ((visibleIndex + 0.5) / TIMELINE_VISIBLE_COLUMNS) * 100;
}

/**
 * The axis labels for a windowed strip. ALWAYS derived from the window — there
 * is no "the window is the session" shortcut, because there almost never is one.
 *
 * `defaultTimelineScale` picks the COARSEST scale whose 24 columns still cover
 * the run, so the window is routinely much wider than the session: a 25-hour
 * session opens at `12h` and draws 3 bars inside a 12-DAY strip. Falling back to
 * the session's own ticks there put a right-hand tick 11 days from the last bar,
 * naming an instant the chart is not drawn to — the tick-and-bars disagreement
 * ISS-4833 exists to prevent, reintroduced by a "this case is trivial" branch
 * that was in fact the common case.
 *
 * Both edges come from the ONE projection the bars are plotted over, and both go
 * through the axis's own `getSessionSpan` formatter — so a windowed row carries
 * the same date-qualification and seconds-precision rules as an unwindowed one,
 * and the ticks cannot name instants the bars are not drawn between. That is the
 * one-derivation rule ISS-4833 / ISS-5366 established, extended to the window.
 *
 * THE TICKS ONLY — NOT the duration caption between them (#4753). This used to
 * return a `durationLabel` of `formatDuration(windowStart, windowEnd)`, and the
 * axis printed it: a 20-minute run opened at `5m`, whose 24 columns are two
 * hours wide, reported "calendar span 2h 0m" for a run that lasted 20 minutes.
 *
 * That is the UI lying about the data, on two counts. The caption's own tooltip
 * promises "calendar time between the FIRST AND LAST EVENT on this axis", and
 * the window is a VIEWPORT — it is chosen by `defaultTimelineScale` and moved by
 * the scrubber, so a measurement taken from it changes when the reader changes
 * the zoom, which no real duration does. And ISS-4791 established that this
 * caption and the "phases span" caption directly beneath it must reconcile;
 * beneath a 2h axis total the phases caption still, correctly, read 20m 0s, so
 * the two adjacent captions contradicted each other — the exact defect ISS-4791
 * closed.
 *
 * The ticks legitimately name the window because the BARS are drawn over the
 * window. The duration between them is a fact about the RUN, so it stays the
 * session's own, and the window's width is already legible from the ticks.
 */
function getWindowedAxis(projection: ProjectedTimeline): {
  span: SessionSpan;
} {
  const start = new Date(projection.windowStartMs);
  const end = new Date(projection.windowEndMs);
  return { span: getSessionSpan({ end, start, window: null }) };
}

const EMPTY_STACKS: TimelineStackSegment[][] = [];
