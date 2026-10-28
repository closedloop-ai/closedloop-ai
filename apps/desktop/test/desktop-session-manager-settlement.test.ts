/**
 * ISS-11273 — `DesktopAuthStatus` must always LEAVE the pending set.
 *
 * Every reader of that set renders it as a wait with no exit: the sidebar
 * workspace menu projects `Loading`/`OpeningBrowser`/`AwaitingRedirect`/
 * `Exchanging` to `WorkspaceMenuProjectionStatus.Pending`, which the trigger
 * renders as the literal word "Loading". That projection is correct, so a
 * permanent "Loading" is always a status the authority never settled — and this
 * suite owns the two ways that used to happen plus the ceiling that bounds the
 * one leg the desktop cannot observe the end of.
 */

import assert from "node:assert/strict";
import { AuthOutcome } from "@closedloop-ai/telemetry-contract/app";
import { DESKTOP_OAUTH_CALLBACK_TIMEOUT_MS } from "@repo/api/src/types/desktop-authorize-url";
import { afterEach, test } from "vitest";
import type { DesktopAuthFailureEventInput } from "../src/main/cloud/auth-failure-telemetry.js";
import { DesktopSessionRequestError } from "../src/main/session/desktop-session-client.js";
import { DesktopAuthStatus } from "../src/shared/contracts.js";
import { deferred } from "./deferred.js";
import {
  API_ORIGIN,
  createLoopbackStub,
  createManager,
  createStubClient,
  installTempRoot,
  storedRecord,
} from "./helpers/desktop-session-manager-fixtures.js";
import { nodeTestTimers } from "./support/node-test-fake-timers.js";

installTempRoot();

// Unconditional, never the last line of the case: an assertion that throws
// between enable and reset would otherwise leave a frozen clock in this worker.
afterEach(() => {
  nodeTestTimers.reset();
});

const ORIGIN_VALIDATION_CAUSE = /Origin must be a valid URL/;
const SUBSCRIBER_CAUSE = /render frame destroyed/;
const API_KEY_STORE_CAUSE = /api key store unavailable/;

/**
 * Drain the microtask queue on the REAL clock. `nodeTestTimers.tick` runs due
 * callbacks and returns without draining, so a bare `await Promise.resolve()`
 * reads the status mid-chain — which is how a shortened ceiling passed a
 * "still pending" assertion that meant to catch it. `setImmediate` is not in
 * this suite's `toFake` list, so it is a genuine turn of the event loop.
 */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * Strip the ceiling + timer overrides so the manager resolves its OWN defaults.
 * Every other sign-in suite injects `delayMs`, so nothing exercised the timer the
 * packaged app actually arms — a default that never fired would leave every one
 * of those suites green.
 */
function withProductionTimer(
  deps: ReturnType<typeof createLoopbackStub>["deps"]
): ReturnType<typeof createLoopbackStub>["deps"] {
  const production: Record<string, unknown> = { ...deps };
  production.delayMs = undefined;
  production.callbackTimeoutMs = undefined;
  production.emailCallbackTimeoutMs = undefined;
  return production as ReturnType<typeof createLoopbackStub>["deps"];
}

// A persisted `apiOrigin` that fails `normalizeAndValidateOrigin` makes
// `resolveApiOrigin()` throw inside the refresh the restore awaits. The boot path
// fires `restore()` and only logs a rejection, so the status used to stay
// `Loading` for the life of the process.
test("a restore whose origin resolution throws settles a FAILED status, never Loading", async () => {
  const failures: DesktopAuthFailureEventInput[] = [];
  const diagnostics: string[] = [];
  const { manager, store } = createManager({
    storeName: "dsm-restore-origin-throws",
    resolveApiOrigin: () => {
      throw new Error("Origin must be a valid URL");
    },
    reportAuthFailure: (input) => failures.push(input),
    logDiagnostic: (message) => diagnostics.push(message),
  });
  store.setSession(storedRecord());

  await manager.restore();

  assert.equal(manager.getState().status, DesktopAuthStatus.RefreshFailed);
  // The persisted record survives — the cause is configuration, so the next
  // launch re-reads the credential a corrected origin would refresh.
  assert.equal(store.getSession()?.refreshToken, "stored-refresh");
  // The in-memory one does NOT, and that is what keeps `RefreshFailed` meaning
  // one thing: a retained session makes `finishSignIn` settle the NEXT failed
  // sign-in as `Authenticated` with no usable token and no error surface.
  assert.equal(manager.getIdentity(), null);
  assert.equal(manager.isAuthenticated(), false);
  assert.equal(await manager.getAccessToken(), null);
  assert.equal(failures[0]?.outcome, AuthOutcome.TokenRefreshFailed);
  assert.match(diagnostics[0] ?? "", ORIGIN_VALIDATION_CAUSE);
});

