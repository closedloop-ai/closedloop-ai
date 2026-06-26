"use client";

import { useCallback, useEffect, useRef } from "react";
import { useViewStatePersistence } from "./use-view-state-persistence";

const DEBOUNCE_MS = 300;

export function useScrollRestore(
  key: string | null,
  container: HTMLElement | null
) {
  const [savedPosition, setSavedPosition, clearPosition] =
    useViewStatePersistence<number>(key, 0);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restoredRef = useRef(false);
  const lastScrollTopRef = useRef(0);
  const frameRef = useRef<number | null>(null);

  const handleScroll = useCallback(() => {
    if (!container) {
      return;
    }
    lastScrollTopRef.current = container.scrollTop;
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(() => {
      setSavedPosition(lastScrollTopRef.current);
      timerRef.current = null;
    }, DEBOUNCE_MS);
  }, [container, setSavedPosition]);

  useEffect(() => {
    if (!container) {
      return;
    }
    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", handleScroll);
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        setSavedPosition(lastScrollTopRef.current);
      }
    };
  }, [container, handleScroll, setSavedPosition]);

  useEffect(() => {
    if (restoredRef.current || savedPosition === 0 || !container) {
      return;
    }
    let attempts = 0;
    const maxAttempts = 30;
    const target = container;

    function tryRestore() {
      if (restoredRef.current || attempts >= maxAttempts) {
        return;
      }
      attempts++;
      if (target.scrollHeight > target.clientHeight) {
        target.scrollTop = Math.min(
          savedPosition,
          target.scrollHeight - target.clientHeight
        );
        restoredRef.current = true;
      } else {
        frameRef.current = requestAnimationFrame(tryRestore);
      }
    }

    frameRef.current = requestAnimationFrame(tryRestore);
    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [container, savedPosition]);

  const clearScrollState = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    clearPosition();
  }, [clearPosition]);

  return { clearPosition: clearScrollState };
}
