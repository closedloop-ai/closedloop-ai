"use strict";

/**
 * E2E-only: hold the renderer's desktop auth bridge UNRESOLVED past
 * `VIEW_RESTORE_AUTH_DEADLINE_MS` (ISS-8288).
 *
 * WHY THIS EXISTS. `usePersistedTableViewState`'s deadline fallback
 * (`restoreStorageKey`, `@repo/app/shared/hooks/use-table-view-storage-key`)
 * only diverges from `storageKey` when `authLoaded` is STILL false after the
 * deadline. In an ordinary E2E profile the bridge settles as signed out well
 * inside it, so the saved view restores through the ordinary path and the
 * fallback is never the reason the read carried the saved sort — which is
 * exactly why `sessions-saved-view-restore-gate.spec.ts` stays green with the
 * fallback removed. Holding auth unresolved is the one input a spec cannot
 * otherwise produce, and it is what makes the deadline branch reachable in the
 * launched shell.
 *
 * TWO CHANNELS, NOT ONE. `createDesktopAuthStore`
 * (`desktop-auth-provider.tsx`) mirrors main's auth state with an initial PULL
 * and a PUSH subscription. The renderer lifecycle policy drops a startup push
 * issued before navigation readiness. This gate also drops one issued after
 * readiness, so holding the pull keeps the store on its `initial` LOADING
 * snapshot (`isLoaded: false`) under either ordering.
 *
 * The hold is released ON A SIGNAL from the spec, never on a timer here: the
 * deadline elapsing is the BEHAVIOR under test, so the spec waits on the
 * observable consequence (the first `pageData` request's `sortBy`) and then
 * lets auth through. Nothing in this file sleeps.
 *
 * What is substituted is the TIMING of one IPC channel and the delivery of one
 * push. Everything else is the real thing: the real `DesktopSessionManager`,
 * the real handler and its real answer (the held pull is invoked on release and
 * its genuine result returned), the real preload bridge, the real
 * `DesktopAuthProvider`, and the real mounted `SessionsView`.
 *
 * HOW. Electron's `-r` loads this in the main process before the app's own
 * entrypoint, so it can wrap `ipcMain.handle` and decorate the listener as the
 * app registers it. Registering a handler directly here instead would make the
 * app's own `ipcMain.handle` for the same channel throw ("Attempted to register
 * a second handler") and take the app down — the same reason
 * `cloud-read-readiness-preload.cjs` and `sessions-page-data-gate-preload.cjs`
 * wrap rather than register. The push half is intercepted on each window's own
 * `webContents.send` property, installed from `browser-window-created`, which
 * fires for the app's window because this module runs before the app creates
 * it.
 *
 * Loaded ONLY when the env var is set, and only ever from `test/e2e/helpers` —
 * it ships in no build.
 */

const { app, BrowserWindow, ipcMain } = require("electron");

/** `DesktopAuthIpcChannel.GetState`. */
const AUTH_STATE_CHANNEL = "desktop:get-desktop-auth-state";

/** `DESKTOP_AUTH_STATE_CHANGED_CHANNEL`. */
const AUTH_STATE_CHANGED_CHANNEL = "desktop:auth-state-changed";

/** Read and driven from the spec through `ElectronApplication.evaluate`. */
const GATE_KEY = "__clE2eDesktopAuthStateGate";

if (process.env.CL_E2E_DESKTOP_AUTH_STATE_GATE === "1") {
  const gate = {
    /** Whether the bridge is currently held unresolved. */
    held: true,
    /** Pull invocations parked so far — the pull half's proof of effect. */
    pullsHeld: 0,
    /** Auth-state pushes dropped while the bridge is held. */
    pushesSuppressed: 0,
    /** Resolvers for the pull invocations currently parked. */
    pending: [],
    /**
     * Let auth resolve: stop dropping pushes and answer every parked pull with
     * the REAL handler's answer. Returns how many pulls were released.
     */
    release() {
      gate.held = false;
      const released = gate.pending.splice(0);
      for (const resolve of released) {
        resolve();
      }
      return released.length;
    },
    /** Exercise the installed push gate without depending on startup timing. */
    probePushSuppression() {
      const before = gate.pushesSuppressed;
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send(AUTH_STATE_CHANGED_CHANNEL, {});
      }
      return gate.pushesSuppressed - before;
    },
  };
  globalThis[GATE_KEY] = gate;

  const registerHandler = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) => {
    if (channel !== AUTH_STATE_CHANNEL) {
      return registerHandler(channel, listener);
    }
    return registerHandler(channel, async (event, ...args) => {
      if (gate.held) {
        gate.pullsHeld += 1;
        await new Promise((resolve) => {
          gate.pending.push(resolve);
        });
      }
      // The REAL handler, invoked on release — the spec asserts against the
      // app's genuine auth answer, never a fixture one.
      return await listener(event, ...args);
    });
  };

  app.on("browser-window-created", (_event, window) => {
    const contents = window.webContents;
    const send = contents.send.bind(contents);
    // Own-property shadow rather than a prototype patch: the interception is
    // scoped to this launch's windows and disappears with them.
    contents.send = (channel, ...args) => {
      if (gate.held && channel === AUTH_STATE_CHANGED_CHANNEL) {
        gate.pushesSuppressed += 1;
        return;
      }
      return send(channel, ...args);
    };
  });
}
