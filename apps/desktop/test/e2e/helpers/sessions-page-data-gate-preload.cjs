"use strict";

/**
 * E2E-only: hold the Sessions combined `pageData` IPC response, and force its
 * best-effort USAGE half into the transient failure the recovery hook exists for
 * (ISS-4561).
 *
 * WHY THIS EXISTS. The bug is a renderer state-machine bug — `usageRecoveryExhausted`
 * flipping true while the FINAL recovery refetch is still in flight — so a spec that
 * reproduces it must be able to (a) make the usage half fail transiently and (b) hold
 * one refetch PENDING while it asserts. Neither is reachable from outside: the usage
 * half is a local SQLite aggregate read in the main process, and it fails transiently
 * only when the forked db-host child happens to be restarting mid-backfill
 * (ISS-4476 / ISS-4474 / ISS-4410) — a lifecycle race no spec can schedule, and one
 * that certainly cannot be paused at the instant the last attempt is dispatched.
 * There is no HTTP anywhere on this path, so `page.route` intercepts nothing.
 *
 * So the ONE input the spec cannot produce is substituted here, at the IPC response
 * boundary the renderer actually consumes — the local analogue of `page.route`.
 * Everything the ticket is about is the real thing: the real `ipcMain` handler and
 * its real list read, the real preload bridge, the real `local-agent-sessions-data-source`,
 * the real react-query cache and poll defaults, the real `useUsageTransientRecovery`,
 * and the real mounted `SessionsSummaryCards`. What is substituted is the usage half's
 * OUTCOME (`usageError` / `usageErrorTransient`, byte-identical to what
 * `getSharedAgentSessionsPageData` returns for a transient usage rejection) and the
 * TIMING of the response.
 *
 * HOW. Electron's `-r` loads this in the main process before the app's own entrypoint,
 * so it can wrap `ipcMain.handle` and decorate the listener for this one channel as the
 * app registers it. Registering a handler directly here instead would make the app's own
 * `ipcMain.handle` for the same channel throw ("Attempted to register a second handler")
 * and take the app down — the same reason `cloud-read-readiness-preload.cjs` wraps
 * rather than registers.
 *
 * The gate is INERT until the spec arms it, so the app boots and paints a real Sessions
 * list off the seeded store first — holding from launch would freeze the list on its
 * first (pre-import, empty) read and every later assertion would be measured against a
 * list that is empty for the wrong reason.
 *
 * Once armed, exactly one response is let through — the one that opens the transient
 * window, since a held response never reaches the renderer and the recovery hook would
 * never start — and every response after it is held until the spec releases it. That is
 * what makes the sequencing sound rather than a race: React Query's `refetchInterval` poll
 * (2s on the desktop `pageData` key) DEDUPES onto a fetch that is already in flight, so
 * while a response is held the poll cannot reach this handler at all, whereas the
 * recovery hook's `refetch()` — `cancelRefetch: true` — always starts a new one. Once
 * the gate has been quiet for longer than the longest recovery backoff, the held
 * invocation is necessarily the hook's next attempt.
 *
 * Loaded ONLY when the env var is set, and only ever from `test/e2e/helpers` — it ships
 * in no build.
 */

const { ipcMain } = require("electron");

/** `SHARED_AGENT_SESSIONS_IPC_CHANNELS.pageData`. */
const CHANNEL = "desktop:shared-agent-sessions:page-data";

/** Read from the spec through `ElectronApplication.evaluate`. */
const GATE_KEY = "__clE2eSessionsPageDataGate";

if (process.env.CL_E2E_SESSIONS_PAGE_DATA_GATE === "1") {
  const gate = {
    /** Invocations this handler has SEEN (not necessarily answered yet). */
    dispatched: 0,
    /** Invocations answered so far. */
    settled: 0,
    /**
     * Whether the usage half is being failed transiently. OFF until the spec
     * arms it, so the app boots, imports and paints a REAL Sessions list first —
     * the state the reported bug starts from. Arming it mid-run is also what
     * makes the failure a transition the recovery hook actually observes.
     */
    failUsage: false,
    /**
     * Answer freely while `settled < passUntil`, hold afterwards. `Infinity`
     * until the spec arms the gate.
     */
    passUntil: Number.POSITIVE_INFINITY,
    /** Resolvers for the invocations currently held. */
    pending: [],
    /**
     * Start failing the usage half, and hold every response from the SECOND one
     * onwards. Exactly one response is let through so the transient window opens
     * (a held response would never reach the renderer and the hook would never
     * start), and the recovery's own attempts are then all held. Atomic — one
     * turn of the main-process event loop — so no response can slip past
     * unheld between the two decisions.
     */
    arm() {
      gate.failUsage = true;
      gate.passUntil = gate.settled + 1;
      return gate.passUntil;
    },
    /** Answer everything held right now; returns how many were let go. */
    release() {
      const released = gate.pending.splice(0);
      for (const resolve of released) {
        resolve();
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
      // The LIST half stays real — it is the half that must keep rendering while
      // the usage half recovers, which is the whole shape of the reported bug.
      const response = await listener(event, ...args);
      if (gate.settled >= gate.passUntil) {
        await new Promise((resolve) => {
          gate.pending.push(resolve);
        });
      }
      gate.settled += 1;
      // `withDb` can resolve its payload-free shutting-down sentinel instead of a
      // page-data response; pass anything without a `list` through untouched
      // rather than inventing a shape the renderer would then have to parse.
      if (
        !(gate.failUsage && response) ||
        typeof response !== "object" ||
        !Object.hasOwn(response, "list")
      ) {
        return response;
      }
      return {
        list: response.list,
        usageError: true,
        usageErrorTransient: true,
      };
    });
  };
}
