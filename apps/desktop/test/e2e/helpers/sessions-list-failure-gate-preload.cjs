"use strict";

/**
 * E2E-only: fail the desktop Sessions combined `pageData` IPC read, so a spec can
 * drive a refetch failure OVER data the renderer already holds (ISS-7661).
 *
 * WHY THIS EXISTS. The contract under test is the desktop half of ISS-7519 /
 * ISS-7528: query-core's error reducer never clears `data`, so a refetch that
 * fails after a read has already succeeded reports `isError === true` while the
 * succeeded result is still on screen. The surface must keep rendering that held
 * result — the neutral "No sessions yet" empty for an empty profile — and must
 * NOT flip to the hard "Couldn't load sessions" card. The renderer suite mounts
 * `SessionsView` against mocked data sources, so it proves the component's
 * derivation but not that the real chain `ipcMain handler -> preload bridge ->
 * local data source -> react-query` renders it that way in the launched app.
 *
 * There is no HTTP anywhere on this path, so `page.route` intercepts nothing. The
 * one input a spec cannot otherwise produce — a local SQLite read that fails on
 * demand, after a successful one — is substituted here, at the IPC response
 * boundary the renderer actually consumes. Everything else is the real thing: the
 * real handler and its real read before arming, the real preload bridge, the real
 * `local-agent-sessions-data-source`, the real react-query cache and desktop poll
 * defaults, and the real mounted `SessionsView`.
 *
 * The failure is deliberately a PLAIN error, never a db-host lifecycle signature
 * and never a known transient code (`shared/transient-source-error.ts`). A
 * transient failure routes to the quiet "Getting your sessions ready" surface and
 * auto-retries, which is a DIFFERENT contract with its own coverage; this gate
 * models an ordinary settled read failure, which is the one that used to be
 * dressed as an outage over held data.
 *
 * INERT until the spec arms it, so the app boots and paints a real Sessions
 * surface off the profile first — that successful read is what the failure has to
 * happen OVER, and arming from launch would make it an ordinary first-load error.
 *
 * HOW. Electron's `-r` loads this in the main process before the app's own
 * entrypoint, so it can wrap `ipcMain.handle` and decorate the listener for this
 * one channel as the app registers it. Registering a handler directly here would
 * make the app's own `ipcMain.handle` for the same channel throw ("Attempted to
 * register a second handler") and take the app down — the same reason
 * `sessions-page-data-gate-preload.cjs` wraps rather than registers.
 *
 * Loaded ONLY when the env var is set, and only ever from `test/e2e/helpers` — it
 * ships in no build.
 */

const { ipcMain } = require("electron");

/** `SHARED_AGENT_SESSIONS_IPC_CHANNELS.pageData`. */
const CHANNEL = "desktop:shared-agent-sessions:page-data";

/** Read from the spec through `ElectronApplication.evaluate`. */
const GATE_KEY = "__clE2eSessionsListFailureGate";

/**
 * The message the armed handler rejects with. Deliberately carries no db-host
 * lifecycle signature and no transient code, so `isTransientSourceError` returns
 * false and the renderer classifies it as an ordinary settled failure.
 */
const FAILURE_MESSAGE = "e2e sessions list read failure";

if (process.env.CL_E2E_SESSIONS_LIST_FAILURE_GATE === "1") {
  const gate = {
    /** Whether the read is being failed. OFF until the spec arms it. */
    failing: false,
    /** Reads answered successfully (i.e. before arming). */
    succeeded: 0,
    /** Reads rejected while armed — what the spec polls to know the failure landed. */
    failed: 0,
    stats() {
      return { failed: gate.failed, succeeded: gate.succeeded };
    },
    arm() {
      gate.failing = true;
      return gate.failed;
    },
  };
  globalThis[GATE_KEY] = gate;

  const registerHandler = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) => {
    if (channel !== CHANNEL) {
      return registerHandler(channel, listener);
    }
    return registerHandler(channel, async (event, ...args) => {
      if (gate.failing) {
        gate.failed += 1;
        throw new Error(FAILURE_MESSAGE);
      }
      const response = await listener(event, ...args);
      gate.succeeded += 1;
      return response;
    });
  };
}
