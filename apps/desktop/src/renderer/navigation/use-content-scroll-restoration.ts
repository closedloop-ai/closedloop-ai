import {
  clampScrollRestoreTarget,
  computeMaxScrollTop,
  hasStoredScrollPosition,
  SESSIONS_SCROLL_RESTORE_MAX_ATTEMPTS,
} from "@repo/app/shared/lib/sessions-scroll-contract";
import { useCallback, useLayoutEffect, useRef } from "react";

// Declared once in the shared contract module (PLN-1950 slice 5) -- this
// alias keeps every existing reference in this file unchanged.
export const MAX_CONTENT_SCROLL_RESTORE_ATTEMPTS =
  SESSIONS_SCROLL_RESTORE_MAX_ATTEMPTS;
export const MAX_REMEMBERED_SCROLL_POSITIONS = 50;

/**
 * One slot per scrolling element, not one offset per href.
 *
 * ISS-12471: keep-alive leaves every visited view mounted, so the shell holds
 * the content viewport AND a route scroller belonging to some other route at
 * the same time. Separate slots are what let both capture freely -- whichever
 * is hidden or cannot overflow simply never fires, and neither can land on the
 * other's remembered offset.
 */
type RememberedScroll = {
  contentViewport?: number;
  routeScroller?: number;
};

type ScrollSlot = keyof RememberedScroll;

const desktopContentScrollPositions = new Map<string, RememberedScroll>();

/**
 * Remember the active route's scroll position per nav href and restore it when
 * that href becomes active again, so a list survives a detail round trip at the
 * offset the user left it. `activeNavScrollKey` is the href to key on, or `null`
 * on a route that owns no restorable list position (a detail, the Settings
 * modal), where nothing is captured or restored.
 *
 * ISS-12471: the content viewport is not the scrolling element on every route.
 * A route whose body pins itself to the viewport height -- every
 * `GridTableListSurface` list, Sessions among them -- scrolls an inner band
 * instead, so measuring the viewport there remembers and restores nothing. Such
 * a route publishes its real scroller through `registerRouteScroller` (wired to
 * the surface's `tableScrollRef` via `RouteScrollerProvider`), and that element
 * is then captured and restored alongside the viewport, in its own slot.
 *
 * One registrant at a time is a contract `RouteScrollerProvider` holds up, not
 * an accident of only Sessions wiring `tableScrollRef` today (ISS-12471, marisol
 * cid 4273664871): the slot below is single, so a second keep-alive route
 * registering its own band would take this one's scroll listener with it. The
 * provider publishes the real registrar only inside the panel whose nav id is
 * the live route's, so a hidden band never reaches here.
 */
export function useContentScrollRestoration(activeNavScrollKey: string | null) {
  const contentViewportRef = useRef<HTMLDivElement | null>(null);
  const routeScrollerRef = useRef<HTMLElement | null>(null);
  // One live restore per element: an expired aim is replaced rather than
  // stacked, so resuming (below) cannot leave a treadmill of frame loops.
  const cancelRestoresRef = useRef(new Map<HTMLElement, () => void>());
  // The elements this activation has already aimed a restore at, dropped
  // whenever the key changes. `GridTableListSurface` attaches `tableScrollRef`
  // through an inline arrow, so React re-attaches the SAME node on every render
  // of the surface; restoring again there would snap the reader back to the
  // last offset a scroll event delivered, which mid-scroll is behind them.
  const restoredRef = useRef<{
    key: string;
    elements: Set<HTMLElement>;
  } | null>(null);
  // Both scroll handlers read the key from a ref rather than a closure: the
  // route scroller's is attached as a DOM listener, and an identity that
  // changed per key would leave the registered node holding a stale one. The
  // ref is written in the layout effect below and never during render (marisol cid
  // 4273665166): a render the shell's deferred nav throws away would otherwise
  // leave it naming an href that never committed, and a scroll in that window
  // records under that href.
  const activeNavScrollKeyRef = useRef(activeNavScrollKey);

  const restoreInto = useCallback(
    (element: HTMLElement, slot: ScrollSlot, activeKey: string | null) => {
      if (!activeKey) {
        return;
      }
      // Marked before the stored-position check, so an element with nothing
      // remembered still counts as aimed at: otherwise every re-attach retries
      // it.
      if (!markRestoreAimed(restoredRef, activeKey, element)) {
        return;
      }
      const scrollTop = desktopContentScrollPositions.get(activeKey)?.[slot];
      if (!hasStoredScrollPosition(scrollTop)) {
        return;
      }
      cancelRestoresRef.current.get(element)?.();
      cancelRestoresRef.current.set(
        element,
        restoreContentScrollPosition(element, scrollTop, () => {
          // The aim never landed, so it is not an attempt the re-attach guard
          // should spend: a list still reading its rows cannot hold the offset
          // inside the frame budget, and the next render is the only thing that
          // reaches this element again (shafty cid 4273904284).
          releaseRestoreAim(restoredRef, activeKey, element);
        })
      );
    },
    []
  );

  const handleContentViewportScroll = useCallback(() => {
    rememberScrollPositionOf(
      activeNavScrollKeyRef.current,
      contentViewportRef.current,
      "contentViewport"
    );
  }, []);

  const handleRouteScrollerScroll = useCallback(() => {
    rememberScrollPositionOf(
      activeNavScrollKeyRef.current,
      routeScrollerRef.current,
      "routeScroller"
    );
  }, []);

  const registerRouteScroller = useCallback(
    (node: HTMLElement | null) => {
      const previous = routeScrollerRef.current;
      if (previous === node) {
        return;
      }
      previous?.removeEventListener("scroll", handleRouteScrollerScroll);
      routeScrollerRef.current = node;
      if (!node) {
        return;
      }
      node.addEventListener("scroll", handleRouteScrollerScroll, {
        passive: true,
      });
      // A list's band mounts when its rows do, which can be commits after the
      // route became active -- by then the effect below has already run with no
      // scroller to aim at, so registration is the only place left to restore.
      // The key comes from this render's closure, not the committed ref: React
      // never invokes a discarded render's ref callbacks, and a child's fire
      // before an ancestor's layout effect has synced that ref.
      restoreInto(node, "routeScroller", activeNavScrollKey);
    },
    [activeNavScrollKey, handleRouteScrollerScroll, restoreInto]
  );

  // Restores both slots on every activation. The route scroller is usually
  // already restored by the time this runs -- a child ref callback fires before
  // an ancestor's layout effect, and `GridTableListSurface`'s inline arrow
  // re-fires on every render -- so this branch is what keeps the hook correct
  // for a surface whose `tableScrollRef` identity is stable instead.
  useLayoutEffect(() => {
    activeNavScrollKeyRef.current = activeNavScrollKey;
    restoredRef.current = null;
    const viewport = contentViewportRef.current;
    const routeScroller = routeScrollerRef.current;
    if (activeNavScrollKey && viewport) {
      restoreInto(viewport, "contentViewport", activeNavScrollKey);
    }
    if (activeNavScrollKey && routeScroller) {
      restoreInto(routeScroller, "routeScroller", activeNavScrollKey);
    }
    const cancelRestores = cancelRestoresRef.current;
    return () => {
      for (const cancelRestore of cancelRestores.values()) {
        cancelRestore();
      }
      cancelRestores.clear();
    };
  }, [activeNavScrollKey, restoreInto]);

  return {
    contentViewportRef,
    handleContentViewportScroll,
    registerRouteScroller,
  };
}

