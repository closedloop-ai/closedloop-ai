import { useEffect, useState } from "react";
import type { LoadingStallPhase } from "../lib/loading-stall-phase";

export type LoadingStallThresholds = {
  /** Elapsed ms before the load is considered slow (offer a retry). */
  softMs: number;
  /** Elapsed ms before the load is considered failed (actionable error). */
  hardMs: number;
};

/**
 * ISS-10645: the ONE budget every desktop listing escalates on. Sessions set
 * these numbers; Branches adopting a second pair would have made "zero cosmetic
 * divergence" a thing two files had to keep agreeing about.
 */
export const LIST_LOADING_STALL_THRESHOLDS: LoadingStallThresholds = {
  softMs: 10_000,
  hardMs: 30_000,
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
 * ISS-10645 moved this out of `apps/desktop/src/renderer/hooks/`. It was placed
 * there because the desktop Sessions list reads local SQLite over IPC on a
 * pure-push QueryClient (`staleTime: Infinity`, no query-level timeout), so a
 * wedged db-host read would otherwise sit in `isLoading` indefinitely with no
 * retry — an exposure web does not have, since it reads the cloud HTTP source
 * with the shared client's normal retry.
 *
 * What made the placement wrong was the ESCALATED states, not the detector: the
 * Branches stall offers an account or connect CTA, and a reader who has not
 * connected GitHub yet exists on web too. Without a phase, web reached the CTA
 * never — so the hook lives where both shells can import it. It carries no
 * Sessions and no desktop coupling, which it never did.
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
    // `globalThis`, not `window`: this module is server-capable shared code now
    // (ISS-10645 moved it out of the desktop renderer), and the timer functions
    // exist on both runtimes — so the effect needs no SSR guard, only a handle
    // type that does not assume the browser's numeric one.
    const softTimer = globalThis.setTimeout(() => setPhase("soft"), softMs);
    const hardTimer = globalThis.setTimeout(() => setPhase("hard"), hardMs);
    return () => {
      globalThis.clearTimeout(softTimer);
      globalThis.clearTimeout(hardTimer);
    };
  }, [active, softMs, hardMs, resetToken]);

  return phase;
}
