"use client";

import { useIsomorphicLayoutEffect } from "@closedloop-ai/design-system/hooks/use-isomorphic-layout-effect";
import {
  GRID_TABLE_ROW_HEIGHT_PX,
  type GridRowWindow,
  isSameGridRowWindow,
  resolveGridRowScrollTop,
  resolveGridRowWindow,
  seedGridRowWindow,
  wholeGridRowPopulation,
} from "@closedloop-ai/design-system/lib/grid-row-window";
import { GRID_ROW_SELECTOR } from "@closedloop-ai/design-system/lib/grid-table-navigation";
import { resolveScrollParent } from "@closedloop-ai/design-system/lib/scroll-parent";
import { useCallback, useRef, useState, useSyncExternalStore } from "react";

// Measure before paint, so the first painted frame already holds the window
// rather than painting every row once and cutting back a frame later. React runs
// no layout effect on the server, where there is nothing to measure anyway.
const useMeasureEffect = useIsomorphicLayoutEffect;

/** What one measurement pass reads off the layout, for the arithmetic to use. */
type GridRowGeometry = {
  /** Height of one painted row, measured rather than assumed. */
  rowHeightPx: number;
  /** Where row 0 begins inside the scroller's content. */
  rowsOffsetPx: number;
  /** How much of the scroller's top edge the body's sticky chrome covers. */
  stickyInsetPx: number;
  /** The scroller's visible height. */
  viewportHeightPx: number;
};

const UNMEASURED_GEOMETRY: GridRowGeometry = {
  rowHeightPx: GRID_TABLE_ROW_HEIGHT_PX,
  rowsOffsetPx: 0,
  stickyInsetPx: 0,
  viewportHeightPx: 0,
};

/**
 * The slice of a uniform-height row population worth painting at the scroller's
 * current offset (ISS-12288), plus the way to bring a row index into it.
 *
 * `attachRowsAnchor` goes on a zero-height element the caller renders where row
 * 0 begins — it is the sibling the rows follow, so its position is independent
 * of which rows are painted, and it is what makes the window honest about the
 * header sitting above the rows inside the same scroller. It is also the node
 * the scroller is found from: `GridTableV2` documents that the HOST owns the
 * scroll container, so there is no prop to read it off and the nearest scrolling
 * ancestor is the answer.
 *
 * MOUNT COST is why the anchor is held in a ref and not only in state. Keying
 * the measurement on a STATE copy of the node cost an extra full-population
 * render: the ref callback fires during the first commit, but the layout effect
 * in that same pass still closed over a null anchor, so only the pass after it
 * could measure. Reading the ref — which the commit has already set — measures
 * in the FIRST layout effect instead. The generation counter is what still
 * re-runs this when the node is REPLACED (a responsive host swapping the grid
 * for a card list), which a ref alone cannot notice.
 *
 * Every state this cannot measure — no anchor, no scrolling ancestor, a
 * container that reports no height — resolves to the whole population. A row
 * must never stop rendering because the layout could not be read.
 */
