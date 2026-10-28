"use client";

import {
  type CSSProperties,
  type RefObject,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

/**
 * ISS-8777 — give the search combobox popup the VIEWPORT as its containing
 * block instead of the nearest positioned ancestor.
 *
 * The popup used to be `position: absolute` inside the typeahead's own
 * `relative` wrapper. That is fine while the wrapper sits outside the sidebar's
 * scroll region, but ISS-8759 moves `<Search />` down into the Labs
 * `SidebarCollapsibleSection`, which is inside `SidebarContent` — and that
 * carries `overflow-auto`. A scroll container clips every descendant whose
 * containing block is itself or one of its descendants, so the results were cut
 * off at the section's edge. The `overflow-auto` is what makes the nav scroll,
 * so it stays; what moves is the popup out of its clipping chain.
 *
 * `position: fixed` resolves against the viewport, which is an ancestor of the
 * scroll container, so the clip no longer applies (CSS 2.1 §11.1.1). No portal:
 * the popup keeps its place in the DOM tree, so the typeahead's focus-out
 * containment check, the `aria-controls` relationship, and a modal ancestor's
 * focus trap and `aria-hidden` sweep all behave exactly as before. The cost of
 * leaving the scroll container's coordinate space is that the popup no longer
 * moves with it, which is what the re-measure below buys back.
 *
 * Two things the placement has to survive, both raised on #6435:
 *
 * - **Geometry that moves with no event.** `Ctrl/Cmd+B` collapses the sidebar
 *   through a `left` transition, and `MobileSearchOverlay` mounts this
 *   typeahead inside a `SheetContent` that slides in under a transform. Neither
 *   emits scroll or resize, and `ResizeObserver` sees no size change because
 *   only the POSITION moves — so an event-only anchor strands the popup at the
 *   coordinates it measured before the animation. A frame loop, running only
 *   while the popup is open, is what tracks a moving ancestor; it is the same
 *   trade Floating UI's `autoUpdate({ animationFrame: true })` makes for
 *   exactly this case. The events are kept alongside it because they land in
 *   the same frame as the change rather than the next one.
 * - **An input near the bottom of the viewport.** Placing the list below it
 *   unconditionally puts every row under the fold, which tracks the input
 *   faithfully and is still unusable (whitlockk). Below stays the preference; the
 *   placement flips above only when below cannot seat a usable list and above
 *   is roomier, and either way the layer is capped to the space it actually
 *   has so the list scrolls inside the viewport instead of past it.
 */
export function useSearchPopupAnchor(open: boolean): {
  anchorRef: RefObject<HTMLDivElement | null>;
  popupStyle: CSSProperties;
} {
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const measuredRef = useRef<SearchPopupAnchor | null>(null);
  const [anchor, setAnchor] = useState<SearchPopupAnchor | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      measuredRef.current = null;
      setAnchor(null);
      return;
    }

    const view = globalThis.window;
    if (view === undefined) {
      return;
    }

    const measure = () => {
      const node = anchorRef.current;
      if (!node) {
        return;
      }
      const next = readAnchor(node, view.innerHeight);
      // The frame loop below re-reads every frame; committing only a CHANGED
      // geometry is what keeps that from turning each frame into a render.
      if (isSameAnchor(measuredRef.current, next)) {
        return;
      }
      measuredRef.current = next;
      setAnchor(next);
    };

    measure();

    // Capture phase: the scroll that matters is the SIDEBAR's, not the
    // window's, and a scroll event on an inner element does not bubble.
    view.addEventListener("scroll", measure, true);
    view.addEventListener("resize", measure);

    const observer = view.ResizeObserver
      ? new view.ResizeObserver(measure)
      : null;
    if (observer && anchorRef.current) {
      observer.observe(anchorRef.current);
    }

    const stopFrameLoop = startFrameLoop(view, measure);

    return () => {
      view.removeEventListener("scroll", measure, true);
      view.removeEventListener("resize", measure);
      observer?.disconnect();
      stopFrameLoop();
    };
  }, [open]);

  return { anchorRef, popupStyle: toPopupStyle(anchor) };
}

