// ISS-5258: the collapsed/expanded preference for the first-launch import
// splash.
//
// Storage goes through the shared renderer-preference seam
// (`shared/renderer-preference-storage.ts`, extracted from the sidebar's own
// helpers) rather than a second hand-rolled try/catch or main-process config:
// this is a renderer-only view preference with no main-process consumer, and
// storage being unavailable must degrade to the default rather than break the
// splash.
//
// Default is EXPANDED, and the key is written ONLY by an explicit user toggle —
// collapse writes `true`, expand writes `false`, and nothing else writes at all.
// So a brand-new user, who by construction has no stored value, always sees the
// import start, and a user who deliberately re-expands has that choice persisted
// rather than silently reverting on the next launch. A missing, corrupt, or
// unreadable value resolves to expanded for the same reason.

import {
  type RefObject,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  readRendererBooleanPreference,
  writeRendererBooleanPreference,
} from "../../shared/renderer-preference-storage";

const IMPORT_SPLASH_COLLAPSED_STORAGE_KEY =
  "closedloop.desktop.import-splash.collapsed";
// Marks whichever disclosure control is currently rendered — the compact row's
// "Show import details" or the expanded header's "Hide import details". The two
// forms swap rather than nest, so the button the user just pressed unmounts on
// its own activation; without moving focus to its counterpart a keyboard user
// is dropped onto `<body>` and has to tab from the top of the app.
const TOGGLE_SELECTOR = "[data-import-splash-toggle]";

/**
 * Read the persisted preference. Anything other than the exact collapsed
 * sentinel — missing, corrupt, storage disabled — resolves to expanded.
 */
export function readImportSplashCollapsed(): boolean {
  return readRendererBooleanPreference(
    IMPORT_SPLASH_COLLAPSED_STORAGE_KEY,
    false
  );
}

/**
 * Persist the preference. Callers update React state first, so a write failure
 * (storage disabled, quota denied) still collapses the splash for this session.
 */
export function writeImportSplashCollapsed(collapsed: boolean): void {
  writeRendererBooleanPreference(
    IMPORT_SPLASH_COLLAPSED_STORAGE_KEY,
    collapsed
  );
}

export type ImportSplashCollapse = {
  collapsed: boolean;
  collapse: () => void;
  expand: () => void;
  /**
   * Attach to the element that contains whichever disclosure control is
   * rendered. After a user-driven toggle the hook moves focus to the
   * counterpart control found inside it, so the disclosure behaves like one
   * control even though the two forms swap.
   */
  surfaceRef: RefObject<HTMLElement | null>;
};

/**
 * The splash's collapsed/expanded state, persisted across navigation and
 * relaunch.
 *
 * ISS-6118 retired the ISS-5258 `collapsible-import-splash` Labs flag enabled,
 * so the disclosure is unconditional and this no longer takes an `enabled`
 * gate.
 *
 * The two handlers are owned here rather than at the call site so the splash
 * component stays a lifecycle orchestrator and does not grow another pair of
 * inline closures.
 */
export function useImportSplashCollapsed(): ImportSplashCollapse {
  const [collapsed, setCollapsed] = useState(readImportSplashCollapsed);
  const surfaceRef = useRef<HTMLElement | null>(null);
  // Only a USER toggle moves focus. A mount that comes up collapsed because of
  // a stored preference must not yank focus out of whatever the user was doing.
  const restoreFocus = useRef(false);
  const update = useCallback(
    (next: boolean) => {
      if (next === collapsed) {
        // A no-op toggle must not arm the focus restore: React would bail out
        // of the state update, the effect would never run, and the ref would
        // stay set to steal focus on some later, unrelated flip.
        return;
      }
      restoreFocus.current = true;
      setCollapsed(next);
      writeImportSplashCollapsed(next);
    },
    [collapsed]
  );
  // The pressed control unmounts at commit, so move focus BEFORE paint —
  // `useEffect` would leave focus on `<body>` for a frame and let the document
  // be announced.
  // `collapsed` is the TRIGGER, not a read value: the swapped-in counterpart
  // only exists after the flip renders. The rule cannot see a dependency the
  // body does not dereference.
  // biome-ignore lint/correctness/useExhaustiveDependencies: trigger-only dep
  useLayoutEffect(() => {
    if (!restoreFocus.current) {
      return;
    }
    restoreFocus.current = false;
    surfaceRef.current?.querySelector<HTMLElement>(TOGGLE_SELECTOR)?.focus();
  }, [collapsed]);
  const collapse = useCallback(() => update(true), [update]);
  const expand = useCallback(() => update(false), [update]);
  return { collapsed, collapse, expand, surfaceRef };
}
