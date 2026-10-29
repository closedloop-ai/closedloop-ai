"use strict";

/**
 * E2E-only: make the desktop SIGN-IN leg fail while leaving the GitHub connect
 * leg untouched, so a launched app can show which leg a failure is attributed
 * to (ISS-10411).
 *
 * WHY THIS EXISTS. `useDesktopGitHubConnect` runs two legs on one click — a
 * device authorization, then the GitHub connect hand-off. They used to share
 * one `try`, so a sign-in that rejected settled as `Failed` and the banner read
 * "GitHub connect could not be opened", naming a step the flow had not reached.
 * Reaching that branch from a spec needs the FIRST leg to reject and the second
 * to stay available, which is the one input a spec cannot otherwise produce: a
 * real device authorization in an E2E profile neither succeeds nor rejects
 * promptly, it opens a browser and waits.
 *
 * WHAT IS SUBSTITUTED: the answer of ONE ipc channel
 * (`desktop:begin-desktop-sign-in`, made to reject) and an observation of a
 * second (`desktop:open-github-connect`, counted and then refused so no real
 * browser is launched from a test). Everything else is the real thing — the
 * real preload bridge, the real `DesktopAuthProvider`, the real hook, and the
 * real mounted surface.
 *
 * The connect channel is counted rather than passed through because the whole
 * point of the assertion is that the second leg is NEVER reached when the first
 * one fails; a count of zero is the proof, and a count of one would otherwise
 * open the operator's browser mid-suite.
 *
 * HOW. Electron's `-r` loads this in the main process before the app's own
 * entrypoint, so it can wrap `ipcMain.handle` and decorate each listener as the
 * app registers it. Registering a handler directly here would make the app's
 * own `ipcMain.handle` for the same channel throw ("Attempted to register a
 * second handler") and take the app down — the same reason
 * `desktop-auth-state-gate-preload.cjs` wraps rather than registers.
 *
 * Loaded ONLY when the env var is set, and only ever from `test/e2e/helpers` —
 * it ships in no build.
 */

const { ipcMain } = require("electron");

/** `DesktopAuthIpcChannel.BeginSignIn`. */
const BEGIN_SIGN_IN_CHANNEL = "desktop:begin-desktop-sign-in";

/** `GitHubConnectOpenerIpcChannel.Open`. */
const OPEN_GITHUB_CONNECT_CHANNEL = "desktop:open-github-connect";

/** Read from the spec through `ElectronApplication.evaluate`. */
const GATE_KEY = "__clE2eGitHubConnectLegGate";

if (process.env.CL_E2E_GITHUB_CONNECT_LEG_GATE === "1") {
  const gate = {
    /** Sign-in invocations rejected so far — the gate's proof of effect. */
    signInsRejected: 0,
    /**
     * Connect hand-offs that reached main. The assertion this gate exists for
     * is that this stays ZERO when the sign-in leg rejects, so it has to be
     * counted rather than inferred from the absence of a browser window.
     */
    connectsReached: 0,
  };
  globalThis[GATE_KEY] = gate;

  const registerHandler = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) => {
    if (channel === BEGIN_SIGN_IN_CHANNEL) {
      return registerHandler(channel, () => {
        gate.signInsRejected += 1;
        throw new Error("e2e: device authorization refused");
      });
    }
    if (channel === OPEN_GITHUB_CONNECT_CHANNEL) {
      return registerHandler(channel, () => {
        gate.connectsReached += 1;
        return { ok: false, reason: "e2e: connect leg must not be reached" };
      });
    }
    return registerHandler(channel, listener);
  };
}
