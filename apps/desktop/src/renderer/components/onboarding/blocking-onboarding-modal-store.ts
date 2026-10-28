import { useSyncExternalStore } from "react";

/**
 * ISS-10570 — whether the guided-onboarding takeover is on screen right now.
 *
 * A MODULE STORE rather than a context, because the two parties are in
 * different component trees: `DesktopGuidedOnboardingDialogHost` mounts as a
 * sibling of the shell in `Sidebar.tsx`, and the dashboard that needs the answer
 * is inside `SidebarInset`. Their only common ancestor is the app root, so a
 * context would have to be provided above both and written from below — which is
 * this store with extra indirection. PR #7513 named the same gap: the guest run
 * is `useState` plus localStorage local to the host, "with no event or context
 * spanning the two component trees".
 *
 * Reported BY the host from the one `open` its dialog is given, so this is a
 * relay and never a second definition of "is the takeover up?".
 */
let blockingOnboardingModalOpen = false;
const listeners = new Set<() => void>();

export function setBlockingOnboardingModalOpen(open: boolean): void {
  if (blockingOnboardingModalOpen === open) {
    return;
  }
  blockingOnboardingModalOpen = open;
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

/**
 * The store's value RIGHT NOW, for a caller that cannot use the hook's
 * render-time snapshot.
 *
 * ISS-10570 (review): `useBlockingOnboardingModalOpen` answers what was true
 * when the reading component rendered, and the two parties here are in
 * different component trees — so a commit in which the host's `open` flips
 * leaves any sibling that rendered in the same commit holding the previous
 * value until the store update schedules it a re-render. That is harmless for
 * anything that only paints, and not harmless for an IRREVERSIBLE write: see
 * `use-tour-arming.ts`, whose permanent first-launch latch has no second
 * chance. Such a write reads here instead, at the moment it runs.
 */
export function getBlockingOnboardingModalOpen(): boolean {
  return blockingOnboardingModalOpen;
}

/**
 * Server-rendering is not a case this renderer has, but `useSyncExternalStore`
 * requires the third argument in the shapes that can be pre-rendered, and
 * answering `false` is the honest one: nothing is on screen yet.
 */
export function useBlockingOnboardingModalOpen(): boolean {
  return useSyncExternalStore(
    subscribe,
    getBlockingOnboardingModalOpen,
    () => false
  );
}
