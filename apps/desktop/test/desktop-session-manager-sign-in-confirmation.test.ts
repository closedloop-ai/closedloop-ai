/**
 * ISS-11345 — a browser sign-in that confirms its account.
 *
 * The system browser decides which account comes back, so a shared browser can
 * hand Desktop someone else's session. With a confirmation, the redeemed session
 * must stay unadopted — no stored record, no access token, no authenticated
 * status — until the user confirms, and anything else must leave them a guest
 * with the redeemed session revoked.
 */

import assert from "node:assert/strict";
import { AuthOutcome, AuthReason } from "@closedloop-ai/telemetry-contract/app";
import type { DesktopIdentity } from "@repo/api/src/types/desktop-identity";
import { describe, test } from "vitest";
import type { DesktopAuthFailureEventInput } from "../src/main/cloud/auth-failure-telemetry.js";
import { DesktopAuthStatus } from "../src/shared/contracts.js";
import { deferred } from "./deferred.js";
import {
  createLoopbackStub,
  createManager,
  createStubClient,
  installTempRoot,
} from "./helpers/desktop-session-manager-fixtures.js";

installTempRoot();

const ACCOUNT: DesktopIdentity = {
  userId: "user-1",
  organizationId: "org-1",
  email: "someone-else@closedloop.test",
  firstName: "Someone",
  lastName: "Else",
  organizationName: "Their Org",
};

function setUp(
  fetchAccount: (token: string) => Promise<DesktopIdentity | null>
) {
  const loopback = createLoopbackStub();
  const stub = createStubClient();
  const revokedRefreshTokens: string[] = [];
  stub.client.revoke = (input?: { refreshToken: string }) => {
    revokedRefreshTokens.push(input?.refreshToken ?? "");
    // Answers a macrotask later, as the network does, so a caller that does
    // not wait for the revoke cannot see the cleanup that follows it.
    return new Promise((resolve) => {
      setImmediate(() => resolve({ ok: true, value: true }));
    });
  };
  const fetchedWith: string[] = [];
  const authFailures: DesktopAuthFailureEventInput[] = [];
  const { manager, store } = createManager({
    stub,
    reportAuthFailure: (input) => authFailures.push(input),
    browserSignIn: {
      ...loopback.deps,
      fetchAccount: (token) => {
        fetchedWith.push(token);
        return fetchAccount(token);
      },
    },
    storeName: "dsm-signin-confirm",
  });
  const statuses: string[] = [];
  manager.subscribe((state) => statuses.push(state.status));
  const awaiting = deferred();
  const run = manager.beginBrowserSignIn(undefined, undefined, undefined, {
    onAwaitingConfirmation: () => awaiting.resolve(),
  });
  // Which happened first: the run holding the account for the user, or the
  // run settling without asking. Racing them keeps a wrong answer a fast,
  // named failure instead of a hang on the one that never comes.
  const firstOutcome = Promise.race([
    awaiting.promise.then(() => HELD),
    run.then(() => SETTLED),
  ]);
  return {
    loopback: loopback.state,
    manager,
    store,
    statuses,
    firstOutcome,
    run,
    revokedRefreshTokens,
    fetchedWith,
    authFailures,
  };
}

const HELD = "held for confirmation";
const SETTLED = "settled without asking";

test("nothing is adopted until the user confirms the account", async () => {
  const t = setUp(() => Promise.resolve(ACCOUNT));

  assert.equal(await t.firstOutcome, HELD);

  const held = t.manager.getState();
  assert.equal(held.status, DesktopAuthStatus.Exchanging);
  assert.deepEqual(held.pendingAccount, ACCOUNT);
  assert.equal(held.userId, null);
  assert.equal(held.organizationId, null);
  assert.equal(t.manager.isAuthenticated(), false);
  assert.equal(t.manager.getIdentity(), null);
  assert.equal(await t.manager.getAccessToken(), null);
  assert.equal(t.store.getSession(), null, "nothing persisted before confirm");
  assert.equal(t.statuses.includes(DesktopAuthStatus.Authenticated), false);
  assert.deepEqual(t.fetchedWith, ["access-1"], "read with the redeemed token");

  t.manager.confirmPendingSignIn();

  assert.deepEqual(await t.run, { ok: true });
  const adopted = t.manager.getState();
  assert.equal(adopted.status, DesktopAuthStatus.Authenticated);
  assert.equal(adopted.userId, "user-1");
  assert.equal(adopted.pendingAccount, undefined);
  assert.equal(t.store.getSession()?.refreshToken, "redeemed-refresh");
  assert.deepEqual(t.revokedRefreshTokens, []);
});

