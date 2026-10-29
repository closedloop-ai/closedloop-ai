import assert from "node:assert/strict";
import { AuthOutcome, AuthReason } from "@closedloop-ai/telemetry-contract/app";
import { test } from "vitest";
import type { DesktopAuthFailureEventInput } from "../src/main/cloud/auth-failure-telemetry.js";
import { DesktopSessionRequestError } from "../src/main/session/desktop-session-client.js";
import {
  createLoopbackStub,
  createManager,
  installTempRoot,
} from "./helpers/desktop-session-manager-fixtures.js";

installTempRoot();

test.each([
  [false, AuthOutcome.SignInExchangeFailed],
  [true, AuthOutcome.SignUpExchangeFailed],
] as const)(
  "ISS-11394: accountCreated=%s reports %s",
  async (accountCreated, outcome) => {
    const reported: DesktopAuthFailureEventInput[] = [];
    const loopback = createLoopbackStub();
    loopback.state.callbackValue.accountCreated = accountCreated;
    loopback.state.redeemResult = {
      ok: false,
      error: DesktopSessionRequestError.Unavailable,
      retryable: true,
    };
    const { manager } = createManager({
      browserSignIn: loopback.deps,
      reportAuthFailure: (input) => reported.push(input),
    });

    assert.deepEqual(await manager.beginBrowserSignIn(), {
      ok: false,
      reason: "exchange_failed",
    });
    assert.equal(loopback.state.redeemCalls, 1);
    assert.deepEqual(reported, [
      { outcome, reason: AuthReason.ServerUnavailable },
    ]);
  }
);

test("ISS-11394: an unreadable sign-up account reports the sign-up arm", async () => {
  const reported: DesktopAuthFailureEventInput[] = [];
  const loopback = createLoopbackStub();
  loopback.state.callbackValue.accountCreated = true;
  const { manager, store } = createManager({
    browserSignIn: {
      ...loopback.deps,
      fetchAccount: () => Promise.resolve(null),
    },
    reportAuthFailure: (input) => reported.push(input),
  });

  const result = await manager.beginBrowserSignIn(
    undefined,
    undefined,
    undefined,
    {
      onAwaitingConfirmation: () =>
        assert.fail("unreadable account cannot be confirmed"),
    }
  );

  assert.deepEqual(result, { ok: false, reason: "exchange_failed" });
  assert.equal(store.getSession(), null);
  assert.deepEqual(reported, [
    {
      outcome: AuthOutcome.SignUpExchangeFailed,
      reason: AuthReason.IdentityReadFailed,
    },
  ]);
});
