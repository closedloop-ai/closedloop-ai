"use client";

import type { KpiStat } from "@repo/api/src/types/insights";
import { Button } from "@repo/design-system/components/ui/button";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  GripVerticalIcon,
  PencilIcon,
  PinIcon,
  Trash2Icon,
} from "lucide-react";
import type { ReactNode } from "react";
import { deltaIsPositive, formatDelta, formatKpiValue } from "../lib/format";
import { EmptyTile } from "./empty-tile";
import { InfoTip } from "./info-tip";
import { KpiDeltaPlaceholder } from "./kpi-delta-placeholder";
import { ResizeButtons } from "./resize-buttons";

/**
 * KPI tile rendered with the design-system `MetricCard` composite, plus the
 * Insights pin/info/drag affordances overlaid in the corner. The metric's
 * short description stays behind the card info icon, while the overlay info
 * button keeps the richer metric-definition copy.
 */
export function KpiMetricTile({
  tileId,
  title,
  kpi,
  unitLabel,
  pinned,
  onTogglePin,
  onEditTile,
  onResizeWidth,
  showDragHandle = false,
  showResizeControls = false,
  bodyOverride,
}: {
  tileId: string;
  title: string;
  kpi: KpiStat | undefined;
  unitLabel?: ReactNode;
  pinned: boolean;
  onTogglePin?: (id: string) => void;
  onEditTile?: (id: string) => void;
  onResizeWidth?: (id: string, width: number) => void;
  showDragHandle?: boolean;
  showResizeControls?: boolean;
  bodyOverride?: ReactNode;
}) {
  let body: ReactNode = <EmptyTile />;
  if (bodyOverride) {
    body = (
      <div className="h-full rounded-lg border bg-card">{bodyOverride}</div>
    );
  } else if (kpi) {
    body = (
      <MetricCard
        className="h-full"
        info={kpi.sub ? { what: kpi.sub } : undefined}
        label={kpi.label || title}
        trend={<TrendBadge deltaPct={kpi.deltaPct} />}
        unitLabel={unitLabel}
        value={formatKpiValue(kpi.value, kpi.format)}
      />
    );
  }

  return (
    <div className="relative h-full">
      {body}
      <div className="absolute top-2 right-2 z-[10000] flex items-center gap-0.5 rounded-md border bg-background/95 p-0.5 opacity-0 shadow-sm transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        {showDragHandle ? (
          <GripVerticalIcon className="insights-drag-handle size-4 cursor-move text-muted-foreground" />
        ) : null}
        <div className="flex items-center gap-0.5">
          {showResizeControls && onResizeWidth ? (
            <ResizeButtons
              className="bg-card"
              onResize={(width) => onResizeWidth(tileId, width)}
            />
          ) : null}
          {onEditTile ? (
            <Button
              aria-label="Edit widget"
              className="insights-widget-control size-6"
              onClick={(event) => {
                event.stopPropagation();
                onEditTile(tileId);
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
          <InfoTip tileId={tileId} />
        </div>
        {onTogglePin ? (
          <Button
            aria-label={pinned ? "Remove widget" : "Pin tile"}
            aria-pressed={pinned}
            className="insights-widget-control size-6"
            onClick={(event) => {
              event.stopPropagation();
              onTogglePin(tileId);
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
    </div>
  );
}

function TrendBadge({ deltaPct }: { deltaPct: number | null }) {
  const delta = formatDelta(deltaPct);
  if (!delta) {
    // Render a dash placeholder instead of hiding the slot so the chip layout
    // stays stable between ranges, and explain the absence via tooltip + a
    // screen-reader-only label (rather than silently dropping the field).
    return <KpiDeltaPlaceholder />;
  }
  const positive = deltaIsPositive(deltaPct);
  return (
    <span
      className={`flex items-center gap-0.5 ${
        positive ? "text-emerald-600" : "text-red-600"
      }`}
    >
      {positive ? (
        <ArrowUpIcon className="size-3" />
      ) : (
        <ArrowDownIcon className="size-3" />
      )}
      {delta}
    </span>
  );
}
