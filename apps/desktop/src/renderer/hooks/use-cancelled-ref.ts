import { useEffect, useRef } from "react";

/**
 * The house cancelled-guard for a loader that is NOT owned by a single effect.
 *
 * `use-session-limits.ts` is the canonical shape: a `let cancelled = false`
 * closed over by a loader declared inside the effect, flipped in that effect's
 * cleanup. That form cannot be used when the same loader is also reachable from
 * a button, a subscription callback, or a second effect — a per-effect-run flag
 * would cancel a user-initiated read that the effect never started, and one
 * effect's re-run would cancel a sibling effect's in-flight read.
 *
 * This is the same guard held for the component's lifetime instead: read
 * `.current` AFTER every await, before committing. `false` is re-armed on mount
 * so a StrictMode remount (dev double-invoke) does not leave the component
 * permanently cancelled.
 *
 * It says "this component is gone", nothing more. A latch that must be released
 * whether or not the read was cancelled (a re-entrancy guard, say) is not this
 * hook's job and must be released unconditionally.
 */
export function useCancelledRef(): { readonly current: boolean } {
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  return cancelledRef;
}
