"use strict";

/**
 * E2E-only: pin the desktop→cloud READINESS snapshot the runtime-status payload
 * carries (ISS-5768), which the Settings → History Sync cell and the startup
 * panel read.
 *
 * ISS-6972 removed the dedicated readiness channel along with the read-source
 * cutover that was its only consumer, so this preload now decorates exactly one
 * channel.
 *
 * WHY THIS EXISTS. The production snapshot comes from `SyncBurndownReporter`,
 * which `start()`s a `setInterval` and takes its FIRST sample one full
 * `SYNC_BURNDOWN_INTERVAL_MS` (60s) later — so for the first minute of every
 * launch `getLatestSnapshot()` is `null`, which projects to UNKNOWN readiness.
 * A launched-Electron spec that needs a settled readiness either way cannot wait
 * that out, and waiting would not make the state DETERMINISTIC even then: the
 * lanes' real drain states depend on whatever the collectors found in the
 * fixture home dirs.
 *
 * So the readiness snapshot — and only it — is answered from a fixture the spec
 * supplies in `CL_E2E_CLOUD_READ_READINESS`. Everything downstream of it is the
 * real thing: the real IPC handler registration, the real preload bridge, the
 * real providers, the real Branches/Sessions sources. This substitutes an INPUT,
 * not the behaviour under test.
 *
 * The runtime-status handler is not replaced: the real one runs and produces the
 * real payload, and only the `cloudReadReadiness` field on its result is
 * overwritten.
 *
 * `CL_E2E_CLOUD_SYNC_PROGRESS` is the second, separate input the same surfaces
 * gate on: `AgentSessionSyncProgress.identified` is true only while the cloud
 * SOCKET is online with a compute target, which no E2E fixture stands up — so
 * without it the cell renders its "not connected to the cloud" dash and no
 * completeness label is reachable at all. Supplying it is what makes the label
 * under test observable; it is not what decides which label appears.
 *
 * ISS-9184: that env var is the FIRST sample, not the only one. The cloud
 * Sessions refresh bridge is a CHANGE detector over this field, so a sample that
 * can only be set at launch yields a baseline and nothing after it — a spec
 * asserting that the bridge reacts to a delivery would have nothing to react to.
 * The sample therefore lives on a main-process global a spec replaces mid-run
 * through `ElectronApplication.evaluate`; `cloud-sync-progress-control.ts` is the
 * half the spec talks to. A launch that never pushes behaves exactly as it did
 * before, so every existing caller is untouched.
 *
 * HOW. Electron's `-r` loads this in the main process before the app's own
 * entrypoint, so it can wrap `ipcMain.handle` and swap or decorate the listener
 * as the app registers it. Registering a handler directly here instead would
 * make the app's own `ipcMain.handle` for the same channel throw ("Attempted to
 * register a second handler"), which would take the app down.
 *
 * Loaded ONLY when the readiness env var is set, and only ever from
 * `test/e2e/helpers` — it ships in no build.
 */

const { ipcMain } = require("electron");

/** `RuntimeInfoIpcChannel.GetRuntimeStatus`. */
const RUNTIME_STATUS_CHANNEL = "desktop:get-runtime-status";

/** Read and driven from the spec through `ElectronApplication.evaluate`. */
const CLOUD_SYNC_KEY = "__clE2eCloudSyncProgress";

const raw = process.env.CL_E2E_CLOUD_READ_READINESS;
if (raw) {
  const snapshot = JSON.parse(raw);
  const rawCloudSync = process.env.CL_E2E_CLOUD_SYNC_PROGRESS;
  const cloudSync = {
    /** The sample every answer carries, or null to leave the real field alone. */
    current: rawCloudSync ? JSON.parse(rawCloudSync) : null,
    /**
     * Answers served since `current` was last replaced. A spec waits on this
     * rather than on a sleep: the renderer's shared runtime-status poll is what
     * turns a pushed sample into something the bridge can compare, so a push
     * that has not been SERVED yet has not reached the renderer at all, and an
     * assertion made before it would be timing out on the wrong thing.
     */
    served: 0,
    push(sample) {
      cloudSync.current = sample;
      cloudSync.served = 0;
    },
  };
  globalThis[CLOUD_SYNC_KEY] = cloudSync;
  const registerHandler = ipcMain.handle.bind(ipcMain);

  const decorateRuntimeStatus =
    (listener) =>
    async (...args) => {
      const status = await listener(...args);
      if (!status || typeof status !== "object") {
        return status;
      }
      // Field overwrite on the REAL payload — every other field the renderer
      // reads (ingest, maintenance, agentMonitor, gateway health) stays whatever
      // the running app actually reported.
      const patched = { ...status, cloudReadReadiness: snapshot };
      if (cloudSync.current) {
        patched.cloudSync = cloudSync.current;
        cloudSync.served += 1;
      }
      return patched;
    };

  ipcMain.handle = (channel, listener) => {
    if (channel === RUNTIME_STATUS_CHANNEL) {
      return registerHandler(channel, decorateRuntimeStatus(listener));
    }
    return registerHandler(channel, listener);
  };
}
