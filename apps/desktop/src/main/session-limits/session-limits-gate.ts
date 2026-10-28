import { DESKTOP_SUBSCRIPTION_SESSION_LIMITS_FEATURE_FLAG_KEY } from "../../shared/feature-flags-labs-detail.js";
import {
  isDesktopMainFeatureFlagEnabled,
  subscribeToDesktopMainFeatureFlagAssignment,
} from "../auth/desktop-feature-flag-assignment.js";

/**
 * ISS-8792 — the `subscriptionSessionLimits` verdict, read ONCE for the main
 * process, on the same source the renderer reads.
 *
 * THE DEFECT THIS CLOSES. `sidebar-shared-items.tsx`'s `SessionLimitsFooter` resolves this
 * key from the signed-in account's PostHog assignment (the renderer's only flag
 * source since ISS-8753), while main resolved the SAME literal from the
 * persisted `settingsStore` setting. A stored opt-in therefore kept main
 * reading a credential and issuing `/usage` requests while the footer stayed
 * dark — capture running behind a surface the user cannot see.
 *
 * WHY IT NEEDS A RE-ATTEMPT AND NOT JUST A SWAP. `UsageApiService.start()`
 * returns without scheduling a timer while its gate reads closed ("Enabling it
 * takes effect on the next start() (app restart)"), and main's assignment
 * settles AFTER boot. A bare swap would therefore read CLOSED at capture
 * startup, schedule nothing, and never capture again for the life of the
 * process — trading the capability away rather than reconciling it. This
 * re-attempts when the verdict actually lands.
 *
 * OPENING NEEDS THE RE-ATTEMPT; CLOSING DOES NOT. `refreshNow()` re-reads the
 * gate on every attempt, so a verdict that closes mid-session makes the already
 * scheduled timer inert on its next tick with no teardown here. That is also
 * why `started` is not re-armed when the verdict closes: the timer that is
 * already running is self-correcting, and re-entering `start()` would only risk
 * a second one.
 *
 * THE SUBSCRIPTION IS LAZY because this gate is built from a class FIELD
 * INITIALISER, which runs before the constructor body wires `createDesktopApplicationServices` — the only caller
 * of `publishDesktopMainFeatureFlagAssignmentStore`. Subscribing eagerly binds
 * to a `null` store, takes the no-op unsubscribe, and is never notified.
 */
export type SessionLimitsProducers = {
  start: () => Promise<void>;
};

export type SessionLimitsGateDeps = {
  /** The producers, or `null` before they exist / after teardown. */
  getProducers: () => SessionLimitsProducers | null;
  isShuttingDown: () => boolean;
  logWarning: (message: string) => void;
};

export type SessionLimitsGate = {
  /** The verdict itself, handed to `SessionLimitsBoot` as its gate. */
  isUsageCaptureEnabled(): boolean;
  /** Start the producers if the verdict is open. Safe to call repeatedly. */
  reconcile(): Promise<void>;
  /** Drop the verdict subscription. */
  dispose(): void;
};

export function createSessionLimitsGate(
  deps: SessionLimitsGateDeps
): SessionLimitsGate {
  let unsubscribe: (() => void) | null = null;
  let disposed = false;
  let started = false;
  // One serial chain whose step re-reads the verdict: the settle listener can
  // fire while an earlier start is still awaiting, and a step acting on a
  // captured verdict would start twice.
  let chain: Promise<void> = Promise.resolve();

  const isUsageCaptureEnabled = (): boolean =>
    isDesktopMainFeatureFlagEnabled(
      DESKTOP_SUBSCRIPTION_SESSION_LIMITS_FEATURE_FLAG_KEY
    );

  const step = async (): Promise<void> => {
    if (deps.isShuttingDown() || started || !isUsageCaptureEnabled()) {
      return;
    }
    const producers = deps.getProducers();
    if (!producers) {
      return;
    }
    try {
      await producers.start();
      started = true;
    } catch (error) {
      deps.logWarning(
        `Failed to start session-limit producers: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  const reconcile = (): Promise<void> => {
    if (!(unsubscribe || disposed)) {
      unsubscribe = subscribeToDesktopMainFeatureFlagAssignment(() => {
        reconcile().catch(() => undefined);
      });
    }
    chain = chain.then(step);
    return chain;
  };

  return {
    isUsageCaptureEnabled,
    reconcile,
    dispose() {
      disposed = true;
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}
