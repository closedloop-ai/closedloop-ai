"use client";

import { BranchKpiState } from "@repo/api/src/types/branch";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
} from "@repo/design-system/components/ui/card";
import {
  GripVerticalIcon,
  Maximize2Icon,
  PencilIcon,
  PinIcon,
  Trash2Icon,
} from "lucide-react";
import type { ReactNode } from "react";
// Insights reuses the existing cross-surface GitHub connect affordance so copy
// and desktop/web CTA behavior stay aligned with Branches.
import { ConnectGitHubIndicator } from "../../branches/components/connect-github-indicator";
import type { GitHubConnectTarget } from "../../github/lib/github-connect-target";
import { GatedMetricIndicatorVariant } from "../../shared/components/gated-metric-indicator";
import type { InsightsTileAvailability } from "../lib/tile-availability";
import {
  type ChartTileDescriptor,
  type TileDescriptor,
  TileKind,
} from "../lib/tile-catalog";
import { InfoTip } from "./info-tip";
import { KpiMetricTile } from "./kpi-stat-tile";
import { ExpandableWidget } from "./overview/expandable-widget";
import { ResizeButtons } from "./resize-buttons";
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
  availability,
  githubConnect,
  notice,
  withSupportingCopy = false,
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
  availability?: InsightsTileAvailability;
  githubConnect?: GitHubConnectTarget;
  /**
   * The Overview dashboard's gated ask on a chart tile: the card wording, with
   * the supporting sentence, instead of the centred Insights-grid wording. The
   * sentence names a session-linked population, so only the dashboard opts in.
   */
  withSupportingCopy?: boolean;
  /**
   * ISS-10414: an optional disclosure about the tile's own content — today, the
   * overview dashboard's "still showing the previous range and scope" chip.
   * Rendered inside the chart card, which is the subtree `ExpandableWidget`
   * relocates into the fullscreen dialog, so the modal carries the same
   * disclosure the grid does (review thread). Omitted everywhere else, so the
   * Insights page's tiles render exactly as before.
   */
  notice?: ReactNode;
}) {
  const isSection = variant === "section";
  // KPI tiles render as the design-system MetricCard composite with the pin /
  // info / drag affordances overlaid; chart tiles use the titled card shell.
  //
  // ISS-7866: the two shapes take the availability override through DIFFERENT
  // slots. A chart tile has a body to replace; a KPI tile does not — replacing
  // its card wholesale is what dropped the metric's name, leaving a bare
  // "Connect GitHub" ask the reader could not attribute to a metric. The KPI
  // path keeps the card and fills its caption slot instead.
  if (tile.kind === TileKind.Kpi) {
    return (
      <KpiMetricTile
        availabilityDetail={renderTileAvailabilityDetail({
          availability,
          githubConnect,
        })}
        kpi={selectKpi(tile, sections)}
        onEditTile={onEditTile}
        onResizeWidth={onResizeWidth}
        onTogglePin={onTogglePin}
        pinned={pinned}
        polarity={tile.polarity}
        showDragHandle={showDragHandle}
        showResizeControls={showResizeControls}
        tileId={tile.id}
        title={tile.title}
        unitLabel={tile.unitLabel}
      />
    );
  }

  return (
    <ChartTile
      bodyOverride={renderTileAvailabilityOverride({
        availability,
        githubConnect,
        withSupportingCopy,
      })}
      comparisonLabel={comparisonLabel}
      comparisonSections={comparisonSections}
      isSection={isSection}
      notice={notice}
      onEditTile={onEditTile}
      onResizeWidth={onResizeWidth}
      onTogglePin={onTogglePin}
      pinned={pinned}
      sections={sections}
      showDragHandle={showDragHandle}
      showResizeControls={showResizeControls}
      tile={tile}
    />
  );
}

/**
 * The titled-card shell for chart / table / panel tiles. The card content routes
 * through the shared {@link ExpandableWidget} so every chart tile inherits the
 * "expand to full-screen modal" affordance uniformly (FEA-3751) — the same modal
 * machinery the overview `DashboardCard` chart rows already use (FEA-3632).
 *
 * Rather than the default floating corner button, the expand control is rendered
 * INTO the tile's existing hover-revealed control cluster (via ExpandableWidget's
 * render-children API), so it sits alongside pin / edit / resize instead of
 * overlapping a second button — and it carries the `insights-widget-control` class
 * so the dashboard grid's drag config (`cancel: ".insights-widget-control"`) never
 * starts a drag when it is clicked.
 */
