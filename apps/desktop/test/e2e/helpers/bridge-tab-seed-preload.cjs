"use strict";
/**
 * ISS-10943: seed the sidecar tab's `localStorage` before the page's own
 * scripts run, so the shell reads the guided-onboarding record on its FIRST
 * paint and `browser-bridge-sidecar.spec.ts` needs no reload.
 *
 * The regular Desktop returning-install adapter invokes this writer only for
 * its intended initial main frame. It retains the production desktop preload;
 * the sidecar tab remains unprivileged and exposes only its bridge handshake.
 *
 * A preload rather than the CDP hook Playwright's `addInitScript` uses:
 * `webContents.debugger.attach` succeeds under Playwright's Electron driver but
 * every `sendCommand` on it then hangs forever, because Playwright already owns
 * that target's CDP session.
 *
 * It is a preload, and `bridge-tab-host.cjs` still hosts an unprivileged page:
 * this runs in the isolated world, requires nothing, and calls no
 * `contextBridge`, so `window.desktopApi` still has only the bridge handshake to
 * come from. The seed is read from `process.env`, which Electron exposes to a
 * sandboxed preload.
 */
const failedKeys = [];
for (const [key, value] of Object.entries(
  JSON.parse(process.env.CLOSEDLOOP_BRIDGE_TAB_LOCAL_STORAGE_SEED ?? "{}")
)) {
  try {
    localStorage.setItem(key, value);
  } catch (error) {
    failedKeys.push(`${key}: ${String(error)}`);
  }
}
// Every key is attempted first, so one refusal cannot hide which others landed.
// Electron reports a throwing preload as `preload-error` and a renderer console
// error.
if (failedKeys.length > 0) {
  throw new Error(
    `bridge-tab-seed-preload could not seed localStorage: ${failedKeys.join("; ")}`
  );
}
