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
import {
  DESKTOP_AUTHORIZE_QUERY_PARAMS,
  DesktopSignInFraming,
  DesktopSignInMethod,
  DesktopSignInProvider,
  decodeDesktopEmailHint,
} from "@repo/api/src/types/desktop-authorize-url";
import { OnboardingAccountOutcome } from "@repo/api/src/types/onboarding-analytics.ts";
import { test } from "vitest";
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
  assert.equal(openedParams.get(key.bootstrapSupported), "1");

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

test("a bootstrap callback publishes the pending Clerk identity while awaiting organization", async () => {
  const loopback = createLoopbackStub();
  loopback.state.callbackValue = {
    code: "bootstrap-code",
    state: "state-1",
    error: null,
    accountCreated: true,
    desktopBootstrap: true,
  };
  const { manager } = createManager({
    browserSignIn: loopback.deps,
    storeName: "dsm-bootstrap-awaiting-org",
  });

  assert.deepEqual(await manager.beginBrowserSignIn(), { ok: true });
  assert.deepEqual(manager.getState(), {
    status: DesktopAuthStatus.Exchanging,
    authGeneration: 0,
    userId: null,
    organizationId: null,
    accountOutcome: OnboardingAccountOutcome.Unknown,
    awaitingOrganization: true,
    pendingUserId: "clerk-user-1",
  });
});

