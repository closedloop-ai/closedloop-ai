"use client";

import { useEffect, useRef, useState } from "react";

type ScrollFade = {
  ref: React.RefObject<HTMLDivElement | null>;
  showTopFade: boolean;
  showBottomFade: boolean;
};

// Tolerance (px) so sub-pixel scroll offsets don't flicker the fades.
const SCROLL_EPSILON = 1;

/**
 * Tracks vertical scroll position of a scrollable element and reports whether
 * content is clipped above (showTopFade) or below (showBottomFade) the
 * viewport. Recomputes on scroll, on element resize, and when children mount
 * or unmount (e.g. async-loaded nav sections).
 */
export function useScrollFade(): ScrollFade {
  const ref = useRef<HTMLDivElement | null>(null);
  const [showTopFade, setShowTopFade] = useState(false);
  const [showBottomFade, setShowBottomFade] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }

    const update = () => {
      const { scrollTop, scrollHeight, clientHeight } = element;
      const maxScroll = scrollHeight - clientHeight;
      // When the container can't actually scroll (no overflow, or overflow
      // clipped — e.g. the sidebar collapsed to icon mode sets overflow:hidden
      // while scrollHeight still exceeds clientHeight), show neither fade.
      if (maxScroll <= SCROLL_EPSILON || !isScrollable(element)) {
        setShowTopFade(false);
        setShowBottomFade(false);
        return;
      }
      setShowTopFade(scrollTop > SCROLL_EPSILON);
      setShowBottomFade(scrollTop < maxScroll - SCROLL_EPSILON);
    };

    const resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(element);
    for (const child of Array.from(element.children)) {
      resizeObserver.observe(child);
    }

    // Re-observe children when sections mount/unmount so content-height
    // changes keep the bottom fade accurate. Removed children don't need an
    // explicit unobserve — ResizeObserver drops references to GC'd elements on
    // its own, so re-observing the current survivors is sufficient and leak-free.
    const mutationObserver = new MutationObserver(() => {
      for (const child of Array.from(element.children)) {
        resizeObserver.observe(child);
      }
      update();
    });
    mutationObserver.observe(element, { childList: true });

    element.addEventListener("scroll", update, { passive: true });
    update();

    return () => {
      element.removeEventListener("scroll", update);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, []);

  return { ref, showTopFade, showBottomFade };
}

function isScrollable(element: HTMLElement): boolean {
  const overflowY = getComputedStyle(element).overflowY;
  return (
    overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay"
  );
}
