"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Copies text to the system clipboard and exposes a short-lived copied state.
 */
export function useCopyToClipboard(resetDelayMs = 2000) {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearResetTimer = useCallback(() => {
    if (resetTimerRef.current === null) {
      return;
    }
    clearTimeout(resetTimerRef.current);
    resetTimerRef.current = null;
  }, []);

  useEffect(() => clearResetTimer, [clearResetTimer]);

  const copy = useCallback(
    async (value: string | null | undefined) => {
      if (!value) {
        return;
      }
      await navigator.clipboard.writeText(value);
      setCopied(true);
      clearResetTimer();
      resetTimerRef.current = setTimeout(() => {
        setCopied(false);
        resetTimerRef.current = null;
      }, resetDelayMs);
    },
    [clearResetTimer, resetDelayMs]
  );

  return [copied, copy] as const;
}
