"use client";

import type { KpiStat } from "@repo/api/src/types/insights";
import { useMetricDeltaTreatment } from "@repo/app/shared/feature-flags/use-metric-delta-treatment";
import { Button } from "@repo/design-system/components/ui/button";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import {
  DELTA_SENTIMENT_TEXT_CLASS,
  deltaSentiment,
  deltaVerdictCaption,
  isComparableDelta,
  type MetricDeltaTreatment,
  type MetricPolarity,
} from "@repo/design-system/components/ui/primitives/metric-polarity";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  GripVerticalIcon,
  MinusIcon,
  PencilIcon,
  PinIcon,
  Trash2Icon,
} from "lucide-react";
import type { ReactNode } from "react";
import { formatDelta, formatKpiTileValue } from "../lib/format";
import { kpiNoComparisonReason } from "../lib/kpi-no-comparison-copy";
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
  polarity,
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
  /**
   * Which direction is good for this metric, from the tile descriptor's
   * required `polarity` (ISS-4633). Required here too — the trend chip cannot
   * colour a delta honestly without it.
   */
  polarity: MetricPolarity;
  unitLabel?: ReactNode;
  pinned: boolean;
  onTogglePin?: (id: string) => void;
  onEditTile?: (id: string) => void;
  onResizeWidth?: (id: string, width: number) => void;
  showDragHandle?: boolean;
  showResizeControls?: boolean;
  bodyOverride?: ReactNode;
}) {
  // ISS-5842, default OFF (ISS-4779): the tile's delta family flips together
  // with the `MetricCard` chip family, so one product never shows both.
  const deltaTreatment = useMetricDeltaTreatment();
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
        trend={
          <TrendBadge
            deltaPct={kpi.deltaPct}
            // ISS-4995: same producer-declared basis the dashboard row reads, so
            // the two KPI surfaces cannot tell one reader two different stories
            // about why the same metric has no comparison.
            noComparisonReason={kpiNoComparisonReason(kpi.deltaBasis)}
            polarity={polarity}
            treatment={deltaTreatment}
          />
        }
        unitLabel={unitLabel}
        value={formatKpiTileValue(kpi.value, kpi.format)}
      />
    );
  }

  return (
    <div className="relative h-full">
      {body}
      {/* Touch pointers have no hover to reveal the overlay, so keep it visible
          via `touch:opacity-100`; the mouse hover reveal is unchanged. */}
      <div className="absolute top-2 right-2 z-[10000] flex items-center gap-0.5 rounded-md border bg-background/95 p-0.5 opacity-0 touch:opacity-100 shadow-sm transition-opacity focus-within:opacity-100 group-hover:opacity-100">
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

function TrendBadge({
  deltaPct,
  polarity,
  noComparisonReason,
  treatment,
}: {
  deltaPct: number | null;
  polarity: MetricPolarity;
  /** The ISS-5842 delta treatment this surface opted into (default-off gated). */
  treatment: MetricDeltaTreatment;
  /**
   * Why this metric has no comparison, when the producer knows (ISS-4995).
   * Undefined keeps the placeholder's reason-agnostic default.
   */
  noComparisonReason?: string;
}) {
  const delta = formatDelta(deltaPct);
  // A non-finite deltaPct (NaN / ±Infinity — e.g. a percent-change over a zero
  // prior base) is "no comparison", not a real movement: without this guard
  // `NaN > 0` is false, so a lower-is-better tile would render a bogus down-arrow
  // + "NaN%" + green "better" (shafty023 review on #4148). Fall to the
  // no-comparison placeholder instead of grading a non-number.
  if (deltaPct === null || !delta || !isComparableDelta(deltaPct)) {
    // Render a placeholder instead of hiding the slot so the chip layout stays
    // stable between ranges, and explain the absence via tooltip + a
    // screen-reader-only label (rather than silently dropping the field). The
    // tile's real delta is bare text + an arrow (no pill), so the absent state
    // uses the matching bare treatment rather than out-designing the present one.
    return <KpiDeltaPlaceholder reason={noComparisonReason} variant="bare" />;
  }
  // The arrow reports the number's real direction; the colour reports whether
  // that direction is good for THIS metric (ISS-4633) — a cost tile whose spend
  // rose keeps its honest up-arrow. Whether a verdict word ALSO appears is the
  // consumer's ISS-5842 treatment: `Legacy` (default) keeps it visible, because
  // colour alone must not carry the good/bad reading (WCAG 2.2 SC 1.4.1);
  // `UnifiedPill` drops it. `deltaVerdictCaption` owns that decision for both
  // delta families so the tile and `MetricDeltaCaption` cannot drift.
  //
  // Layout: the verdict trails the number as a distinct muted token, matching
  // the MetricCard caption's order. `flex-wrap` + `min-w-0` let it wrap under
  // the figure at the narrowest 3-column breakpoint instead of clipping (the
  // `↑ 38% worse` overflow), and are kept under both treatments because a capped
  // figure (`>999%`) still needs the same freedom.
  const sentiment = deltaSentiment(deltaPct, polarity);
  const verdict = deltaVerdictCaption(sentiment, treatment);
  return (
    <span
      className={`flex min-w-0 flex-wrap items-center gap-x-0.5 gap-y-0 ${DELTA_SENTIMENT_TEXT_CLASS[sentiment]}`}
      data-testid="kpi-trend-chip"
    >
      <span className="inline-flex items-center gap-0.5">
        <TrendDirectionIcon deltaPct={deltaPct} />
        <span>{delta}</span>
      </span>
      {verdict ? (
        <span className="font-normal text-muted-foreground">{verdict}</span>
      ) : null}
    </span>
  );
}

/** The honest direction mark: up, down, or steady for a flat 0%. */
function TrendDirectionIcon({ deltaPct }: { deltaPct: number }) {
  if (deltaPct === 0) {
    return <MinusIcon className="size-3" />;
  }
  if (deltaPct > 0) {
    return <ArrowUpIcon className="size-3" />;
  }
  return <ArrowDownIcon className="size-3" />;
}
