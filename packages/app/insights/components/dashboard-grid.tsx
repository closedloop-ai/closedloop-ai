"use client";

import type { InsightsSection } from "@repo/api/src/types/insights";
import { Button } from "@repo/design-system/components/ui/button";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { LayoutDashboardIcon } from "lucide-react";
import { useMemo } from "react";
import { type Layout, Responsive, WidthProvider } from "react-grid-layout";
import type { DashboardPins, GridPosition } from "../hooks/use-dashboard-pins";
import type { InsightsTileAvailability } from "../lib/tile-availability";
import { getTile, type TileDescriptor } from "../lib/tile-catalog";
import { InsightsTile } from "./insights-tile";
import type { InsightsSectionData } from "./tile-content";

const ResponsiveGridLayout = WidthProvider(Responsive);
const GRID_COLS = 12;
const MEDIUM_GRID_COLS = 6;
const SMALL_GRID_COLS = 1;
const ROW_HEIGHT = 72;

export function DashboardGrid({
  pins,
  sections,
  comparisonSections,
  comparisonLabel,
  onAddTiles,
  onEditTile,
  availableSections,
  getTileAvailability,
  githubConnectHref,
  onConnectGitHub,
}: {
  pins: DashboardPins;
  sections: InsightsSectionData;
  comparisonSections?: InsightsSectionData;
  comparisonLabel?: string;
  onAddTiles: () => void;
  onEditTile: (tileId: string) => void;
  availableSections: readonly InsightsSection[];
  getTileAvailability?: (tile: TileDescriptor) => InsightsTileAvailability;
  githubConnectHref?: string;
  onConnectGitHub?: () => void | Promise<void>;
}) {
  // Only render pinned tiles whose section this shell can populate — a tile
  // pinned on a surface that supports more sections is silently skipped here.
  const tiles = useMemo(
    () =>
      pins.tiles
        .map((id) => getTile(id))
        .filter(
          (tile): tile is TileDescriptor =>
            tile !== undefined && availableSections.includes(tile.section)
        ),
    [pins.tiles, availableSections]
  );

  const layouts = useMemo(
    () => ({
      lg: buildLayout(tiles, pins.layout, GRID_COLS),
      md: buildLayout(tiles, pins.layout, MEDIUM_GRID_COLS),
      sm: buildLayout(tiles, pins.layout, SMALL_GRID_COLS),
    }),
    [tiles, pins.layout]
  );
  const layout = layouts.lg;
  const persistLayout = (allLayouts: Record<string, Layout[]>) => {
    // The stored layout is the canonical 12-column (lg) layout; md/sm are
    // derived, read-only collapse views. react-grid-layout keeps a layout per
    // visited breakpoint, and `allLayouts.lg` only changes when the user edits
    // at lg — editing in the md/sm views leaves it untouched. Persisting
    // `allLayouts.lg` therefore ignores collapsed-view edits that would
    // otherwise rewrite the dashboard into a single-column stack. This is
    // breakpoint-agnostic, so it stays correct even on a first load below
    // 1200px, where react-grid-layout never fires onBreakpointChange and a
    // breakpoint ref would still read its "lg" default.
    const lgLayout = allLayouts.lg;
    if (!lgLayout) {
      return;
    }
    const next = toPositions(lgLayout);
    if (!positionsEqual(next, pins.layout)) {
      pins.setLayout(next);
    }
  };

  if (tiles.length === 0) {
    return (
      <EmptyState
        action={
          <Button onClick={onAddTiles} size="sm" variant="outline">
            Add metrics
          </Button>
        }
        className="min-h-80 border"
        description="Pin tiles from any section, or add metrics here, to build your dashboard."
        icon={LayoutDashboardIcon}
        title="No pinned tiles yet"
      />
    );
  }

  return (
    <ResponsiveGridLayout
      breakpoints={{ lg: 1200, md: 900, sm: 0 }}
      className="insights-dashboard-grid -mx-1 min-h-0"
      cols={{ lg: GRID_COLS, md: MEDIUM_GRID_COLS, sm: SMALL_GRID_COLS }}
      compactType="vertical"
      draggableCancel=".insights-widget-control"
      draggableHandle=".insights-drag-handle"
      isBounded
      isResizable
      layouts={layouts}
      margin={[12, 12]}
      measureBeforeMount
      onLayoutChange={(_current, allLayouts) => persistLayout(allLayouts)}
      resizeHandles={["e", "se"]}
      rowHeight={ROW_HEIGHT}
    >
      {tiles.map((tile) => (
        <div className="group relative h-full" key={tile.id}>
          <InsightsTile
            availability={getTileAvailability?.(tile)}
            comparisonLabel={comparisonLabel}
            comparisonSections={
              pins.getTileSettings(tile.id).comparisonOverlay
                ? comparisonSections
                : undefined
            }
            githubConnectHref={githubConnectHref}
            onConnectGitHub={onConnectGitHub}
            onEditTile={onEditTile}
            onResizeWidth={(tileId, width) =>
              pins.setLayout(
                toPositions(
                  layout.map((item) =>
                    item.i === tileId ? { ...item, w: width } : item
                  )
                )
              )
            }
            onTogglePin={pins.togglePin}
            pinned
            sections={sections}
            showDragHandle
            showResizeControls
            tile={tile}
          />
        </div>
      ))}
    </ResponsiveGridLayout>
  );
}

