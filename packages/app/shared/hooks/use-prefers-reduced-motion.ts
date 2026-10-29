"use client";

import { useMediaQuery } from "@repo/design-system/hooks/use-media-query";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Whether the OS is asking for reduced motion.
 *
 * A wrapper over `useMediaQuery` rather than its own `matchMedia` subscription:
 * a second implementation of the same subscription is the SSOT-drift-by-copy
 * this promotion exists to remove. Server snapshot is `false` (see
 * `useMediaQuery`), so SSR and the first client render agree.
 */
export function usePrefersReducedMotion(): boolean {
  return useMediaQuery(REDUCED_MOTION_QUERY);
}
