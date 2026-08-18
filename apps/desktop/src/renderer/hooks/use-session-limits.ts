import { SESSION_LIMIT_STALE_DISPLAY_AFTER_MS } from "@repo/app/session-limits/lib/freshness";
import {
  type SessionLimitsState,
  SessionLimitsStatus,
} from "@repo/app/session-limits/types";
import { useEffect, useState } from "react";

/**
 * Re-read the snapshot at half the display-freshness horizon, so a healthy app
 * always refreshes before its data could cross the line and a "not updating"
 * label therefore always means something genuinely stopped. Deriving it from the
 * shared constant keeps the two from drifting into a window where the UI is
 * permanently, spuriously stale.
 *
 * This is a store read over IPC, not a network call: the `/usage` producer
 * (PRD-538 R5) owns the fetch schedule in the main process, and nothing in the
 * renderer triggers a capture.
 */
const REFRESH_INTERVAL_MS = SESSION_LIMIT_STALE_DISPLAY_AFTER_MS / 2;

const LOADING: SessionLimitsState = { status: SessionLimitsStatus.Loading };
const UNAVAILABLE: SessionLimitsState = {
  status: SessionLimitsStatus.Unavailable,
};

/**
 * Reads the subscription session-limit snapshot from the desktop main process
 * (PRD-538) and refreshes it on an interval.
 *
 * Returns a four-state value rather than `SessionLimits | null` (PRD-538 R6):
 * the first render is LOADING, and only a resolved empty answer is UNAVAILABLE.
 * Collapsing the two into `null` is what made "still fetching" and "you have no
 * subscription" render identically, and it is the shape a fabricated 0% grows
 * out of.
 *
 * A missing bridge, a rejected call, and a null snapshot all resolve to
 * UNAVAILABLE — the UI then hides itself rather than inventing a figure. On a
 * default macOS install that is the expected outcome, not a failure: the capture
 * path never reads the Keychain (PRD-538 R5), so a Keychain-only Claude sign-in
 * legitimately has no snapshot to serve.
 *
 * The main-process snapshot is structurally identical to `SessionLimits`, so no
 * mapping is needed here.
 */
export function useSessionLimits(): SessionLimitsState {
  const [state, setState] = useState<SessionLimitsState>(LOADING);

  useEffect(() => {
    const getSessionLimits = window.desktopApi?.getSessionLimits;
    if (typeof getSessionLimits !== "function") {
      // No bridge at all is a resolved answer, not an eternal wait — otherwise
      // a non-Electron mount would spin a skeleton forever.
      setState(UNAVAILABLE);
      return;
    }

    let cancelled = false;
    // Non-async so calling it fires a self-contained promise chain (no floating
    // promise, no `void`): errors and successes both settle internally.
    const load = () => {
      getSessionLimits()
        .then((snapshot) => {
          if (cancelled) {
            return;
          }
          setState(
            snapshot
              ? { status: SessionLimitsStatus.Ready, limits: snapshot }
              : UNAVAILABLE
          );
        })
        .catch(() => {
          if (!cancelled) {
            setState(UNAVAILABLE);
          }
        });
    };

    load();
    const timer = setInterval(load, REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return state;
}
