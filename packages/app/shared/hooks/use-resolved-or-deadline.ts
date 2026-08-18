"use client";

import { useEffect, useState } from "react";

/**
 * Whether an asynchronously-resolving input is safe to ACT on yet: true once it
 * has resolved, or once `deadlineMs` has elapsed waiting for it.
 *
 * For a surface whose DATA REQUEST depends on a value that arrives after mount —
 * a PostHog flag, a persisted view, anything gated on auth hydration. Gate the
 * query's `enabled` on the result and the surface issues ONE request, with the
 * right params, instead of one against the default and another once the real
 * value lands.
 *
 * The deadline is the load-bearing half. A gate that waits forever is not a
 * safety net, it is a new way for the screen to never load: if the upstream
 * service never initializes, `resolved` stays false indefinitely and an unbounded
 * wait leaves a signed-in user staring at a skeleton. Past the deadline the
 * caller proceeds on its default — the pre-gate behavior — so an outage degrades
 * to "one extra fetch", never to "no screen".
 *
 * The latch tracks the CURRENT wait, not any past one: it resets when `resolved`
 * flips back to false, so a value that resolves, then goes unresolved again (an
 * account switch, a re-initializing provider, a flag re-resolving) re-closes the
 * gate instead of staying permanently open on a deadline that expired during an
 * earlier, unrelated stall.
 *
 * Callers keep their own deadline constant — the durations answer to different
 * services and should be tunable apart — and share only this mechanism.
 */
export function useResolvedOrDeadline(
  resolved: boolean,
  deadlineMs: number
): boolean {
  const [deadlinePassed, setDeadlinePassed] = useState(false);

  useEffect(() => {
    if (resolved) {
      // Not merely "stop waiting": clearing the latch is what lets a later
      // unresolved period re-close the gate. `false` when already `false` is a
      // no-op React bails out of, so this cannot loop.
      setDeadlinePassed(false);
      return;
    }
    const timer = setTimeout(() => setDeadlinePassed(true), deadlineMs);
    return () => clearTimeout(timer);
  }, [resolved, deadlineMs]);

  return resolved || deadlinePassed;
}
