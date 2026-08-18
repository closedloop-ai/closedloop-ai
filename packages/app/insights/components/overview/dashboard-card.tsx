"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { cn } from "@repo/design-system/lib/utils";
import type { ReactNode } from "react";
import { ExpandableWidget, WidgetExpandButton } from "./expandable-widget";

// Shared styling for every overview metric/KPI card — the dashboard stats row
// plus the Sessions/Branches/Analytics/PRs/CoreFeatures summary cards. Built on
// the design-system `MetricCard`'s native metric-on-top spacing. The one
// deliberate tweak is bumping the headline value to `text-3xl`; applied here so
// every card matches.
export const DASHBOARD_METRIC_CARD_CLASS_NAME =
  "h-full [&_[data-slot='card-title']]:text-3xl";

/**
 * The framed card used by the overview dashboard's chart rows (Event Activity,
 * Model Usage, Autonomy, …) and the Recent Sessions panel. A thin wrapper over
 * the design-system `Card` with rounded corners, a consistent 24px gutter, and
 * an optional title/description header.
 *
 * FEA-3632: every card routes through the shared `ExpandableWidget` wrapper, so
 * each chart/graph/panel widget inherits a corner "expand to full screen" modal
 * affordance uniformly (no per-widget code). When no expand label is available
 * the card renders exactly as before, so there is no layout shift or behavior
 * change.
 *
 * FEA-3944: a chart card sized with a fixed pixel band (`fixedHeightClassName`,
 * e.g. `h-[340px]`) must keep that COMPACT band in the grid but FILL the
 * fullscreen modal when expanded — previously the fixed height rode on
 * `CardContent`, which relocates unchanged into the dialog and locked the chart
 * to a band near the top. Such cards render through `ExpandableWidget`'s
 * render-children API so the card knows `isExpanded`: collapsed, `CardContent`
 * carries the fixed band (grid density unchanged); expanded, the `Card` becomes
 * a `flex h-full flex-col` and `CardContent` becomes `min-h-0 flex-1`, so the
 * chart fills whatever height the relocated dialog slot (`HOST_DIALOG_CLASS` =
 * `flex-1 min-h-0`) provides and its ResizeObserver-sized chart/graph (FEA-3622)
 * re-fits the enlarged canvas. This mirrors the PR-throughput chart tile
 * (`InsightsTile`/`ChartTile`), which already fills its expanded modal. Cards
 * with no fixed band pass plain `children` and keep the default corner-expand
 * affordance and prior block layout.
 */
export function DashboardCard({
  title,
  description,
  children,
  className,
  contentClassName,
  fixedHeightClassName,
  expandLabel,
  contentHasOwnTitle = false,
}: {
  title?: string;
  description?: string;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  /**
   * Compact fixed-height band for the collapsed grid view (e.g. `h-[340px]`).
   * When set, the card fills instead of staying at this band while expanded: the
   * band is applied to `CardContent` only in the grid, and dropped for a fill
   * layout in the fullscreen modal so the chart/graph expands to full height.
   * Pass this instead of a fixed `contentClassName` height for chart/graph cards
   * that must fill when expanded.
   */
  fixedHeightClassName?: string;
  /**
   * Label for the expand affordance's aria-label / modal heading. Defaults to
   * `title`; title-less cards (heatmap, agent-pipeline graph) pass an explicit
   * descriptive label. When neither is present the expand control is omitted.
   */
  expandLabel?: string;
  /**
   * Set when the card renders NO outer `title` but its `children` already draw a
   * visible header (e.g. the chart cards whose content renders its own
   * `SectionHeader`). Without this, the fullscreen modal would show a visible
   * `DialogTitle` (derived from `expandLabel`) stacked above the content's own
   * heading — a duplicated title (FEA-4016). Setting it keeps the modal heading
   * sr-only (accessible name preserved) so only the content's heading is visible.
   * Ignored when `title` is set (that path already implies the header is owned).
   */
  contentHasOwnTitle?: boolean;
}) {
  const widgetLabel = expandLabel ?? title;
  // The modal heading is kept sr-only whenever a VISIBLE title already renders in
  // the widget — either this card's own outer `title`, or a title drawn by the
  // `children` (a chart's `SectionHeader`) flagged via `contentHasOwnTitle`.
  // Without the latter, an `expandLabel`-only chart card would render a visible
  // `DialogTitle` stacked above the chart's own heading (FEA-4016).
  const titleInContent = Boolean(title) || contentHasOwnTitle;
  // A fixed-band card renders a height-mode-aware card via ExpandableWidget's
  // render-children API so grid vs expanded pick different content heights.
  const fillMode = Boolean(fixedHeightClassName);

  const renderCard = (isExpanded: boolean) => (
    <Card
      className={cn(
        "min-w-0 rounded-[1.25rem] border-border bg-card",
        // Fill only while expanded: the flex column + `flex-1` body grows to the
        // dialog. Collapsed, the card keeps its natural block height so the grid
        // reads exactly as before.
        fillMode && isExpanded && "flex h-full flex-col",
        className
      )}
    >
      {title ? (
        <CardHeader className="px-4 sm:px-6">
          <CardTitle className="min-w-0 font-semibold text-xl tracking-tight">
            {title}
          </CardTitle>
          {description ? (
            <CardDescription>{description}</CardDescription>
          ) : null}
        </CardHeader>
      ) : null}
      <CardContent
        className={cn(
          "min-w-0 px-4 sm:px-6",
          fillMode && (isExpanded ? "min-h-0 flex-1" : fixedHeightClassName),
          contentClassName
        )}
      >
        {children}
      </CardContent>
    </Card>
  );

  if (!widgetLabel) {
    return renderCard(false);
  }

  // Fixed-band cards must fill when expanded, so they thread `isExpanded` down
  // and render the corner expand control themselves via the SHARED
  // `WidgetExpandButton` (the render-children path suppresses ExpandableWidget's
  // default button, which is the same component — so the two placements can't
  // drift). Non-fixed cards keep the simpler default-button path with a plain
  // block card.
  if (fillMode) {
    return (
      <ExpandableWidget
        // `h-full` reaches the card slot → host chain so the fill Card (`h-full`)
        // has a definite height to resolve against once relocated into the
        // fixed-height dialog slot.
        contentClassName="h-full"
        title={widgetLabel}
        titleInContent={titleInContent}
      >
        {({ expand, isExpanded }) => (
          <>
            {renderCard(isExpanded)}
            {isExpanded ? null : (
              <WidgetExpandButton label={widgetLabel} onClick={expand} />
            )}
          </>
        )}
      </ExpandableWidget>
    );
  }

  return (
    <ExpandableWidget title={widgetLabel} titleInContent={titleInContent}>
      {renderCard(false)}
    </ExpandableWidget>
  );
}