// The other reachable throw: the keystore read itself. `getSession()` folds a
// failed decrypt to null, but `store.get` on a corrupt config file throws.
test("a restore whose keystore read throws settles a FAILED status, never Loading", async () => {
  const { manager, store } = createManager({
    storeName: "dsm-restore-store-throws",
  });
  store.getSession = () => {
    throw new Error("config file is not valid JSON");
  };

  await manager.restore();

  assert.equal(manager.getState().status, DesktopAuthStatus.RefreshFailed);
});

// A throw raised AFTER a setState must not downgrade the answer that call made:
// the signed-out restore below settles legitimately, and a later throw from the
// existing-user derivation must leave it signed out rather than reporting a
// failure the user has to act on.
test("a post-settlement throw leaves the settled status alone", async () => {
  const diagnostics: string[] = [];
  const { manager } = createManager({
    storeName: "dsm-restore-post-settle-throw",
    logDiagnostic: (message) => diagnostics.push(message),
    existingUser: {
      hasApiKey: () => {
        throw new Error("api key store unavailable");
      },
      hasDismissedPrompt: () => false,
      persistDismissal: () => undefined,
    },
  });

  await manager.restore();

  assert.equal(manager.getState().status, DesktopAuthStatus.SignedOut);
  // ...and the cause is still REPORTED. The boot path stopped rethrowing when
  // the settlement catch was added, so a log below the status guard would make
  // this the one throw nothing anywhere records.
  assert.match(diagnostics[0] ?? "", API_KEY_STORE_CAUSE);
});

// The production fan-out starts with the renderer push. One throw there used to
// skip every later subscriber and reject the `restore()` that owns leaving
// `Loading` — a transition nobody can observe is the same stranding as one that
// never happened.
test("a throwing auth-state subscriber neither hides the transition nor strands the status", async () => {
  const diagnostics: string[] = [];
  const seen: DesktopAuthStatus[] = [];
  const { manager } = createManager({
    storeName: "dsm-subscriber-throws",
    logDiagnostic: (message) => diagnostics.push(message),
  });
  manager.subscribe(() => {
    throw new Error("render frame destroyed");
  });
  manager.subscribe((state) => seen.push(state.status));

  await manager.restore();

  assert.deepEqual(seen, [DesktopAuthStatus.SignedOut]);
  assert.equal(manager.getState().status, DesktopAuthStatus.SignedOut);
  assert.match(diagnostics[0] ?? "", SUBSCRIBER_CAUSE);
});

// AC1 — the success path, end to end on the production ceiling: the redirect
// arrives, the code redeems, and the state carries the real organization the
// workspace menu renders.
test("a loopback callback that arrives settles Authenticated with the real organization", async () => {
  const loopback = createLoopbackStub();
  const { manager } = createManager({
    browserSignIn: withProductionTimer(loopback.deps),
    storeName: "dsm-settle-success",
  });

  const result = await manager.beginBrowserSignIn();

  assert.deepEqual(result, { ok: true });
  assert.equal(manager.getState().status, DesktopAuthStatus.Authenticated);
  assert.equal(manager.getState().organizationId, "org-1");
});