/** Which side of the input the popup hangs from. */
export const SearchPopupPlacement = {
  Above: "above",
  Below: "below",
} as const;
export type SearchPopupPlacement =
  (typeof SearchPopupPlacement)[keyof typeof SearchPopupPlacement];

/**
 * The anchor geometry the popup is placed against, in viewport coordinates.
 *
 * `offset` is read against the viewport edge the placement grows from — the top
 * edge when the popup hangs below the input, the bottom edge when it sits above
 * — so exactly one CSS inset is ever set and the two can never disagree.
 */
export type SearchPopupAnchor = {
  left: number;
  width: number;
  maxHeight: number;
  offset: number;
  placement: SearchPopupPlacement;
};

/** Horizontal inset on each side of the anchor (the popup's former `inset-x-2`). */
const POPUP_INSET_X = 8;
/** Gap between the input's bottom edge and the popup (its former `mt-1`). */
const POPUP_GAP_Y = 4;
/** Breathing room kept between the popup and the viewport edge it grows toward. */
const POPUP_VIEWPORT_MARGIN = 8;
/**
 * Below which the side is not worth using: the popup's own border and padding
 * plus roughly two suggestion rows. Under this the list is cropped to nothing
 * useful, which is when flipping to the other side is worth the movement.
 */
const POPUP_MIN_HEIGHT = 120;

function readAnchor(
  node: HTMLElement,
  viewportHeight: number
): SearchPopupAnchor {
  const rect = node.getBoundingClientRect();
  const spaceBelow =
    viewportHeight - rect.bottom - POPUP_GAP_Y - POPUP_VIEWPORT_MARGIN;
  const spaceAbove = rect.top - POPUP_GAP_Y - POPUP_VIEWPORT_MARGIN;
  const placeAbove = spaceBelow < POPUP_MIN_HEIGHT && spaceAbove > spaceBelow;

  return {
    left: rect.left + POPUP_INSET_X,
    // A negative space is not a height, and a negative width is not a width —
    // an anchor narrower than its own insets, or one scrolled off the edge,
    // floors at zero rather than inverting the box.
    maxHeight: Math.max(0, placeAbove ? spaceAbove : spaceBelow),
    offset: placeAbove
      ? viewportHeight - rect.top + POPUP_GAP_Y
      : rect.bottom + POPUP_GAP_Y,
    placement: placeAbove
      ? SearchPopupPlacement.Above
      : SearchPopupPlacement.Below,
    width: Math.max(0, rect.width - POPUP_INSET_X * 2),
  };
}

function isSameAnchor(
  previous: SearchPopupAnchor | null,
  next: SearchPopupAnchor
): boolean {
  return (
    previous !== null &&
    previous.left === next.left &&
    previous.offset === next.offset &&
    previous.placement === next.placement &&
    previous.maxHeight === next.maxHeight &&
    previous.width === next.width
  );
}

/**
 * Re-measure once per frame for as long as the popup is open, and return the
 * canceller. This is what catches an ancestor whose POSITION animates — the
 * sidebar's collapse transition, the mobile sheet's slide-in — neither of which
 * fires scroll, resize, or a `ResizeObserver` entry.
 */
function startFrameLoop(view: Window, measure: () => void): () => void {
  if (typeof view.requestAnimationFrame !== "function") {
    return () => {
      // No frame loop was started, so there is nothing to cancel.
    };
  }

  let frame = view.requestAnimationFrame(function tick() {
    measure();
    frame = view.requestAnimationFrame(tick);
  });

  return () => view.cancelAnimationFrame(frame);
}

function toPopupStyle(anchor: SearchPopupAnchor | null): CSSProperties {
  if (anchor === null) {
    // Fixed from the very first render so the popup is never laid out inside
    // the scroll container, and hidden until measured so it cannot paint one
    // frame at the viewport origin.
    return { position: "fixed", visibility: "hidden" };
  }

  const edge =
    anchor.placement === SearchPopupPlacement.Above
      ? { bottom: anchor.offset }
      : { top: anchor.offset };

  return {
    left: anchor.left,
    maxHeight: anchor.maxHeight,
    position: "fixed",
    width: anchor.width,
    ...edge,
  };
}
