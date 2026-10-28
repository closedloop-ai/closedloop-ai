/**
 * @file finish-update-install.ts
 * @description The final hand-off to electron-updater, lifted out of `app.ts`.
 *
 * The last line of the OLD process. Nothing after it runs, which is why
 * ISS-7247's `restart_initiated` and the persisted expectation are emitted in
 * the shutdown sequence before it — by here the OTel exporter is already flushed
 * and shut down, so a record emitted from this function would never ship.
 */
import pkg from "electron-updater";
import { FAKE_UPDATE_HANDOFF_MARKER } from "./fake-update-feed.js";

const { autoUpdater } = pkg;

export type FinishUpdateInstallDeps = {
  /** Whether the FEA-2099 unsigned fixture feed is driving this run. */
  isFakeFeedActive: () => boolean;
  quit: () => void;
  log: (message: string) => void;
  /** Injected so the e2e marker is observable without writing to the real stdout. */
  writeHandoffMarker?: (marker: string) => void;
};

/** Called by the before-quit continuation, after graceful cleanup completes. */
export function finishPackagedUpdateInstall(
  deps: FinishUpdateInstallDeps
): void {
  // FEA-2099 test seam: under the fake-feed e2e the build is unsigned, so the
  // real binary swap (quitAndInstall) cannot apply and would hang — exactly the
  // wedge this guard exists to catch. Stub the swap at this boundary, emit a
  // deterministic marker (the "handoff reached, no hang" signal the e2e asserts
  // on), and let the normal quit proceed. The before-quit handler has already
  // run graceful cleanup, so reaching here proves the FEA-2026 path completes.
  // Unreachable in packaged builds.
  if (deps.isFakeFeedActive()) {
    deps.log(
      "fake-feed: skipping real quitAndInstall (unsigned); handoff complete"
    );
    const write =
      deps.writeHandoffMarker ??
      ((marker: string) => process.stdout.write(`${marker}\n`));
    write(FAKE_UPDATE_HANDOFF_MARKER);
    deps.quit();
    return;
  }
  deps.log("calling quitAndInstall(isSilent=true, isForceRunAfter=true)");
  autoUpdater.quitAndInstall(true, true);
}
