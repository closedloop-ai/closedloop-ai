"use client";

import { useCallback, useState } from "react";

/**
 * Copies text to the system clipboard and exposes a short-lived copied state.
 */
export function useCopyToClipboard(resetDelayMs = 2000) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(
    async (value: string | null | undefined) => {
      if (!value) {
        return;
      }
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), resetDelayMs);
    },
    [resetDelayMs]
  );

  return [copied, copy] as const;
}
