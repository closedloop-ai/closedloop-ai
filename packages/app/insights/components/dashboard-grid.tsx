"use client";

import type { InsightsSection } from "@repo/api/src/types/insights";
import { INSIGHTS_SPEND_OUTCOME_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { Button } from "@repo/design-system/components/ui/button";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { LayoutDashboardIcon } from "lucide-react";
import { useCallback, useMemo } from "react";
import {
  type Layout,
  type LayoutItem,
  Responsive,
  type ResponsiveLayouts,
  useContainerWidth,
  verticalCompactor,
} from "react-grid-layout";
import { useFeatureFlagEnabledOptional } from "../../shared/feature-flags/use-feature-flag-enabled";
import type { DashboardPins, GridPosition } from "../hooks/use-dashboard-pins";
import type { InsightsTileAvailability } from "../lib/tile-availability";
import {
  getTile,
  isTileEnabled,
  type TileDescriptor,
  TileKind,
} from "../lib/tile-catalog";
import { InsightsTile } from "./insights-tile";
import type { InsightsSectionData } from "./tile-content";

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
  // ISS-4463: a flag-gated tile stops rendering when its flag is off, even if it
  // is still pinned on the saved dashboard from when the flag was on. Reading the
  // one gated key here (rather than a generic resolver) keeps the hook call count
  // stable across renders, which the rules of hooks require.
  const spendOutcomeEnabled = useFeatureFlagEnabledOptional(
    INSIGHTS_SPEND_OUTCOME_FEATURE_FLAG_KEY
  );
  const isFlagEnabled = useCallback(
    (key: string) =>
      key === INSIGHTS_SPEND_OUTCOME_FEATURE_FLAG_KEY
        ? spendOutcomeEnabled
        : false,
    [spendOutcomeEnabled]
  );

  // Only render pinned tiles whose section this shell can populate — a tile
  // pinned on a surface that supports more sections is silently skipped here.
  const tiles = useMemo(
    () =>
      pins.tiles
        .map((id) => getTile(id))
        .filter(
          (tile): tile is TileDescriptor =>
            tile !== undefined &&
            availableSections.includes(tile.section) &&
            isTileEnabled(tile, isFlagEnabled)
        ),
    [pins.tiles, availableSections, isFlagEnabled]
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
  // v2 replaces the WidthProvider HOC with a hook: it observes the container
  // ref's width and gates the grid on `mounted` (measureBeforeMount) so the
  // first paint uses the real width instead of the 1280px fallback.
  const {
    width: containerWidth,
    containerRef,
    mounted,
  } = useContainerWidth({ measureBeforeMount: true });
  const persistLayout = (allLayouts: ResponsiveLayouts) => {
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
    // wongk (#4282): the grid only lays out VISIBLE tiles, so `toPositions` sees
    // nothing for a tile that is still pinned but currently hidden — a
    // flag-gated tile whose flag went off, or a tile whose section this shell
    // cannot populate. Replacing the saved map wholesale would delete those
    // saved positions on the next drag or resize, silently moving the tile when
    // it comes back. Merge instead, keeping saved entries for IDs that are STILL
    // PINNED (an unpinned tile's position is meant to be dropped).
    const next = mergeVisiblePositions(
      pins.layout,
      toPositions(lgLayout),
      pins.tiles
    );
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
    <div ref={containerRef}>
      {mounted && (
        <Responsive
          breakpoints={{ lg: 1200, md: 900, sm: 0 }}
          className="insights-dashboard-grid -mx-1 min-h-0"
          cols={{ lg: GRID_COLS, md: MEDIUM_GRID_COLS, sm: SMALL_GRID_COLS }}
          compactor={verticalCompactor}
          dragConfig={{
            bounded: true,
            cancel: ".insights-widget-control",
            handle: ".insights-drag-handle",
          }}
          layouts={layouts}
          margin={[12, 12]}
          onLayoutChange={(_current, allLayouts) => persistLayout(allLayouts)}
          resizeConfig={{ handles: ["e", "se"] }}
          rowHeight={ROW_HEIGHT}
          width={containerWidth}
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
                    mergeVisiblePositions(
                      pins.layout,
                      toPositions(
                        layout.map((item) =>
                          item.i === tileId ? { ...item, w: width } : item
                        )
                      ),
                      pins.tiles
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
        </Responsive>
      )}
    </div>
  );
}

function buildLayout(
  tiles: TileDescriptor[],
  stored: Record<string, GridPosition>,
  cols: number
): Layout {
  // The single-column collapse can't rely on scaling the stored 12-col x/y:
  // two tiles that sit side-by-side at lg (same y, different x) both scale to
  // x:0/y:0 here, so the vertical compactor stacks them in pin (array) order,
  // not the lg reading order the user laid out. Build this breakpoint from the
  // canonical lg layout sorted top-to-bottom, left-to-right, then give each
  // tile its own row so the stack always reads in that order.
  if (cols === SMALL_GRID_COLS) {
    return buildSingleColumnLayout(tiles, stored);
  }

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
    const item: LayoutItem = {
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
  layout: Layout,
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

// Minimum tile height (in grid rows) at the single-column breakpoint. Charts
// default to h:4 in the catalog, but a heatmap or Sankey collapsed to one
// column loses its horizontal room, so we floor every tile at 3 rows
// (~216px + margins at ROW_HEIGHT 72) so it stays readable at 360px. KPI tiles
// keep their smaller authored height since a single stat needs no floor.
const SINGLE_COLUMN_MIN_ROWS = 3;

// Stack every tile full-width in lg reading order (top-to-bottom, then
// left-to-right for tiles that shared a row). A stored position drives the
// sort; an un-pinned tile falls back to its catalog default so a first render
// without a saved layout still stacks in the catalog's authored order.
function buildSingleColumnLayout(
  tiles: TileDescriptor[],
  stored: Record<string, GridPosition>
): Layout {
  const ordered = tiles
    .map((tile, index) => {
      const saved = stored[tile.id];
      const authoredHeight = Math.max(1, saved?.h ?? tile.grid.h);
      return {
        tile,
        // Ties (same y and x) fall back to the tile's original array index so
        // the stack order stays stable and deterministic.
        index,
        x: saved?.x ?? 0,
        y: saved?.y ?? 0,
        h:
          tile.kind === TileKind.Kpi
            ? authoredHeight
            : Math.max(authoredHeight, SINGLE_COLUMN_MIN_ROWS),
      };
    })
    .sort((a, b) => a.y - b.y || a.x - b.x || a.index - b.index);

  let cursorY = 0;
  return ordered.map(({ tile, h }) => {
    const item: LayoutItem = { i: tile.id, x: 0, y: cursorY, w: 1, h };
    cursorY += h;
    return item;
  });
}

/**
 * Fold the positions of the currently-rendered tiles back into the saved map,
 * preserving the saved position of any tile that is still pinned but was not
 * rendered this pass (hidden by a feature flag, or belonging to a section this
 * shell cannot populate).
 *
 * Positions for tiles that are no longer pinned at all are dropped — unpinning
 * is exactly when a saved position SHOULD be forgotten, so the map cannot grow
 * without bound as tiles come and go.
 */
function mergeVisiblePositions(
  saved: Record<string, GridPosition>,
  visible: Record<string, GridPosition>,
  pinnedTileIds: readonly string[]
): Record<string, GridPosition> {
  const pinned = new Set(pinnedTileIds);
  const merged: Record<string, GridPosition> = {};
  for (const [id, position] of Object.entries(saved)) {
    if (pinned.has(id)) {
      merged[id] = position;
    }
  }
  for (const [id, position] of Object.entries(visible)) {
    merged[id] = position;
  }
  return merged;
}
