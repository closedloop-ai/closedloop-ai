import {
  getTimelineMarkerSemanticSort,
  TIMELINE_MARKER_SEMANTIC_ORDER,
  type TimelineMarkerSemantic,
} from "./timeline-marker-semantics";

export const BRANCH_TIMELINE_MARKER_TARGET_SIZE_PX = 24;
export const BRANCH_TIMELINE_MARKER_VISIBLE_SIZE_PX = 12;
export const BRANCH_TIMELINE_MARKER_LANE_PITCH_PX = 24;
export const BRANCH_TIMELINE_MARKER_MAX_DIRECT_LANES =
  TIMELINE_MARKER_SEMANTIC_ORDER.length;
export const DEFAULT_TIMELINE_MARKER_RAIL_WIDTH_PX = 1024;

export type TimelineMarkerGeometry = {
  targetSizePx: number;
  visibleSizePx: number;
  lanePitchPx: number;
  maxDirectLanes: number;
};

export type TimelineMarkerInput<TPayload> = {
  id: string;
  label: string;
  leftPct: number;
  row: number | null;
  semantic: TimelineMarkerSemantic;
  sourceOrder: number;
  stableOrderKey: string;
  timeMs: number;
  payload: TPayload;
};

export type PackedTimelineMarker<TPayload> = {
  id: string;
  kind: "direct";
  item: TimelineMarkerInput<TPayload>;
  laneIndex: number;
  leftPct: number;
  topPx: number;
  targetSizePx: number;
  visibleSizePx: number;
};

export type PackedTimelineCluster<TPayload> = {
  id: string;
  kind: "cluster";
  items: readonly TimelineMarkerInput<TPayload>[];
  laneIndex: number;
  leftPct: number;
  topPx: number;
  targetSizePx: number;
  visibleSizePx: number;
};

export type PackedTimelineEntry<TPayload> =
  | PackedTimelineMarker<TPayload>
  | PackedTimelineCluster<TPayload>;

export type TimelineMarkerPackResult<TPayload> = {
  entries: readonly PackedTimelineEntry<TPayload>[];
  geometry: TimelineMarkerGeometry;
  railHeightPx: number;
};

type PositionedInput<TPayload> = TimelineMarkerInput<TPayload> & {
  endPx: number;
  leftPx: number;
  startPx: number;
};

type LaneAssignment<TPayload> = {
  item: PositionedInput<TPayload>;
  laneIndex: number;
};

type SemanticLaneGroup<TPayload> = {
  items: readonly PositionedInput<TPayload>[];
  semantic: TimelineMarkerSemantic;
};

export function getBranchTimelineMarkerGeometry(): TimelineMarkerGeometry {
  return {
    lanePitchPx: BRANCH_TIMELINE_MARKER_LANE_PITCH_PX,
    maxDirectLanes: BRANCH_TIMELINE_MARKER_MAX_DIRECT_LANES,
    targetSizePx: BRANCH_TIMELINE_MARKER_TARGET_SIZE_PX,
    visibleSizePx: BRANCH_TIMELINE_MARKER_VISIBLE_SIZE_PX,
  };
}

export function packTimelineMarkers<TPayload>(
  items: readonly TimelineMarkerInput<TPayload>[],
  options: Readonly<{
    geometry?: Partial<TimelineMarkerGeometry>;
    railWidthPx?: number;
  }> = {}
): TimelineMarkerPackResult<TPayload> {
  const geometry = resolveGeometry(options.geometry);
  const railWidthPx = resolveRailWidth(options.railWidthPx);
  const positioned = items
    .filter((item) => Number.isFinite(item.timeMs))
    .map((item) => positionInput(item, railWidthPx, geometry.targetSizePx))
    .sort(compareTimelineMarkerInputs);
  const entries: PackedTimelineEntry<TPayload>[] = [];
  for (const group of groupCollidingInputs(positioned)) {
    entries.push(...packSemanticCollisionGroup(group, geometry));
  }
  const lanesUsed = Math.max(1, ...entries.map((entry) => entry.laneIndex + 1));
  return {
    entries,
    geometry,
    railHeightPx: lanesUsed * geometry.lanePitchPx,
  };
}

export function getPackedTimelineMarkerStyle(
  entry: Pick<PackedTimelineEntry<unknown>, "leftPct" | "topPx">
): { left: string; top: string } {
  return {
    left: `${entry.leftPct}%`,
    top: `${entry.topPx}px`,
  };
}

function resolveGeometry(
  overrides: Partial<TimelineMarkerGeometry> | undefined
): TimelineMarkerGeometry {
  const base = getBranchTimelineMarkerGeometry();
  return {
    lanePitchPx: positiveOr(base.lanePitchPx, overrides?.lanePitchPx),
    maxDirectLanes: Math.max(
      1,
      Math.floor(positiveOr(base.maxDirectLanes, overrides?.maxDirectLanes))
    ),
    targetSizePx: positiveOr(base.targetSizePx, overrides?.targetSizePx),
    visibleSizePx: positiveOr(base.visibleSizePx, overrides?.visibleSizePx),
  };
}

