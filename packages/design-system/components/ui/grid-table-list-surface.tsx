"use client";

// Grid Table v2 promotion candidate, derived from the approved Generic Artifact
// prototype's list shell.

import { cn } from "@closedloop-ai/design-system/lib/utils";
import { useMediaQuery } from "@closedloop-ai/design-system/hooks/use-media-query";
import { GRID_TABLE_V2_NARROW_VIEWPORT_QUERY } from "@closedloop-ai/design-system/lib/grid-table-v2-responsive";
import { TableBulkActionBarInFlowContext } from "@closedloop-ai/design-system/lib/table-bulk-action-bar-layout";
import {
  type FocusEvent,
  type HTMLAttributes,
  type ReactNode,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";

/**
 * The band layout every v2 list surface shares: a toolbar band, an optional
 * metric-card strip, the scrolling table region, and a pagination footer.
 *
 * It owns only ephemeral responsive layout state, no data, and knows nothing
 * about what a row is. It is the peer of `GridTableToolbar` one level up: that component lays out
 * the CONTROLS, this one lays out the PAGE those controls sit on.
 *
 * It exists because the band structure is the part that was silently
 * copy-pasted. The Generic Artifact prototype, the Sessions listing and the
 * Branches listing all render the same four bands with the same borders,
 * padding and scroll ownership, and each had its own copy — which is how they
 * drifted (the metric strip snaps horizontally on narrow viewports in one and
 * wraps in another). Composing this instead means a surface supplies its
 * toolbar, its cards and its table, and cannot get the frame wrong.
 *
 * Scroll ownership is the load-bearing detail. The TABLE band owns the
 * horizontal scroll (`overflow-auto`), not the page — `GridTableV2` renders no
 * overflow wrapper of its own and documents that the host owns the scroll
 * container, which is what makes its sticky header resolve against the right
 * ancestor. The toolbar and footer bands sit OUTSIDE that scroller so they stay
 * put while the columns move.
 */
export function GridTableListSurface({
  bulkActions,
  className,
  metrics,
  mode: modeOverride,
  pagination,
  table,
  tableScrollAttributes,
  tableScrollRef,
  tableScrollTestId = GRID_TABLE_SCROLL_BAND_TEST_ID,
  toolbar,
}: {
  /** Optional selection rail; omitted consumers keep their existing bands. */
  bulkActions?: ReactNode;
  className?: string;
  /**
   * The metric-card summary row. Rendered in its own band between the toolbar
   * and the table; omit it entirely rather than passing an empty node, so a
   * surface with no metrics costs no vertical space.
   */
  metrics?: ReactNode;
  /** Explicit responsive mode for controlled stories and rollout adapters. */
  mode?: GridTableListSurfaceMode;
  /**
   * Pagination footer. Omit when the surface is grouped — a page boundary
   * cutting through a group renders a section header with rows missing beneath
   * it, which reads as data loss rather than as pagination.
   */
  pagination?: ReactNode;
  /** The grid itself. This band owns the horizontal scroll. */
  table: GridTableListSurfaceSlot;
  /**
   * The scrolling table band's element, handed to a host that needs to read or
   * restore its scroll offset. This band is the ONLY scroll container in the
   * surface — the toolbar, metric and pagination bands sit outside it — so a
   * host with nothing else to attach to would otherwise silently observe a
   * container that never scrolls.
   */
  tableScrollAttributes?: Pick<
    HTMLAttributes<HTMLDivElement>,
    "aria-label" | "role" | "tabIndex"
  >;
  tableScrollRef?: (node: HTMLElement | null) => void;
  /** Stable test id for a surface that already has route-level scroll anchors. */
  tableScrollTestId?: string;
  /** Typically a `GridTableToolbar`. */
  toolbar: GridTableListSurfaceSlot;
}) {
  const isNarrowViewport = useMediaQuery(
    GRID_TABLE_V2_NARROW_VIEWPORT_QUERY
  );
  const mode: GridTableListSurfaceMode =
    modeOverride ?? (isNarrowViewport ? "compact" : "expanded");
  // Only a viewport breakpoint crossing changes either slot.
  const toolbarContent = useMemo(
    () => renderSurfaceSlot(toolbar, mode),
    [toolbar, mode]
  );
  const tableContent = useMemo(
    () => renderSurfaceSlot(table, mode),
    [table, mode]
  );
  const rootRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocusedTable = useRef(false);
  const tableFocusGeneration = useRef(0);
  const previousMode = useRef(mode);

  useLayoutEffect(() => {
    if (previousMode.current !== mode && previouslyFocusedTable.current) {
      const active = globalThis.document.activeElement;
      if (active === globalThis.document.body) {
        const destination =
          tableScrollAttributes?.tabIndex === undefined
            ? rootRef.current
            : scrollRef.current;
        destination?.focus();
        if (destination === rootRef.current) {
          previouslyFocusedTable.current = false;
        }
      }
    }
    previousMode.current = mode;
  }, [mode, tableScrollAttributes?.tabIndex]);

  const onTableBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (event.relatedTarget && event.currentTarget.contains(event.relatedTarget)) {
      return;
    }
    if (event.relatedTarget) {
      previouslyFocusedTable.current = false;
      return;
    }
    // A removed focused row can blur with no destination during the same commit.
    // Defer clearing so its mode handoff runs first; a new focus cancels the clear.
    const generation = tableFocusGeneration.current;
    globalThis.queueMicrotask(() => {
      if (tableFocusGeneration.current === generation) {
        previouslyFocusedTable.current = false;
      }
    });
  };

  return (
    <div
      className={cn("flex min-h-0 min-w-0 flex-col", className)}
      ref={rootRef}
      tabIndex={-1}
    >
      <div className="min-w-0 border-b px-4 py-3">{toolbarContent}</div>
      {metrics ? (
        <div
          className="min-w-0 overflow-hidden px-4 pt-4 pb-3 [contain:paint]"
          data-testid={GRID_TABLE_METRIC_BAND_TEST_ID}
        >
          {metrics}
        </div>
      ) : null}
      {/* `contain: paint` keeps the grid's intrinsic width from creating page scroll. */}
      {/* ISS-4901 / ISS-8909: the at-rest-invisible overlay scrollbar cue. Each
          v1 list surface carried this utility on the scroll container it owned
          itself; this band is the element that scrolls for EVERY v2 surface, so
          retiring those hosts drops the affordance from all of them at once
          unless it lives here. It is the shipped `scrollbar-overlay` utility
          (design-system `globals.css`), not a new one, and the band exposes no
          `className` seam for a host to supply it. */}
      <div
        {...tableScrollAttributes}
        className="scrollbar-overlay min-h-0 min-w-0 flex-1 overflow-auto [contain:paint]"
        data-testid={tableScrollTestId}
        onBlurCapture={onTableBlur}
        onFocusCapture={() => {
          tableFocusGeneration.current += 1;
          previouslyFocusedTable.current = true;
        }}
        ref={(node) => {
          scrollRef.current = node;
          tableScrollRef?.(node);
        }}
      >
        {tableContent}
      </div>
      <TableBulkActionBarInFlowContext.Provider value={mode === "compact"}>
        {bulkActions}
      </TableBulkActionBarInFlowContext.Provider>
      {pagination ? (
        <div
          className="flex min-w-0 justify-end border-t px-4 py-3"
          data-testid={GRID_TABLE_PAGINATION_BAND_TEST_ID}
        >
          {pagination}
        </div>
      ) : null}
    </div>
  );
}