function buildLayout(
  tiles: TileDescriptor[],
  stored: Record<string, GridPosition>,
  cols: number
): Layout[] {
  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;
  return tiles.map((tile) => {
    const saved = stored[tile.id];
    if (saved) {
      return { i: tile.id, ...scalePosition(saved, GRID_COLS, cols) };
    }
    const width = scaleWidthToCols(tile.grid.w, GRID_COLS, cols);
    if (cursorX + width > cols) {
      cursorX = 0;
      cursorY += rowHeight;
      rowHeight = 0;
    }
    const item: Layout = {
      i: tile.id,
      x: cursorX,
      y: cursorY,
      w: width,
      h: tile.grid.h,
    };
    cursorX += width;
    rowHeight = Math.max(rowHeight, tile.grid.h);
    return item;
  });
}

function clampWidth(width: number, cols: number): number {
  return Math.min(Math.max(1, width), cols);
}

function scaleValueToCols(value: number, fromCols: number, toCols: number) {
  return Math.max(0, Math.round((value / fromCols) * toCols));
}

function scaleWidthToCols(
  width: number,
  fromCols: number,
  toCols: number
): number {
  return clampWidth(Math.round((width / fromCols) * toCols), toCols);
}

// Re-base a tile position from one column count onto another: scale the width,
// scale x, then clamp x so the tile stays fully on-grid. Both directions share
// this logic — deriving a collapsed-breakpoint layout from the canonical
// 12-column store (fromCols = GRID_COLS) and folding an edited layout back into
// canonical storage (toCols = GRID_COLS). The canonical → canonical case
// (fromCols === toCols === GRID_COLS) reduces to a plain clamp.
function scalePosition(
  position: GridPosition,
  fromCols: number,
  toCols: number
): GridPosition {
  const w = scaleWidthToCols(position.w, fromCols, toCols);
  const x = Math.min(
    scaleValueToCols(position.x, fromCols, toCols),
    Math.max(0, toCols - w)
  );
  return { ...position, x, w };
}

function toPositions(
  layout: Layout[],
  cols = GRID_COLS
): Record<string, GridPosition> {
  const positions: Record<string, GridPosition> = {};
  for (const item of layout) {
    positions[item.i] = scalePosition(
      { x: item.x, y: item.y, w: item.w, h: item.h },
      cols,
      GRID_COLS
    );
  }
  return positions;
}

function positionsEqual(
  left: Record<string, GridPosition>,
  right: Record<string, GridPosition>
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  for (const key of leftKeys) {
    const a = left[key];
    const b = right[key];
    if (!(a && b)) {
      return false;
    }
    if (a.x !== b.x || a.y !== b.y || a.w !== b.w || a.h !== b.h) {
      return false;
    }
  }
  return true;
}