test("a failed bootstrap exchange settles back to signed out", async () => {
  const loopback = createLoopbackStub();
  loopback.state.callbackValue = {
    code: "bootstrap-code",
    state: "state-1",
    error: null,
    accountCreated: true,
    desktopBootstrap: true,
  };
  loopback.state.bootstrapRedeemResult = {
    ok: false,
    error: "invalid",
    retryable: false,
  };
  const { manager } = createManager({
    browserSignIn: loopback.deps,
    storeName: "dsm-bootstrap-redeem-failure",
  });

  assert.deepEqual(await manager.beginBrowserSignIn(), {
    ok: false,
    reason: "expired",
  });
  assert.equal(manager.getState().status, DesktopAuthStatus.SignedOut);
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

// ISS-5954 M2 — the email method must reach the URL as its explicit value:
// absent means GitHub on the web side, so a manager that dropped it here would
// send every email pick to GitHub's consent screen.
test("beginBrowserSignIn carries the email method onto the opened URL", async () => {
  const loopback = createLoopbackStub();
  const { manager } = createManager({
    browserSignIn: loopback.deps,
    storeName: "dsm-signin-method-email",
  });

  await manager.beginBrowserSignIn(DesktopSignInMethod.Email);

  assert.equal(loopback.state.openCalls.length, 1, "browser opened once");
  const opened = new URL(loopback.state.openCalls[0] ?? "");
  assert.equal(
    opened.searchParams.get(DESKTOP_AUTHORIZE_QUERY_PARAMS.provider),
    DesktopSignInMethod.Email
  );
});

// ISS-5954 M5 — the typed address prefills the email form and nothing else: it
// rides the URL (hence browser history) ONLY for the method that renders that
// form. A social pick with a stray hint must not leak the address.
test("beginBrowserSignIn puts the email hint on the URL for the email method only", async () => {
  const emailRun = createLoopbackStub();
  const { manager: emailManager } = createManager({
    browserSignIn: emailRun.deps,
    storeName: "dsm-signin-email-hint",
  });
  await emailManager.beginBrowserSignIn(
    DesktopSignInMethod.Email,
    "kerensa+desktop@closedloop.ai"
  );
  const emailUrl = new URL(emailRun.state.openCalls[0] ?? "");
  assert.equal(
    decodeDesktopEmailHint(
      emailUrl.searchParams.get(DESKTOP_AUTHORIZE_QUERY_PARAMS.emailHint)
    ),
    "kerensa+desktop@closedloop.ai"
  );

  const socialRun = createLoopbackStub();
  const { manager: socialManager } = createManager({
    browserSignIn: socialRun.deps,
    storeName: "dsm-signin-social-no-hint",
  });
  await socialManager.beginBrowserSignIn(
    DesktopSignInProvider.Google,
    "kerensa+desktop@closedloop.ai"
  );
  const socialUrl = new URL(socialRun.state.openCalls[0] ?? "");
  assert.equal(
    socialUrl.searchParams.has(DESKTOP_AUTHORIZE_QUERY_PARAMS.emailHint),
    false
  );
});

// ISS-5954 — the door framing rides the same email-only branch as the hint:
// only the email landing page reads it, so a social pick must not carry it.
test("beginBrowserSignIn puts the framing on the URL for the email method only", async () => {
  const emailRun = createLoopbackStub();
  const { manager: emailManager } = createManager({
    browserSignIn: emailRun.deps,
    storeName: "dsm-signin-email-framing",
  });
  await emailManager.beginBrowserSignIn(
    DesktopSignInMethod.Email,
    undefined,
    DesktopSignInFraming.SignIn
  );
  const emailUrl = new URL(emailRun.state.openCalls[0] ?? "");
  assert.equal(
    emailUrl.searchParams.get(DESKTOP_AUTHORIZE_QUERY_PARAMS.framing),
    DesktopSignInFraming.SignIn
  );

  const socialRun = createLoopbackStub();
  const { manager: socialManager } = createManager({
    browserSignIn: socialRun.deps,
    storeName: "dsm-signin-social-no-framing",
  });
  await socialManager.beginBrowserSignIn(
    DesktopSignInProvider.Google,
    undefined,
    DesktopSignInFraming.SignIn
  );
  const socialUrl = new URL(socialRun.state.openCalls[0] ?? "");
  assert.equal(
    socialUrl.searchParams.has(DESKTOP_AUTHORIZE_QUERY_PARAMS.framing),
    false
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
    accountCreated: false,
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
    accountCreated: false,
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
    accountCreated: false,
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
  loopback.state.callbackValue = {
    code: null,
    state: "state-1",
    error: null,
    accountCreated: false,
  };
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

// ISS-10411 (PLN-2043 M5) — DELAYED callback delivery. The ceiling is minutes
// because the whole browser interaction lives inside it, so a redirect the
// person takes their time over is the ordinary case. The timeout test above
// covers a callback that NEVER arrives; this one covers the other half, which
// nothing pinned: the flow parks with the ceiling armed, redeems nothing while
// parked, and still signs the device in when the redirect lands.
//
// What it does NOT pin is elapsed time against the ceiling: `delayMs` never
// settles in this run, so "the timer has not fired yet" is all that is
// modelled, and a run with the timer disarmed would look identical here. That
// the timer was armed at all is pinned — `timeoutSignal` exists and is torn
// down once the callback wins. Pinning the ordering itself would need a gated
// `delayMs` that settles after the callback loses the race; the production
// path is a plain `Promise.race`, so that seam buys a distinction no mutation
// of this code can exploit.
test("beginBrowserSignIn parks in AwaitingRedirect and authenticates when the redirect lands", async () => {
  const loopback = createLoopbackStub();
  const callback = deferred<void>(); // the redirect is still outstanding
  loopback.state.callbackGate = callback;
  const parked = deferred<void>();
  const statusWhileWaiting: string[] = [];
  const { manager, store } = createManager({
    browserSignIn: loopback.deps,
    storeName: "dsm-signin-late-callback",
  });
  // What the flow reports WHILE the browser still has the person. A bounded
  // wait on the flow reaching the loopback, not a sleep.
  loopback.state.onWait = () => {
    statusWhileWaiting.push(manager.getState().status);
    parked.resolve();
  };

  const signIn = manager.beginBrowserSignIn();
  await parked.promise;

  assert.deepEqual(statusWhileWaiting, [DesktopAuthStatus.AwaitingRedirect]);
  assert.equal(loopback.state.redeemCalls, 0, "nothing redeemed while waiting");

  callback.resolve();

  assert.deepEqual(await signIn, { ok: true });
  assert.equal(loopback.state.redeemInputs[0]?.code, "auth-code");
  assert.equal(manager.getState().status, DesktopAuthStatus.Authenticated);
  assert.equal(store.getSession()?.refreshToken, "redeemed-refresh");
  assert.equal(
    loopback.state.timeoutSignal?.aborted,
    true,
    "the ceiling timer is torn down once the late callback wins"
  );
});

// ISS-10411 (PLN-2043 M5) — the fail-safe end of delayed delivery: once the
// ceiling has reported `redirect_timeout`, NOTHING is left listening for the
// redirect. The wait is aborted and the listener released (which the timeout
// test above pins too), and — the part this test owns — the manager never
// re-opens the wait. `waitCalls` is asserted nowhere else in the desktop
// suites, so a manager that re-subscribed after the ceiling and redeemed a
// code arriving afterwards would pass every other case in this file.
//
// Handing the redirect over afterwards shows the consequence rather than
// driving it: the flow has already stopped reading that gate by the time it
// resolves, which is exactly why a late arrival cannot revive the run.
test("beginBrowserSignIn never authenticates a loopback callback that arrives after the ceiling", async () => {
  const loopback = createLoopbackStub();
  const callback = deferred<void>();
  loopback.state.callbackGate = callback;
  loopback.state.timeoutFires = true;
  const { manager, store } = createManager({
    browserSignIn: loopback.deps,
    storeName: "dsm-signin-callback-after-ceiling",
  });

  const result = await manager.beginBrowserSignIn();
  assert.deepEqual(result, { ok: false, reason: "redirect_timeout" });

  // The browser comes back after we stopped waiting.
  callback.resolve();
  await callback.promise;
  // Drain the microtasks the late callback would settle on, so the assertions
  // below read the state after it had its chance to act rather than before.
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(loopback.state.redeemCalls, 0, "a late code is never redeemed");
  assert.equal(
    store.hasSession(),
    false,
    "no session minted after the ceiling"
  );
  assert.equal(manager.getState().status, DesktopAuthStatus.SignedOut);
  assert.equal(await manager.getAccessToken(), null);
  assert.equal(loopback.state.closeCalls, 1, "listener released on timeout");
  assert.equal(
    loopback.state.waitSignal?.aborted,
    true,
    "the loopback wait is torn down once the ceiling won"
  );
  assert.equal(
    loopback.state.waitCalls,
    1,
    "the loopback wait is never re-opened, so a late redirect has no listener"
  );
});

// ISS-5954 M3 — the email journey (Clerk form + inbox round trip for the
// verification code) outlives the OAuth-bounce ceiling, so the email method
// must arm the LONGER timeout while every other pick keeps the standard one.
test("beginBrowserSignIn arms the email ceiling for an email pick only", async () => {
  const emailRun = createLoopbackStub();
  const { manager: emailManager } = createManager({
    browserSignIn: emailRun.deps,
    storeName: "dsm-signin-email-timeout",
  });
  await emailManager.beginBrowserSignIn(DesktopSignInMethod.Email);
  assert.deepEqual(emailRun.state.delayMsCalls, [3000]);

  const socialRun = createLoopbackStub();
  const { manager: socialManager } = createManager({
    browserSignIn: socialRun.deps,
    storeName: "dsm-signin-social-timeout",
  });
  await socialManager.beginBrowserSignIn(DesktopSignInProvider.Google);
  assert.deepEqual(socialRun.state.delayMsCalls, [1000]);

  const absentRun = createLoopbackStub();
  const { manager: absentManager } = createManager({
    browserSignIn: absentRun.deps,
    storeName: "dsm-signin-absent-timeout",
  });
  await absentManager.beginBrowserSignIn();
  assert.deepEqual(absentRun.state.delayMsCalls, [1000]);
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

test("ISS-10913: a callback reporting a created account settles as created_signed_in", async () => {
  const loopback = createLoopbackStub();
  loopback.state.callbackValue = {
    code: "auth-code",
    state: "state-1",
    error: null,
    accountCreated: true,
  };
  const { manager } = createManager({
    browserSignIn: loopback.deps,
    storeName: "dsm-signin-created",
  });

  const result = await manager.beginBrowserSignIn();

  assert.deepEqual(result, { ok: true });
  assert.equal(
    manager.getState().accountOutcome,
    OnboardingAccountOutcome.CreatedSignedIn
  );
});

test("ISS-10913: a callback with no creation marker settles as signed_in, not unknown", async () => {
  // Absence is "no creation observed"; the session state is still plainly
  // visible, so withholding it would report an unknown the process does not have.
  const loopback = createLoopbackStub();
  const { manager } = createManager({
    browserSignIn: loopback.deps,
    storeName: "dsm-signin-existing",
  });

  await manager.beginBrowserSignIn();

  assert.equal(
    manager.getState().accountOutcome,
    OnboardingAccountOutcome.SignedIn
  );
});

test("ISS-10913: a created account whose redeem fails settles as created_logged_out", async () => {
  const loopback = createLoopbackStub();
  loopback.state.callbackValue = {
    code: "auth-code",
    state: "state-1",
    error: null,
    accountCreated: true,
  };
  loopback.state.redeemResult = {
    ok: false,
    error: "invalid",
    retryable: false,
  };
  const { manager } = createManager({
    browserSignIn: loopback.deps,
    storeName: "dsm-signin-created-lost",
  });

  const result = await manager.beginBrowserSignIn();

  assert.deepEqual(result, { ok: false, reason: "expired" });
  assert.equal(manager.getState().status, DesktopAuthStatus.SignedOut);
  assert.equal(
    manager.getState().accountOutcome,
    OnboardingAccountOutcome.CreatedLoggedOut
  );
});

test("ISS-10913: the creation fact does not survive a run that dies before its callback", async () => {
  // tamsinb on #7793: the earlier version of this case let the SECOND run
  // deliver a callback with `accountCreated: false`, which overwrites the latch
  // before redeem — so deleting the reset in `beginBrowserSignIn` left it green
  // and it pinned nothing. The reset is only load-bearing when the second run
  // never reaches a callback at all: a timeout or a cancel settles through
  // `finishSignIn`, and a stale `true` would report created_logged_out for a
  // run in which nothing was created.
  const loopback = createLoopbackStub();
  loopback.state.callbackValue = {
    code: "auth-code",
    state: "state-1",
    error: null,
    accountCreated: true,
  };
  loopback.state.redeemResult = {
    ok: false,
    error: "invalid",
    retryable: false,
  };
  const { manager } = createManager({
    browserSignIn: loopback.deps,
    storeName: "dsm-signin-created-then-timeout",
  });
  await manager.beginBrowserSignIn();
  assert.equal(
    manager.getState().accountOutcome,
    OnboardingAccountOutcome.CreatedLoggedOut,
    "first run created an account and lost the session"
  );

  // Second run: the browser never comes back, so no callback ever lands and
  // nothing can overwrite the latch except the reset under test.
  loopback.state.timeoutFires = true;
  const second = await manager.beginBrowserSignIn();

  assert.deepEqual(second, { ok: false, reason: "redirect_timeout" });
  assert.equal(manager.getState().status, DesktopAuthStatus.SignedOut);
  assert.equal(
    manager.getState().accountOutcome,
    OnboardingAccountOutcome.LoggedOut,
    "a run that never returned created nothing — the prior run's fact must not carry"
  );
});
