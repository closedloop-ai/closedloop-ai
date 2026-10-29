import { clamp } from "@repo/api/src/utils/math";
import {
  type DotColor,
  getMarkerDotColor,
} from "@repo/app/agents/components/detail/activity-dot-rendering";
import type { ActivityMarker } from "./session-timeline-axis";
import type { TimelineDotEvent } from "./session-timeline-strip-parts";

export function buildDotCells(
  markers: readonly ActivityMarker[],
  limitDotEvents: readonly ActivityMarker[],
  bucketCount: number
): DotCell[] {
  if (bucketCount === 0) {
    return [];
  }
  const laned = Array.from({ length: bucketCount }, createMarkerCell);
  for (const { color, marker } of collectLaneMarkers(markers, limitDotEvents)) {
    laned[getBucketIndexFromPercent(marker.x, bucketCount)][color].push(marker);
  }
  return laned.map(buildDotCell);
}

/** Both marker sources in ONE pass, tagged with the lane each one belongs to. */
function collectLaneMarkers(
  markers: readonly ActivityMarker[],
  limitDotEvents: readonly ActivityMarker[]
): LanedMarker[] {
  const laned: LanedMarker[] = [];
  for (const marker of markers) {
    const color = getMarkerDotColor(marker.kind);
    if (color) {
      laned.push({ color, marker });
    }
  }
  for (const marker of limitDotEvents) {
    laned.push({ color: "r", marker });
  }
  return laned;
}

/** Each of the cell's three lanes, ordered and reduced to what the strip renders. */
function buildDotCell(cell: MarkerCell): DotCell {
  return { b: orderLane(cell.b), g: orderLane(cell.g), r: orderLane(cell.r) };
}

/**
 * One lane, ordered so its first member is that bucket's FIRST event.
 *
 * ISS-8657: the limit dots used to be appended to the trouble lane in a SECOND
 * pass, so the lane's order was KIND PRIORITY — every failure, then every limit
 * — and answered to nothing else. `getDotJumpRow` takes the lane's first member,
 * the event the rail's click targets, so a bucket holding a 09:01 limit and a
 * 09:04 failure resolved to the failure.
 *
 * ISS-8721: ordering by plotted `x` alone could not answer that, because `x` is
 * not one scale on every path. It is clock-derived on the projected path
 * (`projectSessionTimeline` re-derives both sources through `resolveMarkerMs`)
 * and on the persisted-marker path, but NOT on the fallback path, where
 * `buildTurnMarker` derives `x` from a turn's ORDINAL while the limit dots carry
 * a window fraction — so a later limit could sort ahead of an earlier failure
 * and the click jumped to the wrong row. Both producers now carry the marker's
 * ABSOLUTE instant (`atMs`), which is one scale by construction, so a lane keys
 * on that whenever every one of ITS OWN members has one.
 *
 * Sorting is stable, so markers sharing a key keep the source order they had.
 */
function orderLane(lane: readonly ActivityMarker[]): TimelineDotEvent[] {
  const keys = resolveLaneSortKeys(lane);
  return lane
    .map((marker, index) => ({ key: keys[index], marker }))
    .sort((left, right) => left.key - right.key)
    .map(({ marker }) => ({
      kind: marker.kind,
      label: marker.label,
      t: marker.t,
      tl: marker.tl,
    }));
}

/**
 * The sort key for each member of ONE lane, parallel to `lane`: every marker's
 * `atMs` when every marker in that lane has a finite one, and otherwise every
 * marker's `x`.
 *
 * Returning one array rather than a comparator is what makes the choice a single
 * decision over the lane instead of a per-comparison one — a comparator that
 * reached for `atMs` only when BOTH sides carried it would not be transitive, so
 * the order it produced would depend on the source order it was meant to
 * replace. A key mixing milliseconds with percentages is not an order at all.
 *
 * SCOPED TO THE LANE, which is the unit `getDotJumpRow` actually reads. Deciding
 * this over the whole session instead (the shape this replaced) let ONE limit dot
 * whose instant falls outside the window — `withLimitDotInstant` withholds
 * `atMs` there, and the window is derived from transcript rows and the phase
 * span, never from a throttle's own timestamp — drop every OTHER bucket back
 * onto the mixed-scale comparison this exists to remove, including buckets whose
 * own members all carried an instant. A lane that genuinely has no common key
 * keeps the plotted-position order it already had, and no lane pays for a
 * different lane's missing instant.
 */
function resolveLaneSortKeys(lane: readonly ActivityMarker[]): number[] {
  const instants: number[] = [];
  for (const marker of lane) {
    if (marker.atMs === undefined || !Number.isFinite(marker.atMs)) {
      return lane.map((fallback) => fallback.x);
    }
    instants.push(marker.atMs);
  }
  return instants;
}

function getBucketIndexFromPercent(
  percent: number,
  bucketCount: number
): number {
  if (bucketCount <= 1) {
    return 0;
  }
  return clamp(Math.floor((percent / 100) * bucketCount), 0, bucketCount - 1);
}

function createMarkerCell(): MarkerCell {
  return { b: [], g: [], r: [] };
}

export type DotCell = Record<DotColor, TimelineDotEvent[]>;

/** A cell mid-build: the markers each lane caught, before they are ordered. */
type MarkerCell = Record<DotColor, ActivityMarker[]>;

type LanedMarker = { color: DotColor; marker: ActivityMarker };
