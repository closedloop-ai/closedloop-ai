"use strict";

/**
 * E2E-only gate for the Agents combined page-data IPC response (ISS-6141).
 *
 * WHY THIS EXISTS. The restore gate's claim is about WHICH view the first
 * bounded read paginates under, and about what the surface renders while that
 * read is outstanding. There is no HTTP anywhere on this path — the local
 * reader is an `ipcMain` handler over SQLite in the main process — so
 * `page.route` observes nothing, and a local read settles far too fast for a
 * spec to catch the pending window. Electron's `-r` loads this in the main
 * process before the app's own entrypoint, so it can WRAP `ipcMain.handle` and
 * decorate the listener for this one channel as the app registers it.
 * Registering a handler here instead would make the app's own
 * `ipcMain.handle` for the same channel throw and take the app down — the same
 * reason `branches-page-data-gate-preload.cjs` wraps rather than registers.
 *
 * WHAT IS SUBSTITUTED, and what stays real: only the RESPONSE TIMING, plus a
 * record of each request. The real handler, the real `coerceAgentComponentFilters`,
 * the real local page-data reader, the real preload bridge, the real react-query
 * cache and the real mounted Agents surface all run untouched.
 *
 * It HOLDS FROM LAUNCH, unlike the Branches gate, which arms on demand. The
 * window this spec asserts on is the very first read the surface issues, so
 * there is no later moment at which arming would still catch it. Nothing reads
 * this channel before the Agents view mounts, so holding from launch parks
 * nothing else.
 *
 * Loaded ONLY from `test/e2e/helpers`, and only for a launch that asked; it
 * ships in no build.
 */

const { ipcMain } = require("electron");

/** `SHARED_AGENT_COMPONENTS_IPC_CHANNELS.pageData`. */
const CHANNEL = "desktop:db:get-agent-components-page-data";

/** Read from the spec through `ElectronApplication.evaluate`. */
const GATE_KEY = "__clE2eAgentsPageDataGate";

const gate = {
  /** Invocations this handler has SEEN (not necessarily answered yet). */
  dispatched: 0,
  /** Invocations answered so far. */
  settled: 0,
  /** Whether later responses are parked. Holding from launch — see the note above. */
  holding: true,
  /** `{ resolve, response }` for each invocation currently parked. */
  pending: [],
  /**
   * The REQUEST of every invocation, in order. The restore gate's whole claim is
   * about which view the first read paginates under, and `sortBy`/`sortDir` come
   * off the persisted view — so the spec has to read the request, not just count
   * it.
   */
  requests: [],
  /** Answer everything parked AND stop holding, leaving the handler fully open. */
  resume() {
    gate.holding = false;
    const released = gate.pending.splice(0);
    for (const entry of released) {
      gate.settled += 1;
      entry.resolve(entry.response);
    }
    return released.length;
  },
};

globalThis[GATE_KEY] = gate;

const registerHandler = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => {
  if (channel !== CHANNEL) {
    return registerHandler(channel, listener);
  }
  return registerHandler(channel, async (event, ...args) => {
    gate.dispatched += 1;
    gate.requests.push(args[0] ?? null);
    // Holding is a dispatch-time decision: a read dispatched before `resume`
    // must not settle early just because the real reader finished after it.
    const shouldHold = gate.holding;
    const response = await listener(event, ...args);
    if (!shouldHold) {
      gate.settled += 1;
      return response;
    }
    return new Promise((resolve) => {
      gate.pending.push({ resolve, response });
    });
  });
};
