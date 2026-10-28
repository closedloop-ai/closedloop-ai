import type { GuidedOnboardingRun } from "@repo/app/onboarding/lib/guided-onboarding-run";
import { useSyncExternalStore } from "react";

/**
 * ISS-11251 — whether a RUN OVERRIDE owns the guided-onboarding mount right now.
 *
 * `GuidedOnboardingDialogHost` renders the run it is HANDED and disables its own
 * server read when one is supplied, while `GuidedGettingStartedCard` always
 * reads and posts the SERVER run. So while an override is in play the two are
 * describing different runs: the card counts the server's steps and its press
 * posts a server transition the modal is not watching — an enabled control that
 * does nothing, which is exactly the inert "Invite teammates" the operator hit.
 *
 * A MODULE STORE for the same reason {@link
 * ./blocking-onboarding-modal-store.ts} is one: the two parties sit in different
 * component trees. `DesktopGuidedOnboardingDialogHost` mounts as a sibling of the
 * shell in `Sidebar.tsx` and the card is inside the sidebar, so their only common
 * ancestor is the app root.
 *
 * Relays the run ITSELF rather than a flag, so the card reads and posts through
 * the same source the modal does instead of merely knowing it must not offer
 * anything. Reported BY the host from the one `run` it was given, so this is a
 * relay and never a second answer to "whose run is on screen?".
 */
let guidedOnboardingRunOverride: GuidedOnboardingRun | undefined;
const listeners = new Set<() => void>();

/**
 * Whether two runs describe the same thing, BY FIELD rather than by reference.
 *
 * Neither run source memoizes its return, so a host republishes a structurally
 * identical object on every render. Compared by reference that is a change on
 * every progress tick, and each one notified every subscriber and — through the
 * publish/clear pair — flipped the card's `run === undefined` gate on the way. A
 * run IS its snapshot, its loading state and its poster; nothing else about the
 * object is observable.
 */
function isSameRun(
  left: GuidedOnboardingRun | undefined,
  right: GuidedOnboardingRun | undefined
): boolean {
  if (left === right) {
    return true;
  }
  if (!(left && right)) {
    return false;
  }
  return (
    left.snapshot === right.snapshot &&
    left.isLoading === right.isLoading &&
    left.postTransition === right.postTransition
  );
}

export function setGuidedOnboardingRunOverride(
  run: GuidedOnboardingRun | undefined
): void {
  if (isSameRun(guidedOnboardingRunOverride, run)) {
    return;
  }
  guidedOnboardingRunOverride = run;
  for (const listener of listeners) {
    listener();
  }
}

/**
 * Clear the override ONLY if `run` is still the published one.
 *
 * Across commits React runs an arriving host's effect before a departing one's
 * cleanup, so an unconditional clear lets a departing host blank the store while
 * a live host is still rendering its run. Matched by field for the same reason
 * {@link setGuidedOnboardingRunOverride} is.
 */
export function clearGuidedOnboardingRunOverride(
  run: GuidedOnboardingRun | undefined
): void {
  if (!isSameRun(guidedOnboardingRunOverride, run)) {
    return;
  }
  guidedOnboardingRunOverride = undefined;
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getGuidedOnboardingRunOverride():
  | GuidedOnboardingRun
  | undefined {
  return guidedOnboardingRunOverride;
}

/**
 * `undefined` for the pre-render shape `useSyncExternalStore` requires: no host
 * has reported a run yet, and the server run is the default every reader takes.
 */
export function useGuidedOnboardingRunOverride():
  | GuidedOnboardingRun
  | undefined {
  return useSyncExternalStore(
    subscribe,
    getGuidedOnboardingRunOverride,
    () => undefined
  );
}
