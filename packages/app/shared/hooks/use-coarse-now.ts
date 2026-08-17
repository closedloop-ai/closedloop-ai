"use client";

import { useEffect, useState } from "react";

/**
 * The current time, refreshed every `intervalMs`, for derivations that depend on
 * the clock as well as on their inputs.
 *
 * The problem it solves: a `useMemo` keyed on `[items, …]` never re-runs while
 * its inputs are referentially stable, so a derivation that reads `new Date()`
 * internally is frozen at whatever the clock said on the last real input change.
 * TanStack Query's structural sharing preserves item identity across refetches
 * that return the same page, so during an idle window — exactly when a session is
 * going quiet and about to cross a staleness threshold — the inputs can stay
 * stable indefinitely.
 *
 * Returning the time rather than a bare tick counter is deliberate: the consumer
 * passes this value INTO its derivation, which keeps that derivation a pure
 * function of its arguments (testable with a fixed clock, and honest to
 * `useExhaustiveDependencies` — a tick that only exists to invalidate a memo is
 * an unused dependency by every static reading of the code).
 *
 * `enabled: false` runs NO timer and returns one stable instant for the lifetime
 * of the component, so a dark-launched caller costs nothing and never re-renders
 * on this account until its flag is on.
 *
 * The interval is cleared on unmount and re-created whenever `intervalMs` or
 * `enabled` changes, so a superseded timer can never keep firing.
 */
export function useCoarseNow(intervalMs: number, enabled = true): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    if (!(enabled && Number.isFinite(intervalMs) && intervalMs > 0)) {
      return;
    }
    const timer = setInterval(() => {
      setNow(new Date());
    }, intervalMs);
    return () => {
      clearInterval(timer);
    };
  }, [intervalMs, enabled]);

  return now;
}
