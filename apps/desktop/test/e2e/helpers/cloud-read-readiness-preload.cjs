"use strict";

/**
 * E2E-only: pin the desktop→cloud READINESS snapshot the renderer's read-source
 * cutover reads (ISS-5477 / ISS-5714), and — since ISS-5768 — the copy of that
 * snapshot the runtime-status payload carries.
 *
 * WHY THIS EXISTS. The production snapshot comes from `SyncBurndownReporter`,
 * which `start()`s a `setInterval` and takes its FIRST sample one full
 * `SYNC_BURNDOWN_INTERVAL_MS` (60s) later — so for the first minute of every
 * launch `getLatestSnapshot()` is `null`, which projects to UNKNOWN readiness
 * and holds every surface on Local. A launched-Electron spec that needs a
 * settled cutover either way cannot wait that out, and waiting would not make
 * the state DETERMINISTIC even then: the lanes' real drain states depend on
 * whatever the collectors found in the fixture home dirs.
 *
 * So the readiness snapshot — and only it — is answered from a fixture the spec
 * supplies in `CL_E2E_CLOUD_READ_READINESS`. Everything downstream of it is the
 * real thing: the real IPC handler registration, the real preload bridge, the
 * real `resolveCloudReadCutover`, the real providers, the real
 * Branches/Sessions sources. This substitutes an INPUT, not the behaviour under
 * test.
 *
 * TWO CHANNELS, ONE FIXTURE (ISS-5768). The Settings → History Sync cell and the
 * startup panel read the readiness off `desktop:get-runtime-status`, not off the
 * dedicated readiness channel, so a spec asserting what those surfaces DISPLAY
 * has to pin the field there too. The runtime-status handler is not replaced:
 * the real one runs and produces the real payload, and only the
 * `cloudReadReadiness` field on its result is overwritten.
 *
 * `CL_E2E_CLOUD_SYNC_PROGRESS` is the second, separate input the same surfaces
 * gate on: `AgentSessionSyncProgress.identified` is true only while the cloud
 * SOCKET is online with a compute target, which no E2E fixture stands up — so
 * without it the cell renders its "not connected to the cloud" dash and no
 * completeness label is reachable at all. Supplying it is what makes the label
 * under test observable; it is not what decides which label appears.
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

/** `RuntimeInfoIpcChannel.GetCloudReadReadiness`. */
const READINESS_CHANNEL = "desktop:get-cloud-read-readiness";
/** `RuntimeInfoIpcChannel.GetRuntimeStatus`. */
const RUNTIME_STATUS_CHANNEL = "desktop:get-runtime-status";

const raw = process.env.CL_E2E_CLOUD_READ_READINESS;
if (raw) {
  const snapshot = JSON.parse(raw);
  const rawCloudSync = process.env.CL_E2E_CLOUD_SYNC_PROGRESS;
  const cloudSync = rawCloudSync ? JSON.parse(rawCloudSync) : null;
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
      if (cloudSync) {
        patched.cloudSync = cloudSync;
      }
      return patched;
    };

  ipcMain.handle = (channel, listener) => {
    if (channel === READINESS_CHANNEL) {
      return registerHandler(channel, () => snapshot);
    }
    if (channel === RUNTIME_STATUS_CHANNEL) {
      return registerHandler(channel, decorateRuntimeStatus(listener));
    }
    return registerHandler(channel, listener);
  };
}
