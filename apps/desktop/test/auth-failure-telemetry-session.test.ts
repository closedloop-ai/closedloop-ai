/**
 * @file auth-failure-telemetry-session.test.ts
 * @description ISS-6334 coverage for the auth-failure reports that originate in
 * `DesktopSessionManager` — the cases where the reporter must fire, and the
 * cases where it must NOT.
 *
 * Split from `auth-failure-telemetry.test.ts`, which owns the relay/socket
 * sources and is at the file-size ceiling.
 */
import assert from "node:assert/strict";
import { AuthOutcome, AuthReason } from "@closedloop-ai/telemetry-contract/app";
import { describe, test } from "vitest";
import type { DesktopAuthFailureEventInput } from "../src/main/cloud/auth-failure-telemetry.js";
import { DesktopSessionRequestError } from "../src/main/session/desktop-session-client.js";
import type { SafeStorageLike } from "../src/main/util/electron-safe-storage.js";
import {
  createLoopbackStub,
  createManager,
  installTempRoot,
  storedRecord,
} from "./helpers/desktop-session-manager-fixtures.js";

installTempRoot();

/**
 * A keystore that accepts writes and then cannot read them back. This is the
 * difference between the two states `getSession()` collapses into one `null`:
 * a session IS persisted, the install just cannot decrypt it.
 */
const UNREADABLE_KEYSTORE: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(value, "utf8"),
  decryptString: () => {
    throw new Error("keystore unavailable");
  },
};

describe("ISS-6334: an unreadable session is not an ordinary sign-out", () => {
  test("a persisted session the install cannot read reports; an absent one does not", async () => {
    // `getSession()` returns null for four situations — nothing stored,
    // safeStorage unavailable, a failed decrypt, and a corrupt record — and
    // `restore()` used to treat all four as a sign-out and return before the
    // reporter could run. Only the FIRST is an ordinary sign-out; the rest are
    // a broken install that goes quiet on every authenticated lane.
    for (const testCase of [
      { persisted: true, expectedReports: 1 },
      { persisted: false, expectedReports: 0 },
    ]) {
      const storeName = `dsm-unreadable-${testCase.persisted}`;
      if (testCase.persisted) {
        // Persist through a WORKING keystore, so the blob on disk is real.
        const seed = createManager({ storeName });
        seed.store.setSession(storedRecord());
      }

      const reported: DesktopAuthFailureEventInput[] = [];
      const { manager, store } = createManager({
        storeName,
        safeStorage: UNREADABLE_KEYSTORE,
        reportAuthFailure: (input) => reported.push(input),
      });
      // The precondition the fix turns on: a blob is present but unreadable.
      assert.equal(store.hasSession(), testCase.persisted);
      assert.equal(store.getSession(), null);

      await manager.restore();

      assert.equal(
        reported.length,
        testCase.expectedReports,
        `persisted=${testCase.persisted} produced ${reported.length} report(s)`
      );
      if (testCase.expectedReports === 1) {
        assert.deepEqual(reported[0], {
          outcome: AuthOutcome.TokenRefreshFailed,
          reason: AuthReason.CredentialUnreadable,
        });
      }
    }
  });
});

describe("ISS-6334: a superseded sign-in does not spend the dedupe slot", () => {
  test("a canceled redeem that fails late is not reported", async () => {
    // The dedupe window is keyed on `outcome:reason`, so a report from a run
    // nobody is waiting for would suppress the REPLACEMENT run's real failure
    // for the whole window.
    const reported: DesktopAuthFailureEventInput[] = [];
    const loopback = createLoopbackStub();
    loopback.state.redeemResult = {
      ok: false,
      error: DesktopSessionRequestError.Unavailable,
      retryable: true,
    };
    const { manager } = createManager({
      browserSignIn: loopback.deps,
      storeName: "dsm-auth-failure-superseded",
      reportAuthFailure: (input) => reported.push(input),
    });
    // The user cancels while the redeem is in flight; it then fails anyway.
    loopback.state.onRedeem = () => manager.cancelSignIn();

    const result = await manager.beginBrowserSignIn();

    // Positive control: the redeem really ran and really failed, so a green
    // assertion below is not just "nothing happened".
    assert.equal(loopback.state.redeemCalls, 1);
    assert.deepEqual(result, { ok: false, reason: "cancelled" });
    assert.deepEqual(reported, []);
  });

  test("the same failure on a live run IS reported", async () => {
    // The other half of the pair: without this, deleting the reporter outright
    // would leave the test above green.
    const reported: DesktopAuthFailureEventInput[] = [];
    const loopback = createLoopbackStub();
    loopback.state.redeemResult = {
      ok: false,
      error: DesktopSessionRequestError.Unavailable,
      retryable: true,
    };
    const { manager } = createManager({
      browserSignIn: loopback.deps,
      storeName: "dsm-auth-failure-live",
      reportAuthFailure: (input) => reported.push(input),
    });

    const result = await manager.beginBrowserSignIn();

    assert.deepEqual(result, { ok: false, reason: "exchange_failed" });
    assert.deepEqual(reported, [
      {
        outcome: AuthOutcome.SignInExchangeFailed,
        reason: AuthReason.ServerUnavailable,
      },
    ]);
  });
});