function positiveOr(fallback: number, value: number | undefined): number {
  return value != null && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function resolveRailWidth(value: number | undefined): number {
  return value != null && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_TIMELINE_MARKER_RAIL_WIDTH_PX;
}

function positionInput<TPayload>(
  item: TimelineMarkerInput<TPayload>,
  railWidthPx: number,
  targetSizePx: number
): PositionedInput<TPayload> {
  const leftPct = Math.max(0, Math.min(100, item.leftPct));
  const leftPx = (leftPct / 100) * railWidthPx;
  const halfTarget = targetSizePx / 2;
  return {
    ...item,
    leftPct,
    endPx: leftPx + halfTarget,
    leftPx,
    startPx: leftPx - halfTarget,
  };
}

function compareTimelineMarkerInputs<TPayload>(
  a: TimelineMarkerInput<TPayload>,
  b: TimelineMarkerInput<TPayload>
): number {
  return (
    a.timeMs - b.timeMs ||
    getTimelineMarkerSemanticSort(a.semantic) -
      getTimelineMarkerSemanticSort(b.semantic) ||
    compareNullableRows(a.row, b.row) ||
    a.sourceOrder - b.sourceOrder ||
    a.stableOrderKey.localeCompare(b.stableOrderKey) ||
    a.id.localeCompare(b.id)
  );
}

function compareNullableRows(a: number | null, b: number | null): number {
  if (a == null && b == null) {
    return 0;
  }
  if (a == null) {
    return 1;
  }
  if (b == null) {
    return -1;
  }
  return a - b;
}

function groupCollidingInputs<TPayload>(
  items: readonly PositionedInput<TPayload>[]
): PositionedInput<TPayload>[][] {
  const groups: PositionedInput<TPayload>[][] = [];
  let current: PositionedInput<TPayload>[] = [];
  let currentEndPx = Number.NEGATIVE_INFINITY;
  for (const item of items) {
    if (current.length === 0 || item.startPx < currentEndPx) {
      current.push(item);
      currentEndPx = Math.max(currentEndPx, item.endPx);
      continue;
    }
    groups.push(current);
    current = [item];
    currentEndPx = item.endPx;
  }
  if (current.length > 0) {
    groups.push(current);
  }
  return groups;
}

function packSemanticCollisionGroup<TPayload>(
  group: readonly PositionedInput<TPayload>[],
  geometry: TimelineMarkerGeometry
): PackedTimelineEntry<TPayload>[] {
  const semanticRows = groupSemanticRows(group);
  if (semanticRows.length <= geometry.maxDirectLanes) {
    return semanticRows.flatMap((row, laneIndex) =>
      packSemanticRow(row.items, laneIndex, geometry)
    );
  }
  const directRowCount = Math.max(0, geometry.maxDirectLanes - 1);
  const directEntries = semanticRows
    .slice(0, directRowCount)
    .flatMap((row, laneIndex) =>
      packSemanticRow(row.items, laneIndex, geometry)
    );
  const overflowItems = semanticRows
    .slice(directRowCount)
    .flatMap((row) => row.items);
  if (overflowItems.length === 0) {
    return directEntries;
  }
  return [
    ...directEntries,
    toClusterEntry(overflowItems, geometry, geometry.maxDirectLanes - 1),
  ];
}

function groupSemanticRows<TPayload>(
  group: readonly PositionedInput<TPayload>[]
): SemanticLaneGroup<TPayload>[] {
  const rows = new Map<TimelineMarkerSemantic, PositionedInput<TPayload>[]>();
  for (const item of group) {
    const items = rows.get(item.semantic) ?? [];
    items.push(item);
    rows.set(item.semantic, items);
  }
  return [...rows]
    .map(([semantic, items]) => ({
      items: [...items].sort(compareTimelineMarkerInputs),
      semantic,
    }))
    .sort(
      (a, b) =>
        getTimelineMarkerSemanticSort(a.semantic) -
        getTimelineMarkerSemanticSort(b.semantic)
    );
}

function packSemanticRow<TPayload>(
  items: readonly PositionedInput<TPayload>[],
  laneIndex: number,
  geometry: TimelineMarkerGeometry
): PackedTimelineEntry<TPayload>[] {
  return groupCollidingInputs(items).map((collidingItems) => {
    if (collidingItems.length === 1) {
      return toDirectEntry({ item: collidingItems[0]!, laneIndex }, geometry);
    }
    return toClusterEntry(collidingItems, geometry, laneIndex);
  });
}

function toDirectEntry<TPayload>(
  assignment: LaneAssignment<TPayload>,
  geometry: TimelineMarkerGeometry
): PackedTimelineMarker<TPayload> {
  return {
    id: assignment.item.id,
    item: assignment.item,
    kind: "direct",
    laneIndex: assignment.laneIndex,
    leftPct: assignment.item.leftPct,
    targetSizePx: geometry.targetSizePx,
    topPx: assignment.laneIndex * geometry.lanePitchPx,
    visibleSizePx: geometry.visibleSizePx,
  };
}

function toClusterEntry<TPayload>(
  items: readonly TimelineMarkerInput<TPayload>[],
  geometry: TimelineMarkerGeometry,
  laneIndex: number
): PackedTimelineCluster<TPayload> {
  const leftPct =
    items.reduce((total, item) => total + item.leftPct, 0) / items.length;
  return {
    id: `cluster-${items.map((item) => item.id).join("-")}`,
    items,
    kind: "cluster",
    laneIndex,
    leftPct,
    targetSizePx: geometry.targetSizePx,
    topPx: laneIndex * geometry.lanePitchPx,
    visibleSizePx: geometry.visibleSizePx,
  };
}
