import {
  BOOT_ADMISSION_DEADLINE_MS,
  whenBootAdmissionAllowed,
} from "../lifecycle/boot-admission-deadline.js";
import { gatewayLog } from "../logging/gateway-logger.js";

export class CloudSocketStartupCoordinator {
  private generation = 0;

  invalidate(): void {
    this.generation += 1;
  }

  async startAfterInitialUi(options: CloudSocketStartupOptions): Promise<void> {
    const startGeneration = ++this.generation;
    // ISS-5346: ORDER IS LOAD-BEARING — the reveal first, THEN the readiness
    // gates. See the two option docs below.
    //
    // ISS-5990: and the reveal hop is BOUNDED here, because the promise behind
    // it is not. Bounding it at the call site instead would put the ordering in
    // two places; it lives here for the same reason the ordering itself does.
    await whenBootAdmissionAllowed({
      whenWindowRevealed: options.waitForWindowReveal,
      onDeadline: () =>
        gatewayLog.warn(
          "cloud-socket",
          `Starting cloud socket after ${BOOT_ADMISSION_DEADLINE_MS}ms with no window reveal`
        ),
    });
    await options.waitForInitialUi();
    await options.yieldToMainLoop();

    if (options.isShuttingDown()) {
      return;
    }
    if (!options.isCloudConnectionEnabled()) {
      return;
    }
    if (startGeneration !== this.generation) {
      return;
    }

    await options.startCloudSocket();
  }
}

type CloudSocketStartupOptions = {
  isCloudConnectionEnabled: () => boolean;
  isShuttingDown: () => boolean;
  startCloudSocket: () => Promise<void>;
  /**
   * ISS-5346: the initial window reveal (`DesktopWindow.whenInitiallyShown()`).
   *
   * Awaited BEFORE {@link waitForInitialUi} and load-bearing in that position.
   * The readiness wait below fails open on its own 2s bound, which on a slow
   * renderer expires before the reveal has even been armed — dropping the
   * socket's first burst straight into first paint, the contention this
   * ordering exists to prevent. Owned here rather than composed at the call
   * site so the ordering has one home and `app.ts` (shrink-only grandfather
   * list) stays a single wiring line.
   *
   * Cannot deadlock: the reveal waits on the renderer MOUNT, not on the
   * dashboard gates below, so the two waits are independent.
   *
   * ISS-5990: may never settle — `whenInitiallyShown()` is armed only by the
   * renderer-ready IPC or an explicit show — so `startAfterInitialUi` races it
   * against a deadline rather than awaiting it raw. Pass the bare promise here;
   * do not pre-bound it at the call site.
   */
  waitForWindowReveal: () => Promise<void>;
  /** The dashboard readiness gates, awaited after the reveal above. */
  waitForInitialUi: () => Promise<void>;
  yieldToMainLoop: () => Promise<void>;
};

export function logCloudSocketStartupFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  gatewayLog.warn(
    "cloud-socket",
    `Cloud socket startup scheduling failed: ${message}`
  );
}