test("cancelling the confirmation leaves the user a guest", async () => {
  const t = setUp(() => Promise.resolve(ACCOUNT));

  assert.equal(await t.firstOutcome, HELD);
  t.manager.cancelSignIn();

  assert.deepEqual(await t.run, { ok: false, reason: "cancelled" });
  const state = t.manager.getState();
  assert.equal(state.status, DesktopAuthStatus.SignedOut);
  assert.equal(state.pendingAccount, undefined);
  assert.equal(t.store.getSession(), null);
  assert.equal(await t.manager.getAccessToken(), null);
  assert.equal(t.statuses.includes(DesktopAuthStatus.Authenticated), false);
  assert.deepEqual(t.revokedRefreshTokens, ["redeemed-refresh"]);
  // Declining is the user's answer, not an auth failure.
  assert.deepEqual(t.authFailures, []);

  // A confirm that lands after the cancel has nothing left to adopt.
  t.manager.confirmPendingSignIn();
  assert.equal(t.manager.getState().status, DesktopAuthStatus.SignedOut);
  assert.equal(t.store.getSession(), null);
});

test("quitting while the account is held revokes it and frees the listener", async () => {
  const t = setUp(() => Promise.resolve(ACCOUNT));

  assert.equal(await t.firstOutcome, HELD);
  await t.manager.releaseSignIn();

  assert.deepEqual(t.revokedRefreshTokens, ["redeemed-refresh"]);
  assert.equal(t.loopback.closeCalls, 1);
  assert.equal(t.store.getSession(), null);
  assert.equal(t.statuses.includes(DesktopAuthStatus.Authenticated), false);
});

test("a failed identity read is retried once, then the account is held", async () => {
  let reads = 0;
  const t = setUp(() => {
    reads += 1;
    return reads === 1
      ? Promise.reject(new Error("network blip"))
      : Promise.resolve(ACCOUNT);
  });

  assert.equal(await t.firstOutcome, HELD);
  assert.deepEqual(t.fetchedWith, ["access-1", "access-1"]);
  t.manager.confirmPendingSignIn();

  assert.deepEqual(await t.run, { ok: true });
  assert.equal(t.manager.getState().status, DesktopAuthStatus.Authenticated);
  assert.deepEqual(t.revokedRefreshTokens, []);
  assert.deepEqual(t.authFailures, []);
});

describe("an account Desktop cannot show is never adopted", () => {
  test.each([
    ["the identity read returns nothing", () => Promise.resolve(null), 2],
    [
      "the identity read fails",
      () => Promise.reject(new Error("network down")),
      2,
    ],
    [
      "the identity names a different user",
      () => Promise.resolve({ ...ACCOUNT, userId: "user-2" }),
      1,
    ],
  ] as const)("%s", async (_label, fetchAccount, reads) => {
    const t = setUp(fetchAccount);

    assert.equal(await t.firstOutcome, SETTLED);
    assert.equal(t.fetchedWith.length, reads);
    assert.deepEqual(await t.run, { ok: false, reason: "exchange_failed" });
    const state = t.manager.getState();
    assert.equal(state.status, DesktopAuthStatus.SignedOut);
    assert.equal(state.pendingAccount, undefined);
    assert.equal(t.store.getSession(), null);
    assert.equal(t.statuses.includes(DesktopAuthStatus.Authenticated), false);
    assert.deepEqual(t.revokedRefreshTokens, ["redeemed-refresh"]);
    assert.deepEqual(t.authFailures, [
      {
        outcome: AuthOutcome.SignInExchangeFailed,
        reason: AuthReason.IdentityReadFailed,
      },
    ]);
  });
});
