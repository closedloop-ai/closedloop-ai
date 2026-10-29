/**
 * @file terminal-install-latch.ts
 * @description ISS-6170 — remember which pack ids this build has already proved
 * it cannot install, so the distribution reconcile stops re-attempting them.
 *
 * WHETHER a failure is terminal is the caller's judgement, not this module's:
 * ISS-4428 makes a pre-catalog-seed `ENOTFOUND` transient, so
 * `required-plugin-installer.ts` refuses to latch until that seed has landed.
 *
 * The key is the PACK ID because `runInstall(packId, HARNESS_AUTO)` is fully
 * determined by it — the harness is always the sentinel — so "the same request"
 * IS "the same pack id", which is the scope
 * {@link ../../shared/install-run-contract.js#StreamRunRetryClass} calls
 * permanent.
 *
 * The lifetime is the PROCESS because `ENOTFOUND` means the pack is absent from
 * THIS build's compiled-in catalog seed, and the remedy the failure names is
 * updating Desktop — which replaces the seed and restarts the process. So the
 * condition is permanent for the running build and transient across upgrades,
 * and a process-scoped latch expires exactly when the remedy lands.
 */

import type { StreamRunErrorCode } from "../../shared/install-run-contract.js";

/**
 * Hard cap on distinct latched pack ids. Pack ids arrive from cloud-assigned
 * distributions, so the key space is external input and cannot be left to grow;
 * the cap bounds it without a timer.
 *
 * At saturation the latch REFUSES the new key rather than evicting the oldest.
 * Eviction looks safe per-key — the evicted pack gets one more attempt and
 * re-latches — but the caller re-walks the SAME cloud-assigned list in a stable
 * order on every reconcile, which turns each eviction into the next one:
 * retaining packs 1…64 means pack 0 evicts pack 1, which then evicts pack 2, so
 * every pack is un-latched and re-attempted on every pass. That is the exact
 * retry storm this module exists to stop, restored in full above the cap, and it
 * re-fires the once-only give-up notification with it because a re-latch is
 * indistinguishable from a first latch. Refusing admission keeps the first
 * {@link TERMINAL_INSTALL_LATCH_MAX_PACKS} quiet permanently and confines the
 * retries to the overflow alone.
 */
export const TERMINAL_INSTALL_LATCH_MAX_PACKS = 64;

/** What was recorded about one pack this build gave up on. */
export type TerminalInstallRecord = {
  code: StreamRunErrorCode;
  reason: string;
};

/**
 * Bounded set of pack ids whose install this build has classified as permanently
 * impossible, each carrying the code and reason to keep reporting.
 */
export class TerminalInstallLatch {
  private readonly recordByPackId = new Map<string, TerminalInstallRecord>();

  /** The recorded give-up for `packId`, or `undefined` if not latched. */
  recordFor(packId: string): TerminalInstallRecord | undefined {
    return this.recordByPackId.get(packId);
  }

  /**
   * Record `packId` as terminally uninstallable. Returns `true` only on the
   * transition into the latched state, so the caller can raise its ONCE-ONLY
   * signals from the branch where the precondition actually held rather than on
   * every subsequent reconcile. Signals that must instead keep retrying until
   * they are delivered read this return value as `false` and re-raise anyway.
   *
   * `false` also covers the saturated case, where the pack is NOT latched and
   * keeps its retries. That is the honest reading for both callers: it did not
   * give up on this pack, so neither the once-only notification nor the give-up
   * report belongs to it.
   */
  latch(packId: string, record: TerminalInstallRecord): boolean {
    if (this.recordByPackId.has(packId)) {
      return false;
    }
    if (this.recordByPackId.size >= TERMINAL_INSTALL_LATCH_MAX_PACKS) {
      return false;
    }
    this.recordByPackId.set(packId, record);
    return true;
  }
}
