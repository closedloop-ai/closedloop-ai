"use strict";

/**
 * E2E-only: fail the desktop LOCAL insights read, so a spec can drive the
 * dashboard's terminal error state in the launched app (ISS-10409).
 *
 * WHY THIS EXISTS. `DesktopDashboardContent.Error` is one of the two states the
 * header's Tour control refuses in, and it is the only one of the two a spec can
 * hold still: `Loading` clears itself the moment the reads settle, so any
 * assertion taken there is a race against a state nothing can pin. This state is
 * terminal — the three insights queries set `refetchOnMount`,
 * `refetchOnWindowFocus`, `refetchOnReconnect` and `refetchInterval` all off, so
 * once they have exhausted `MAX_TRANSIENT_QUERY_RETRIES` nothing refetches them
 * until the reader presses the dashboard's own Retry.
 *
 * There is no HTTP anywhere on this path — signed out, the renderer reads
 * insights from the local SQLite store over IPC — so `page.route` intercepts
 * nothing. The one input a spec cannot otherwise produce is substituted here, at
 * the IPC response boundary the renderer consumes. Everything else is the real
 * thing: the real preload bridge, the real `DesktopInsightsProvider` in local
 * mode, the real react-query retry policy, and the real mounted dashboard.
 *
 * ARMED FROM LAUNCH, unlike `sessions-list-failure-gate-preload.cjs`, which is
 * inert until a spec arms it. That gate models a refetch failing OVER held data;
 * this one models a first read that never lands, which is the input the error
 * branch is reached from. `release()` hands the real read back so a spec can
 * press Retry and watch the same control come out of refusal.
 *
 * The failure is deliberately a PLAIN error, never a db-host lifecycle
 * signature: `withDb`'s `DB_HOST_EXIT_REDRIVE_READ` retries a read whose worker
 * exited, and this gate rejects ahead of that wrapper anyway, so an injected
 * lifecycle signature would only muddy what the spec is holding.
 *
 * HOW. Electron's `-r` loads this in the main process before the app's own
 * entrypoint, so it can wrap `ipcMain.handle` and decorate the listener for this
 * one channel as the app registers it. Registering a handler directly here would
 * make the app's own `ipcMain.handle` for the same channel throw ("Attempted to
 * register a second handler") and take the app down.
 *
 * Loaded ONLY when the env var is set, and only ever from `test/e2e/helpers` — it
 * ships in no build.
 */

const { ipcMain } = require("electron");

/** The local own-data insights read (`agent-dashboard-local-read-ipc.ts`). */
const CHANNEL = "desktop:db:get-insights";

/** Read from the spec through `ElectronApplication.evaluate`. */
const GATE_KEY = "__clE2eInsightsReadFailureGate";

const FAILURE_MESSAGE = "e2e insights read failure";

if (process.env.CL_E2E_INSIGHTS_READ_FAILURE_GATE === "1") {
  const gate = {
    /** Whether the read is being failed. ON from launch — see the header. */
    failing: true,
    /** Reads rejected while failing — what the spec polls to know it landed. */
    failed: 0,
    /** Reads answered by the real handler (i.e. after release). */
    succeeded: 0,
    stats() {
      return { failed: gate.failed, succeeded: gate.succeeded };
    },
    release() {
      gate.failing = false;
      return gate.succeeded;
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
