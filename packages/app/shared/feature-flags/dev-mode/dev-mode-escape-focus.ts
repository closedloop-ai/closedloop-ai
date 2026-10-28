/**
 * Focus recovery for the dev-mode switch's moving home (ISS-9891, PR #6961).
 *
 * Toggling dev mode can unmount the very switch that was toggled: turning it
 * OFF suppresses the two nav-placement flags, so the Labs section — switch
 * included — leaves the tree, and turning it back ON from the fallback home
 * un-suppresses them, so the fallback leaves the tree the same way. Either way
 * a keyboard or screen-reader user is left focused on a removed node unless
 * someone hands focus on.
 *
 * The hand-off is attribute-addressed rather than ref-threaded because the two
 * ends of the transition live in different components: the switch inside Labs,
 * and the fallback switch the sidebar renders in its footer
 * (`apps/app/.../sidebar.tsx`). ISS-10195 retired the workspace-experience gate,
 * so there is no second tree and no account-menu trigger any more — the footer
 * fallback is the only durable target. Exactly one marked element is mounted at
 * a time, by the same `useLabsNavMoveVisible` predicate that decides the
 * switch's home.
 */

export const DEV_MODE_ESCAPE_TARGET_ATTRIBUTE = "data-dev-mode-escape-target";

/** Spread onto the durable control that should receive orphaned focus. */
export const DEV_MODE_ESCAPE_TARGET_PROPS = {
  [DEV_MODE_ESCAPE_TARGET_ATTRIBUTE]: "",
} as const;

/**
 * Call from the toggle handler, BEFORE React re-renders. The check runs in a
 * microtask: React flushes a discrete event's updates synchronously before
 * microtasks run, so by then the old home is unmounted and the new one is in
 * the DOM. Deliberately fire-and-forget — the caller is the component being
 * unmounted, so an effect cleanup could never run this late.
 *
 * Focus is only moved when the transition actually orphaned it (active element
 * gone, or fallen back to the body); focus that survived — the toggle that
 * unmounts nothing, or a viewer who had already moved on — is never stolen.
 */
export function focusDevModeEscapeTargetAfterTransition(): void {
  queueMicrotask(() => {
    const doc = globalThis.document;
    if (doc === undefined) {
      return;
    }
    const active = doc.activeElement;
    if (active !== null && active !== doc.body && active.isConnected) {
      return;
    }
    doc
      .querySelector<HTMLElement>(`[${DEV_MODE_ESCAPE_TARGET_ATTRIBUTE}]`)
      ?.focus();
  });
}
