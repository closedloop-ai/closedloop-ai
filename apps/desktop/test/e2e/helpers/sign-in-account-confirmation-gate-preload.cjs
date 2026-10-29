"use strict";

/**
 * E2E-only: stand in for main's side of a confirmation-gated sign-in
 * (ISS-11345), so a launched app can show the account-confirmation dialog and
 * prove what the user's answer sends.
 *
 * WHY THIS EXISTS. A real sign-in in an E2E profile opens the operator's
 * browser and waits on a person, and a real confirmation needs a redeemed
 * session to hold. The main-process half — holding, adopting, revoking — is
 * pinned by `test/desktop-session-manager-sign-in-confirmation.test.ts`; what
 * only a launched app can prove is the rest: the dashboard card asking for a
 * confirmation over the real preload, the real `DesktopAuthProvider` rendering
 * the held account from a real state push, and the dialog's answer reaching
 * main on the right channel.
 *
 * WHAT IS SUBSTITUTED: the answers of the begin, cancel, and confirm sign-in
 * channels. Begin records its options and, when a confirmation was asked for,
 * pushes a held-account state and parks until cancel or confirm. Neither answer
 * signs anyone in: both push signed-out and settle begin as not-ok, so the
 * GitHub connect leg never runs and no browser is launched from a test.
 *
 * HOW. Loaded with Electron's `-r` before the app's entrypoint so it can wrap
 * `ipcMain.handle` — registering directly would collide with the app's own
 * handler ("Attempted to register a second handler"), the same reason
 * `github-connect-leg-gate-preload.cjs` wraps.
 *
 * Loaded ONLY when the env var is set, and only from `test/e2e/helpers`.
 */

const { ipcMain } = require("electron");

/** `DesktopAuthIpcChannel.BeginSignIn`. */
const BEGIN_SIGN_IN_CHANNEL = "desktop:begin-desktop-sign-in";
/** `DesktopAuthIpcChannel.CancelSignIn`. */
const CANCEL_SIGN_IN_CHANNEL = "desktop:cancel-desktop-sign-in";
/** `DesktopAuthIpcChannel.ConfirmSignIn`. */
const CONFIRM_SIGN_IN_CHANNEL = "desktop:confirm-desktop-sign-in";
/** `DESKTOP_AUTH_STATE_CHANGED_CHANNEL`. */
const AUTH_STATE_CHANGED_CHANNEL = "desktop:auth-state-changed";

/** Read from the spec through `ElectronApplication.evaluate`. */
const GATE_KEY = "__clE2eSignInAccountConfirmationGate";

/** The account the gate claims the browser returned. Mirrored in the spec. */
const HELD_ACCOUNT = {
  userId: "iss-11345-user",
  organizationId: "iss-11345-org",
  email: "someone-else@iss-11345.test",
  firstName: "Someone",
  lastName: "Else",
  organizationName: "Their Org",
};

const SIGNED_OUT = { status: "signed_out", userId: null, organizationId: null };

if (process.env.CL_E2E_SIGN_IN_ACCOUNT_CONFIRMATION_GATE === "1") {
  const gate = {
    /** Begin calls that asked for a confirmation. */
    confirmationsRequested: 0,
    cancels: 0,
    confirms: 0,
    /** Settles the parked begin, if one is parked. */
    settle: null,
  };
  globalThis[GATE_KEY] = gate;

  let sender = null;
  const answer = () => {
    sender?.send(AUTH_STATE_CHANGED_CHANNEL, SIGNED_OUT);
    gate.settle?.({ ok: false, reason: "cancelled" });
    gate.settle = null;
  };

  const registerHandler = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) => {
    if (channel === BEGIN_SIGN_IN_CHANNEL) {
      return registerHandler(channel, (event, ...args) => {
        const options = args[3];
        if (!options?.confirmAccount) {
          return { ok: false, reason: "unavailable" };
        }
        gate.confirmationsRequested += 1;
        sender = event.sender;
        sender.send(AUTH_STATE_CHANGED_CHANNEL, {
          status: "exchanging",
          userId: null,
          organizationId: null,
          pendingAccount: HELD_ACCOUNT,
        });
        return new Promise((resolve) => {
          gate.settle = resolve;
        });
      });
    }
    if (channel === CANCEL_SIGN_IN_CHANNEL) {
      return registerHandler(channel, () => {
        gate.cancels += 1;
        answer();
      });
    }
    if (channel === CONFIRM_SIGN_IN_CHANNEL) {
      return registerHandler(channel, () => {
        gate.confirms += 1;
        answer();
      });
    }
    return registerHandler(channel, listener);
  };
}
