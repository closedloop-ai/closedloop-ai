"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { MinusIcon, PlusIcon } from "lucide-react";
import { type CSSProperties, useMemo, type WheelEvent } from "react";
import {
  type Layout,
  Responsive,
  type ResponsiveLayouts,
  useContainerWidth,
  verticalCompactor,
} from "react-grid-layout";
import { createScaledStrategy } from "react-grid-layout/core";
import { StyleBoard } from "./style-browser-canvas-boards";
import type { ColorConflict } from "./style-browser-color-conflicts";
import {
  type StyleTaxonomyGroup,
  type TokenDefinition,
  type TokenEdits,
  tokensForTaxonomyGroup,
} from "./style-browser-editor-data";
import type { AddedTokenDefinition } from "./style-browser-token-operations";

export function StyleCanvas({
  groups,
  tokensById,
  edits,
  colorConflicts,
  previewStyle,
  selectedGroupId,
  selectedToken,
  addedTokenIds,
  removedTokenIds,
  layouts,
  zoom,
  onAddToken,
  onLayoutsChange,
  onSelectGroup,
  onSelectToken,
  onZoomChange,
}: {
  groups: readonly StyleTaxonomyGroup[];
  tokensById: Readonly<Record<string, TokenDefinition>>;
  edits: TokenEdits;
  colorConflicts: ReadonlyMap<string, ColorConflict>;
  previewStyle: CSSProperties;
  selectedGroupId: string;
  selectedToken: TokenDefinition;
  addedTokenIds: ReadonlySet<string>;
  removedTokenIds: ReadonlySet<string>;
  layouts: ResponsiveLayouts;
  zoom: number;
  onAddToken: (token: AddedTokenDefinition, value: string) => void;
  onLayoutsChange: (layouts: ResponsiveLayouts) => void;
  onSelectGroup: (groupId: string) => void;
  onSelectToken: (token: TokenDefinition) => void;
  onZoomChange: (zoom: number) => void;
}) {
  const { containerRef, mounted, width } = useContainerWidth({
    measureBeforeMount: true,
  });
  const canvasWidth = Math.max(width, MIN_CANVAS_WIDTH);
  const canvasBreakpoint = currentCanvasBreakpoint(width);
  const canvasHeight = estimateCanvasHeight(layouts[canvasBreakpoint] ?? []);
  const scaledPositionStrategy = useMemo(
    () => createScaledStrategy(zoom),
    [zoom]
  );
  const changeZoom = (amount: number, focus?: ZoomFocus) => {
    const next = clampZoom(zoom + amount);
    if (focus && next !== zoom) {
      keepZoomFocus(focus, zoom, next);
    }
    onZoomChange(next);
  };
  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey) {
      return;
    }
    event.preventDefault();
    changeZoom(-event.deltaY * PINCH_ZOOM_SENSITIVITY, {
      clientX: event.clientX,
      clientY: event.clientY,
      container: event.currentTarget,
    });
  };

  return (
    <div
      className="style-lab-canvas min-h-[42rem] overflow-auto p-4 text-foreground lg:min-h-0"
      onWheel={handleWheel}
      ref={containerRef}
      style={previewStyle}
    >
      <div className="sticky top-0 left-0 z-30 mb-4 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="max-w-full rounded-md border bg-background/95 px-2.5 py-1.5 text-xs shadow-sm backdrop-blur">
          <span className="text-muted-foreground">Source</span>
          <code className="ml-2 font-mono">
            packages/design-system/styles/globals.css
          </code>
        </div>
        <ZoomControls
          onResetZoom={() => onZoomChange(1)}
          onZoomIn={() => changeZoom(ZOOM_STEP)}
          onZoomOut={() => changeZoom(-ZOOM_STEP)}
          zoom={zoom}
        />
      </div>
      {mounted ? (
        <div
          style={{
            minHeight: canvasHeight * zoom,
            width: canvasWidth * zoom,
          }}
        >
          <div
            style={{
              transform: `scale(${zoom})`,
              transformOrigin: "top left",
              width: canvasWidth,
            }}
          >
            <Responsive
              breakpoints={{ lg: 1120, md: 740, sm: 0 }}
              className="style-lab-grid"
              cols={{ lg: 12, md: 8, sm: 1 }}
              compactor={verticalCompactor}
              dragConfig={{
                bounded: true,
                cancel: ".style-lab-control",
                handle: ".style-lab-drag-handle",
              }}
              layouts={layouts}
              margin={[CANVAS_MARGIN, CANVAS_MARGIN]}
              onLayoutChange={(_layout: Layout, allLayouts) =>
                onLayoutsChange(allLayouts)
              }
              positionStrategy={scaledPositionStrategy}
              resizeConfig={{ handles: ["e", "se", "s"] }}
              rowHeight={CANVAS_ROW_HEIGHT}
              width={canvasWidth}
            >
              {groups.map((group) => (
                <div
                  className="h-full"
                  data-style-group-id={group.id}
                  key={group.id}
                >
                  <StyleBoard
                    addedTokenIds={addedTokenIds}
                    colorConflicts={colorConflicts}
                    edits={edits}
                    group={group}
                    isSelected={selectedGroupId === group.id}
                    onAddToken={onAddToken}
                    onSelectGroup={onSelectGroup}
                    onSelectToken={onSelectToken}
                    removedTokenIds={removedTokenIds}
                    selectedToken={selectedToken}
                    tokens={tokensForTaxonomyGroup(group, tokensById)}
                    tokensById={tokensById}
                  />
                </div>
              ))}
            </Responsive>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ZoomControls({
  zoom,
  onZoomOut,
  onZoomIn,
  onResetZoom,
}: {
  zoom: number;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onResetZoom: () => void;
}) {
  const zoomLabel = `${Math.round(zoom * 100)}%`;
  return (
    <fieldset className="style-lab-control flex w-fit items-center overflow-hidden rounded-md border bg-background/95 shadow-sm backdrop-blur">
      <legend className="sr-only">Canvas zoom controls</legend>
      <Button
        aria-label="Zoom out"
        className="rounded-none border-0"
        disabled={zoom <= MIN_ZOOM}
        onClick={onZoomOut}
        size="icon-sm"
        title="Zoom out"
        type="button"
        variant="ghost"
      >
        <MinusIcon />
      </Button>
      <Button
        aria-label="Reset zoom"
        className="min-w-14 rounded-none border-x px-2 font-mono text-xs"
        onClick={onResetZoom}
        size="sm"
        title="Reset zoom"
        type="button"
        variant="ghost"
      >
        {zoomLabel}
      </Button>
      <Button
        aria-label="Zoom in"
        className="rounded-none border-0"
        disabled={zoom >= MAX_ZOOM}
        onClick={onZoomIn}
        size="icon-sm"
        title="Zoom in"
        type="button"
        variant="ghost"
      >
        <PlusIcon />
      </Button>
    </fieldset>
  );
}

function keepZoomFocus(
  { container, clientX, clientY }: ZoomFocus,
  currentZoom: number,
  nextZoom: number
) {
  const rect = container.getBoundingClientRect();
  const focusX = clientX - rect.left;
  const focusY = clientY - rect.top;
  const unscaledX = (container.scrollLeft + focusX) / currentZoom;
  const unscaledY = (container.scrollTop + focusY) / currentZoom;
  const applyScroll = () => {
    container.scrollLeft = Math.max(0, unscaledX * nextZoom - focusX);
    container.scrollTop = Math.max(0, unscaledY * nextZoom - focusY);
  };
  const requestFrame = globalThis.requestAnimationFrame;
  if (requestFrame) {
    requestFrame(applyScroll);
    return;
  }
  globalThis.setTimeout(applyScroll, 0);
}

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(value.toFixed(2))));
}

function currentCanvasBreakpoint(width: number): CanvasBreakpoint {
  if (width >= 1120) {
    return "lg";
  }
  if (width >= 740) {
    return "md";
  }
  return "sm";
}

function estimateCanvasHeight(layout: Layout): number {
  const maxRow = layout.reduce((current, item) => {
    return Math.max(current, item.y + item.h);
  }, 1);
  return maxRow * CANVAS_ROW_HEIGHT + (maxRow + 1) * CANVAS_MARGIN;
}

const CANVAS_MARGIN = 16;
const CANVAS_ROW_HEIGHT = 96;
const MAX_ZOOM = 1.5;
const MIN_CANVAS_WIDTH = 960;
const MIN_ZOOM = 0.5;
const PINCH_ZOOM_SENSITIVITY = 0.004;
const ZOOM_STEP = 0.1;

type CanvasBreakpoint = "lg" | "md" | "sm";

type ZoomFocus = {
  container: HTMLDivElement;
  clientX: number;
  clientY: number;
};
