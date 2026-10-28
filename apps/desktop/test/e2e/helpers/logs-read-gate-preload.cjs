"use strict";

/**
 * E2E-only: hold a gateway-log READ open so a spec can press Pause while that
 * read is still in flight — the exact window ISS-7593 fixes.
 *
 * WHY THIS EXISTS. The bug is a race between one IPC answer and one click.
 * `desktop:get-logs` is a local in-memory read that answers in well under a
 * frame, so a spec can never reach the Pause button while a real read is
 * outstanding, and there is no HTTP anywhere on this path for `page.route` to
 * intercept. The one input a spec cannot produce — a log read that is still
 * unanswered when Pause is pressed — is substituted here, at the IPC boundary
 * the renderer actually consumes.
 *
 * Everything else is the real thing: the real `ipcMain` handler still runs (its
 * answer is discarded, not its execution), the real preload bridge, the real
 * `LogsPanel` effect, its real 3s poll, and the real Pause/Resume controls.
 *
 * WHAT IS SUBSTITUTED: the log ROWS. The spec sets a payload it can assert on by
 * text, because the real gateway log of a freshly launched throwaway profile
 * carries whatever boot lines that run happened to emit — nothing a spec can
 * name. While held, every read parks until `release()` answers it.
 *
 * HOW. Electron's `-r` loads this in the main process before the app's own
 * entrypoint, so it can wrap `ipcMain.handle` and decorate the listener as the
 * app registers it. Registering a handler for the same channel here instead
 * would make the app's own `ipcMain.handle` throw ("Attempted to register a
 * second handler") and take the app down — the same reason
 * `local-session-source-gate-preload.cjs` wraps rather than registers.
 *
 * Loaded ONLY when the env var is set, and only ever from `test/e2e/helpers` —
 * it ships in no build.
 */

const { ipcMain } = require("electron");

/** `LogsActivityChannel.GetLogs` in src/main/ipc/logs-activity-ipc.ts. */
const GET_LOGS_CHANNEL = "desktop:get-logs";

/** Read from the spec through `ElectronApplication.evaluate`. */
const GATE_KEY = "__clE2eLogsReadGate";

if (process.env.CL_E2E_LOGS_READ_GATE === "1") {
  const gate = {
    /** Inert until a spec arms it, so a launch alone changes no timing. */
    held: false,
    /** Reads currently parked, polled by the spec before it presses Pause. */
    pending: [],
    /** The rows every read answers with. */
    payload: [],
    hold() {
      gate.held = true;
    },
    setPayload(entries) {
      gate.payload = entries;
    },
    pendingCount() {
      return gate.pending.length;
    },
    /** Answers every parked read with `entries`; returns how many there were. */
    release(entries) {
      gate.held = false;
      gate.payload = entries;
      const parked = gate.pending.splice(0);
      for (const resolve of parked) {
        resolve(entries);
      }
      return parked.length;
    },
  };
  globalThis[GATE_KEY] = gate;

  const registerHandler = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) => {
    if (channel !== GET_LOGS_CHANNEL) {
      return registerHandler(channel, listener);
    }
    return registerHandler(channel, async (event, ...args) => {
      // The real handler still runs; only its rows are replaced.
      await listener(event, ...args);
      if (!gate.held) {
        return gate.payload;
      }
      return new Promise((resolve) => {
        gate.pending.push(resolve);
      });
    });
  };
}
