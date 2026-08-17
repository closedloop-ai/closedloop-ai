"use strict";

/**
 * E2E-only: hold the local session SOURCE closed while the session READ keeps
 * answering, which is the boot window ISS-6002 is about.
 *
 * WHY THIS EXISTS. The reported bug is an ordering bug between two independent
 * main-process answers. During the first ~10s of a cold launch the local SQLite
 * store is not serving yet: `desktop:get-agent-monitor-url` reports `starting`,
 * and the session list read answers — successfully — with `{ total: 0 }`. The
 * Dashboard read that zero as "this Mac has no sessions" and rendered
 * "No agent sessions yet" over a store holding 1,014 of them. The window is real
 * but it is a boot RACE: it closes on its own within seconds, in an order no
 * spec can schedule, and by the time Playwright has driven to the Dashboard it
 * is usually gone. There is no HTTP anywhere on this path, so `page.route`
 * intercepts nothing.
 *
 * So the one input the spec cannot produce — a source that stays down while the
 * reads answer — is substituted here, at the IPC boundary the renderer actually
 * consumes. Everything else is the real thing: the real `ipcMain` handlers and
 * their real reads, the real preload bridge, the real `useLocalSessionSourceStatus`
 * probe and its 500ms `starting` self-poll, the real `useSessionsReadGate`, the
 * real react-query session poll, and the real mounted `FirstLaunchDashboard`.
 *
 * WHAT IS SUBSTITUTED, and only while held:
 *   - `desktop:get-agent-monitor-url` answers `starting` — the status the real
 *     probe returns before the local store opens.
 *   - `desktop:get-runtime-status` answers with its `ingest` field dropped. The
 *     read gate also latches open on an OBSERVED-complete boot import, so on the
 *     empty profile a spec launches with, the import would finish and open the
 *     gate within a second. An absent field is the shape an older/not-yet-up
 *     main process sends, which the renderer already treats as "unknown", so
 *     nothing has to parse a value invented here. (The first-launch import
 *     splash reads the same field; it is not this spec's subject.)
 *
 * The session LIST read is deliberately untouched — it answering while the
 * source is down is the entire premise of the bug.
 *
 * HOW. Electron's `-r` loads this in the main process before the app's own
 * entrypoint, so it can wrap `ipcMain.handle` and decorate these two listeners
 * as the app registers them. Registering handlers directly here instead would
 * make the app's own `ipcMain.handle` for the same channel throw ("Attempted to
 * register a second handler") and take the app down — the same reason
 * `sessions-page-data-gate-preload.cjs` and `cloud-read-readiness-preload.cjs`
 * wrap rather than register.
 *
 * Loaded ONLY when the env var is set, and only ever from `test/e2e/helpers` —
 * it ships in no build.
 */

const { ipcMain } = require("electron");

/** The readiness probe `useLocalSessionSourceStatus` polls. */
const AGENT_MONITOR_URL_CHANNEL = "desktop:get-agent-monitor-url";
/** The shared runtime-status poll the import-progress projection reads. */
const RUNTIME_STATUS_CHANNEL = "desktop:get-runtime-status";

/** `LOCAL_SESSION_SOURCE_STATUSES.starting`. */
const STARTING = "starting";

/** Read from the spec through `ElectronApplication.evaluate`. */
const GATE_KEY = "__clE2eLocalSessionSourceGate";

if (process.env.CL_E2E_LOCAL_SESSION_SOURCE_GATE === "1") {
  const gate = {
    /**
     * Held from launch, unlike the pageData gate: the state under test is the
     * boot window itself, so there is nothing to let the app reach first.
     */
    held: true,
    /** Probes answered while held — proves the renderer really was polling. */
    heldProbes: 0,
    release() {
      gate.held = false;
      return gate.heldProbes;
    },
  };
  globalThis[GATE_KEY] = gate;

  const registerHandler = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) => {
    if (
      channel !== AGENT_MONITOR_URL_CHANNEL &&
      channel !== RUNTIME_STATUS_CHANNEL
    ) {
      return registerHandler(channel, listener);
    }
    return registerHandler(channel, async (event, ...args) => {
      const response = await listener(event, ...args);
      if (!gate.held) {
        return response;
      }
      gate.heldProbes += 1;
      if (channel === AGENT_MONITOR_URL_CHANNEL) {
        return { localSessionSourceStatus: STARTING };
      }
      // Pass anything that is not an object straight through rather than
      // inventing a shape the renderer would then have to parse.
      if (!response || typeof response !== "object") {
        return response;
      }
      return { ...response, ingest: null };
    });
  };
}
