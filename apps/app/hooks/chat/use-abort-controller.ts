"use client";

import { useCallback, useRef } from "react";

/**
 * Owns the AbortController ref used by streaming flows. Exposes a
 * `create` factory that installs a fresh controller (returning it so
 * callers can read `signal` directly), an `abort` callback that fires
 * on the current controller if any, and a `clear` callback to drop the
 * reference once the stream settles.
 */
export function useAbortController() {
  const ref = useRef<AbortController | null>(null);

  const create = useCallback(() => {
    const controller = new AbortController();
    ref.current = controller;
    return controller;
  }, []);

  const abort = useCallback(() => {
    ref.current?.abort();
  }, []);

  const clear = useCallback(() => {
    ref.current = null;
  }, []);

  return { create, abort, clear };
}