/** The viewport-resolved layout shared by a list surface's toolbar and body. */
export type GridTableListSurfaceMode = "compact" | "expanded";

/** Static slots retain existing callers; render slots opt into shared mode. */
export type GridTableListSurfaceSlot =
  | ReactNode
  | ((mode: GridTableListSurfaceMode) => ReactNode);

function renderSurfaceSlot(
  slot: GridTableListSurfaceSlot,
  mode: GridTableListSurfaceMode
): ReactNode {
  return typeof slot === "function" ? slot(mode) : slot;
}

/**
 * The metric strip's own layout, split out because its responsive behaviour is
 * the thing that drifted between surfaces.
 *
 * Below `md` the cards are a horizontally snapping carousel — one nearly-full-
 * width card at a time, so a phone shows one metric properly instead of four
 * illegibly. At `md` and up they share the row evenly and snapping is switched
 * OFF (`md:snap-none`), because snap points on a row that already fits make the
 * container fight a pointer user who drags it.
 */
export function GridTableMetricStrip({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex snap-x snap-mandatory gap-3 overflow-x-auto pb-1 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset md:snap-none",
        className
      )}
      tabIndex={0}
    >
      {children}
    </div>
  );
}

/**
 * Per-card sizing for a card inside {@link GridTableMetricStrip}. Exported as a
 * class string rather than a wrapper component because the cards themselves are
 * caller-owned (`MetricCard`, or a surface's own summary card), and they take a
 * `className` — wrapping them would add a div between the strip's flex context
 * and the card, which is what breaks the even `md:flex-1` distribution.
 */
export const GRID_TABLE_METRIC_CARD_CLASS =
  "shrink-0 basis-[calc(100%_-_2.5rem)] snap-start md:min-w-44 md:flex-1 md:basis-auto";

/**
 * Anchor for the metric band ITSELF, not its contents.
 *
 * A surface whose every metric is hidden must drop this band rather than keep
 * its `pt-4 pb-3` around a strip rendering nothing — otherwise the unexplained
 * empty space the reader asked to remove just moves up one level (FEA-4217).
 * That is a claim about the WRAPPER, so it needs a handle on the wrapper; the
 * card contents cannot witness their own container.
 */
export const GRID_TABLE_METRIC_BAND_TEST_ID = "grid-table-metric-band";

/**
 * Anchor for the scrolling table band — the surface's ONLY scroll container.
 *
 * Same reason the metric band carries one: a host that restores a list position
 * makes a claim about which ELEMENT it attached to, and no assertion about the
 * rows inside can witness that. The v1 Sessions listing has the identical anchor
 * on its own scroll container for the identical reason.
 */
export const GRID_TABLE_SCROLL_BAND_TEST_ID = "grid-table-scroll-band";

/**
 * Anchor for the pagination band ITSELF, for the same reason the metric band
 * carries one: the band is CONDITIONAL, and no assertion about what is inside it
 * can witness the wrapper.
 *
 * Without this, a surface rendering no pagination is indistinguishable from one
 * rendering an EMPTY band — the control inside publishes `role="navigation"`, so
 * querying that role reports "no pagination" in both cases, while the second
 * still paints a bordered `border-t px-4 py-3` strip containing nothing. That is
 * the FEA-4217 defect the metric band's anchor already exists to catch.
 */
export const GRID_TABLE_PAGINATION_BAND_TEST_ID = "grid-table-pagination-band";
