"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * A reconcile signals once per changed thread, so a burst of signals runs one
 * reload, plus one more after it when a signal arrived mid-reload: that reload
 * may have read before the signalled write committed.
 */
export function useCoalescedReload(reload: () => Promise<unknown>): () => void {
  const latest = useRef(reload);
  useEffect(() => {
    latest.current = reload;
  });
  const state = useRef({ inFlight: false, again: false });
  return useCallback(function run() {
    if (state.current.inFlight) {
      state.current.again = true;
      return;
    }
    state.current.inFlight = true;
    const settle = () => {
      state.current.inFlight = false;
      if (state.current.again) {
        state.current.again = false;
        run();
      }
    };
    latest.current().then(settle, settle);
  }, []);
}
