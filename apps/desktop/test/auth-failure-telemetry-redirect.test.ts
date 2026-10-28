import assert from "node:assert/strict";
import { AuthOutcome, AuthReason } from "@closedloop-ai/telemetry-contract/app";
import {
  DesktopSignInFraming,
  DesktopSignInMethod,
} from "@repo/api/src/types/desktop-authorize-url";
import { test } from "vitest";
import {
  createAuthFailureTelemetry,
  type DesktopAuthFailureEventInput,
} from "../src/main/cloud/auth-failure-telemetry.js";
import { DesktopAuthStatus } from "../src/shared/contracts.js";
import { deferred } from "./deferred.js";
import {
  createLoopbackStub,
  createManager,
  installTempRoot,
} from "./helpers/desktop-session-manager-fixtures.js";

installTempRoot();

test.each([
  [undefined, AuthOutcome.SignInRedirectFailed],
  [DesktopSignInFraming.SignIn, AuthOutcome.SignInRedirectFailed],
  [DesktopSignInFraming.SignUp, AuthOutcome.SignUpRedirectFailed],
] as const)(
  "ISS-11394: no callback with framing %s reports %s",
  async (framing, outcome) => {
    const reported: DesktopAuthFailureEventInput[] = [];
    const loopback = createLoopbackStub();
    loopback.state.callbackGate = deferred<void>();
    loopback.state.timeoutFires = true;
    const { manager, store } = createManager({
      browserSignIn: loopback.deps,
      reportAuthFailure: (input) => reported.push(input),
    });

    const result = await manager.beginBrowserSignIn(
      DesktopSignInMethod.Email,
      undefined,
      framing
    );

    assert.deepEqual(result, { ok: false, reason: "redirect_timeout" });
    assert.equal(loopback.state.waitCalls, 1);
    assert.equal(loopback.state.redeemCalls, 0);
    assert.equal(loopback.state.closeCalls, 1);
    assert.equal(manager.getState().status, DesktopAuthStatus.SignedOut);
    assert.equal(store.getSession(), null);
    assert.deepEqual(reported, [
      { outcome, reason: AuthReason.RedirectTimeout },
    ]);
  }
);

test.each(["wrong_state", "missing_code"] as const)(
  "ISS-11394: %s reports a redirect failure without exchanging",
  async (failure) => {
    const reported: DesktopAuthFailureEventInput[] = [];
    const loopback = createLoopbackStub();
    if (failure === "wrong_state") {
      loopback.state.callbackValue.state = "foreign-state";
      loopback.state.callbackValue.accountCreated = true;
    } else {
      loopback.state.callbackValue.code = null;
    }
    const { manager } = createManager({
      browserSignIn: loopback.deps,
      reportAuthFailure: (input) => reported.push(input),
    });

    assert.deepEqual(await manager.beginBrowserSignIn(), {
      ok: false,
      reason: "state_mismatch",
    });
    assert.equal(loopback.state.redeemCalls, 0);
    assert.deepEqual(reported, [
      {
        outcome: AuthOutcome.SignInRedirectFailed,
        reason: AuthReason.CallbackInvalid,
      },
    ]);
  }
);

test.each(["user_cancel", "superseded_timeout", "browser_cancel"] as const)(
  "ISS-11394: %s never reports",
  async (cancellation) => {
    const reported: DesktopAuthFailureEventInput[] = [];
    const loopback = createLoopbackStub();
    const { manager } = createManager({
      browserSignIn: loopback.deps,
      reportAuthFailure: (input) => reported.push(input),
    });
    if (cancellation === "browser_cancel") {
      loopback.state.callbackValue.error = "access_denied";
    } else {
      loopback.state.callbackGate = deferred<void>();
      loopback.state.timeoutFires = cancellation === "superseded_timeout";
      loopback.state.onWait = () => manager.cancelSignIn();
    }

    assert.deepEqual(await manager.beginBrowserSignIn(), {
      ok: false,
      reason: "cancelled",
    });
    assert.equal(loopback.state.waitCalls, 1);
    assert.equal(loopback.state.redeemCalls, 0);
    assert.deepEqual(reported, []);
  }
);

test("ISS-11394: a canceled timeout cannot suppress its replacement's real failure", async () => {
  const emitted: DesktopAuthFailureEventInput[] = [];
  const telemetry = createAuthFailureTelemetry({
    now: () => 0,
    emit: (input) => {
      emitted.push(input);
      return true;
    },
  });
  const loopback = createLoopbackStub();
  loopback.state.callbackGate = deferred<void>();
  loopback.state.timeoutFires = true;
  const { manager } = createManager({
    browserSignIn: loopback.deps,
    reportAuthFailure: telemetry.report,
  });
  loopback.state.onWait = () => manager.cancelSignIn();

  assert.deepEqual(await manager.beginBrowserSignIn(), {
    ok: false,
    reason: "cancelled",
  });
  assert.deepEqual(emitted, []);
  loopback.state.onWait = undefined;
  assert.deepEqual(await manager.beginBrowserSignIn(), {
    ok: false,
    reason: "redirect_timeout",
  });
  assert.deepEqual(emitted, [
    {
      outcome: AuthOutcome.SignInRedirectFailed,
      reason: AuthReason.RedirectTimeout,
    },
  ]);
});

test.each([
  ["open_failed", AuthReason.BrowserOpenFailed],
  ["start_failed", AuthReason.SignInStartFailed],
] as const)(
  "ISS-11394: a run that ends %s, with no callback, reports %s",
  async (failure, reason) => {
    const reported: DesktopAuthFailureEventInput[] = [];
    const loopback = createLoopbackStub();
    if (failure === "open_failed") {
      loopback.state.openShouldThrow = true;
    } else {
      loopback.state.listenerStartRejects = true;
    }
    const { manager } = createManager({
      browserSignIn: loopback.deps,
      reportAuthFailure: (input) => reported.push(input),
    });

    assert.deepEqual(await manager.beginBrowserSignIn(), {
      ok: false,
      reason: failure,
    });
    assert.equal(loopback.state.redeemCalls, 0);
    assert.deepEqual(reported, [
      { outcome: AuthOutcome.SignInRedirectFailed, reason },
    ]);
  }
);

test("ISS-11394: a timeout does not dedupe a callback failure on the same install", async () => {
  const emitted: DesktopAuthFailureEventInput[] = [];
  const telemetry = createAuthFailureTelemetry({
    now: () => 0,
    emit: (input) => {
      emitted.push(input);
      return true;
    },
  });
  const loopback = createLoopbackStub();
  loopback.state.callbackGate = deferred<void>();
  loopback.state.timeoutFires = true;
  const { manager } = createManager({
    browserSignIn: loopback.deps,
    reportAuthFailure: telemetry.report,
  });

  await manager.beginBrowserSignIn();
  loopback.state.callbackGate = undefined;
  loopback.state.timeoutFires = false;
  loopback.state.callbackValue.state = "foreign-state";
  await manager.beginBrowserSignIn();

  assert.deepEqual(
    emitted.map((input) => input.reason),
    [AuthReason.RedirectTimeout, AuthReason.CallbackInvalid]
  );
});
