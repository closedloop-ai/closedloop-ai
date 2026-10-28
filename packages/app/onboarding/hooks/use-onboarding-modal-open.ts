"use client";

import type { GuidedOnboardingSnapshot } from "@repo/api/src/types/onboarding-guided";
import {
  isBlockingPhase,
  type OnboardingMachineState,
} from "@repo/api/src/types/onboarding-phase";
import { useLayoutEffect } from "react";

export function useOnboardingModalOpen(
  snapshot: GuidedOnboardingSnapshot | null,
  currentState: OnboardingMachineState | null,
  recoveredRevision: number | null,
  onOpenChange?: (open: boolean) => void
): boolean {
  const open =
    snapshot !== null &&
    currentState !== null &&
    recoveredRevision !== snapshot.revision &&
    isBlockingPhase(currentState.phase);
  // Reported on the edge rather than every render, and unmount reports `false`:
  // a consumer holding "the takeover is up" has no other way to learn that this
  // host went away, and a stuck `true` is the one direction that is unsafe — it
  // would hold a first-launch tour unspendable forever.
  //
  // LAYOUT-timed, not passive (ISS-10570 review). The consumer that needs this
  // is a shell SIBLING whose own arming runs in a passive effect, and passive
  // effects flush in tree order — so a passive publish here would be correct
  // only because this host happens to be rendered before the shell in
  // `Sidebar.tsx`, and moving it would silently hand that sibling a stale
  // `false` on the commit the takeover opens in. Every layout effect in a commit
  // runs before any passive effect in it, so this ordering is a property of the
  // phase rather than of the tree.
  useLayoutEffect(() => {
    onOpenChange?.(open);
    return () => onOpenChange?.(false);
  }, [onOpenChange, open]);
  return open;
}