// AC3/AC4 — the never-returns path on the timer the packaged app actually arms.
// Driven by fake timers, so the ceiling's VALUE is pinned in BOTH directions: a
// default raised (or a timer that never fires) leaves the run unsettled past the
// ceiling, and a default lowered settles it before the sub-ceiling tick.
test("the production callback ceiling fires when the loopback never returns", async () => {
  nodeTestTimers.enable(["setTimeout"]);
  const loopback = createLoopbackStub();
  loopback.state.callbackGate = deferred<void>();
  const reachedWait = deferred<void>();
  loopback.state.onWait = () => reachedWait.resolve();
  const { manager } = createManager({
    browserSignIn: withProductionTimer(loopback.deps),
    storeName: "dsm-settle-ceiling",
  });

  const signIn = manager.beginBrowserSignIn();
  await reachedWait.promise;
  assert.equal(manager.getState().status, DesktopAuthStatus.AwaitingRedirect);

  let settled = false;
  const tracked = signIn.then((outcome) => {
    settled = true;
    return outcome;
  });

  nodeTestTimers.tick(DESKTOP_OAUTH_CALLBACK_TIMEOUT_MS - 1);
  await flushMicrotasks();
  assert.equal(
    settled,
    false,
    "the sign-in must not settle one tick short of the ceiling"
  );
  assert.equal(manager.getState().status, DesktopAuthStatus.AwaitingRedirect);

  nodeTestTimers.tick(1);
  await flushMicrotasks();
  assert.equal(settled, true, "the ceiling settled the run");
  assert.deepEqual(await tracked, { ok: false, reason: "redirect_timeout" });

  assert.equal(manager.getState().status, DesktopAuthStatus.SignedOut);
  assert.equal(loopback.state.redeemCalls, 0);
});

// A refresh that returns a typed retryable failure is NOT this defect: it settles
// Authenticated so the token read retries. Pinned here so the new catch cannot
// be widened into swallowing the ordinary offline case.
test("a retryable refresh failure still settles Authenticated, not the failed status", async () => {
  const stub = createStubClient();
  stub.setRefresh(() =>
    Promise.resolve({
      ok: false,
      error: DesktopSessionRequestError.Network,
      retryable: true,
    })
  );
  const { manager, store } = createManager({
    stub,
    storeName: "dsm-restore-retryable",
  });
  store.setSession(storedRecord());

  await manager.restore();

  assert.equal(manager.getState().status, DesktopAuthStatus.Authenticated);
});

// The consequence the settled status exists to prevent (review-soul, HIGH).
// An unrestorable session that kept its in-memory record breaks the way back in
// twice over: `beginBrowserSignIn` refuses outright while a session exists
// (`already_in_progress`), and `finishSignIn` derives its resting state from
// credential presence alone, so a failure that did get through would settle as a
// confident `Authenticated` with no usable token and no error surface. Both are
// worse than the "Loading" this ticket removes.
test("an unrestorable session cannot make a later failed sign-in report Authenticated", async () => {
  const loopback = createLoopbackStub();
  loopback.state.openShouldThrow = true;
  const { manager, store } = createManager({
    storeName: "dsm-restore-then-failed-signin",
    browserSignIn: loopback.deps,
    resolveApiOrigin: () => {
      throw new Error("Origin must be a valid URL");
    },
  });
  store.setSession(storedRecord());

  await manager.restore();
  assert.equal(manager.getState().status, DesktopAuthStatus.RefreshFailed);

  assert.deepEqual(await manager.beginBrowserSignIn(), {
    ok: false,
    reason: "open_failed",
  });
  assert.equal(manager.getState().status, DesktopAuthStatus.SignedOut);
  assert.equal(manager.isAuthenticated(), false);
});

// The way back OUT, which the settled status is worth nothing without. `signOut`
// evaluated `baseClientArgs()` as an ARGUMENT to `revoke()`, so the same invalid
// `apiOrigin` that strands the restore threw before there was a promise for
// `.catch()` to attach to — and `clearSession` never ran. The user reached an
// "Account unavailable" they could not sign out of either.
test("sign out clears the session even when the origin resolver throws", async () => {
  const stub = createStubClient();
  let originBroken = false;
  const { manager, store } = createManager({
    stub,
    storeName: "dsm-signout-origin-throws",
    resolveApiOrigin: () => {
      if (originBroken) {
        throw new Error("Origin must be a valid URL");
      }
      return API_ORIGIN;
    },
  });
  store.setSession(storedRecord());

  await manager.restore();
  assert.equal(manager.getState().status, DesktopAuthStatus.Authenticated);

  originBroken = true;
  await manager.signOut();

  assert.equal(manager.getState().status, DesktopAuthStatus.SignedOut);
  assert.equal(manager.isAuthenticated(), false);
  assert.equal(store.getSession(), null);
  // The revoke never reached the wire — the origin threw building its args — so
  // the local clear is the whole of what this path can still guarantee.
  assert.equal(stub.calls.revoke, 0);
});
