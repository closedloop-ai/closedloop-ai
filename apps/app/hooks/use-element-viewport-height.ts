"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type UseElementViewportHeightOptions = {
  /** Minimum height floor in pixels. */
  minHeight?: number;
  /** Distance from the viewport bottom to leave free in pixels. */
  bottomGap?: number;
};

/**
 * Tracks the height from an element's top to the viewport bottom, re-measuring
 * on window resize and element size changes. Returns `[height, setRef]` where
 * `setRef` is a React callback ref to attach to the element.
 */
export function useElementViewportHeight({
  bottomGap = 0,
  minHeight = 0,
}: UseElementViewportHeightOptions = {}) {
  const elementRef = useRef<HTMLElement | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const [height, setHeight] = useState<number | null>(null);

  const update = useCallback(() => {
    const el = elementRef.current;
    if (!el) {
      return;
    }
    const top = el.getBoundingClientRect().top;
    setHeight(
      Math.max(minHeight, Math.floor(globalThis.innerHeight - top - bottomGap))
    );
  }, [bottomGap, minHeight]);

  const setRef = useCallback(
    (node: HTMLElement | null) => {
      const prev = elementRef.current;
      elementRef.current = node;
      const observer = observerRef.current;
      if (observer) {
        if (prev) {
          observer.unobserve(prev);
        }
        if (node) {
          observer.observe(node);
        }
      }
      if (node) {
        update();
      }
    },
    [update]
  );

  useEffect(() => {
    const onResize = () => update();
    globalThis.addEventListener("resize", onResize);
    observerRef.current = new ResizeObserver(update);
    if (elementRef.current) {
      observerRef.current.observe(elementRef.current);
    }
    return () => {
      globalThis.removeEventListener("resize", onResize);
      observerRef.current?.disconnect();
      observerRef.current = null;
    };
  }, [update]);

  return [height, setRef] as const;
}
