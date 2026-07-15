"use client";

import { cn } from "@repo/design-system/lib/utils";
import {
  type CSSProperties,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

/** Anchor rect (viewport coords) the tooltip positions itself against. */
export type BranchTipAnchor = {
  top: number;
  bottom: number;
  left: number;
  width: number;
};

const VIEWPORT_PADDING = 12;
const ANCHOR_GAP = 8;

/** Snapshot an element's viewport rect as a tip anchor (for hover handlers). */
export function tipAnchorFromElement(element: HTMLElement): BranchTipAnchor {
  const rect = element.getBoundingClientRect();
  return {
    top: rect.top,
    bottom: rect.bottom,
    left: rect.left,
    width: rect.width,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Renders a `.bq-tip` card into `document.body` with fixed positioning so it
 * escapes the sticky timeline's stacking context AND the page scroll
 * container's `overflow` clipping. Inline (absolutely-positioned) tooltips were
 * covered by the sticky tab-toggle row and, near the top of the page, cut off
 * by the scroller — this lifts them out of both. Opens above the anchor when
 * there is room, flips below otherwise; centered on the anchor and clamped to
 * the viewport.
 */
export function BranchTipPortal({
  anchor,
  className,
  children,
}: {
  anchor: BranchTipAnchor;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  // Start hidden at a rough position; measure on layout to center + flip.
  const [style, setStyle] = useState<CSSProperties>(() => ({
    left: anchor.left,
    position: "fixed",
    top: anchor.bottom + ANCHOR_GAP,
    visibility: "hidden",
  }));
  // No scroll-dismiss: the only anchors (timeline bars + event-dot rail) live in
  // the sticky `.bq-timeline-sticky` header, which stays pinned during scroll, so
  // the captured anchor rect stays valid and the tooltip never detaches.

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) {
      return;
    }
    const { width, height } = node.getBoundingClientRect();
    const viewportWidth = globalThis.innerWidth;
    const viewportHeight = globalThis.innerHeight;
    const maxLeft = Math.max(
      VIEWPORT_PADDING,
      viewportWidth - width - VIEWPORT_PADDING
    );
    const left = clamp(
      anchor.left + anchor.width / 2 - width / 2,
      VIEWPORT_PADDING,
      maxLeft
    );
    const topAbove = anchor.top - height - ANCHOR_GAP;
    const topBelow = anchor.bottom + ANCHOR_GAP;
    const maxTop = Math.max(
      VIEWPORT_PADDING,
      viewportHeight - height - VIEWPORT_PADDING
    );
    setStyle({
      left,
      maxHeight: `calc(100vh - ${VIEWPORT_PADDING * 2}px)`,
      position: "fixed",
      top: clamp(
        topAbove >= VIEWPORT_PADDING ? topAbove : topBelow,
        VIEWPORT_PADDING,
        maxTop
      ),
      visibility: "visible",
    });
  }, [anchor]);

  if (globalThis.document === undefined) {
    return null;
  }

  return createPortal(
    <div
      className={cn("bq-tip bq-tip-fixed", className)}
      ref={ref}
      style={style}
    >
      {children}
    </div>,
    globalThis.document.body
  );
}