export function useGridRowWindow({
  enabled,
  rowCount,
}: {
  enabled: boolean;
  rowCount: number;
}): {
  attachRowsAnchor: (node: HTMLElement | null) => void;
  rowWindow: GridRowWindow;
  scrollRowIntoView: (index: number) => void;
} {
  // The server and the hydrating render both read the server snapshot, so a
  // hydrated grid starts from the same whole population the server painted and
  // only a client-only mount starts from the seed. The layout effect narrows
  // either one before paint.
  const seedsBeforePaint = useSyncExternalStore(
    subscribeToNothing,
    seedsOnClientMount,
    seedsOnServerOrHydration
  );
  const [rowWindow, setRowWindow] = useState<GridRowWindow>(() =>
    enabled && seedsBeforePaint
      ? seedGridRowWindow(rowCount)
      : wholeGridRowPopulation(rowCount)
  );
  // What a scroll event must NOT re-read. Every field here flushes layout, and
  // doing that per scroll event is the cost this hook exists to avoid; none of
  // them can change without a resize, which is what refreshes them.
  const geometry = useRef<GridRowGeometry>(UNMEASURED_GEOMETRY);
  const scroller = useRef<HTMLElement | null>(null);
  const anchor = useRef<HTMLElement | null>(null);
  // Whether a measurement pass has run yet, which is what separates the one free
  // attach from every later one — see `attachRowsAnchor`.
  const hasMeasured = useRef(false);
  const rows = useRef(rowCount);
  rows.current = rowCount;
  // Bumped whenever the anchor node itself changes, which is the only thing a
  // ref cannot tell the effect below.
  const [anchorGeneration, setAnchorGeneration] = useState(0);

  const attachRowsAnchor = useCallback((node: HTMLElement | null) => {
    const previous = anchor.current;
    if (previous === node) {
      return;
    }
    anchor.current = node;
    // An attach that lands BEFORE the first measurement pass needs no signal:
    // the ref is set during the commit and that pass reads it directly, so
    // bumping would only split one render into two — on a 500-row page, a second
    // full pass. That is the mount, and it is the only attach the exemption can
    // cover.
    //
    // Every attach after a pass has run needs the bump, because the pass has
    // already read a DIFFERENT node — or none (davetho review). A responsive
    // host below its card breakpoint has no grid and so no anchor, and widening
    // back to one arrives here with `previous` null just as a mount does;
    // keying the exemption on the previous node read that as a mount, so no
    // scroll listener and no observer were reattached and the body painted its
    // whole population on every poll until the row count happened to change.
    // Both orders reach it: mounting narrow and widening, and mounting wide then
    // shrinking and widening back.
    if (hasMeasured.current || node === null) {
      setAnchorGeneration((generation) => generation + 1);
    }
  }, []);

  // Every write goes through this, so a window that selects the same rows costs
  // no render. That is what makes the hook free for the grids that do not window
  // at all: their whole-population answer never changes, so a data change does
  // not add a second render pass to every table in the repo.
  const settle = useCallback((next: GridRowWindow) => {
    setRowWindow((previous) =>
      isSameGridRowWindow(previous, next) ? previous : next
    );
  }, []);

  useMeasureEffect(() => {
    // Before every early return: from here on, an attach is news this pass has
    // already missed.
    hasMeasured.current = true;
    const rowsAnchor = anchor.current;
    if (!(enabled && rowsAnchor)) {
      scroller.current = null;
      geometry.current = UNMEASURED_GEOMETRY;
      settle(wholeGridRowPopulation(rowCount));
      return;
    }
    const scrollElement = resolveScrollParent(rowsAnchor);
    scroller.current = scrollElement;
    if (!scrollElement) {
      geometry.current = UNMEASURED_GEOMETRY;
      settle(wholeGridRowPopulation(rowCount));
      return;
    }
    const refreshGeometry = () => {
      geometry.current = {
        rowHeightPx: measureRowHeightPx(rowsAnchor),
        rowsOffsetPx:
          rowsAnchor.getBoundingClientRect().top -
          scrollElement.getBoundingClientRect().top +
          scrollElement.scrollTop,
        stickyInsetPx: measureStickyInsetPx(rowsAnchor),
        viewportHeightPx: scrollElement.clientHeight,
      };
    };
    const applyWindow = () => {
      settle(
        resolveGridRowWindow({
          rowCount: rows.current,
          rowHeightPx: geometry.current.rowHeightPx,
          rowsOffsetPx: geometry.current.rowsOffsetPx,
          scrollTop: scrollElement.scrollTop,
          viewportHeightPx: geometry.current.viewportHeightPx,
        })
      );
    };
    const remeasure = () => {
      refreshGeometry();
      applyWindow();
    };
    remeasure();
    // One window update per animation frame, not per scroll event. A scroll
    // fires far more often than the screen refreshes, and each accepted update
    // re-renders the whole painted slice — so an uncoalesced handler spends the
    // frame it was trying to save.
    let frame = 0;
    const onScroll = () => {
      if (frame !== 0) {
        return;
      }
      frame = globalThis.requestAnimationFrame(() => {
        frame = 0;
        applyWindow();
      });
    };
    scrollElement.addEventListener("scroll", onScroll, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(remeasure);
    observer?.observe(scrollElement);
    return () => {
      if (frame !== 0) {
        globalThis.cancelAnimationFrame(frame);
      }
      scrollElement.removeEventListener("scroll", onScroll);
      observer?.disconnect();
    };
  }, [anchorGeneration, enabled, rowCount, settle]);

  const scrollRowIntoView = useCallback((index: number) => {
    const scrollElement = scroller.current;
    if (!scrollElement) {
      return;
    }
    const scrollTop = resolveGridRowScrollTop({
      index,
      rowCount: rows.current,
      rowHeightPx: geometry.current.rowHeightPx,
      rowsOffsetPx: geometry.current.rowsOffsetPx,
      scrollTop: scrollElement.scrollTop,
      stickyInsetPx: geometry.current.stickyInsetPx,
      viewportHeightPx: geometry.current.viewportHeightPx,
    });
    if (scrollTop !== null) {
      scrollElement.scrollTop = scrollTop;
    }
  }, []);

  return { attachRowsAnchor, rowWindow, scrollRowIntoView };
}

/**
 * The height of a painted row, or the seed constant when none is painted yet.
 *
 * Read off a row AFTER the anchor, never a `querySelector` over the body: the
 * column-header row carries the same row marker once the header joins the
 * roving model (ISS-8930), and it is shorter than a data row — so a body-wide
 * query would measure the header and shrink every pad by a fifth.
 */
function measureRowHeightPx(rowsAnchor: HTMLElement): number {
  let sibling = rowsAnchor.nextElementSibling;
  while (sibling) {
    if (sibling.matches(GRID_ROW_SELECTOR)) {
      const height = sibling.getBoundingClientRect().height;
      return height > 0 ? height : GRID_TABLE_ROW_HEIGHT_PX;
    }
    sibling = sibling.nextElementSibling;
  }
  return GRID_TABLE_ROW_HEIGHT_PX;
}

/**
 * How much of the scroller's top edge the body's own sticky chrome covers: the
 * sum of the heights of the anchor's PRECEDING siblings that are stuck there.
 *
 * Measured rather than named, because this package's window code has no business
 * knowing which element the header is — a host that adds a second sticky band
 * above the rows is covered without this learning about it.
 */
function measureStickyInsetPx(rowsAnchor: HTMLElement): number {
  let inset = 0;
  let sibling = rowsAnchor.previousElementSibling;
  while (sibling) {
    if (globalThis.getComputedStyle(sibling).position === "sticky") {
      inset += sibling.getBoundingClientRect().height;
    }
    sibling = sibling.previousElementSibling;
  }
  return inset;
}

function subscribeToNothing(): () => void {
  return () => undefined;
}

function seedsOnClientMount(): boolean {
  return true;
}

function seedsOnServerOrHydration(): boolean {
  return false;
}
