import type { EventDot } from "../mock";

export const PROTOTYPE_EVENT_DOT_MAX_ROWS = 3;
const EVENT_DOT_KIND_ORDER: readonly EventDot["kind"][] = [
  "blue",
  "green",
  "red",
];

export type PositionedEventDot =
  | { type: "dot"; dot: EventDot; leftPct: number; stackIndex: number }
  | {
      type: "cluster";
      dots: readonly EventDot[];
      leftPct: number;
      stackIndex: number;
    };

export function positionEventDots(
  dots: readonly EventDot[],
  columnCount: number
): PositionedEventDot[] {
  if (columnCount <= 0) {
    return [];
  }
  const dotsByColumn = new Map<number, { dot: EventDot; index: number }[]>();
  dots.forEach((dot, index) => {
    const columnIndex = Math.max(
      0,
      Math.min(Math.floor((dot.leftPct / 100) * columnCount), columnCount - 1)
    );
    const columnDots = dotsByColumn.get(columnIndex) ?? [];
    columnDots.push({ dot, index });
    dotsByColumn.set(columnIndex, columnDots);
  });
  const positioned: (PositionedEventDot & { sourceIndex: number })[] = [];
  for (const [columnIndex, columnDots] of dotsByColumn) {
    const leftPct = ((columnIndex + 0.5) / columnCount) * 100;
    positioned.push(...positionColumnDots(columnDots, leftPct));
  }
  return positioned
    .sort((a, b) => a.sourceIndex - b.sourceIndex)
    .map(({ sourceIndex: _sourceIndex, ...entry }) => entry);
}

function positionColumnDots(
  columnDots: readonly { dot: EventDot; index: number }[],
  leftPct: number
): (PositionedEventDot & { sourceIndex: number })[] {
  const groups = groupColumnDotsByKind(columnDots);
  if (groups.length <= PROTOTYPE_EVENT_DOT_MAX_ROWS) {
    return groups.map((group, stackIndex) =>
      positionKindGroup(group, leftPct, stackIndex)
    );
  }
  const directGroups = groups.slice(0, PROTOTYPE_EVENT_DOT_MAX_ROWS - 1);
  const overflowGroups = groups.slice(PROTOTYPE_EVENT_DOT_MAX_ROWS - 1);
  return [
    ...directGroups.map((group, stackIndex) =>
      positionKindGroup(group, leftPct, stackIndex)
    ),
    {
      dots: overflowGroups.flatMap((group) =>
        group.items.map(({ dot }) => dot)
      ),
      leftPct,
      sourceIndex:
        overflowGroups[0]?.items[0]?.index ?? columnDots[0]?.index ?? 0,
      stackIndex: PROTOTYPE_EVENT_DOT_MAX_ROWS - 1,
      type: "cluster",
    },
  ];
}

function groupColumnDotsByKind(
  columnDots: readonly { dot: EventDot; index: number }[]
): {
  items: readonly { dot: EventDot; index: number }[];
  kind: EventDot["kind"];
}[] {
  const groups = new Map<
    EventDot["kind"],
    { dot: EventDot; index: number }[]
  >();
  for (const item of columnDots) {
    const items = groups.get(item.dot.kind) ?? [];
    items.push(item);
    groups.set(item.dot.kind, items);
  }
  return [...groups]
    .map(([kind, items]) => ({ items, kind }))
    .sort(
      (a, b) =>
        EVENT_DOT_KIND_ORDER.indexOf(a.kind) -
        EVENT_DOT_KIND_ORDER.indexOf(b.kind)
    );
}

function positionKindGroup(
  group: { items: readonly { dot: EventDot; index: number }[] },
  leftPct: number,
  stackIndex: number
): PositionedEventDot & { sourceIndex: number } {
  if (group.items.length === 1) {
    const item = group.items[0]!;
    return {
      dot: item.dot,
      leftPct,
      sourceIndex: item.index,
      stackIndex,
      type: "dot",
    };
  }
  return {
    dots: group.items.map(({ dot }) => dot),
    leftPct,
    sourceIndex: group.items[0]?.index ?? 0,
    stackIndex,
    type: "cluster",
  };
}

export function eventDotClusterLabel(dots: readonly EventDot[]): string {
  if (dots.length === 1) {
    return "1 more timeline event";
  }
  return `${dots.length} more timeline events`;
}
