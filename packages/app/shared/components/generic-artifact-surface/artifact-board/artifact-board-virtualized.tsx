"use client";

import {
  KANBAN_COLUMN_GAP_PX,
  KANBAN_COLUMN_WIDTH_PX,
  KanbanBoardLayout,
} from "@repo/design-system/components/ui/layout/kanban-board";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  type ReactNode,
  type Ref,
  useCallback,
  useMemo,
  useState,
} from "react";
import type {
  ArtifactBoardItem,
  ArtifactBoardLane,
} from "./artifact-board-model";
import {
  ARTIFACT_BOARD_CARD_ESTIMATE_PX,
  ARTIFACT_BOARD_CARD_OVERSCAN,
  ARTIFACT_BOARD_LANE_OVERSCAN,
  artifactBoardPinnedIndexes,
  artifactBoardPinnedRange,
  shouldVirtualizeArtifactBoardCards,
  shouldVirtualizeArtifactBoardLanes,
} from "./artifact-board-virtualization";

export function ArtifactBoardLaneWindow({
  lanes,
  pinnedLaneIds,
  renderLane,
}: Readonly<{
  lanes: readonly ArtifactBoardLane[];
  pinnedLaneIds: ReadonlySet<string>;
  renderLane: (lane: ArtifactBoardLane, index: number) => ReactNode;
}>) {
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(
    null
  );
  const virtualized = shouldVirtualizeArtifactBoardLanes(lanes.length);
  const pinnedIndexes = useMemo(
    () =>
      artifactBoardPinnedIndexes(
        lanes.map((lane) => lane.id),
        pinnedLaneIds
      ),
    [lanes, pinnedLaneIds]
  );
  const rangeExtractor = useCallback(
    (range: Parameters<typeof artifactBoardPinnedRange>[0]) =>
      artifactBoardPinnedRange(range, pinnedIndexes),
    [pinnedIndexes]
  );
  const virtualizer = useVirtualizer({
    count: lanes.length,
    enabled: virtualized,
    estimateSize: () => KANBAN_COLUMN_WIDTH_PX,
    gap: KANBAN_COLUMN_GAP_PX,
    getScrollElement: () => scrollElement,
    horizontal: true,
    initialRect: {
      height: 0,
      width: (KANBAN_COLUMN_WIDTH_PX + KANBAN_COLUMN_GAP_PX) * 3,
    },
    overscan: ARTIFACT_BOARD_LANE_OVERSCAN,
    rangeExtractor,
  });

  if (!virtualized) {
    return (
      <KanbanBoardLayout
        className="min-h-96 flex-1"
        contentClassName="min-h-96"
      >
        {lanes.map(renderLane)}
      </KanbanBoardLayout>
    );
  }

  return (
    <KanbanBoardLayout
      className="min-h-96 flex-1"
      contentClassName="relative min-h-96"
      contentStyle={{ width: virtualizer.getTotalSize() }}
      viewportRef={setScrollElement}
    >
      {virtualizer.getVirtualItems().map((virtualLane) => {
        const lane = lanes[virtualLane.index];
        if (!lane) {
          return null;
        }
        return (
          <div
            data-artifact-board-lane-virtual-index={virtualLane.index}
            data-index={virtualLane.index}
            key={virtualLane.key}
            ref={virtualizer.measureElement}
            style={{
              left: 0,
              position: "absolute",
              top: 0,
              transform: `translateX(${virtualLane.start}px)`,
              width: virtualLane.size,
            }}
          >
            {renderLane(lane, virtualLane.index)}
          </div>
        );
      })}
    </KanbanBoardLayout>
  );
}

export function ArtifactBoardCardWindow({
  endSlot,
  pinnedRootIds,
  renderColumn,
  renderRoot,
  roots,
}: Readonly<{
  endSlot: ReactNode;
  pinnedRootIds: ReadonlySet<string>;
  renderColumn: (
    children: ReactNode,
    bodyRef: Ref<HTMLDivElement>
  ) => ReactNode;
  renderRoot: (item: ArtifactBoardItem, index: number) => ReactNode;
  roots: readonly ArtifactBoardItem[];
}>) {
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(
    null
  );
  const virtualized = shouldVirtualizeArtifactBoardCards(roots.length);
  const pinnedIndexes = useMemo(
    () =>
      artifactBoardPinnedIndexes(
        roots.map((root) => root.id),
        pinnedRootIds
      ),
    [pinnedRootIds, roots]
  );
  const rangeExtractor = useCallback(
    (range: Parameters<typeof artifactBoardPinnedRange>[0]) =>
      artifactBoardPinnedRange(range, pinnedIndexes),
    [pinnedIndexes]
  );
  const virtualizer = useVirtualizer({
    count: roots.length,
    enabled: virtualized,
    estimateSize: () => ARTIFACT_BOARD_CARD_ESTIMATE_PX,
    getScrollElement: () => scrollElement,
    initialRect: {
      height: ARTIFACT_BOARD_CARD_ESTIMATE_PX * 4,
      width: KANBAN_COLUMN_WIDTH_PX,
    },
    overscan: ARTIFACT_BOARD_CARD_OVERSCAN,
    rangeExtractor,
  });

  if (!virtualized) {
    return renderColumn(
      <>
        {roots.map(renderRoot)}
        {endSlot}
      </>,
      setScrollElement
    );
  }

  return renderColumn(
    <>
      <div
        data-artifact-board-card-window
        style={{ height: virtualizer.getTotalSize(), position: "relative" }}
      >
        {virtualizer.getVirtualItems().map((virtualCard) => {
          const root = roots[virtualCard.index];
          if (!root) {
            return null;
          }
          return (
            <div
              data-artifact-board-card-virtual-index={virtualCard.index}
              data-index={virtualCard.index}
              key={virtualCard.key}
              ref={virtualizer.measureElement}
              style={{
                left: 0,
                position: "absolute",
                top: 0,
                transform: `translateY(${virtualCard.start}px)`,
                width: "100%",
              }}
            >
              {renderRoot(root, virtualCard.index)}
            </div>
          );
        })}
      </div>
      {endSlot}
    </>,
    setScrollElement
  );
}
