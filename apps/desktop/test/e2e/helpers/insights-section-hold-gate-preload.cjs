"use strict";

/**
 * E2E-only: park the desktop LOCAL insights read for ONE section, from launch,
 * until the spec releases it (ISS-12110).
 *
 * WHY THIS EXISTS. ISS-12110 holds each dashboard tour beat until the section
 * its panel reads has finished its first load. A local read settles far too
 * fast for a spec to catch that window, and there is no HTTP on this path
 * (signed out, the renderer reads insights from SQLite over IPC), so
 * `page.route` intercepts nothing. Same seam as
 * `insights-read-failure-gate-preload.cjs`, but it HOLDS rather than fails: the
 * tour does not wait on a FAILED section, so a failure would hold no beat.
 *
 * Only the timing of the named section's reads is substituted. The real
 * handler answers every read once released, every other section answers
 * immediately, and the preload bridge, react-query cache and mounted dashboard
 * are the real ones.
 *
 * HOW. Electron's `-r` loads this in the main process before the app's own
 * entrypoint, so it wraps `ipcMain.handle` for this one channel as the app
 * registers it — registering a handler here instead would make the app's own
 * registration throw and take the app down.
 *
 * Loaded ONLY when the env var names a section, and only ever from
 * `test/e2e/helpers` — it ships in no build.
 */

const { ipcMain } = require("electron");

/** `AgentDashboardDbIpcChannel.GetInsights`. */
const CHANNEL = "desktop:db:get-insights";

/** Read from the spec through `ElectronApplication.evaluate`. */
const GATE_KEY = "__clE2eInsightsSectionHoldGate";

const heldSection = process.env.CL_E2E_INSIGHTS_HOLD_SECTION;

if (heldSection) {
  const gate = {
    holding: true,
    /** Reads of the held section parked so far, released or not. */
    held: 0,
    /** One resolver per read still parked. */
    pending: [],
    stats() {
      return { held: gate.held, parked: gate.pending.length };
    },
    /** Let every parked read through and stop holding new ones. */
    release() {
      gate.holding = false;
      for (const resolve of gate.pending.splice(0)) {
        resolve();
      }
      return gate.stats();
    },
  };
  globalThis[GATE_KEY] = gate;

  const registerHandler = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) => {
    if (channel !== CHANNEL) {
      return registerHandler(channel, listener);
    }
    return registerHandler(channel, async (event, ...args) => {
      // `getInsights(section, period, scope)`: the section is the first arg.
      if (gate.holding && args[0] === heldSection) {
        gate.held += 1;
        await new Promise((resolve) => {
          gate.pending.push(resolve);
        });
      }
      return listener(event, ...args);
    });
  };
}
