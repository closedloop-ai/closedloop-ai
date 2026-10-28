/**
 * @file ISS-10950 — the boot gate that holds local session parsing until the
 * reader has agreed to it.
 *
 * The Welcome modal promises that analysis has not started ("Start Analyzing My
 * Sessions"), so the boot import may not be underway while it is on screen — a
 * renderer-side hide would only stop the reader seeing work that was already
 * happening.
 *
 * ISS-10890 moved the sync-policy step behind the organization step, and the
 * operator ruled (2026-09-24) that pressing Welcome's Start is this device's
 * agreement to local analysis; that superseded ISS-10950's "until the sync step
 * Continue" clause. So the answer is either that recorded agreement or a
 * persisted sync-observability tier, read here through
 * {@link hasAgreedToSessionAnalysis}. Both are deliberately NOT org-scoped the
 * way `hasRecordedSyncConsent` is: that predicate governs EGRESS, which an org
 * switch may legitimately re-ask and which this gate leaves untouched, while
 * this one governs whether this device ever agreed to read its own disk.
 *
 * `applySyncConsent` clears the tier before rewriting it when a sign-in rebinds
 * to a different org, so the tier this predicate reads IS null for that write
 * window. The latch is already released by then, and the Start agreement is
 * never cleared, so a crash inside the window re-asks only for egress on a
 * device that recorded one; a device that answered only the sync step before
 * this agreement existed is re-asked for local reading as well.
 */

import {
  hasAnsweredSyncConsent,
  type SyncConsentRecord,
} from "../../shared/sync-consent.js";

/** Sources the gate's verdict and the wake-up that releases it. */
export type SessionAnalysisConsentGateDeps = {
  /**
   * Whether this device has agreed to have its sessions analysed. Read on every
   * check rather than snapshotted, so the settings store stays the one place the
   * answer lives.
   */
  hasAgreedToSessionAnalysis: () => boolean;
};

/** The settings reads {@link hasAgreedToSessionAnalysis} takes. */
export type SessionAnalysisConsentReads = {
  getSessionAnalysisAgreed: () => boolean;
  getSyncConsentRecord: () => SyncConsentRecord;
  hasSyncObservabilityTierBeenSet: () => boolean;
};

/**
 * Whether local session analysis may begin on this device.
 *
 * The recorded Welcome Start agreement (ISS-10890) is the answer a fresh
 * install gives, since it reaches Session discovery before any sync step.
 *
 * The two tier clauses stay, because the tier's VALUE and its PRESENCE answer
 * different questions and only both together separate a first launch from an
 * upgrade.
 *
 * A recorded tier is the answer itself — every level the step offers derives a
 * non-null one, `off` included, so choosing to upload nothing is still consent
 * to read the disk.
 *
 * An ABSENT key is an install that predates ISS-10554's first-launch seed. That
 * seed writes the key on every new profile as an explicit `null`, so absence
 * cannot be a device sitting in the onboarding window — it is one that has been
 * running, and importing, since before this gate existed. Nothing is going to
 * ask it: the wizard is behind it and the post-auth takeover only fires when
 * signed in. Gating it would stop an import the reader already had, which is the
 * Compatibility Guardrail case, so it is grandfathered. This is the one clause
 * that fails OPEN, and it is bounded: a profile that ever reaches the seed can
 * never take it.
 */
export function hasAgreedToSessionAnalysis(
  reads: SessionAnalysisConsentReads
): boolean {
  return (
    reads.getSessionAnalysisAgreed() ||
    hasAnsweredSyncConsent(reads.getSyncConsentRecord()) ||
    !reads.hasSyncObservabilityTierBeenSet()
  );
}

/**
 * A latch, not a subscription: consent is answered once and never withdrawn
 * here, so a released gate stays released for the life of the process even if a
 * later write moves the tier.
 */
export class SessionAnalysisConsentGate {
  private readonly deps: SessionAnalysisConsentGateDeps;
  private released = false;
  private disposed = false;
  private waiters: Array<(granted: boolean) => void> = [];

  constructor(deps: SessionAnalysisConsentGateDeps) {
    this.deps = deps;
  }

