"use client";

import { useEffect, useRef, useState } from "react";

// Axis the fade tracks. `showTopFade`/`showBottomFade` map to the start/end of
// the axis: for "vertical" they are literally top/bottom; for "horizontal" they
// are the left (start) and right (end) edges of a horizontally scrolling track.
type ScrollFadeAxis = "vertical" | "horizontal";

type ScrollFade = {
  ref: React.RefObject<HTMLDivElement | null>;
  showTopFade: boolean;
  showBottomFade: boolean;
  /**
   * Whether the element can actually scroll on this axis right now — content
   * genuinely overflows AND the computed overflow allows scrolling. Distinct
   * from `showTopFade || showBottomFade` (which is also false at rest before the
   * first measurement), and stable while scrolling, so callers can hang
   * scroll-only affordances — a tab stop, an end inset — on it without those
   * flickering as the user scrolls to either end.
   */
  isScrollable: boolean;
};

// Tolerance (px) so sub-pixel scroll offsets don't flicker the fades.
const SCROLL_EPSILON = 1;

/**
 * Tracks scroll position of a scrollable element on the given axis and reports
 * whether content is clipped before (showTopFade) or after (showBottomFade) the
 * viewport. For a "horizontal" axis those map to the left/right edges.
 * Recomputes on scroll, on element resize, and when children mount or unmount
 * (e.g. async-loaded nav sections, or a variable-width toggle row).
 */
export function useScrollFade(axis: ScrollFadeAxis = "vertical"): ScrollFade {
  const ref = useRef<HTMLDivElement | null>(null);
  const [showTopFade, setShowTopFade] = useState(false);
  const [showBottomFade, setShowBottomFade] = useState(false);
  const [canScroll, setCanScroll] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }

    const update = () => {
      const isHorizontal = axis === "horizontal";
      const scrollStart = isHorizontal ? element.scrollLeft : element.scrollTop;
      const scrollSize = isHorizontal
        ? element.scrollWidth
        : element.scrollHeight;
      const clientSize = isHorizontal
        ? element.clientWidth
        : element.clientHeight;
      const maxScroll = scrollSize - clientSize;
      // When the container can't actually scroll (no overflow, or overflow
      // clipped — e.g. the sidebar collapsed to icon mode sets overflow:hidden
      // while scrollHeight still exceeds clientHeight), show neither fade.
      if (maxScroll <= SCROLL_EPSILON || !isScrollable(element, axis)) {
        setCanScroll(false);
        setShowTopFade(false);
        setShowBottomFade(false);
        return;
      }
      setCanScroll(true);
      setShowTopFade(scrollStart > SCROLL_EPSILON);
      setShowBottomFade(scrollStart < maxScroll - SCROLL_EPSILON);
    };

    // ResizeObserver/MutationObserver exist in every browser and the Electron
    // renderer, but a bare jsdom test environment may not polyfill them. Treat
    // them as progressive enhancement: the scroll listener still keeps the
    // fades accurate on user scroll, so a missing observer degrades gracefully
    // instead of throwing during mount.
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    if (resizeObserver) {
      resizeObserver.observe(element);
      for (const child of Array.from(element.children)) {
        resizeObserver.observe(child);
      }
    }

    // Re-observe children when sections mount/unmount so content-size changes
    // keep the fades accurate. Removed children don't need an explicit
    // unobserve — ResizeObserver drops references to GC'd elements on its own,
    // so re-observing the current survivors is sufficient and leak-free.
    const mutationObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(() => {
            if (resizeObserver) {
              for (const child of Array.from(element.children)) {
                resizeObserver.observe(child);
              }
            }
            update();
          });
    mutationObserver?.observe(element, { childList: true });

    element.addEventListener("scroll", update, { passive: true });
    update();

    return () => {
      element.removeEventListener("scroll", update);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    };
  }, [axis]);

  return { ref, showTopFade, showBottomFade, isScrollable: canScroll };
}

function isScrollable(element: HTMLElement, axis: ScrollFadeAxis): boolean {
  const style = getComputedStyle(element);
  const overflow = axis === "horizontal" ? style.overflowX : style.overflowY;
  return overflow === "auto" || overflow === "scroll" || overflow === "overlay";
}
