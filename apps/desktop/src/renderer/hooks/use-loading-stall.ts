import { useEffect, useState } from "react";

/**
 * How long a blocking (no-data-yet) load may run before the UI escalates. A
 * `soft` phase is reached first — the loading affordance stays but gains a
 * retry — and a `hard` phase after that, where the surface should show an
 * actionable "temporarily unavailable" error rather than an endless spinner.
 */
export type LoadingStallPhase = "none" | "soft" | "hard";

export type LoadingStallThresholds = {
  /** Elapsed ms before the load is considered slow (offer a retry). */
  softMs: number;
  /** Elapsed ms before the load is considered failed (actionable error). */
  hardMs: number;
};

/**
 * FEA-3639 — bound a blocking load so it can never spin forever. While `active`
 * (the surface is showing a skeleton/spinner with no data to fall back on), this
 * advances `none → soft → hard` as `softMs`/`hardMs` elapse. It resets to `none`
 * the moment `active` goes false — a load that resolves (to rows OR to a real
 * error) clears the escalation — and clears its timers on unmount, so a canceled
 * load never escalates a later, unrelated one.
 *
 * `resetToken` restarts the budget on demand: bump it (e.g. from a Retry
 * handler) to reset `none` and re-arm the timers even while `active` stays true.
 * Without it, a wedged read keeps `active` continuously true — the effect never
 * re-runs — so the phase would latch at `hard` and Retry could never return the
 * surface to a spinner. Any change to the value re-arms; the value itself is
 * never read, only its identity.
 *
 * Desktop-only by placement: the Sessions list reads local SQLite over IPC on a
 * pure-push QueryClient (`staleTime: Infinity`, no query-level timeout), so a
 * wedged db-host read would otherwise sit in `isLoading` indefinitely with no
 * retry. Web reads the cloud HTTP source with the shared client's normal retry,
 * so it does not need this. Kept generic (no Sessions coupling) so other desktop
 * list surfaces with the same no-timeout exposure can adopt it.
 */
export function useLoadingStall(
  active: boolean,
  { softMs, hardMs }: LoadingStallThresholds,
  resetToken?: number
): LoadingStallPhase {
  const [phase, setPhase] = useState<LoadingStallPhase>("none");

  // biome-ignore lint/correctness/useExhaustiveDependencies: resetToken is an intentional restart trigger (a Retry bumps it), not a value read inside the effect.
  useEffect(() => {
    if (!active) {
      // A resolved (or never-started) load carries no stall. Reset here rather
      // than only on the timers so a fast load between two slow ones starts
      // clean.
      setPhase("none");
      return;
    }
    setPhase("none");
    const softTimer = window.setTimeout(() => setPhase("soft"), softMs);
    const hardTimer = window.setTimeout(() => setPhase("hard"), hardMs);
    return () => {
      window.clearTimeout(softTimer);
      window.clearTimeout(hardTimer);
    };
  }, [active, softMs, hardMs, resetToken]);

  return phase;
}
