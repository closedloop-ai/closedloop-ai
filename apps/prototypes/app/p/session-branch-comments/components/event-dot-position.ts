import type { EventDot } from "../mock";

export function positionEventDots(
  dots: readonly EventDot[],
  columnCount: number
): { dot: EventDot; leftPct: number; stackIndex: number }[] {
  if (columnCount <= 0) {
    return [];
  }
  const stackSizeByColumn = new Map<number, number>();
  return dots.map((dot) => {
    const columnIndex = Math.max(
      0,
      Math.min(Math.floor((dot.leftPct / 100) * columnCount), columnCount - 1)
    );
    const stackIndex = stackSizeByColumn.get(columnIndex) ?? 0;
    stackSizeByColumn.set(columnIndex, stackIndex + 1);
    return {
      dot,
      leftPct: ((columnIndex + 0.5) / columnCount) * 100,
      stackIndex,
    };
  });
}