  /**
   * Resolves `true` once the reader has agreed, immediately when they already
   * had, and `false` when {@link dispose} unwound the wait instead.
   *
   * The boolean is the gate's own answer rather than the caller's: a dispose
   * releases every waiter, so a resumer that only consulted a second source
   * about shutdown would start the import the gate exists to hold the moment
   * those two sources disagreed (marisolashgrove review, ISS-10950).
   */
  whenGranted(): Promise<boolean> {
    if (this.disposed) {
      return Promise.resolve(false);
    }
    if (this.released || this.deps.hasAgreedToSessionAnalysis()) {
      this.released = true;
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /**
   * Whether analysis may run RIGHT NOW, for a caller that cannot wait — a live
   * restart, which has nothing to resume into. Disposed reads as refused: the
   * process is going down and the boot start is the only one that resumes.
   */
  isGranted(): boolean {
    if (this.disposed) {
      return false;
    }
    if (this.released || this.deps.hasAgreedToSessionAnalysis()) {
      this.released = true;
      return true;
    }
    return false;
  }

  /** Re-read the persisted answer after a write that may have recorded one. */
  reconcile(): void {
    if (this.released || !this.deps.hasAgreedToSessionAnalysis()) {
      return;
    }
    this.released = true;
    this.settle(true);
  }

  /**
   * Unwind every wait at shutdown, pending and future. Does NOT record consent:
   * waiters resume with `false`.
   */
  dispose(): void {
    this.disposed = true;
    this.settle(false);
  }

  private settle(granted: boolean): void {
    const pending = this.waiters;
    this.waiters = [];
    for (const resolve of pending) {
      resolve(granted);
    }
  }
}

/**
 * What the boot-path gate needs from `DesktopApplication`, in the shape its
 * sibling gate (`createSessionLimitsGate`) already takes, so app.ts composes
 * both the same way.
 *
 * Golden mode is pre-granted: it replays a frozen corpus out of a throwaway
 * profile with no reader to ask, the same carve-out `syncAgentMonitorHooksOnBoot`
 * and cloud egress already take there.
 */
export type SessionAnalysisConsentGateOptions = {
  isGoldenMode: () => boolean;
  isShuttingDown: () => boolean;
  logWarning: (message: string) => void;
  /**
   * A PROVIDER, not the reads: this composes in a class-field initializer, which
   * runs before the constructor assigns the settings store.
   */
  settings: () => SessionAnalysisConsentReads;
};

export type BootCollectorStarter = { startCollectors: () => void };

/** The boot-path gate, composed. */
export function createSessionAnalysisConsentGate(
  options: SessionAnalysisConsentGateOptions
) {
  const gate = new SessionAnalysisConsentGate({
    hasAgreedToSessionAnalysis: () =>
      options.isGoldenMode() || hasAgreedToSessionAnalysis(options.settings()),
  });
  return {
    /**
     * Start the boot import once the reader has agreed, and not before.
     *
     * Detached rather than awaited, because the wait can be the length of the
     * onboarding wizard and the caller's remaining boot work is unrelated to
     * reading the reader's transcripts. Never throws into boot: the gate
     * resolves on dispose, `startCollectors` is inert against a closed runtime,
     * and a failure past both is reported rather than raised.
     */
    startCollectorsWhenAgreed(runtime: BootCollectorStarter): void {
      gate
        .whenGranted()
        .then((granted) => {
          if (!granted || options.isShuttingDown()) {
            return;
          }
          runtime.startCollectors();
        })
        .catch((error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          options.logWarning(
            `Collector start after analysis consent failed: ${message}`
          );
        });
    },
    /**
     * Run a LIVE collector restart, or refuse it while the gate is held.
     *
     * The three restart paths — the per-harness collector toggle
     * (`settings-ipc`), the hooks toggle (`agent-monitor-ipc`) and the Sessions
     * Reload button — reach `collectorManager.start()` directly, so before this
     * they ran the whole import the boot gate was still holding (tamsinb
     * review, ISS-10950). Refused rather than queued: `startCollectorsWhenAgreed`
     * is already parked on the same gate and is what starts the import when the
     * answer lands.
     */
    restartCollectorsIfAgreed(
      restart: () => Promise<void> | undefined
    ): Promise<void> | undefined {
      if (!gate.isGranted()) {
        return undefined;
      }
      return restart();
    },
    reconcile: () => gate.reconcile(),
    dispose: () => gate.dispose(),
  };
}
