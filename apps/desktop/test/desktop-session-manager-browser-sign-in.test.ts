/**
 * `DesktopSessionManager.beginBrowserSignIn` — the loopback OAuth flow.
 *
 * Split out of `desktop-session-manager.test.ts` (ISS-5112), which had grown
 * past its grandfathered ceiling. This half owns one responsibility: the browser
 * hand-off — opening the authorize URL, the loopback callback race, cancellation,
 * and every way the round trip can fail. Restore/refresh/sign-out and the
 * existing-user prompt stay in the original file.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DESKTOP_AUTHORIZE_QUERY_PARAMS,
  DesktopSignInProvider,
} from "@repo/api/src/types/desktop-authorize-url";
import { DesktopAuthStatus } from "../src/shared/contracts.js";
import { deferred } from "./deferred.js";
import {
  API_ORIGIN,
  AUTHORIZE_REDIRECT_URI,
  createLoopbackStub,
  createManager,
  installTempRoot,
  storedRecord,
} from "./helpers/desktop-session-manager-fixtures.js";

installTempRoot();

test("beginBrowserSignIn opens the authorize URL, redeems the callback code, and authenticates", async () => {
  const loopback = createLoopbackStub();
  const { manager, store } = createManager({
    browserSignIn: loopback.deps,
    storeName: "dsm-signin-ok",
  });
  const statuses: string[] = [];
  manager.subscribe((state) => statuses.push(state.status));

  const result = await manager.beginBrowserSignIn();

  assert.deepEqual(result, { ok: true });
  const opened = new URL(loopback.state.openCalls[0]);
  const openedParams = opened.searchParams;
  const key = DESKTOP_AUTHORIZE_QUERY_PARAMS;
  assert.equal(opened.origin, "https://app.closedloop.test");
  assert.equal(opened.pathname, "/settings/integrations/desktop/authorize");
  assert.equal(openedParams.get(key.codeChallenge), "challenge-1");
  assert.equal(openedParams.get(key.codeChallengeMethod), "S256");
  assert.equal(openedParams.get(key.state), "state-1");
  assert.equal(openedParams.get(key.redirectUri), AUTHORIZE_REDIRECT_URI);
  assert.equal(openedParams.get(key.gatewayId), "gateway-1");
  assert.equal(openedParams.get(key.deviceName), "test-machine");

  const redeemInput = loopback.state.redeemInputs[0];
  assert.equal(redeemInput.apiOrigin, API_ORIGIN);
  assert.equal(redeemInput.code, "auth-code");
  assert.equal(redeemInput.codeVerifier, "verifier-1");
  assert.equal(redeemInput.gatewayId, "gateway-1");
  assert.equal(redeemInput.redirectUri, AUTHORIZE_REDIRECT_URI);

  assert.equal(manager.getState().status, DesktopAuthStatus.Authenticated);
  assert.deepEqual(manager.getIdentity(), {
    userId: "user-1",
    organizationId: "org-1",
  });
  assert.equal(store.getSession()?.refreshToken, "redeemed-refresh");
  assert.equal(loopback.state.closeCalls, 1, "listener closed after success");
  assert.equal(
    loopback.state.timeoutSignal?.aborted,
    true,
    "callback-timeout timer torn down once the callback won"
  );
  assert.deepEqual(statuses, [
    DesktopAuthStatus.OpeningBrowser,
    DesktopAuthStatus.AwaitingRedirect,
    DesktopAuthStatus.Exchanging,
    DesktopAuthStatus.Authenticated,
  ]);
});

// ISS-5112 — the seam between the IPC handler and the URL builder. Both ends are
// tested on their own, so dropping `provider` HERE (the manager forgetting to
// thread it through prepareSignIn) leaves every other test green while the
// browser opens GitHub for a person who picked Google.
test("beginBrowserSignIn carries the picked provider onto the opened URL", async () => {
  const loopback = createLoopbackStub();
  const { manager } = createManager({
    browserSignIn: loopback.deps,
    storeName: "dsm-signin-provider-google",
  });

  await manager.beginBrowserSignIn(DesktopSignInProvider.Google);

  assert.equal(loopback.state.openCalls.length, 1, "browser opened once");
  const opened = new URL(loopback.state.openCalls[0] ?? "");
  assert.equal(
    opened.searchParams.get(DESKTOP_AUTHORIZE_QUERY_PARAMS.provider),
    DesktopSignInProvider.Google
  );
});

test("beginBrowserSignIn opens a provider-free URL when no method was named", async () => {
  // The version-skew shape: an older renderer passes nothing, and the URL has to
  // stay byte-identical to the one this flow always produced.
  const loopback = createLoopbackStub();
  const { manager } = createManager({
    browserSignIn: loopback.deps,
    storeName: "dsm-signin-provider-absent",
  });

  await manager.beginBrowserSignIn();

  const opened = new URL(loopback.state.openCalls[0] ?? "");
  assert.equal(
    opened.searchParams.has(DESKTOP_AUTHORIZE_QUERY_PARAMS.provider),
    false
  );
});

test("beginBrowserSignIn returns start_failed when a resolver port throws", async () => {
  const loopback = createLoopbackStub();
  loopback.state.descriptorThrows = true;
  const { manager } = createManager({
    browserSignIn: loopback.deps,
    storeName: "dsm-signin-descriptor-throw",
  });

  const result = await manager.beginBrowserSignIn();

  assert.deepEqual(result, { ok: false, reason: "start_failed" });
  assert.equal(loopback.state.openCalls.length, 0, "browser never opened");
  assert.equal(
    manager.getState().status,
    DesktopAuthStatus.SignedOut,
    "never stranded in opening_browser"
  );
  assert.deepEqual(
    loopback.state.diagnostics,
    ["Browser sign-in failed to start: signing key unavailable"],
    "the swallowed root cause is surfaced to diagnostics"
  );
});

test("beginBrowserSignIn returns start_failed when the loopback listener won't start", async () => {
  const loopback = createLoopbackStub();
  loopback.state.listenerStartRejects = true;
  const { manager } = createManager({
    browserSignIn: loopback.deps,
    storeName: "dsm-signin-listener-fail",
  });

  const result = await manager.beginBrowserSignIn();

  assert.deepEqual(result, { ok: false, reason: "start_failed" });
  assert.equal(loopback.state.openCalls.length, 0);
  assert.deepEqual(
    loopback.state.diagnostics,
    ["Browser sign-in failed to start: port bind failed"],
    "the loopback bind failure is surfaced to diagnostics"
  );
});

test("beginBrowserSignIn returns open_failed and closes the listener when the browser can't launch", async () => {
  const loopback = createLoopbackStub();
  loopback.state.openShouldThrow = true;
  const { manager } = createManager({
    browserSignIn: loopback.deps,
    storeName: "dsm-signin-open-fail",
  });

  const result = await manager.beginBrowserSignIn();

  assert.deepEqual(result, { ok: false, reason: "open_failed" });
  assert.equal(loopback.state.closeCalls, 1, "listener closed on open failure");
  assert.equal(manager.getState().status, DesktopAuthStatus.SignedOut);
});

test("beginBrowserSignIn rejects a callback whose state does not match", async () => {
  const loopback = createLoopbackStub();
  loopback.state.callbackValue = {
    code: "auth-code",
    state: "wrong-state",
    error: null,
  };
  const { manager } = createManager({
    browserSignIn: loopback.deps,
    storeName: "dsm-signin-state-mismatch",
  });

  const result = await manager.beginBrowserSignIn();

  assert.deepEqual(result, { ok: false, reason: "state_mismatch" });
  assert.equal(loopback.state.redeemCalls, 0, "no redeem on state mismatch");
  assert.equal(manager.getState().status, DesktopAuthStatus.SignedOut);
});

test("beginBrowserSignIn settles as cancelled when the web consent screen reports access_denied", async () => {
  // Cancelling on the web used to be purely client-side: the tab said "return
  // to the desktop app" while the desktop sat in AwaitingRedirect until the
  // sign-in timeout. The consent screen now hands the loopback an `error`, and
  // this is the desktop half that answers it immediately.
  const loopback = createLoopbackStub();
  loopback.state.callbackValue = {
    code: null,
    state: "state-1",
    error: "access_denied",
  };
  const { manager } = createManager({
    browserSignIn: loopback.deps,
    storeName: "dsm-signin-denied",
  });

  const result = await manager.beginBrowserSignIn();

  assert.deepEqual(result, { ok: false, reason: "cancelled" });
  assert.equal(loopback.state.redeemCalls, 0);
  assert.equal(manager.getState().status, DesktopAuthStatus.SignedOut);
});

test("beginBrowserSignIn treats an error callback carrying the WRONG state as a mismatch", async () => {
  // The state check runs first, so a page that is not our redirect cannot end
  // our run just by claiming a cancel.
  const loopback = createLoopbackStub();
  loopback.state.callbackValue = {
    code: null,
    state: "wrong-state",
    error: "access_denied",
  };
  const { manager } = createManager({
    browserSignIn: loopback.deps,
    storeName: "dsm-signin-denied-wrong-state",
  });

  const result = await manager.beginBrowserSignIn();

  assert.deepEqual(result, { ok: false, reason: "state_mismatch" });
  assert.equal(loopback.state.redeemCalls, 0);
});

test("beginBrowserSignIn rejects a callback with no code as a state mismatch", async () => {
  const loopback = createLoopbackStub();
  loopback.state.callbackValue = { code: null, state: "state-1", error: null };
  const { manager } = createManager({
    browserSignIn: loopback.deps,
    storeName: "dsm-signin-no-code",
  });

  const result = await manager.beginBrowserSignIn();

  assert.deepEqual(result, { ok: false, reason: "state_mismatch" });
  assert.equal(loopback.state.redeemCalls, 0);
});

test("beginBrowserSignIn times out when no loopback callback arrives", async () => {
  const loopback = createLoopbackStub();
  loopback.state.callbackGate = deferred<void>(); // callback never resolves
  loopback.state.timeoutFires = true;
  const { manager } = createManager({
    browserSignIn: loopback.deps,
    storeName: "dsm-signin-timeout",
  });

  const result = await manager.beginBrowserSignIn();

  assert.deepEqual(result, { ok: false, reason: "redirect_timeout" });
  assert.equal(loopback.state.redeemCalls, 0);
  assert.equal(loopback.state.closeCalls, 1, "listener closed on timeout");
  assert.equal(
    loopback.state.waitSignal?.aborted,
    true,
    "loopback wait torn down once the timeout won"
  );
  assert.equal(manager.getState().status, DesktopAuthStatus.SignedOut);
});

test("beginBrowserSignIn maps an invalid/expired code to expired", async () => {
  const loopback = createLoopbackStub();
  loopback.state.redeemResult = {
    ok: false,
    error: "invalid",
    retryable: false,
  };
  const { manager, store } = createManager({
    browserSignIn: loopback.deps,
    storeName: "dsm-signin-code-invalid",
  });

  const result = await manager.beginBrowserSignIn();

  assert.deepEqual(result, { ok: false, reason: "expired" });
  assert.equal(store.hasSession(), false);
  assert.equal(manager.getState().status, DesktopAuthStatus.SignedOut);
});

test("beginBrowserSignIn maps a PoP-rejected redeem to exchange_failed", async () => {
  const loopback = createLoopbackStub();
  loopback.state.redeemResult = {
    ok: false,
    error: "pop_rejected",
    retryable: false,
  };
  const { manager, store } = createManager({
    browserSignIn: loopback.deps,
    storeName: "dsm-signin-redeem-pop",
  });

  const result = await manager.beginBrowserSignIn();

  assert.deepEqual(result, { ok: false, reason: "exchange_failed" });
  assert.equal(store.hasSession(), false);
  assert.equal(manager.getState().status, DesktopAuthStatus.SignedOut);
});

test("beginBrowserSignIn is unavailable without browser sign-in ports", async () => {
  const { manager } = createManager({ storeName: "dsm-signin-unavailable" });
  const result = await manager.beginBrowserSignIn();
  assert.deepEqual(result, { ok: false, reason: "unavailable" });
});

test("beginBrowserSignIn rejects a concurrent call as already_in_progress", async () => {
  const loopback = createLoopbackStub();
  const gate = deferred<void>();
  loopback.state.callbackGate = gate;
  const { manager } = createManager({
    browserSignIn: loopback.deps,
    storeName: "dsm-signin-concurrent",
  });

  const first = manager.beginBrowserSignIn();
  const second = await manager.beginBrowserSignIn();
  assert.deepEqual(second, { ok: false, reason: "already_in_progress" });

  gate.resolve();
  assert.deepEqual(await first, { ok: true });
});

test("beginBrowserSignIn rejects when a session already exists", async () => {
  const loopback = createLoopbackStub();
  const { manager, store } = createManager({
    browserSignIn: loopback.deps,
    storeName: "dsm-signin-have-session",
  });
  store.setSession(storedRecord());
  await manager.restore();
  assert.equal(manager.getState().status, DesktopAuthStatus.Authenticated);

  const result = await manager.beginBrowserSignIn();

  assert.deepEqual(result, { ok: false, reason: "already_in_progress" });
  assert.equal(loopback.state.openCalls.length, 0, "never opened a browser");
});

test("cancelSignIn frees the run slot so a later sign-in is not locked out", async () => {
  const loopback = createLoopbackStub();
  const gate = deferred<void>();
  loopback.state.callbackGate = gate;
  const { manager } = createManager({
    browserSignIn: loopback.deps,
    storeName: "dsm-signin-lockout",
  });

  // The first run parks awaiting the loopback callback; cancel releases the slot
  // synchronously so a second sign-in is not rejected as already_in_progress.
  const first = manager.beginBrowserSignIn();
  manager.cancelSignIn();
  loopback.state.callbackGate = undefined; // the retry's callback resolves at once
  const second = await manager.beginBrowserSignIn();

  assert.deepEqual(await first, { ok: false, reason: "cancelled" });
  assert.deepEqual(second, { ok: true });
  assert.equal(manager.getState().status, DesktopAuthStatus.Authenticated);
});

test("signOut cancels an in-flight browser sign-in", async () => {
  const loopback = createLoopbackStub();
  loopback.state.callbackGate = deferred<void>();
  const { manager } = createManager({
    browserSignIn: loopback.deps,
    storeName: "dsm-signin-signout",
  });
  // signOut() synchronously cancels the run the instant it parks on the callback.
  let signOut: Promise<void> | undefined;
  loopback.state.onWait = () => {
    signOut = manager.signOut();
  };

  const result = await manager.beginBrowserSignIn();
  await signOut;

  assert.deepEqual(result, { ok: false, reason: "cancelled" });
  assert.equal(manager.getState().status, DesktopAuthStatus.SignedOut);
});

test("a cancel during the redeem does not authenticate the device", async () => {
  const loopback = createLoopbackStub();
  const { manager, store } = createManager({
    browserSignIn: loopback.deps,
    storeName: "dsm-signin-cancel-redeem",
  });
  // Cancel fires the instant the redeem request is issued (mid round-trip).
  loopback.state.onRedeem = () => manager.cancelSignIn();

  const result = await manager.beginBrowserSignIn();

  assert.deepEqual(result, { ok: false, reason: "cancelled" });
  assert.equal(store.hasSession(), false, "no session persisted after cancel");
  assert.equal(manager.getState().status, DesktopAuthStatus.SignedOut);
  assert.equal(await manager.getAccessToken(), null);
});

test("a cancel during the async listener start never opens a browser", async () => {
  const loopback = createLoopbackStub();
  const startGate = deferred<void>();
  loopback.state.listenerStartGate = startGate;
  const { manager } = createManager({
    browserSignIn: loopback.deps,
    storeName: "dsm-signin-cancel-setup",
  });

  // The run parks inside prepareSignIn awaiting the (gated) listener start;
  // cancel supersedes it before setup completes.
  const first = manager.beginBrowserSignIn();
  manager.cancelSignIn();
  startGate.resolve(); // setup finishes, but the run is now superseded

  assert.deepEqual(await first, { ok: false, reason: "cancelled" });
  assert.equal(
    loopback.state.openCalls.length,
    0,
    "browser never opened for a superseded run"
  );
  assert.equal(loopback.state.redeemCalls, 0);
  assert.equal(
    loopback.state.closeCalls,
    1,
    "the listener started during setup is released"
  );
  assert.equal(manager.getState().status, DesktopAuthStatus.SignedOut);
});

test("a thrown redeem settles to exchange_failed without stranding exchanging", async () => {
  const loopback = createLoopbackStub();
  loopback.state.redeemThrows = true; // redeem rejects instead of returning a typed result
  const statuses: string[] = [];
  const { manager, store } = createManager({
    browserSignIn: loopback.deps,
    storeName: "dsm-signin-redeem-throw",
  });
  manager.subscribe((state) => statuses.push(state.status));

  const result = await manager.beginBrowserSignIn();

  assert.deepEqual(result, { ok: false, reason: "exchange_failed" });
  assert.equal(store.hasSession(), false);
  // It reaches exchanging, then settles back out of it — never stranded.
  assert.ok(
    statuses.includes(DesktopAuthStatus.Exchanging),
    "entered exchanging"
  );
  assert.equal(
    statuses.at(-1),
    DesktopAuthStatus.SignedOut,
    "settled back to a resting state"
  );
  assert.equal(manager.getState().status, DesktopAuthStatus.SignedOut);
});
