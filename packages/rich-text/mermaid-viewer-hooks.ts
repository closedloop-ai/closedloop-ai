/**
 * React hooks for the Mermaid viewer.
 *
 * These encapsulate the DOM-side effects (ResizeObserver, MutationObserver,
 * CTM-based coordinate reads, Fullscreen API) so `mermaid-viewer.tsx` can
 * stay focused on composition. Each hook is deliberately small and does one
 * thing so they can be tested and reused independently.
 */

import { type RefObject, useEffect, useRef, useState } from "react";
import {
  type ContentBBox,
  fitNodeLabels,
  type SvgDimensions,
} from "./mermaid-viewer-utils";

/**
 * Track the `clientWidth` / `clientHeight` of an element via ResizeObserver.
 * Returns state, so consumers can depend on the current size and re-render
 * when it changes (ref mutations are not reactive).
 */
export function useContainerSize(ref: RefObject<HTMLElement | null>): {
  width: number;
  height: number;
} {
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const target = ref.current;
    if (!target) {
      return;
    }
    const update = () =>
      setSize({ width: target.clientWidth, height: target.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(target);
    return () => observer.disconnect();
  }, [ref]);

  return size;
}

/**
 * Keep a ref synced with the browser's Fullscreen API state, and expose a
 * toggle. Wrapping the wrapper element (rather than the canvas itself) means
 * the fullscreen element owns its own background and overlay UI.
 *
 * Sync goes both ways: calling `toggle()` requests/exits fullscreen; and an
 * external change (Esc, OS-level exit) is picked up via `fullscreenchange`
 * and reflected back into the returned `isFullscreen` flag.
 */
export function useFullscreen(wrapperRef: RefObject<HTMLElement | null>): {
  isFullscreen: boolean;
  toggle: () => void;
} {
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    function onFullscreenChange() {
      setIsFullscreen(!!document.fullscreenElement);
    }
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () =>
      document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  function toggle() {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      wrapperRef.current?.requestFullscreen();
    }
  }

  return { isFullscreen, toggle };
}

/**
 * Observe the SVG inside `ref` for structural changes, and on every change:
 *   1. Run `fitNodeLabels` (shrink overflowing mermaid label fonts).
 *   2. Measure the SVG's natural (unscaled) render size.
 *   3. Measure the content bounding box in SVG user space.
 *
 * Uses a MutationObserver (rather than a one-shot effect) because mermaid
 * re-renders the SVG on theme mount, strict-mode double-invoke, and any time
 * the source changes. A single effect would miss those.
 *
 * Returns the latest measurements plus a `scaleRef` that consumers must keep
 * synced with the current CSS scale (so we can recover the unscaled size from
 * `getBoundingClientRect`).
 */
export function useSvgMeasurements(
  contentRef: RefObject<HTMLDivElement | null>,
  scaleRef: RefObject<number>
): {
  naturalSize: SvgDimensions | null;
  contentBBox: ContentBBox | null;
} {
  const [naturalSize, setNaturalSize] = useState<SvgDimensions | null>(null);
  const [contentBBox, setContentBBox] = useState<ContentBBox | null>(null);

  useEffect(() => {
    const target = contentRef.current;
    if (!target) {
      return;
    }
    const update = () => {
      fitNodeLabels(target);
      const svg = target.querySelector("svg");
      if (!(svg instanceof SVGSVGElement)) {
        return;
      }
      // Divide out the current CSS scale so we get unscaled dimensions.
      // Epsilon check prevents noisy re-renders from sub-pixel differences.
      const rect = svg.getBoundingClientRect();
      const currentScale = scaleRef.current || 1;
      const width = rect.width / currentScale;
      const height = rect.height / currentScale;
      if (width > 0 && height > 0) {
        setNaturalSize((prev) =>
          prev &&
          Math.abs(prev.width - width) < 0.5 &&
          Math.abs(prev.height - height) < 0.5
            ? prev
            : { width, height }
        );
      }
      try {
        const bbox = svg.getBBox();
        if (bbox.width > 0 && bbox.height > 0) {
          setContentBBox((prev) =>
            prev &&
            Math.abs(prev.x - bbox.x) < 0.5 &&
            Math.abs(prev.y - bbox.y) < 0.5 &&
            Math.abs(prev.width - bbox.width) < 0.5 &&
            Math.abs(prev.height - bbox.height) < 0.5
              ? prev
              : {
                  x: bbox.x,
                  y: bbox.y,
                  width: bbox.width,
                  height: bbox.height,
                }
          );
        }
      } catch {
        // getBBox throws for detached/hidden SVGs. Retry on next mutation.
      }
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(target, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [contentRef, scaleRef]);

  return { naturalSize, contentBBox };
}

/**
 * Compute the portion of the SVG currently visible in a container as an SVG-
 * user-space rectangle, using the browser's own transformation matrix
 * (`getScreenCTM`). Returns `null` until the SVG is present and has a
 * usable CTM.
 *
 * Using `getScreenCTM().inverse()` means we don't have to reconstruct the
 * math from the CSS `transform` + viewBox ourselves; this automatically
 * picks up any internal `<g>` transforms mermaid adds, viewBox offsets, and
 * ancestor transforms.
 *
 * `deps` exists because the effect reads live DOM state (not props/state
 * directly) — consumers must pass whatever values should trigger a
 * re-measurement (typically the current pan/zoom transform + container size).
 */
export function useVisibleRegion({
  containerRef,
  contentRef,
  trigger,
}: {
  containerRef: RefObject<HTMLElement | null>;
  contentRef: RefObject<HTMLElement | null>;
  /**
   * An arbitrary value whose change indicates the DOM may have moved — e.g.
   * `{transform, containerSize, naturalSize}`. Identity change re-runs the
   * measurement. Pass an object / memoized tuple to avoid false re-runs.
   */
  trigger: unknown;
}): ContentBBox | null {
  const [region, setRegion] = useState<ContentBBox | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `trigger` is a change sentinel; actual values are read from DOM
  useEffect(() => {
    const container = containerRef.current;
    const content = contentRef.current;
    if (!(container && content)) {
      return;
    }
    const svg = content.querySelector("svg");
    if (!(svg instanceof SVGSVGElement)) {
      return;
    }
    const ctm = svg.getScreenCTM();
    if (!ctm) {
      return;
    }
    const inverse = ctm.inverse();
    const containerRect = container.getBoundingClientRect();
    // Transform the container's top-left and bottom-right corners from screen
    // pixels into SVG user space.
    const tl = new DOMPoint(
      containerRect.left,
      containerRect.top
    ).matrixTransform(inverse);
    const br = new DOMPoint(
      containerRect.right,
      containerRect.bottom
    ).matrixTransform(inverse);
    setRegion({
      x: tl.x,
      y: tl.y,
      width: br.x - tl.x,
      height: br.y - tl.y,
    });
  }, [trigger]);

  return region;
}

/**
 * A latest-value ref for any reactive value. Equivalent to a small idiom
 * repeated across this module — extracted for clarity.
 */
export function useLatestRef<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
