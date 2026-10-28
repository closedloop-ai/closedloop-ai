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
  /**
   * The container the saved position was last restored INTO, not a bare "have
   * we restored yet" flag.
   *
   * A host can swap the scroll container out and back while the hook stays
   * mounted — the Documents index unmounts it for its no-results state and
   * remounts it when the search is cleared (davetho review, cid 3955792554).
   * Against a boolean the replacement container arrived after the one allowed
   * restore had already been spent, so the reader's position was silently
   * dropped. Keyed on the element, each container gets restored into exactly
   * once, which is what "restore once" was always meant to say.
   *
   * DO NOT "fix" this by keeping the host's container mounted around its empty
   * state instead. That looks like the smaller change and it destroys the
   * position outright: when the rows unmount inside a still-mounted container,
   * `scrollHeight` collapses, the browser clamps `scrollTop` to 0 and fires a
   * `scroll` event, and {@link DEBOUNCE_MS} later this hook persists that 0 —
   * before the reader has even cleared the search. Unmounting the container is
   * the case that survives, because the effect cleanup saves the last real
   * position and no clamp event fires; re-arming per element is what makes it
   * come back.
   *
   * ISS-9726: the element is only half the identity. The KEY can change under a
   * container that never unmounts — an organization switch renames every
   * namespaced key, and the flag resolving moves a surface off its held `null`
   * onto the real one. Against the element alone the one allowed restore was
   * already spent by the previous key, so the new key's stored offset was never
   * applied and the reader was left wherever the old key had put them. Both
   * halves are tracked, so a restore is armed once per (container, key) pair.
   */
  const restoredForRef = useRef<HTMLElement | null>(null);
  const restoredKeyRef = useRef<string | null>(null);
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
    const target = container;
    const targetKey = key;
    function alreadyRestored() {
      return (
        restoredForRef.current === target &&
        restoredKeyRef.current === targetKey
      );
    }
    if (savedPosition === 0 || !target || alreadyRestored()) {
      return;
    }
    let attempts = 0;
    const maxAttempts = 30;

    function tryRestore() {
      if (!target || alreadyRestored() || attempts >= maxAttempts) {
        return;
      }
      attempts++;
      if (target.scrollHeight > target.clientHeight) {
        target.scrollTop = Math.min(
          savedPosition,
          target.scrollHeight - target.clientHeight
        );
        restoredForRef.current = target;
        restoredKeyRef.current = targetKey;
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
  }, [container, savedPosition, key]);

  const clearScrollState = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    clearPosition();
  }, [clearPosition]);

  return { clearPosition: clearScrollState };
}