function ChartTile({
  tile,
  sections,
  comparisonSections,
  comparisonLabel,
  bodyOverride,
  isSection,
  pinned,
  onTogglePin,
  onEditTile,
  onResizeWidth,
  showDragHandle,
  showResizeControls,
  notice,
}: {
  tile: ChartTileDescriptor;
  sections: InsightsSectionData;
  comparisonSections?: InsightsSectionData;
  comparisonLabel?: string;
  bodyOverride: ReactNode;
  isSection: boolean;
  pinned: boolean;
  onTogglePin?: (id: string) => void;
  onEditTile?: (id: string) => void;
  onResizeWidth?: (id: string, width: number) => void;
  showDragHandle: boolean;
  showResizeControls: boolean;
  /** ISS-10414 — see {@link InsightsTile}'s `notice`. */
  notice?: ReactNode;
}) {
  // Used for the card heading, the expanded modal's accessible name, and the
  // expand control's label, so all three name the same chart.
  const title = tile.title;
  // On a touch pointer there is no hover to reveal these controls, so
  // `touch:opacity-100` keeps the pin / edit / info / expand cluster visible;
  // the mouse hover reveal (`group-hover:opacity-100`) is unchanged.
  const controls = ({
    expandButton,
    isExpanded = false,
    collapse,
  }: {
    expandButton?: ReactNode;
    // Grid-only affordances (drag handle, width resize) are meaningless inside
    // the full-screen modal — there is no grid to drag within and no column
    // width to set — so they are suppressed while expanded, the same way the
    // expand button itself is. Leaving them lit but inert reads as broken.
    isExpanded?: boolean;
    // Closes the modal. Used when an action makes the expanded view stale — e.g.
    // removing (unpinning) the tile, which would otherwise leave the modal
    // hovering over a widget that no longer exists on the dashboard behind it.
    collapse?: () => void;
  } = {}) => (
    <div className="relative z-[10000] flex shrink-0 items-center gap-0.5 rounded-md border bg-background/95 p-0.5 opacity-0 touch:opacity-100 shadow-sm transition-opacity focus-within:opacity-100 group-hover:opacity-100">
      {showDragHandle && !isExpanded ? (
        <GripVerticalIcon className="insights-drag-handle size-4 shrink-0 cursor-move text-muted-foreground" />
      ) : null}
      {showResizeControls && onResizeWidth && !isExpanded ? (
        <ResizeButtons onResize={(width) => onResizeWidth(tile.id, width)} />
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
            // Removing (unpinning) the tile takes it off the dashboard; if we're
            // in the expanded modal, close it so it doesn't linger over a widget
            // that no longer exists behind it.
            if (pinned && isExpanded) {
              collapse?.();
            }
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
      {expandButton}
    </div>
  );

  const card = (headerControls: ReactNode) => (
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
            {title}
          </span>
        </div>
        {headerControls}
      </CardHeader>
      {/* Inside the card, so it relocates into the expand dialog with the
          chart it describes. Outside `CardContent`'s `flex-1` body, so the
          container-sized chart's height math is untouched. Bare rather than
          padded: the notice carries its own gutter, so its always-mounted
          `sr-only` half (out of flow) costs a settled tile no layout. */}
      {notice}
      <CardContent
        className={isSection ? "min-h-0 flex-1 px-6" : "min-h-0 flex-1 p-3"}
      >
        {bodyOverride ?? (
          <InsightsChartContent
            comparisonLabel={comparisonLabel}
            comparisonSections={comparisonSections}
            sections={sections}
            tile={tile}
          />
        )}
      </CardContent>
    </Card>
  );

  // The card content is portaled/relocated as a single instance by
  // ExpandableWidget. The expand control lives INSIDE that content (in the
  // existing control cluster) via the render-children API, so it relocates with
  // the widget and never double-mounts. It is hidden while the modal is already
  // open — expanding-while-expanded is a no-op.
  return (
    <ExpandableWidget
      className="h-full"
      contentClassName="h-full"
      title={title}
      titleInContent
    >
      {({ expand, collapse, isExpanded }) =>
        card(
          controls({
            isExpanded,
            collapse,
            expandButton: isExpanded ? null : (
              <Button
                aria-label={`Expand ${title}`}
                className="insights-widget-control size-6 shrink-0"
                onClick={(event) => {
                  event.stopPropagation();
                  expand();
                }}
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                size="icon"
                type="button"
                variant="ghost"
              >
                <Maximize2Icon className="size-3.5" />
              </Button>
            ),
          })
        )
      }
    </ExpandableWidget>
  );
}

/**
 * What a non-Available tile says, with NO layout of its own (ISS-7866): the
 * connect affordance when the tile is gated, the unavailable sentence
 * otherwise, and `null` when the tile can render its real value.
 *
 * Hosts own the container. A KPI card puts this in its `MetricCard` caption
 * slot and keeps its label; a chart tile fills its body with it via
 * {@link renderTileAvailabilityOverride}.
 */
export function renderTileAvailabilityDetail({
  availability,
  githubConnect,
  withSupportingCopy = false,
}: {
  availability: InsightsTileAvailability | undefined;
  githubConnect: GitHubConnectTarget | undefined;
  /**
   * ISS-11476's supporting sentence, which the Overview dashboard's cards pass
   * and the Insights grid's tiles do not: the sentence names a session-linked
   * population, and this node's own rule holds explanatory copy to its producer
   * (`packages/app/insights/AGENTS.md`). The cloud KPI tiles are a provider-PR
   * population with no authoring-session link, so it would be a false claim
   * there. Codex review on #8169.
   */
  withSupportingCopy?: boolean;
}): ReactNode {
  if (!availability || availability.state === BranchKpiState.Available) {
    return null;
  }
  if (availability.state === BranchKpiState.Gated) {
    // A KPI caption sits beside the card's own label, so the verb alone is
    // unambiguous here.
    return (
      <ConnectGitHubIndicator
        connect={githubConnect}
        variant={GatedMetricIndicatorVariant.Card}
        withSupportingCopy={withSupportingCopy}
      />
    );
  }
  return TILE_UNAVAILABLE_MESSAGE;
}

/**
 * The same content sized to FILL a chart tile's body. Chart tiles have a body
 * to replace, so the override is centred in the card's content area; KPI tiles
 * take {@link renderTileAvailabilityDetail} directly instead.
 */
export function renderTileAvailabilityOverride({
  availability,
  githubConnect,
  withSupportingCopy = false,
}: {
  availability: InsightsTileAvailability | undefined;
  githubConnect: GitHubConnectTarget | undefined;
  /** See {@link InsightsTile}'s `withSupportingCopy`. */
  withSupportingCopy?: boolean;
}): ReactNode {
  if (!availability || availability.state === BranchKpiState.Available) {
    return null;
  }
  // ISS-7866 review: a chart tile REPLACES its whole body, so unlike the KPI
  // caption above there is no card label beside the ask to say which metric is
  // dark. It takes the centred treatment, which keeps the explanation. Building
  // it here rather than reusing `renderTileAvailabilityDetail` is the point —
  // sharing that helper is what made one narrowing silently empty both.
  if (availability.state === BranchKpiState.Gated) {
    return (
      <div className="grid h-full min-h-24 place-items-center px-3">
        <ConnectGitHubIndicator
          connect={githubConnect}
          variant={
            withSupportingCopy
              ? GatedMetricIndicatorVariant.Card
              : GatedMetricIndicatorVariant.Centered
          }
          withSupportingCopy={withSupportingCopy}
        />
      </div>
    );
  }
  return (
    <div className="grid h-full min-h-24 place-items-center px-3 text-center text-muted-foreground text-xs">
      {TILE_UNAVAILABLE_MESSAGE}
    </div>
  );
}

const TILE_UNAVAILABLE_MESSAGE =
  "This GitHub metric is unavailable for the selected scope.";
