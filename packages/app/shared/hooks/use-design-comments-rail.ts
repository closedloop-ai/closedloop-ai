"use client";

import {
  type RefObject,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";

/** Production's narrow breakpoint for the Branch comments rail. */
const NARROW_COMMENTS_QUERY = "(max-width: 1024px)";
const RAIL_GUTTER_PX = 96;
const RAIL_MIN_PX = 220;

function subscribeNarrow(onChange: () => void) {
  const query = globalThis.window.matchMedia(NARROW_COMMENTS_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

const readNarrow = () =>
  globalThis.window.matchMedia(NARROW_COMMENTS_QUERY).matches;
// The server has no viewport: treat it as narrow so the rail never paints
// open and then closes.
const readNarrowOnServer = () => true;

/**
 * Comments-rail state for the PRD-751 design harnesses (ISS-10963, ISS-10964).
 * Below production's narrow breakpoint the rail and its toggle are hidden:
 * the narrow sheet is ISS-11209's, and an inline rail there would leave the
 * page a sliver. `availableWidth` bounds the shared rail's resize.
 */
export function useDesignCommentsRail(rootRef: RefObject<HTMLElement | null>) {
  const narrow = useSyncExternalStore(
    subscribeNarrow,
    readNarrow,
    readNarrowOnServer
  );
  const [open, setOpen] = useState(true);
  // Only read while the rail is available, i.e. above the 1024px breakpoint,
  // until the observer reports the real width.
  const [rootWidth, setRootWidth] = useState(1200);

  useEffect(() => {
    const element = rootRef.current;
    if (!element) {
      return;
    }
    const observer = new ResizeObserver(([entry]) => {
      if (entry) {
        setRootWidth(entry.contentRect.width);
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [rootRef]);

  return {
    availableWidth: Math.max(RAIL_MIN_PX, rootWidth - RAIL_GUTTER_PX),
    /** False below the breakpoint: hosts render neither rail nor toggle. */
    available: !narrow,
    open: open && !narrow,
    setOpen,
  };
}
