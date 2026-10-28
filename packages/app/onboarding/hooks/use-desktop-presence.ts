"use client";

import { COMPUTE_TARGETS_QUERY_OPTIONS } from "../../compute/hooks/compute-target-query-options";
import { useComputeTargets } from "../../compute/hooks/use-compute-targets";

/**
 * Whether one of this reader's own Desktop apps is reporting online.
 *
 * A HINT, NOT A FACT, and every consumer owes that distinction. The online
 * heartbeat is the only desktop-presence signal a browser has, and it answers
 * neither of the two questions a handoff actually depends on: it cannot tell
 * THIS machine from another machine of the same reader's, and it cannot say
 * whether the build behind it ever registered the `closedloop://` protocol —
 * one predating ISS-6109 heartbeats without having registered anything, and
 * navigating an unregistered scheme is a silent no-op in every browser
 * (`packages/api/src/types/desktop-deep-link.ts`).
 *
 * So a `true` here may only ever ADD an option. A caller that lets it withdraw
 * one — swapping out an installer, hiding a forward control — turns either
 * false positive into a dead end, which is the defect this hook's own callers
 * were reviewed for (ISS-11330).
 *
 * WEB ONLY. `enabled` is the caller's, because the read costs a request and the
 * only surface that can act on the answer is the browser: the Electron renderer
 * is already the app this would hand off to.
 */
export function useDesktopAppRunning(enabled: boolean): boolean {
  const { data: computeTargets } = useComputeTargets({
    ...COMPUTE_TARGETS_QUERY_OPTIONS,
    enabled,
  });

  // `ownerName` absent is what marks a target as this reader's own rather than
  // a teammate's.
  return (
    enabled &&
    (computeTargets?.some((target) => !target.ownerName && target.isOnline) ??
      false)
  );
}
