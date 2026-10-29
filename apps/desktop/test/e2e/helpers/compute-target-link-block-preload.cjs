"use strict";

/**
 * E2E-only (ISS-11426): pin the `computeTargetLinkBlock` field the
 * runtime-status payload carries, so a launched-app spec can assert the
 * Settings → Relay / Gateway relink alert.
 *
 * WHY THIS EXISTS. The production block is latched by
 * `ComputeTargetLinkBlockTracker` when a real sync lane is refused
 * `target_not_owned` by a real cloud — an authenticated socket, a compute
 * target the server has heard of, and a 403 it codes. A launched-Electron spec
 * stands up none of that, so without a fixture the block is `null` for the whole
 * launch and the alert is unreachable from the app at all.
 *
 * This substitutes an INPUT, not the behaviour under test. The runtime-status
 * handler is the real one, the preload bridge is the real one, and the alert,
 * its Zod projection, its flag gate, its poll subscription and its href are all
 * the shipped code — only the one field on the handler's result is overwritten.
 *
 * Same mechanism and same constraints as `cloud-read-readiness-preload.cjs`:
 * Electron's `-r` loads this in the main process before the app's entrypoint so
 * it can wrap `ipcMain.handle`; registering a handler for the channel directly
 * would make the app's own registration throw and take the app down. Loaded
 * only when the env var is set, and only ever from `test/e2e/helpers` — it ships
 * in no build.
 */

const { ipcMain } = require("electron");

/** `RuntimeInfoIpcChannel.GetRuntimeStatus`. */
const RUNTIME_STATUS_CHANNEL = "desktop:get-runtime-status";

const raw = process.env.CL_E2E_COMPUTE_TARGET_LINK_BLOCK;
if (raw) {
  const block = JSON.parse(raw);
  const registerHandler = ipcMain.handle.bind(ipcMain);

  const decorateRuntimeStatus =
    (listener) =>
    async (...args) => {
      const status = await listener(...args);
      if (!status || typeof status !== "object") {
        return status;
      }
      return { ...status, computeTargetLinkBlock: block };
    };

  ipcMain.handle = (channel, listener) => {
    if (channel === RUNTIME_STATUS_CHANNEL) {
      return registerHandler(channel, decorateRuntimeStatus(listener));
    }
    return registerHandler(channel, listener);
  };
}
