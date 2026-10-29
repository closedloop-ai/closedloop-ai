"use client";

import { useCallback, useEffect, useRef } from "react";
import { useAuthSnapshot } from "./use-auth-snapshot";

/**
 * Returns an async function that resolves once the shell's auth state has
 * hydrated (`AuthSnapshot.isLoaded`). Used by the API client so the first
 * requests after page load carry a real token instead of racing hydration.
 */
export function useWaitForAuthLoaded() {
  return useWaitForLoaded(useAuthSnapshot().isLoaded);
}

/**
 * The wait itself, over an ALREADY-RESOLVED `isLoaded` (ISS-9450).
 *
 * Split out so `useApiClientOptional` can build the same wait from
 * `useOptionalAuthSnapshot`, which resolves to a stable signed-out-but-loaded
 * snapshot instead of throwing where no auth provider is mounted. One
 * implementation, so the two entry points cannot answer differently about when
 * a request may go out.
 */
export function useWaitForLoaded(isLoaded: boolean) {
  const pendingPromiseRef = useRef<Promise<void> | null>(null);
  const pendingResolveRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!isLoaded) {
      return;
    }

    pendingResolveRef.current?.();
    pendingResolveRef.current = null;
    pendingPromiseRef.current = null;
  }, [isLoaded]);

  useEffect(() => {
    return () => {
      pendingResolveRef.current?.();
      pendingResolveRef.current = null;
      pendingPromiseRef.current = null;
    };
  }, []);

  return useCallback(async () => {
    if (isLoaded) {
      return;
    }

    if (!pendingPromiseRef.current) {
      pendingPromiseRef.current = new Promise<void>((resolve) => {
        pendingResolveRef.current = resolve;
      });
    }

    await pendingPromiseRef.current;
  }, [isLoaded]);
}
