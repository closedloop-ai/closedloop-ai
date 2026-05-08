"use client";

import { useAuth } from "@repo/auth/client";
import { useCallback, useEffect, useRef } from "react";

export function useWaitForAuthLoaded() {
  const { isLoaded } = useAuth();
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
