import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";

// Shown in a KPI delta slot when a prior-period comparison is not available for
// the selected range (the 90d/"all" ranges have no well-defined prior window,
// and shorter ranges lack one until there is enough history). Screen readers
// read this instead of a bare em dash.
export const NO_COMPARISON_LABEL =
  "No prior-period comparison for this range. Comparisons appear for shorter ranges.";

/**
 * Dash placeholder for the KPI delta slot. Rendered instead of hiding the slot
 * so the KPI card/tile layout stays stable between ranges, and explains the
 * absence via tooltip + a screen-reader-only label (rather than silently
 * dropping the field). Shared by the Insights `KpiMetricTile` and the overview /
 * first-launch stats-row `MetricCard` so both surfaces behave identically.
 */
export function KpiDeltaPlaceholder() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="flex items-center font-normal text-muted-foreground"
          data-testid="kpi-delta-placeholder"
        >
          <span aria-hidden="true">—</span>
          <span className="sr-only">{NO_COMPARISON_LABEL}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-[220px]">
        {NO_COMPARISON_LABEL}
      </TooltipContent>
    </Tooltip>
  );
}
