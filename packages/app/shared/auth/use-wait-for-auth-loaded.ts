"use client";

import { useCallback, useEffect, useRef } from "react";
import { useAuthSnapshot } from "./use-auth-snapshot";

/**
 * Returns an async function that resolves once the shell's auth state has
 * hydrated (`AuthSnapshot.isLoaded`). Used by the API client so the first
 * requests after page load carry a real token instead of racing hydration.
 */
export function useWaitForAuthLoaded() {
  const { isLoaded } = useAuthSnapshot();
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
