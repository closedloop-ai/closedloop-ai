"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Copies text to the system clipboard and exposes a short-lived
 * `copied` state suitable for icon-swap confirmation. Returns
 * `[copied, copy]` where `copy(value)` resolves to `true` on success
 * and `false` when the clipboard write rejects (permission denied,
 * insecure context, etc.) or `value` is falsy.
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
    async (value: string | null | undefined): Promise<boolean> => {
      if (!value) {
        return false;
      }
      try {
        await navigator.clipboard.writeText(value);
      } catch {
        return false;
      }
      setCopied(true);
      clearResetTimer();
      resetTimerRef.current = setTimeout(() => {
        setCopied(false);
        resetTimerRef.current = null;
      }, resetDelayMs);
      return true;
    },
    [clearResetTimer, resetDelayMs]
  );

  return [copied, copy] as const;
}
