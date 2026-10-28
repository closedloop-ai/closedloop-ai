"use client";

import { useEffect } from "react";

/**
 * How long a deep link waits for its fragment target to render. Long enough
 * for a lazy panel chunk plus its first read on a slow connection; bounded so
 * an observer never outlives a link whose target does not exist.
 */
export const FRAGMENT_TARGET_WAIT_MS = 10_000;

/**
 * Scrolls a `#fragment` deep link into view once its element exists, and moves
 * focus there with it (ISS-10316).
 *
 * The browser's own fragment scroll cannot do this for Settings: it looks for
 * the element when the document loads, before the modal mounts, before the
 * lazy panel chunk loads, and before the card renders. So the shell watches
 * for the element instead of looking once.
 *
 * Mount-only on purpose: re-running would pull a user who has scrolled away
 * back to the anchor. Runs after the dialog's own open-focus, because a
 * parent's effect runs after its children's, so the focus move here wins.
 */
export function useSettingsFragmentScroll(): void {
  useEffect(() => {
    const targetId = readFragmentId(globalThis.location?.hash ?? "");
    if (targetId === null) {
      return;
    }
    if (revealFragmentTarget(targetId)) {
      return;
    }

    const observer = new MutationObserver(() => {
      if (revealFragmentTarget(targetId)) {
        stop();
      }
    });
    // At the deadline a read that is still loading no longer holds the reveal
    // back: a slow read elsewhere on the panel must not strand a target that
    // already rendered.
    const timeout = globalThis.setTimeout(() => {
      stop();
      revealFragmentTarget(targetId, { ignoreLoading: true });
    }, FRAGMENT_TARGET_WAIT_MS);
    function stop() {
      observer.disconnect();
      globalThis.clearTimeout(timeout);
    }
    observer.observe(globalThis.document.body, {
      childList: true,
      subtree: true,
    });
    return stop;
  }, []);
}

function readFragmentId(hash: string): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  // A fragment that starts with `/` is a route, not an element id: the desktop
  // renderer keeps its whole route in the hash, and Clerk's embedded profile
  // uses hash routing too.
  if (raw.length === 0 || raw.startsWith("/")) {
    return null;
  }
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

function revealFragmentTarget(
  targetId: string,
  { ignoreLoading = false }: { ignoreLoading?: boolean } = {}
): boolean {
  const target = globalThis.document.getElementById(targetId);
  if (target === null) {
    return false;
  }
  // While any read on the panel is still loading, content above the target
  // can still grow and push it down, so wait for the last skeleton to go.
  if (
    !ignoreLoading &&
    globalThis.document.querySelector(PANEL_LOADING_SELECTOR) !== null
  ) {
    return false;
  }
  target.scrollIntoView({ block: "start" });
  // Keyboard and screen-reader users follow the same link, so focus moves
  // with the viewport rather than only the pixels.
  target.focus({ preventScroll: true });
  return true;
}

/** The marker `SettingsPanelDataStateView` puts on its loading screen. */
const PANEL_LOADING_SELECTOR = '[data-settings-panel-data-state="loading"]';