/**
 * Records that `element` has been aimed at for `activeKey`, returning false when
 * it already had been. The set is replaced rather than added to when the key
 * moves, so each activation restores once per element.
 */
function markRestoreAimed(
  restoredRef: { current: { key: string; elements: Set<HTMLElement> } | null },
  activeKey: string,
  element: HTMLElement
): boolean {
  const restored = restoredRef.current;
  if (restored?.key !== activeKey) {
    restoredRef.current = { elements: new Set([element]), key: activeKey };
    return true;
  }
  if (restored.elements.has(element)) {
    return false;
  }
  restored.elements.add(element);
  return true;
}

/**
 * Drops `element` from `activeKey`'s aimed set, so the next re-attach may aim
 * again. Scoped to `activeKey` so a restore that expires after the route moved
 * on cannot reopen the new route's guard.
 */
function releaseRestoreAim(
  restoredRef: { current: { key: string; elements: Set<HTMLElement> } | null },
  activeKey: string,
  element: HTMLElement
): void {
  const restored = restoredRef.current;
  if (restored?.key !== activeKey) {
    return;
  }
  restored.elements.delete(element);
}

function rememberScrollPositionOf(
  activeNavScrollKey: string | null,
  element: HTMLElement | null,
  slot: ScrollSlot
): void {
  if (!(activeNavScrollKey && element)) {
    return;
  }
  rememberContentScrollPosition(activeNavScrollKey, element.scrollTop, slot);
}

function rememberContentScrollPosition(
  href: string,
  scrollTop: number,
  slot: ScrollSlot
): void {
  if (!Number.isFinite(scrollTop)) {
    return;
  }
  const remembered = desktopContentScrollPositions.get(href) ?? {};
  remembered[slot] = Math.max(0, scrollTop);
  desktopContentScrollPositions.set(href, remembered);
  while (desktopContentScrollPositions.size > MAX_REMEMBERED_SCROLL_POSITIONS) {
    const firstKey = desktopContentScrollPositions.keys().next().value;
    if (firstKey === undefined) {
      return;
    }
    desktopContentScrollPositions.delete(firstKey);
  }
}

/**
 * Exported (PLN-1950 slice 5) so the sessions-scroll-contract test drives
 * this exact production function rather than a copy.
 */
export function restoreContentScrollPosition(
  element: HTMLElement,
  scrollTop: number,
  onUnsatisfied?: () => void
): () => void {
  let frame: number | null = null;
  let attempts = 0;
  let cancelled = false;

  function applyScroll() {
    if (cancelled) {
      return;
    }
    attempts += 1;
    const maxScrollTop = computeMaxScrollTop(
      element.scrollHeight,
      element.clientHeight
    );
    element.scrollTop = clampScrollRestoreTarget(scrollTop, maxScrollTop);
    if (!(scrollTop > 0 && element.scrollTop <= 0)) {
      return;
    }
    if (
      attempts < MAX_CONTENT_SCROLL_RESTORE_ATTEMPTS &&
      typeof globalThis.requestAnimationFrame === "function"
    ) {
      frame = globalThis.requestAnimationFrame(applyScroll);
      return;
    }
    onUnsatisfied?.();
  }

  applyScroll();
  return () => {
    cancelled = true;
    if (
      frame !== null &&
      typeof globalThis.cancelAnimationFrame === "function"
    ) {
      globalThis.cancelAnimationFrame(frame);
    }
  };
}
