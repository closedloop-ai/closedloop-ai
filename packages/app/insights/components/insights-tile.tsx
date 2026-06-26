"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
} from "@repo/design-system/components/ui/card";
import {
  GripVerticalIcon,
  PencilIcon,
  PinIcon,
  Trash2Icon,
} from "lucide-react";
import { type TileDescriptor, TileKind } from "../lib/tile-catalog";
import { InfoTip } from "./info-tip";
import { KpiMetricTile } from "./kpi-stat-tile";
import {
  InsightsChartContent,
  type InsightsSectionData,
  selectKpi,
} from "./tile-content";

export function InsightsTile({
  tile,
  sections,
  comparisonSections,
  comparisonLabel,
  pinned,
  onTogglePin,
  onEditTile,
  onResizeWidth,
  showDragHandle = false,
  showResizeControls = false,
  variant = "compact",
}: {
  tile: TileDescriptor;
  sections: InsightsSectionData;
  comparisonSections?: InsightsSectionData;
  comparisonLabel?: string;
  pinned: boolean;
  onTogglePin?: (id: string) => void;
  onEditTile?: (id: string) => void;
  onResizeWidth?: (id: string, width: number) => void;
  showDragHandle?: boolean;
  showResizeControls?: boolean;
  /**
   * Header presentation. `compact` (default) is the dense grid styling used by
   * the Insights page: a small `text-sm` title with a divider beneath it.
   * `section` matches the desktop dashboard's other section cards — a `text-xl`
   * title and no divider — so a tile reads as a full section rather than a grid
   * cell.
   */
  variant?: "compact" | "section";
}) {
  const isSection = variant === "section";
  // KPI tiles render as the design-system MetricCard composite with the pin /
  // info / drag affordances overlaid; chart tiles use the titled card shell.
  if (tile.kind === TileKind.Kpi) {
    return (
      <KpiMetricTile
        kpi={selectKpi(tile, sections)}
        onEditTile={onEditTile}
        onResizeWidth={onResizeWidth}
        onTogglePin={onTogglePin}
        pinned={pinned}
        showDragHandle={showDragHandle}
        showResizeControls={showResizeControls}
        tileId={tile.id}
        title={tile.title}
      />
    );
  }

  return (
    <Card className="flex h-full flex-col overflow-hidden">
      <CardHeader
        className={
          isSection
            ? "flex flex-row items-center justify-between gap-2 space-y-0 px-6"
            : "flex flex-row items-center justify-between gap-2 space-y-0 border-b px-3 py-2"
        }
      >
        <div className="flex min-w-0 items-center gap-1">
          <span
            className={
              isSection
                ? "truncate font-semibold text-[var(--foreground)] text-xl tracking-tight"
                : "truncate font-medium text-sm"
            }
          >
            {tile.title}
          </span>
        </div>
        <div className="relative z-[10000] flex shrink-0 items-center gap-0.5 rounded-md border bg-background/95 p-0.5 opacity-0 shadow-sm transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          {showDragHandle ? (
            <GripVerticalIcon className="insights-drag-handle size-4 shrink-0 cursor-move text-muted-foreground" />
          ) : null}
          {showResizeControls && onResizeWidth ? (
            <ResizeButtons
              onResize={(width) => onResizeWidth(tile.id, width)}
            />
          ) : null}
          {onEditTile ? (
            <Button
              aria-label="Edit widget"
              className="insights-widget-control size-6 shrink-0"
              onClick={(event) => {
                event.stopPropagation();
                onEditTile(tile.id);
              }}
              onMouseDown={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
              size="icon"
              type="button"
              variant="ghost"
            >
              <PencilIcon className="size-3.5" />
            </Button>
          ) : null}
          <InfoTip tileId={tile.id} />
          {onTogglePin ? (
            <Button
              aria-label={pinned ? "Remove widget" : "Pin tile"}
              aria-pressed={pinned}
              className="insights-widget-control size-6 shrink-0"
              onClick={(event) => {
                event.stopPropagation();
                onTogglePin(tile.id);
              }}
              onMouseDown={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
              size="icon"
              variant="ghost"
            >
              {pinned ? (
                <Trash2Icon className="size-3.5" />
              ) : (
                <PinIcon className="size-3.5" />
              )}
            </Button>
          ) : null}
        </div>
      </CardHeader>
      <CardContent
        className={isSection ? "min-h-0 flex-1 px-6" : "min-h-0 flex-1 p-3"}
      >
        <InsightsChartContent
          comparisonLabel={comparisonLabel}
          comparisonSections={comparisonSections}
          sections={sections}
          tile={tile}
        />
      </CardContent>
    </Card>
  );
}

function ResizeButtons({ onResize }: { onResize: (width: number) => void }) {
  return (
    <div className="insights-widget-control hidden items-center rounded border p-0.5 md:flex">
      {[
        { label: "1/2", width: 6 },
        { label: "Full", width: 12 },
      ].map((option) => (
        <Button
          className="h-6 px-1.5 text-[10px]"
          key={option.width}
          onClick={(event) => {
            event.stopPropagation();
            onResize(option.width);
          }}
          onMouseDown={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          size="sm"
          type="button"
          variant="ghost"
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
}
